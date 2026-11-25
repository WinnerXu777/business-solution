import { createConnection } from 'node:net';
import { MemoryRecordRepository, PostgresRecordRepository } from '@bs/business';
import {
  loadDemoFixtures,
  type DemoFixtures,
  type ToolCall,
  type ToolResultMap,
} from '@bs/contracts';
import { createPlatformServices, fixtureAdmin, GovernedGateway, type ToolGateway } from '@bs/core';
import type { PlatformServices } from '../../../packages/core/src/platform/index.ts';
import Fastify, { type FastifyRequest } from 'fastify';
import pg from 'pg';
import { createFixtureRouter } from '../../../packages/adapters/src/llm/index.ts';
import { createMessagingAdapters } from '../../../packages/adapters/src/messaging/index.ts';
import { sendToMailpit } from '../../../packages/adapters/src/messaging/mailpit.ts';
import { createFixtureScoringAdapter } from '../../../packages/adapters/src/scoring/index.ts';
import { PostgresGovernanceStore } from '../../../packages/core/src/governance/store.ts';
import { registerAutomation } from './automation/index.ts';
import { configureAuth, type HostAuth } from './auth-bootstrap.ts';
import { fixtureConnectors } from './connector-bootstrap.ts';
import { connectorsPlugin, type ConnectorPluginOptions } from './connectors/index.ts';
import { governanceRoutes, type VerifiedIdentity } from './governance/index.ts';
import { bearerToken } from './governance/identity.ts';
import { insightTools, registerInsightsRoutes } from './insights/routes.ts';
import { platformRoutes } from './platform/index.ts';
import {
  createPlatformFixtureIdentityVerifier,
  createPlatformSessionIdentityVerifier,
} from './platform/identity.ts';
import { llmPlugin, type LlmPluginOptions } from './llm/index.ts';
import { platformPostgres } from './platform/postgres.ts';
import { connectPlatformGateway } from './platform-bootstrap.ts';
import { simulatedLlmPrices } from '../../../packages/core/src/governance/billing.ts';
import { readVaultMasterKey } from '../../../packages/core/src/platform/vault.ts';

const fixtureLogins = {
  'fixture-admin': 'actor-admin',
  'fixture-operator': 'actor-operator',
  'fixture-approver': 'actor-approver',
  'fixture-reader': 'actor-reader',
  'fixture-isolation': 'actor-isolation',
};

function fixtureBearerBindings(env: NodeJS.ProcessEnv, { grants }: DemoFixtures) {
  const config = env.FIXTURE_BEARER_BINDINGS;
  const identities = [...grants, fixtureAdmin];
  const bindings = new Map<string, VerifiedIdentity>();
  if (env.BS_FIXTURE_LOGIN === '1') {
    for (const [token, actorId] of Object.entries(fixtureLogins)) {
      const { tenantId, actor } = identities.find((row) => row.actor.id === actorId)!;
      bindings.set(token, { tenantId, actor });
    }
  }
  if (config === undefined) return bindings;

  const invalid = () => new Error('Invalid FIXTURE_BEARER_BINDINGS configuration.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();

  for (const [token, binding] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[^\s,]+$/.test(token) || !binding || typeof binding !== 'object') throw invalid();
    const { tenantId, actorId } = binding as Record<string, unknown>;
    const grant = identities.find((row) => row.tenantId === tenantId && row.actor.id === actorId);
    if (!grant) throw invalid();
    bindings.set(token, { tenantId: grant.tenantId, actor: grant.actor });
  }
  return bindings;
}

interface AppOptions {
  auth?: HostAuth;
  connectors?: ConnectorPluginOptions;
  fixtureConnectors?: boolean;
  llm?: LlmPluginOptions | ((services: PlatformServices, now: () => string) => LlmPluginOptions);
}

