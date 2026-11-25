import { randomUUID } from 'node:crypto';
import type { CredentialStore, OAuthPkce, OAuthSubject } from './auth.ts';
import {
  ConnectorError,
  SerialQueue,
  keyOf,
  type BindingRef,
  type Clock,
  type Connector,
  type ConnectorContext,
  type ConnectorManifest,
  type Credential,
  type Operation,
} from './sdk.ts';

export interface ConnectorRegistration {
  connector: Connector;
  oauth?: OAuthPkce;
}

export interface Installation extends BindingRef {
  connectorId: string;
  connectorVersion: string;
  accountId: string;
  mode: 'primary' | 'shadow';
  status: 'installed' | 'authorized' | 'verified' | 'active' | 'paused' | 'revoking' | 'revoked';
  verifiedAt?: string;
}

interface ActiveConnector {
  binding: Installation;
  connector: Connector;
  context: ConnectorContext;
}

export class ConnectorLifecycle {
  private readonly catalog = new Map<string, ConnectorRegistration>();
  private readonly bindings = new Map<string, Installation>();
  private readonly connections = new Map<string, BindingRef>();
  private readonly owners = new Set<string>();
  private readonly queue = new SerialQueue();
  private readonly windows = new Map<string, { startsAt: number; used: number }>();
  private readonly store: CredentialStore;
  private readonly clock: Clock;

  constructor(
    registrations: readonly ConnectorRegistration[],
    store: CredentialStore,
    clock: Clock = Date.now,
  ) {
    this.store = store;
    this.clock = clock;
    for (const registration of registrations) {
      const manifest = registration.connector.manifest;
      const { requests, windowMs } = manifest.rateLimit;
      if (
        !manifest.id ||
        !manifest.version ||
        this.catalog.has(manifest.id) ||
        (manifest.authType === 'oauth2-pkce') !== Boolean(registration.oauth) ||
        !Number.isSafeInteger(requests) ||
        requests <= 0 ||
        !Number.isSafeInteger(windowMs) ||
        windowMs <= 0 ||
        manifest.authoritativeFor.some((value) => !manifest.recordClasses.includes(value)) ||
        (manifest.webhook &&
          manifest.webhook.recordClasses.some((value) => !manifest.recordClasses.includes(value)))
      ) {
        throw new ConnectorError('validation_failed');
      }
      this.catalog.set(manifest.id, {
        oauth: registration.oauth,
        connector: {
          manifest: structuredClone(manifest),
          verifyAccount: registration.connector.verifyAccount.bind(registration.connector),
          read: registration.connector.read.bind(registration.connector),
          snapshot: registration.connector.snapshot.bind(registration.connector),
          listChangedSince: registration.connector.listChangedSince.bind(registration.connector),
          write: registration.connector.write?.bind(registration.connector),
          reconcile: registration.connector.reconcile?.bind(registration.connector),
        },
      });
    }
  }

  available(): ConnectorManifest[] {
    return [...this.catalog.values()].map(({ connector }) => structuredClone(connector.manifest));
  }

  install(
    tenantId: string,
    connectorId: string,
    accountId: string,
    mode: Installation['mode'] = 'primary',
  ): Installation {
    if (!tenantId || !accountId || !['primary', 'shadow'].includes(mode)) {
      throw new ConnectorError('validation_failed');
    }
    const registration = this.registration(connectorId);
    const binding: Installation = {
      tenantId,
      connectionId: randomUUID(),
      connectorId,
      connectorVersion: registration.connector.manifest.version,
      accountId,
      mode,
      status: 'installed',
    };
    this.bindings.set(this.bindingKey(binding), binding);
    this.connections.set(binding.connectionId, { tenantId, connectionId: binding.connectionId });
    return { ...binding };
  }

  resolveConnection(connectionId: string): BindingRef {
    const ref = this.connections.get(connectionId);
    if (!ref) throw new ConnectorError('not_found');
    return { ...ref };
  }

  get(ref: BindingRef): Installation {
    return { ...this.binding(ref) };
  }

  manifest(ref: BindingRef): ConnectorManifest {
    return structuredClone(this.registration(this.binding(ref).connectorId).connector.manifest);
  }

