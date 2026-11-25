import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import type { TenantRepository } from './repository.ts';

export interface ConnectionInput {
  kind: 'api_client' | 'mcp_client';
  name: string;
  scopes: string[];
}

interface Connection extends ConnectionInput {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredConnection {
  connection: Connection;
  secretHash: string;
}

function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest();
}

export class ConnectionStore {
  private readonly repository: TenantRepository<StoredConnection>;
  private readonly audit: PlatformAudit;
  private readonly now: () => string;

  constructor(
    repository: TenantRepository<StoredConnection>,
    audit: PlatformAudit,
    now: () => string,
  ) {
    this.repository = repository;
    this.audit = audit;
    this.now = now;
  }

  async list(tenantId: string) {
    return (await this.repository.list(tenantId)).map(({ connection }) => connection);
  }

  create(context: MutationContext, input: ConnectionInput) {
    const { kind, name, scopes } = structuredClone(input);
    return this.audit.transaction(context.tenantId, async () => {
      const secret = 'fixture_' + randomBytes(32).toString('base64url');
      const connection: Connection = {
        id: 'connection-' + randomUUID(),
        kind,
        name,
        scopes: [...new Set(scopes)],
        createdAt: this.now(),
        lastUsedAt: null,
      };
      await this.audit.record(context, 'platform.connection.create');
      await this.repository.put(context.tenantId, connection.id, {
        connection,
        secretHash: hashSecret(secret).toString('hex'),
      });
      return { ...connection, secret };
    });
  }

  delete(context: MutationContext, id: string) {
    return this.audit.transaction(context.tenantId, async () => {
      if (!(await this.repository.get(context.tenantId, id))) throw new PlatformError('not_found');
      await this.audit.record(context, 'platform.connection.delete');
      await this.repository.delete(context.tenantId, id);
    });
  }

  authenticate(
    tenantId: string,
    id: string,
    secret: string,
    kind: ConnectionInput['kind'],
    scope: string,
  ) {
    return this.audit.transaction(tenantId, async () => {
      const stored = await this.repository.get(tenantId, id);
      if (!stored || !timingSafeEqual(Buffer.from(stored.secretHash, 'hex'), hashSecret(secret)))
        return;
      const { connection } = stored;
      if (connection.kind !== kind || !connection.scopes.includes(scope)) return;
      connection.lastUsedAt = this.now();
      await this.audit.record(
        {
          tenantId,
          actor: { id, kind: 'service' },
          source: kind === 'mcp_client' ? 'mcp' : 'rest',
          traceId: randomUUID(),
          correlationId: id,
        },
        'platform.connection.use',
      );
      await this.repository.put(tenantId, id, stored);
      return connection;
    });
  }
}