export function createApp(env: NodeJS.ProcessEnv = process.env, options: AppOptions = {}) {
  const fixtures = loadDemoFixtures();
  const app = Fastify();
  const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL }) : undefined;
  if (pool) {
    pool.on('error', (err) => app.log.error({ err }, 'Idle Postgres connection failed'));
    app.addHook('onClose', () => pool.end());
  }
  const store = pool ? new PostgresGovernanceStore(pool) : undefined;
  const startedAt = performance.now();
  const now = pool
    ? () => new Date().toISOString()
    : () => new Date(Date.parse(fixtures.asOf) + performance.now() - startedAt).toISOString();
  function resolveIdentity(request: FastifyRequest) {
    const token = bearerToken(request.headers.authorization);
    return token ? verifyIdentity(token) : undefined;
  }
  const connectors = options.fixtureConnectors
    ? fixtureConnectors(() => services, resolveIdentity, now)
    : undefined;
  const records = store
    ? new PostgresRecordRepository(store, connectors?.records)
    : new MemoryRecordRepository(fixtures, connectors?.records);
  function tenantActors(tenantId: string) {
    return services.directory.activeVersion(tenantId) === undefined
      ? []
      : services.directory.members(tenantId).map(({ user }) => user.actor);
  }
  const governed = new GovernedGateway({
    fixtures,
    records,
    store,
    now,
    identity: {
      actors: tenantActors,
      allows: (identity, permission) => services.directory.allows(identity, permission),
    },
    async entitlement(tenantId, module) {
      const entry = (await services.entitlements.listing(tenantId, [])).find(
        ({ moduleId }) => moduleId === module,
      );
      if (entry?.windowStart && entry.windowEnd)
        return {
          tenantId,
          flag: { module, enabled: entry.enabled },
          unit: 'actions',
          allowance: entry.allowance,
          windowStart: entry.windowStart,
          windowEnd: entry.windowEnd,
        };
    },
    resolveLlmBinding: (tenantId) =>
      services.resolveBinding(tenantId, 'llm', {
        operation: 'inference',
        dataClasses: ['synthetic'],
      }),
    billing: () => services.billing,
    onBillingError: () => app.log.error('Governance billing ingestion failed'),
    providers: {
      llm: createFixtureRouter(),
      messages: createMessagingAdapters(
        {
          enabled: env.BS_MAILPIT === '1',
          host: env.BS_MAILPIT_HOST,
          port: Number(env.BS_MAILPIT_PORT ?? 1025),
        },
        env.BS_MAILPIT_HOST === 'mailpit'
          ? (preview, id, options) =>
              sendToMailpit(preview, id, { ...options, host: '127.0.0.1' }, (_host, port) =>
                createConnection({ host: 'mailpit', port }),
              )
          : undefined,
      ),
      scoring: createFixtureScoringAdapter(),
    },
  });
  const services: ReturnType<typeof createPlatformServices> = createPlatformServices({
    fixtures,
    gateway: governed,
    now,
    persistence: pool ? platformPostgres(pool) : undefined,
    fixtureUsageBridge: false,
    billing: { providerPrices: simulatedLlmPrices },
    vaultMasterKey: readVaultMasterKey(env),
  });
  const auth = options.auth && configureAuth(services.directory, options.auth);
  const verifyIdentity = auth
    ? createPlatformSessionIdentityVerifier(auth)
    : createPlatformFixtureIdentityVerifier(
        fixtureBearerBindings(env, fixtures),
        services.directory,
      );
  const { transport: gateway, reports } = connectPlatformGateway(services, governed);
  const canReview = (identity: VerifiedIdentity) =>
    services.directory.allows(identity, 'approvals.decide');

  app.register(async (instance) => {
    instance.addHook('onRequest', (request, _reply, done) => {
      const path = request.url.split('?')[0];
      if (!['/platform/v1/modules', '/platform/v1/audit', '/platform/v1/usage'].includes(path)) {
        done();
        return;
      }
      void Promise.resolve(resolveIdentity(request))
        .then((identity) => identity && governed.reportingSnapshot(identity.tenantId))
        .then((snapshot) => {
          if (snapshot) reports.run(snapshot, done);
          else done();
        }, done);
    });
    await instance.register(platformRoutes, { services, auth, verifyIdentity });
  });

  app.register(governanceRoutes, {
    gateway,
    verifyIdentity,
    restToolsHandledElsewhere: insightTools,
    canReview,
  });
  registerInsightsRoutes(app, { gateway, resolveIdentity });
  const connectorOptions = options.connectors ?? connectors?.options;
  if (connectorOptions) app.register(connectorsPlugin, connectorOptions);
  if (options.llm) {
    const llm = typeof options.llm === 'function' ? options.llm(services, now) : options.llm;
    app.register(llmPlugin, llm);
  }

  const automationGateway: ToolGateway = {
    async call<Request extends ToolCall>(
      request: Request,
    ): Promise<ToolResultMap[Request['tool']]> {
      // The workflow route resumes as the signer. The gateway executes as the
      // original requester after checking the stored grant and designated signer.
      if (request.tool === 'workflow.template.run' && request.input.approvalId) {
        const { envelope, input } = request;
        if (canReview(envelope)) {
          const grants = await gateway.listApprovals(envelope.tenantId);
          const approval = grants.find(
            (grant) =>
              grant.id === input.approvalId &&
              grant.approverId === envelope.actor.id &&
              grant.tool === request.tool &&
              (grant.state === 'approved' || grant.state === 'consumed'),
          );
          const requester = tenantActors(envelope.tenantId).find(
            (actor) => actor.id === approval?.requestedBy,
          );
          if (requester) {
            return gateway.call({ ...request, envelope: { ...envelope, actor: requester } });
          }
        }
      }
      return gateway.call(request);
    },
  };
  app.register(
    async (instance) => {
      const identities = new WeakMap<FastifyRequest, VerifiedIdentity>();
      instance.addHook('onRequest', async (request, reply) => {
        const identity = await resolveIdentity(request);
        if (!identity) {
          return reply
            .header('WWW-Authenticate', 'Bearer')
            .code(401)
            .send({ error: 'unauthorized' });
        }
        identities.set(request, identity);
        reply.header('Cache-Control', 'no-store');
      });
      await registerAutomation(instance, {
        gateway: automationGateway,
        python: env.BS_WORKER_PYTHON,
        identity(request, role) {
          const identity = identities.get(request);
          if (identity && (role === 'requester' || canReview(identity))) return identity;
        },
        async authorizeRuntime(scope, capability) {
          if (
            !services.directory.allows(scope, 'actions.request') &&
            !(canReview(scope) && (capability === 'bot' || capability === 'workflow'))
          ) {
            return false;
          }
          const module = capability === 'bot' ? 'ai' : 'workflows';
          const modules = await services.entitlements.listing(scope.tenantId, []);
          return modules.some((entry) => entry.moduleId === module && entry.enabled);
        },
        pendingApprovals: (tenantId) => gateway.listApprovals(tenantId, 'pending'),
        approvalPreviews: (tenantId, approvalId) => governed.approvalPreviews(tenantId, approvalId),
        sign: (envelope, approvalId) => gateway.signApproval(envelope, approvalId),
      });
    },
    { prefix: '/automation' },
  );

  if (store) {
    const tenants = [...new Set(fixtures.grants.map((grant) => grant.tenantId))];
    let active: Promise<void> | undefined;
    const interval = setInterval(() => {
      active ??= (async () => {
        for (const tenant of tenants) await governed.dispatchOutbox(tenant);
      })()
        .catch((err) => app.log.error({ err }, 'Outbox dispatch failed'))
        .finally(() => {
          active = undefined;
        });
    }, 5_000);
    interval.unref();
    app.addHook('preClose', async () => {
      clearInterval(interval);
      await active;
    });
  }

  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: { status: { const: 'ok' } },
            required: ['status'],
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );
  return app;
}
