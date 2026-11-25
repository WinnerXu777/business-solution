import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import test from 'node:test';
import {
  loadDemoFixtures,
  type ActorGrant,
  type CallEnvelope,
  type ScoreFraudOutput,
  type RunForecastOutput,
  type RunProfileOutput,
} from '@bs/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { createFakeProviders } from '../../../../packages/adapters/src/fake-providers.ts';
import {
  createWorkerScoringAdapter,
  type ScoringAdapter,
} from '../../../../packages/adapters/src/scoring/index.ts';
import { createFixtureInsightsGateway } from '../../src/insights/fixture-gateway.ts';
import { registerInsightsRoutes } from '../../src/insights/routes.ts';

const fixtures = loadDemoFixtures();
const [operator, , reader, , foreign] = fixtures.grants;
const sales = { series: 'weekly_sales', skuId: null, horizonWeeks: 3 } as const;
const skuDemand = (skuId: string) => ({ series: 'sku_demand', skuId, horizonWeeks: 3 });

function buildApp(gateway: ReturnType<typeof createFixtureInsightsGateway>) {
  const app = Fastify();
  const identities = new Map([
    ['Bearer fixture-operator', operator],
    ['Bearer fixture-foreign', foreign],
    ['Bearer fixture-reader', reader],
  ]);
  registerInsightsRoutes(app, {
    gateway,
    resolveIdentity: (request) => identities.get(request.headers.authorization ?? ''),
  });
  return app;
}

function call(
  app: FastifyInstance,
  tool: string,
  input: object,
  options: { claim?: ActorGrant; token?: string; key?: string; pathTool?: string } = {},
) {
  const {
    claim = operator,
    token = 'fixture-operator',
    key = randomUUID(),
    pathTool = tool,
  } = options;
  const envelope: CallEnvelope = {
    version: 'v1',
    tenantId: claim.tenantId,
    actor: claim.actor,
    source: 'worker',
    traceId: 'trace-' + key,
    correlationId: 'insights-test',
    idempotencyKey: key,
  };
  return app.inject({
    method: 'POST',
    url: '/v1/tools/' + pathTool,
    headers: { authorization: 'Bearer ' + token },
    payload: { tool, envelope, input },
  });
}