  startOAuth(subject: OAuthSubject) {
    return this.lock(subject, async (binding) => {
      const oauth = this.registration(binding.connectorId).oauth;
      if (!oauth) throw new ConnectorError('unsupported');
      this.assertStatus(binding, ['installed']);
      return oauth.start(subject);
    });
  }

  authorizeOAuth(subject: OAuthSubject, state: string, code: string) {
    return this.lock(subject, async (binding) => {
      const oauth = this.registration(binding.connectorId).oauth;
      if (!oauth) throw new ConnectorError('unsupported');
      this.assertStatus(binding, ['installed']);
      await this.store.put(binding, await oauth.exchange(subject, state, code));
      binding.status = 'authorized';
      return { ...binding };
    });
  }

  async completeOAuth(caller: Omit<OAuthSubject, 'connectionId'>, state: string, code: string) {
    for (const { connector, oauth } of this.catalog.values()) {
      const subject = await oauth?.subject(state, caller);
      if (subject && this.binding(subject).connectorId === connector.manifest.id) {
        return this.authorizeOAuth(subject, state, code);
      }
    }
    throw new ConnectorError('auth_required');
  }

  authorizeApiKey(ref: BindingRef, key: string) {
    return this.lock(ref, async (binding) => {
      if (this.registration(binding.connectorId).connector.manifest.authType !== 'api-key') {
        throw new ConnectorError('unsupported');
      }
      this.assertStatus(binding, ['installed']);
      if (!key.trim()) throw new ConnectorError('validation_failed');
      await this.store.put(binding, { type: 'api-key', key });
      binding.status = 'authorized';
      return { ...binding };
    });
  }

  verifyAccount(ref: BindingRef) {
    return this.lock(ref, async (binding) => {
      this.assertStatus(binding, ['authorized', 'paused']);
      await this.checkAccount(binding, await this.credential(binding));
      if (binding.status === 'authorized') binding.status = 'verified';
      return { ...binding };
    });
  }

  activate(ref: BindingRef) {
    return this.lock(ref, async (binding) => {
      this.assertStatus(binding, ['verified', 'paused']);
      if (!binding.verifiedAt) throw new ConnectorError('auth_required');
      const { authoritativeFor } = this.registration(binding.connectorId).connector.manifest;
      if (binding.mode === 'primary') {
        for (const other of this.bindings.values()) {
          if (
            other.tenantId !== binding.tenantId ||
            other === binding ||
            !this.owners.has(this.bindingKey(other))
          )
            continue;
          const manifest = this.registration(other.connectorId).connector.manifest;
          if (
            manifest.authoritativeFor.some((recordClass) => authoritativeFor.includes(recordClass))
          )
            throw new ConnectorError('conflict');
        }
        this.owners.add(this.bindingKey(binding));
      }
      binding.status = 'active';
      return { ...binding };
    });
  }

  pause(ref: BindingRef) {
    return this.lock(ref, async (binding) => {
      this.assertStatus(binding, ['active']);
      binding.status = 'paused';
      return { ...binding };
    });
  }

  refresh(ref: BindingRef) {
    return this.lock(ref, async (binding) => {
      this.assertStatus(binding, ['verified', 'active', 'paused']);
      const oauth = this.registration(binding.connectorId).oauth;
      if (!oauth) throw new ConnectorError('unsupported');
      await this.refreshCredential(binding, await this.credential(binding));
      return { ...binding };
    });
  }

  revoke(ref: BindingRef) {
    return this.lock(ref, async (binding) => {
      if (binding.status === 'revoked') return { ...binding };
      binding.status = 'revoking';
      const credential = await this.store.get(binding);
      if (credential?.type === 'oauth2-pkce') {
        await this.registration(binding.connectorId).oauth!.revoke(credential);
      }
      await this.store.delete(binding);
      binding.status = 'revoked';
      this.owners.delete(this.bindingKey(binding));
      return { ...binding };
    });
  }

