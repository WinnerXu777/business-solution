import { randomUUID } from 'node:crypto';
import type { ConnectedRecords } from '@bs/business';
import type { Deal } from '@bs/contracts';
import type { FastifyRequest } from 'fastify';
import {
  ConnectorError,
  ConnectorLifecycle,
  ConnectorSync,
  WebhookIngestor,
  createFixtureConnectors,
  fixtureAccounts,
  type Credential,
  type CredentialStore,
  type Installation,
} from '../../../packages/adapters/src/connectors/index.ts';
import type {
  MutationContext,
  PlatformServices,
} from '../../../packages/core/src/platform/index.ts';
import type { ConnectorPermission, ConnectorPluginOptions } from './connectors/index.ts';
import type { VerifiedIdentity } from './governance/index.ts';

const vaultProvider = 'fixture-connector';
const stages: ReadonlySet<string> = new Set(['lead', 'qualified', 'proposal', 'won', 'lost']);

function vaultCredentials(vault: PlatformServices['vault']): CredentialStore {
  const references = new Map<string, string>();
  const key = ({ tenantId, connectionId }: Parameters<CredentialStore['get']>[0]) =>
    JSON.stringify([tenantId, connectionId]);
  const context = ({
    tenantId,
    connectionId,
  }: Parameters<CredentialStore['get']>[0]): MutationContext => ({
    tenantId,
    actor: { id: 'service-connectors', kind: 'service' },
    source: 'worker',
    traceId: randomUUID(),
    correlationId: connectionId,
  });
  return {
    async get(binding) {
      const ref = references.get(key(binding));
      if (!ref) return;
      return vault.accessor(
        binding.tenantId,
        'crm',
        vaultProvider,
        ref,
      )(context(binding), (secret) =>
        Promise.resolve(
          JSON.parse(
            Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength).toString('utf8'),
          ) as Credential,
        ),
      );
    },
    async put(binding, credential) {
      const ref = references.get(key(binding));
      const serialized = JSON.stringify(credential);
      if (ref) await vault.rotate(context(binding), ref, serialized);
      else {
        const entry = await vault.create(context(binding), {
          capability: 'crm',
          providerId: vaultProvider,
          secret: serialized,
        });
        references.set(key(binding), entry.ref);
      }
    },
    async delete(binding) {
      const ref = references.get(key(binding));
      if (ref) {
        await vault.revoke(context(binding), ref);
        references.delete(key(binding));
      }
    },
  };
}

