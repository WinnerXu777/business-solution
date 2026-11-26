import { randomBytes, randomUUID } from 'node:crypto';
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

import { ConsoleSpanExporter, Tracer } from '../../../packages/core/src/observability/index.ts';
import { installOps, instrumentGatewayCall } from './ops/index.ts';
import { channelsPlugin, type ChannelsOptions } from './channels/index.ts';
import { botsPlugin } from './bots/index.ts';
import { createFixtureBotsBackend } from './bots/fixture.ts';
import { demoPrivacy, fixtureChannelBootstrap } from './fixture-bootstrap.ts';
import { workflowRoutes } from './workflows/index.ts';
import { createWorkflowEffects, nativeDrafts } from './workflows/effects.ts';
import { platformLlm } from './llm-bootstrap.ts';
import { browserLlm, consoleLlm, registerConsoleRoutes } from './console-bootstrap.ts';
import { installCookieSessions } from './session-bootstrap.ts';

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
  services?: PlatformServices;
  platform?: Pick<NonNullable<Parameters<typeof createPlatformServices>[0]>, 'privacy' | 'webhookTransport'>;
  channels?: ChannelsOptions;
  fixturePlugins?: boolean;
  eventPollMs?: number;
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
  if (options.auth) installCookieSessions(app);
  const channelFixture = options.fixturePlugins ? fixtureChannelBootstrap(env, now) : undefined;
  const connectors = options.fixtureConnectors
    ? fixtureConnectors(() => services, resolveIdentity, now)
    : undefined;
  const records = store
    ? new PostgresRecordRepository(store, connectors?.records)
    : new MemoryRecordRepository(fixtures, connectors?.records);
  async function tenantActors(tenantId: string) {
    return (await services.directory.activeVersion(tenantId)) === undefined
      ? []
      : (await services.directory.members(tenantId)).map(({ user }) => user.actor);
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
    async guardContact(preview, purpose, attemptId) {
      const { tenantId, customerId: contactId, channel, recipient } = preview;
      const decision = await services.contacts.canContact(tenantId, contactId, channel, purpose);
      if (!decision.allow) return false;
      return (await services.contacts.reserveContact(
        tenantId, { contactId, channel, purpose }, attemptId, recipient,
      )).allow;
    },
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
  const services: ReturnType<typeof createPlatformServices> = options.services ?? createPlatformServices({
    fixtures,
    gateway: governed,
    now,
    persistence: pool ? platformPostgres(pool) : undefined,
    fixtureUsageBridge: false,
    billing: { providerPrices: simulatedLlmPrices },
    vaultMasterKey: readVaultMasterKey(env) ?? (!pool && options.fixturePlugins ? randomBytes(32) : undefined),
    ...(options.fixturePlugins && {
      privacy: demoPrivacy(fixtures),
      webhookTransport: async () => ({ status: 204 }),
    }),
    ...options.platform,
  });
  const auth = options.auth && configureAuth(app, services.directory, fixtures.grants, options.auth);
  const verifyIdentity = auth
    ? createPlatformSessionIdentityVerifier(auth)
    : createPlatformFixtureIdentityVerifier(
        fixtureBearerBindings(env, fixtures),
        services.directory,
      );
  const { transport: gateway, reports } = connectPlatformGateway(services, governed);
  const canReview = (identity: VerifiedIdentity) =>
    services.directory.allows(identity, 'approvals.decide');

  const tracer = new Tracer(env.BS_TRACE_CONSOLE === '1' ? new ConsoleSpanExporter() : undefined);
  gateway.call = instrumentGatewayCall(tracer, gateway.call.bind(gateway));
  const probePool = pool && new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 750,
    query_timeout: 750,
    statement_timeout: 750,
  });
  if (probePool) {
    probePool.on('error', () => app.log.warn('Readiness connection failed'));
    app.addHook('onClose', () => probePool.end());
  }
  installOps(app, {
    tracer,
    checks: {
      database: async () => {
        if (probePool) await probePool.query('SELECT 1');
        return true;
      },
      queue: async () => {
        if (!probePool) return true;
        const { rows } = await probePool.query<{ ready: boolean }>(
          "SELECT to_regclass('governance.outbox') IS NOT NULL AS ready",
        );
        return rows[0]?.ready === true;
      },
      providers: async () => {
        if (env.BS_MAILPIT !== '1') return true;
        return new Promise<boolean>((resolve) => {
          const socket = createConnection({
            host: env.BS_MAILPIT_HOST ?? '127.0.0.1',
            port: Number(env.BS_MAILPIT_PORT ?? 1025),
          });
          function finish(ready: boolean) {
            socket.destroy();
            resolve(ready);
          }
          socket.setTimeout(700, () => finish(false));
          socket.once('error', () => finish(false));
          socket.once('data', (data) => finish(data.toString().startsWith('220')));
        });
      },
    },
    authorize: async (request) => {
      const identity = await resolveIdentity(request);
      return !!identity &&
        identity.tenantId === fixtureAdmin.tenantId &&
        (await services.directory.resolve(identity))?.role === 'admin';
    },
  });

  const llmOption = options.llm ?? (channelFixture && platformLlm);
  const llm = typeof llmOption === 'function' ? llmOption(services, now) : llmOption;
  if (llm) {
    const api = channelFixture ? channelFixture.llm(llm) : llm;
    app.register(llmPlugin, consoleLlm(app, browserLlm(app, services, api, resolveIdentity)));
  }
  registerConsoleRoutes(app, services, resolveIdentity, auth || undefined);

  if (!options.services && env.BS_FIXTURE_LOGIN === '1') {
    app.addHook('onReady', async () => {
      const tenantId = fixtureAdmin.tenantId;
      const known = await services.contacts.listConsents(tenantId);
      const demos = [
        ['cust-002', 'collections', 'email'],
        ['cust-002', 'collections', 'sms'],
        ['cust-002', 'collections', 'voice'],
        ['cust-008', 'marketing', 'email'],
        ['cust-009', 'marketing', 'email'],
      ] as const;
      for (const [contactId, purpose, channel] of demos) {
        if (known.some((row) => row.contactId === contactId && row.channel === channel && row.purpose === purpose)) continue;
        const id = randomUUID();
        await services.contacts.grant({
          ...fixtureAdmin, source: 'worker', traceId: id, correlationId: id,
        }, { contactId, purpose, channel, basis: 'express', source: 'fixture', evidenceRef: 'fixture-demo' });
      }
    });
  }

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
  const channels = options.channels ?? channelFixture?.channels(app, services, verifyIdentity);
  if (channels) app.register(channelsPlugin, channels);

  if (options.fixturePlugins) {
    app.register(botsPlugin, {
      backend: createFixtureBotsBackend(env.BS_WORKER_PYTHON),
      async resolveIdentity(request) {
        const identity = await resolveIdentity(request);
        const role = identity && (await services.directory.resolve(identity))?.role;
        if (identity && (role === 'admin' || role === 'operator' || role === 'approver' || role === 'reader')) {
          return { ...identity, role };
        }
      },
    });
    if (channelFixture) app.register(workflowRoutes, {
      async identify(request) {
        const identity = await resolveIdentity(request);
        const member = identity && (await services.directory.resolve(identity));
        if (identity && member) return { ...identity, roles: [member.role] };
      },
      async authorize(scope, capability) {
        if (capability === 'decide') return canReview(scope);
        if (capability === 'read') return (await services.directory.resolve(scope)) !== undefined;
        return services.directory.allows(scope, 'actions.request');
      },
      relay: createWorkflowEffects({
        gateway,
        sign: (scope, id) => gateway.signApproval(scope, id),
        draft: nativeDrafts(app, (scope) => channelFixture.key(scope.tenantId)),
        authorize: ({ scope }) => services.directory.allows(scope, 'actions.request'),
      }),
      python: env.BS_WORKER_PYTHON,
      now: () => Date.parse(now()),
    });
  }

  const automationGateway: ToolGateway = {
    async call<Request extends ToolCall>(
      request: Request,
    ): Promise<ToolResultMap[Request['tool']]> {
      // The workflow route resumes as the signer. The gateway executes as the
      // original requester after checking the stored grant and designated signer.
      if (request.tool === 'workflow.template.run' && request.input.approvalId) {
        const { envelope, input } = request;
        if (await canReview(envelope)) {
          const grants = await gateway.listApprovals(envelope.tenantId);
          const approval = grants.find(
            (grant) =>
              grant.id === input.approvalId &&
              grant.approverId === envelope.actor.id &&
              grant.tool === request.tool &&
              (grant.state === 'approved' || grant.state === 'consumed'),
          );
          const requester = (await tenantActors(envelope.tenantId)).find(
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
      const identities = new WeakMap<FastifyRequest, { identity: VerifiedIdentity; review: boolean }>();
      instance.addHook('onRequest', async (request, reply) => {
        const identity = await resolveIdentity(request);
        if (!identity) {
          return reply
            .header('WWW-Authenticate', 'Bearer')
            .code(401)
            .send({ error: 'unauthorized' });
        }
        identities.set(request, { identity, review: await canReview(identity) });
        reply.header('Cache-Control', 'no-store');
      });
      await registerAutomation(instance, {
        gateway: automationGateway,
        python: env.BS_WORKER_PYTHON,
        identity(request, role) {
          const verified = identities.get(request);
          if (verified && (role === 'requester' || verified.review)) return verified.identity;
        },
        async authorizeRuntime(scope, capability) {
          if (
            !(await services.directory.allows(scope, 'actions.request')) &&
            !((await canReview(scope)) && (capability === 'bot' || capability === 'workflow'))
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

  {
    const tenants = [...new Set(fixtures.grants.map((grant) => grant.tenantId))];
    let active: Promise<void> | undefined;
    const interval = setInterval(() => {
      active ??= (async () => {
        for (const tenant of tenants) {
          if (store) await governed.dispatchOutbox(tenant);
          await governed.publishEvents(tenant, (event) => services.events.publishOnce(tenant, event, []));
          await services.events.deliverDue(tenant);
        }
      })()
        .catch((err) => app.log.error({ err }, 'Outbox dispatch failed'))
        .finally(() => {
          active = undefined;
        });
    }, options.eventPollMs ?? 5_000);
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
