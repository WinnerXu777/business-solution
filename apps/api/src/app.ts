import { MemoryRecordRepository, PostgresRecordRepository } from '@bs/business';
import { loadDemoFixtures, type DemoFixtures } from '@bs/contracts';
import { GovernedGateway } from '@bs/core';
import Fastify from 'fastify';
import pg from 'pg';
import {
  createFixtureIdentityVerifier,
  governanceRoutes,
  type VerifiedIdentity,
} from './governance/index.ts';

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
  const records = pool ? new PostgresRecordRepository(pool) : new MemoryRecordRepository(fixtures);
  app.register(governanceRoutes, {
    gateway: new GovernedGateway({ fixtures, records }),
    verifyIdentity,
  });

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