  withActive<T>(
    ref: BindingRef,
    operation: Operation,
    execute: (active: ActiveConnector) => Promise<T>,
  ): Promise<T> {
    return this.lock(ref, async (binding) => {
      const allowed: Installation['status'][] = ['active'];
      if (operation === 'reconcile') allowed.push('paused');
      if (!allowed.includes(binding.status) || !binding.verifiedAt)
        throw new ConnectorError('auth_required');
      const { connector } = this.registration(binding.connectorId);
      const scopes = connector.manifest.scopes[operation];
      if (!scopes) throw new ConnectorError('unsupported');
      if (operation === 'write' && binding.mode === 'shadow') {
        throw new ConnectorError('write_frozen');
      }
      let credential = await this.credential(binding);
      if (credential.type === 'oauth2-pkce') {
        if (credential.expiresAt <= this.clock()) {
          credential = await this.refreshCredential(binding, credential);
        }
        const granted = credential.scopes;
        if (scopes.some((scope) => !granted.includes(scope))) {
          throw new ConnectorError('permission_denied');
        }
      }
      this.reserve(binding, connector.manifest);
      return execute({
        binding: { ...binding },
        context: {
          tenantId: binding.tenantId,
          connectionId: binding.connectionId,
          accountId: binding.accountId,
          credential,
        },
        connector,
      });
    });
  }

  private async credential(binding: Installation) {
    const credential = await this.store.get(binding);
    if (
      !credential ||
      credential.type !== this.registration(binding.connectorId).connector.manifest.authType
    ) {
      throw new ConnectorError('auth_required');
    }
    return credential;
  }

  private async refreshCredential(binding: Installation, credential: Credential) {
    if (credential.type !== 'oauth2-pkce') throw new ConnectorError('unsupported');
    const oauth = this.registration(binding.connectorId).oauth!;
    const refreshed = await oauth.refresh(credential);
    // Restore the usable status only after verifying the rotated credential against the pinned account.
    const previousStatus = binding.status;
    binding.status =
      this.owners.has(this.bindingKey(binding)) || previousStatus === 'paused'
        ? 'paused'
        : 'authorized';
    delete binding.verifiedAt;
    await this.store.put(binding, refreshed);
    await this.checkAccount(binding, refreshed);
    binding.status = previousStatus;
    return refreshed;
  }

  private async checkAccount(binding: Installation, credential: Credential) {
    const { connector } = this.registration(binding.connectorId);
    if (credential.type === 'oauth2-pkce') {
      if (credential.expiresAt <= this.clock()) throw new ConnectorError('auth_required');
      const required = ['read', 'snapshot', 'listChangedSince'] as const;
      if (
        required.some((operation) =>
          connector.manifest.scopes[operation]?.some((scope) => !credential.scopes.includes(scope)),
        )
      )
        throw new ConnectorError('permission_denied');
    }
    this.reserve(binding, connector.manifest);
    let account: string;
    try {
      account = await connector.verifyAccount(credential);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('provider_unavailable');
    }
    if (account !== binding.accountId) throw new ConnectorError('permission_denied');
    binding.verifiedAt = new Date(this.clock()).toISOString();
  }

  private reserve(binding: Installation, manifest: ConnectorManifest) {
    const { requests, windowMs } = manifest.rateLimit;
    const key = keyOf(binding.tenantId, manifest.id, binding.accountId);
    const now = this.clock();
    const previous = this.windows.get(key);
    const window =
      previous && previous.startsAt + windowMs > now ? previous : { startsAt: now, used: 0 };
    if (window.used >= requests) {
      throw new ConnectorError('rate_limited', window.startsAt + windowMs - now);
    }
    window.used += 1;
    this.windows.set(key, window);
  }

  private assertStatus(binding: Installation, allowed: Installation['status'][]) {
    if (!allowed.includes(binding.status)) throw new ConnectorError('conflict');
  }

  private registration(id: string) {
    const registration = this.catalog.get(id);
    if (!registration) throw new ConnectorError('not_found');
    return registration;
  }

  private bindingKey(ref: BindingRef) {
    return keyOf(ref.tenantId, ref.connectionId);
  }

  private binding(ref: BindingRef) {
    const binding = this.bindings.get(this.bindingKey(ref));
    if (!binding) throw new ConnectorError('not_found');
    return binding;
  }

  private lock<T>(ref: BindingRef, work: (binding: Installation) => Promise<T>) {
    return this.queue.run(this.bindingKey(ref), () => work(this.binding(ref)));
  }
}
