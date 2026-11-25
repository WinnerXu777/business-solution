import { MemoryRecordRepository, PostgresRecordRepository } from '@bs/business';
import {
  loadDemoFixtures,
  type DemoFixtures,
  type ToolCall,
  type ToolResultMap,
} from '@bs/contracts';
import { GovernedGateway, type ToolGateway } from '@bs/core';
import Fastify, { type FastifyRequest } from 'fastify';
import pg from 'pg';
import { createFixtureRouter } from '../../../packages/adapters/src/llm/index.ts';
import { createMessagingAdapters } from '../../../packages/adapters/src/messaging/index.ts';
import { createFixtureScoringAdapter } from '../../../packages/adapters/src/scoring/index.ts';
import { PostgresGovernanceStore } from '../../../packages/core/src/governance/store.ts';
import { registerAutomation } from './automation/index.ts';
import {
  createFixtureIdentityVerifier,
  governanceRoutes,
  type VerifiedIdentity,
} from './governance/index.ts';
import { bearerToken } from './governance/identity.ts';
import { insightTools, registerInsightsRoutes } from './insights/routes.ts';

function fixtureBearerBindings(config: string | undefined, { grants }: DemoFixtures) {
  const bindings = new Map<string, VerifiedIdentity>();
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
    const grant = grants.find((row) => row.tenantId === tenantId && row.actor.id === actorId);
    if (!grant) throw invalid();
    bindings.set(token, { tenantId: grant.tenantId, actor: grant.actor });
  }
  return bindings;
}

export function createApp(env: NodeJS.ProcessEnv = process.env) {
  const fixtures = loadDemoFixtures();
  const verifyIdentity = createFixtureIdentityVerifier(
    fixtureBearerBindings(env.FIXTURE_BEARER_BINDINGS, fixtures),
    fixtures,
  );
  const app = Fastify();
  const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL }) : undefined;
  if (pool) {
    pool.on('error', (err) => app.log.error({ err }, 'Idle Postgres connection failed'));
    app.addHook('onClose', () => pool.end());
  }
  const store = pool ? new PostgresGovernanceStore(pool) : undefined;
  const records = store
    ? new PostgresRecordRepository(store)
    : new MemoryRecordRepository(fixtures);
  const gateway = new GovernedGateway({
    fixtures,
    records,
    store,
    now: store ? () => new Date().toISOString() : undefined,
    providers: {
      llm: createFixtureRouter(),
      messages: createMessagingAdapters({
        enabled: env.BS_MAILPIT === '1',
        host: env.BS_MAILPIT_HOST,
        port: Number(env.BS_MAILPIT_PORT ?? 1025),
      }),
      scoring: createFixtureScoringAdapter(),
    },
  });
  const resolveIdentity = (request: FastifyRequest) => {
    const token = bearerToken(request.headers.authorization);
    return token ? verifyIdentity(token) : undefined;
  };
  const canReview = (identity: VerifiedIdentity) =>
    fixtures.grants.some(
      (grant) =>
        grant.tenantId === identity.tenantId &&
        grant.actor.id === identity.actor.id &&
        grant.actor.kind === identity.actor.kind &&
        grant.role === 'approver',
    );

  app.register(governanceRoutes, {
    gateway,
    verifyIdentity,
    restToolsHandledElsewhere: insightTools,
    canReview,
  });
  registerInsightsRoutes(app, { gateway, resolveIdentity });

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
          const requester = fixtures.grants.find(
            (grant) =>
              grant.tenantId === envelope.tenantId && grant.actor.id === approval?.requestedBy,
          );
          if (requester) {
            return gateway.call({ ...request, envelope: { ...envelope, actor: requester.actor } });
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
        for (const tenant of tenants) await gateway.dispatchOutbox(tenant);
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
