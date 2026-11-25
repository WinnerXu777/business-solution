import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import type { Capability } from './providers.ts';
import type { TenantRepository } from './repository.ts';

interface Sealed {
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface CredentialMetadata {
  ref: string;
  capability: Capability;
  providerId: string;
  version: number;
  status: 'active' | 'revoked';
  updatedAt: string;
}

export interface StoredCredential {
  metadata: CredentialMetadata;
  sealed?: Sealed;
}

export interface CredentialInput {
  capability: Capability;
  providerId: string;
  secret: string;
}

export type WrappedTenantKey = Sealed;
type AccessEvidence = Pick<MutationContext, 'source' | 'traceId' | 'correlationId'>;

export interface CredentialAccessor {
  <Result>(evidence: AccessEvidence, use: (secret: Uint8Array) => Promise<Result>): Promise<Result>;
}

export const vaultRefPattern = /^vault:\/\/cred-[0-9a-f-]{36}$/;
export const masterKeyEnvironment = 'BS_PLATFORM_VAULT_MASTER_KEY';

export function readVaultMasterKey(environment = process.env): Buffer | undefined {
  const value = environment[masterKeyEnvironment];
  if (value === undefined) return;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw new Error('Invalid platform vault master key.');
  }
  return bytes;
}

function seal(key: Buffer, data: Buffer, scope: unknown[]): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(scope)));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function open(key: Buffer, value: Sealed, scope: unknown[]): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(scope)));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const plaintext = decipher.update(Buffer.from(value.ciphertext, 'base64'));
  try {
    decipher.final();
    return plaintext;
  } catch (error) {
    plaintext.fill(0);
    throw error;
  }
}

function credentialScope(tenantId: string, row: CredentialMetadata) {
  return ['platform-credential-v1', tenantId, row.ref, row.capability, row.providerId, row.version];
}

export class CredentialVault {
  private readonly masterKey?: Buffer;
  private readonly keys: TenantRepository<WrappedTenantKey>;
  private readonly credentials: TenantRepository<StoredCredential>;
  private readonly audit: PlatformAudit;
  private readonly now: () => string;

  constructor(
    masterKey: Uint8Array | undefined,
    keys: TenantRepository<WrappedTenantKey>,
    credentials: TenantRepository<StoredCredential>,
    audit: PlatformAudit,
    now: () => string,
  ) {
    if (masterKey && masterKey.length !== 32) throw new Error('Invalid platform vault master key.');
    this.masterKey = masterKey && Buffer.from(masterKey);
    this.keys = keys;
    this.credentials = credentials;
    this.audit = audit;
    this.now = now;
  }

  async list(tenantId: string) {
    return (await this.credentials.list(tenantId)).map(({ metadata }) => metadata);
  }

  private async tenantKey(tenantId: string, create = false) {
    if (!this.masterKey) throw new PlatformError('unavailable');
    const scope = ['platform-tenant-key-v1', tenantId];
    const wrapped = await this.keys.get(tenantId, 'current');
    if (wrapped) return open(this.masterKey, wrapped, scope);
    if (!create) throw new PlatformError('unavailable');
    const key = randomBytes(32);
    try {
      await this.keys.put(tenantId, 'current', seal(this.masterKey, key, scope));
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  private async store(
    context: MutationContext,
    metadata: CredentialMetadata,
    secret: string,
    create: boolean,
  ) {
    if (!secret || Buffer.byteLength(secret) > 16_384) throw new PlatformError('forbidden');
    const key = await this.tenantKey(context.tenantId, create);
    const plaintext = Buffer.from(secret);
    let sealed: Sealed;
    try {
      sealed = seal(key, plaintext, credentialScope(context.tenantId, metadata));
    } finally {
      key.fill(0);
      plaintext.fill(0);
    }
    await this.audit.record(
      context,
      create ? 'platform.credential.create' : 'platform.credential.rotate',
      'ok',
      metadata.ref.slice(8),
    );
    await this.credentials.put(context.tenantId, metadata.ref, { metadata, sealed });
    return metadata;
  }

  create(context: MutationContext, { capability, providerId, secret }: CredentialInput) {
    return this.audit.transaction(context.tenantId, () =>
      this.store(
        context,
        {
          ref: 'vault://cred-' + randomUUID(),
          capability,
          providerId,
          version: 1,
          status: 'active',
          updatedAt: this.now(),
        },
        secret,
        true,
      ),
    );
  }

  rotate(context: MutationContext, ref: string, secret: string) {
    return this.audit.transaction(context.tenantId, async () => {
      const current = (await this.credentials.get(context.tenantId, ref))?.metadata;
      if (current?.status !== 'active') throw new PlatformError('not_found');
      return this.store(
        context,
        { ...current, version: current.version + 1, updatedAt: this.now() },
        secret,
        false,
      );
    });
  }

  revoke(context: MutationContext, ref: string) {
    return this.audit.transaction(context.tenantId, async () => {
      const current = (await this.credentials.get(context.tenantId, ref))?.metadata;
      if (!current) throw new PlatformError('not_found');
      if (current.status === 'revoked') return;
      await this.audit.record(context, 'platform.credential.revoke', 'ok', ref.slice(8));
      await this.credentials.put(context.tenantId, ref, {
        metadata: { ...current, status: 'revoked', updatedAt: this.now() },
      });
    });
  }

  private async matching(
    tenantId: string,
    capability: Capability,
    providerId: string,
    ref: string,
  ) {
    const row = await this.credentials.get(tenantId, ref);
    if (
      row?.sealed &&
      row.metadata.ref === ref &&
      row.metadata.status === 'active' &&
      row.metadata.capability === capability &&
      row.metadata.providerId === providerId
    )
      return { metadata: row.metadata, sealed: row.sealed };
  }

  async assertActive(tenantId: string, capability: Capability, providerId: string, ref: string) {
    if (!(await this.matching(tenantId, capability, providerId, ref)))
      throw new PlatformError('not_found');
    if (!this.masterKey) throw new PlatformError('unavailable');
  }

  /** Minted inside the trusted adapter boundary. Every invocation checks the current credential. */
  accessor(
    tenantId: string,
    capability: Capability,
    providerId: string,
    ref: string,
  ): CredentialAccessor {
    return async (evidence, use) => {
      const context = {
        ...evidence,
        tenantId,
        actor: { id: 'adapter-' + providerId, kind: 'service' } as const,
      };
      let plaintext: Buffer | undefined;
      try {
        const error = await this.audit.transaction(tenantId, async () => {
          const row = await this.matching(tenantId, capability, providerId, ref);
          const subjectId = vaultRefPattern.test(ref) ? ref.slice(8) : undefined;
          if (!row) {
            await this.audit.record(context, 'platform.credential.access', 'denied', subjectId);
            return 'not_found';
          }
          try {
            const key = await this.tenantKey(tenantId);
            try {
              plaintext = open(key, row.sealed, credentialScope(tenantId, row.metadata));
            } finally {
              key.fill(0);
            }
          } catch {
            await this.audit.record(context, 'platform.credential.access', 'failed', subjectId);
            return 'unavailable';
          }
          await this.audit.record(context, 'platform.credential.access', 'ok', subjectId);
        });
        if (!plaintext) throw new PlatformError(error ?? 'unavailable');
        return await use(plaintext);
      } finally {
        plaintext?.fill(0);
      }
    };
  }
}