export function fixtureConnectors(
  services: () => PlatformServices,
  resolveIdentity: (
    request: FastifyRequest,
  ) => VerifiedIdentity | undefined | Promise<VerifiedIdentity | undefined>,
  now: () => string,
) {
  const clock = () => Date.parse(now());
  const fixture = createFixtureConnectors(clock);
  const credentials: CredentialStore = {
    get: (binding) => store().get(binding),
    put: (binding, credential) => store().put(binding, credential),
    delete: (binding) => store().delete(binding),
  };
  let vaultStore: CredentialStore | undefined;
  function store() {
    return (vaultStore ??= vaultCredentials(services().vault));
  }
  const lifecycle = new ConnectorLifecycle(fixture.registrations, credentials, clock);
  const sync = new ConnectorSync(lifecycle, clock);
  const webhooks = new WebhookIngestor(
    lifecycle,
    { get: async () => undefined },
    async (ref) => {
      await sync.poll(ref);
    },
    clock,
  );
  const installations = new Map<string, Installation[]>();

  function installed(binding: Installation) {
    const prior = installations.get(binding.tenantId) ?? [];
    installations.set(binding.tenantId, [...prior, binding]);
  }

  function primary(tenantId: string, connectorId: string) {
    return installations
      .get(tenantId)
      ?.find(
        (entry) =>
          entry.connectorId === connectorId &&
          entry.mode === 'primary' &&
          lifecycle.get(entry).status !== 'revoked',
      );
  }

  async function identify(request: FastifyRequest, permission: ConnectorPermission) {
    const identity = await resolveIdentity(request);
    if (!identity) throw new ConnectorError('auth_required');
    const { directory } = services();
    const admin = await directory.allows(identity, 'settings.manage');
    const operator = await directory.allows(identity, 'actions.request');
    const read = await directory.allows(identity, 'records.read');
    if (permission === 'connectors:read' ? !read : !admin && !operator)
      throw new ConnectorError('permission_denied');
    return { tenantId: identity.tenantId, actorId: identity.actor.id };
  }

  function crmRecords(tenantId: string) {
    const binding = primary(tenantId, 'hubspot-fixture');
    if (!binding || lifecycle.get(binding).status !== 'active') return [];
    return sync.records(binding).filter(({ presence }) => presence === 'present');
  }

  const records: ConnectedRecords = {
    contacts(tenantId) {
      const rows = crmRecords(tenantId);
      return rows.flatMap(({ id, recordClass, fields }) => {
        if (
          recordClass !== 'contact' ||
          typeof fields.firstname !== 'string' ||
          typeof fields.email !== 'string'
        )
          return [];
        const company = rows.find(
          (row) =>
            row.recordClass === 'company' &&
            typeof row.fields.domain === 'string' &&
            (fields.email as string).endsWith('@' + row.fields.domain),
        );
        return company
          ? [
              {
                id,
                customerId: company.id,
                name: fields.firstname,
                email: fields.email,
                phone: typeof fields.phone === 'string' ? fields.phone : '',
              },
            ]
          : [];
      });
    },
    deals(tenantId) {
      const rows = crmRecords(tenantId);
      // The fictional CRM fixture defines one company and one associated deal.
      const company = rows.find(
        ({ externalId, recordClass }) => recordClass === 'company' && externalId === 'hs-company-1',
      );
      if (!company) return [];
      return rows.flatMap(({ id, externalId, recordClass, fields }) =>
        recordClass === 'deal' &&
        externalId === 'hs-deal-1' &&
        typeof fields.dealname === 'string' &&
        typeof fields.dealstage === 'string' &&
        stages.has(fields.dealstage)
          ? [
              {
                id,
                customerId: company.id,
                title: fields.dealname,
                stage: fields.dealstage as Deal['stage'],
                valueCents: 0,
              },
            ]
          : [],
      );
    },
  };

  type Params = { Params: { id: string } };
  const status = new Map<string, { imported: number; unchanged: number }>();
  const options: ConnectorPluginOptions = {
    lifecycle,
    sync,
    webhooks,
    identify,
    installed,
    registerFixtureUi(app) {
      const manifestFor = (id: string) => {
        const manifest = lifecycle.available().find((item) => item.id === id);
        if (!manifest) throw new ConnectorError('not_found');
        return manifest;
      };
      const bindingFor = (tenantId: string, id: string) => {
        const binding = primary(tenantId, id);
        if (!binding) throw new ConnectorError('not_found');
        return binding;
      };
      app.get('/connectors/ui', async (request) => {
        await identify(request, 'connectors:read');
        return lifecycle.available().map((item) => ({
          id: item.id,
          name: item.edition,
          description: 'Offline fixture for ' + item.capability,
          auth: item.authType === 'oauth2-pkce' ? 'oauth' : 'none',
        }));
      });
      app.post<Params>('/connectors/ui/:id/install', async (request, reply) => {
        const { tenantId } = await identify(request, 'connectors:manage');
        const manifest = manifestFor(request.params.id);
        if (!primary(tenantId, manifest.id)) {
          const accounting = manifest.authType === 'oauth2-pkce';
          const binding = lifecycle.install(
            tenantId,
            manifest.id,
            accounting ? fixtureAccounts.accounting : fixtureAccounts.crm,
          );
          installed(binding);
        }
        const binding = bindingFor(tenantId, manifest.id);
        if (manifest.authType === 'api-key' && lifecycle.get(binding).status === 'installed') {
          await lifecycle.authorizeApiKey(binding, fixtureAccounts.crmKey);
          await lifecycle.verifyAccount(binding);
          await lifecycle.activate(binding);
        }
        return reply.code(204).send();
      });
      app.post<Params>('/connectors/ui/:id/oauth/start', async (request) => {
        const caller = await identify(request, 'connectors:manage');
        const binding = bindingFor(caller.tenantId, request.params.id);
        const { state, code } = fixture.consent(
          await lifecycle.startOAuth({ ...caller, connectionId: binding.connectionId }),
        );
        await lifecycle.completeOAuth(caller, state, code);
        await lifecycle.verifyAccount(binding);
        await lifecycle.activate(binding);
        return { authorizeUrl: '#/connectors/connector/' + encodeURIComponent(request.params.id) };
      });
      app.get<Params>('/connectors/ui/:id/status', async (request) => {
        const { tenantId } = await identify(request, 'connectors:read');
        manifestFor(request.params.id);
        const binding = primary(tenantId, request.params.id);
        if (!binding) return { state: 'available', lastSyncAt: null };
        const current = lifecycle.get(binding).status;
        return {
          state:
            current === 'active' ? 'connected' : current === 'installed' ? 'installed' : 'error',
          lastSyncAt: sync.status(binding).syncedAt,
        };
      });
      app.post<Params>('/connectors/ui/:id/sync', async (request, reply) => {
        const { tenantId } = await identify(request, 'connectors:sync');
        const binding = bindingFor(tenantId, request.params.id);
        const report = await sync.importSnapshot(binding);
        const imported = report.added.length + report.changed.length;
        const unchanged =
          sync.records(binding).filter(({ presence }) => presence === 'present').length - imported;
        status.set(binding.connectionId, { imported, unchanged: Math.max(0, unchanged) });
        return reply.code(204).send();
      });
      app.get<Params>('/connectors/ui/:id/reconciliation', async (request) => {
        const { tenantId } = await identify(request, 'connectors:read');
        const binding = bindingFor(tenantId, request.params.id);
        const report = sync.report(binding);
        if (!report) return null;
        return {
          syncId: report.checkpoint ?? report.checkedAt,
          ...(status.get(binding.connectionId) ?? {
            imported: report.added.length + report.changed.length,
            unchanged: 0,
          }),
          issues: (['missing', 'conflicting'] as const).flatMap((reason) =>
            report[reason].map(({ externalId }) => ({ recordId: externalId, reason })),
          ),
        };
      });
    },
  };
  return { options, records };
}