test('worker-backed routes deliver all insights with zero external model or network calls', async (t) => {
  const providers = createFakeProviders();
  const unexpected = () => {
    throw new Error('External call attempted by insights.');
  };
  const llm = t.mock.method(providers.llm, 'complete', unexpected);
  const fetch = t.mock.method(globalThis, 'fetch', unexpected);
  const connect = t.mock.method(Socket.prototype, 'connect', unexpected);
  const gateway = createFixtureInsightsGateway(createWorkerScoringAdapter(), providers);
  const app = buildApp(gateway);
  t.after(() => app.close());

  const expectedReasons = [
    ['rush_request', 'unusual_order_value'],
    ['unusual_order_value', 'delivery_address_changed'],
  ];
  for (const [index, orderId] of ['ord-003', 'ord-004'].entries()) {
    const response = await call(app, 'fraud.score', { orderId });
    assert.equal(response.statusCode, 200);
    const result = response.json<{ state: string; output: ScoreFraudOutput }>();
    assert.equal(result.state, 'ok');
    assert.equal(result.output.orderId, orderId);
    assert.equal(result.output.disposition, 'review');
    assert.deepEqual(result.output.rule.reasons, expectedReasons[index]);
    assert.ok(result.output.rule.score >= 0.5 && result.output.rule.score <= 1);
    assert.ok(result.output.model.score > 0 && result.output.model.score < 1);
    assert.match(result.output.model.artifactId, /^synthetic-fraud-logistic-/);
  }

  const prediction = await call(app, 'forecast.run', sales);
  const result = prediction.json<{ state: string; output: RunForecastOutput }>();
  assert.equal(result.state, 'ok');
  assert.equal(result.output.status, 'fixture');
  assert.equal(result.output.unit, 'cents');
  assert.equal(result.output.points.length, 3);
  for (const { lower, estimate, upper } of result.output.points) {
    assert.ok(0 <= lower && lower < estimate && estimate < upper);
  }

  const sparse = await call(app, 'forecast.run', skuDemand('sku-002'));
  assert.deepEqual(sparse.json(), {
    state: 'ok',
    output: {
      status: 'insufficient_history',
      unit: 'items',
      artifactId: result.output.artifactId,
      points: [],
    },
  });

  const profile = await call(app, 'profile.run', { customerId: 'cust-008' });
  const reviewed = profile.json<{ state: string; output: RunProfileOutput }>();
  assert.equal(reviewed.state, 'ok');
  assert.equal(reviewed.output.customerId, 'cust-008');
  assert.equal(reviewed.output.segment, 'win_back');
  assert.equal(reviewed.output.reviewRequired, true);
  assert.deepEqual(reviewed.output.evidenceIds, ['cust-008', 'ord-008']);
  assert.equal(gateway.usage().length, 5);
  assert.ok(gateway.audit().every((entry) => entry.source === 'rest'));
  assert.equal(llm.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(connect.mock.callCount(), 0);
});

test('mismatching identity claims and foreign records cannot reach a scoring adapter', async (t) => {
  const score = t.mock.fn(() => {
    throw new Error('Unauthorized record reached scoring.');
  });
  const scoring: ScoringAdapter = { fraud: score, forecast: score, profile: score };
  const gateway = createFixtureInsightsGateway(scoring);
  const app = buildApp(gateway);
  t.after(() => app.close());
  const forbidden = { state: 'denied', code: 'forbidden', message: 'forbidden' };
  const notFound = { state: 'denied', code: 'not_found', message: 'not found' };

  const unsigned = await call(app, 'fraud.score', { orderId: 'ord-003' }, { token: 'invalid' });
  assert.equal(unsigned.statusCode, 401);
  const forged = await call(app, 'fraud.score', { orderId: 'ord-isolation' }, { claim: foreign });
  assert.deepEqual(forged.json(), forbidden);
  const forgedActor = await call(app, 'fraud.score', { orderId: 'ord-003' }, { claim: reader });
  assert.deepEqual(forgedActor.json(), forbidden);
  const unauthorizedRole = await call(
    app,
    'fraud.score',
    { orderId: 'ord-003' },
    { claim: reader, token: 'fixture-reader' },
  );
  assert.deepEqual(unauthorizedRole.json(), forbidden);

  for (const orderId of ['ord-isolation', 'ord-missing']) {
    assert.deepEqual((await call(app, 'fraud.score', { orderId })).json(), notFound);
  }
  assert.deepEqual(
    (await call(app, 'profile.run', { customerId: 'cust-isolation' })).json(),
    notFound,
  );
  assert.deepEqual((await call(app, 'forecast.run', skuDemand('sku-isolation'))).json(), notFound);

  const wrongTool = await call(
    app,
    'fraud.score',
    { orderId: 'ord-003' },
    { pathTool: 'profile.run' },
  );
  assert.equal(wrongTool.statusCode, 400);
  const wrongHorizon = await call(app, 'forecast.run', { ...sales, horizonWeeks: 13 });
  assert.equal(wrongHorizon.statusCode, 400);
  assert.equal(score.mock.callCount(), 0);
  assert.equal(gateway.usage().length, 0);
});

test('concurrent weekly sales calls and retries preserve workspace scope', async (t) => {
  const gateway = createFixtureInsightsGateway();
  const app = buildApp(gateway);
  t.after(() => app.close());
  const key = 'sales';
  const [own, other, retry] = await Promise.all([
    call(app, 'forecast.run', sales, { key }),
    call(app, 'forecast.run', sales, { claim: foreign, token: 'fixture-foreign', key }),
    call(app, 'forecast.run', sales, { key }),
  ]);
  assert.equal(own.json().output.points.length, 3);
  assert.equal(other.json().output.status, 'insufficient_history');
  assert.deepEqual(other.json().output.points, []);
  assert.deepEqual(retry.json(), own.json());
  assert.equal(gateway.usage().length, 2);
});
