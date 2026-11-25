import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  loadDemoFixtures,
  type CallEnvelope,
  type ApprovePurchaseOrderResult,
  type DraftPurchaseOrderResult,
  type MessagePreview,
  type Order,
  type RunChatResult,
  type RunForecastResult,
  type RunProfileResult,
  type RunWorkflowTemplateResult,
  type ScoreFraudResult,
  type SendEmailResult,
  type UsageCounterEvent,
} from '@bs/contracts';
import { createApp } from '../../apps/api/src/app.ts';
import { verifyAuditExport } from '../../packages/core/src/governance/audit.ts';
import type { AuditLink } from '../../packages/core/src/governance/store.ts';

test('the real fixture app runs the milestone 1 walkthrough without live providers', async (t) => {
  const fixtures = loadDemoFixtures();
  const [operator, approver, reader, , foreign] = fixtures.grants;
  const app = createApp({
    FIXTURE_BEARER_BINDINGS: JSON.stringify(
      Object.fromEntries(
        [operator, approver, reader, foreign].map(({ tenantId, actor }) => [
          actor.id,
          { tenantId, actorId: actor.id },
        ]),
      ),
    ),
  });
  t.after(() => app.close());

  const inject = (url: string, payload?: object, grant = operator, key: string = randomUUID()) =>
    app.inject({
      url,
      method: payload ? 'POST' : 'GET',
      payload,
      headers: {
        authorization: 'Bearer ' + grant.actor.id,
        accept: 'application/json',
        'idempotency-key': key,
      },
    });
  async function json<Result>(url: string, payload?: object, grant = operator, key?: string) {
    const response = await inject(url, payload, grant, key);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Result>();
  }
  function rest<Result>(tool: string, input: object, grant = operator) {
    const key = randomUUID();
    const { tenantId, actor } = grant;
    const envelope: CallEnvelope = {
      tenantId,
      actor,
      version: 'v1',
      source: 'portal',
      traceId: key,
      correlationId: 'milestone-1',
      idempotencyKey: key,
    };
    return json<Result>('/v1/tools/' + tool, { tool, envelope, input }, grant);
  }
  const automation = <Result>(path: string, body?: object, grant = operator, key?: string) =>
    json<Result>('/automation' + path, body, grant, key);
  const usage = () => json<UsageCounterEvent[]>('/v1/governance/usage', undefined, approver);

  assert.equal((await app.inject('/automation/orders/ord-001')).statusCode, 401);
  const order = await rest<{ state: 'ok'; output: Order }>(
    'order.read',
    { orderId: 'ord-001' },
    reader,
  );
  assert.equal(order.output.id, 'ord-001');
  const rpc = await json<{ result: { structuredContent: unknown } }>(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'order.read', arguments: { orderId: 'ord-001' } },
    },
    reader,
  );
  assert.deepEqual(rpc.result.structuredContent, order);
  assert.deepEqual(
    await rest('order.read', { orderId: 'ord-isolation' }, reader),
    await rest('order.read', { orderId: 'ord-missing' }, reader),
  );
  const native = {
    sessionId: 'walkthrough',
    prompt: 'Can you check order ord-001?',
    route: 'native',
  };
  const chat = await automation<RunChatResult>('/chat', native, operator, 'native');
  assert.equal(chat.state, 'ok');
  assert.deepEqual(chat.output.order, order.output);
  const voice = await automation<{ transcript: string; result: RunChatResult }>('/voice', {
    sessionId: native.sessionId,
    fixtureId: 'audio-order-001',
    route: 'native',
  });
  assert.equal(voice.transcript, native.prompt);
  assert.deepEqual(voice.result, chat);

  const purchase = await automation<DraftPurchaseOrderResult>('/purchase-orders/draft', {
    requestId: 'pr-001',
  });
  assert.equal(purchase.state, 'ok');
  assert.equal(purchase.output.draft.vendorId, 'vendor-002');
  assert.equal(purchase.output.draft.lines[0].skuId, 'sku-001');
  const poApproval = { approvalId: purchase.output.approval.id };
  assert.equal((await inject('/automation/approvals/approve', poApproval)).statusCode, 403);
  const approve = <Result>(body: { approvalId: string }, key?: string) =>
    automation<Result>('/approvals/approve', body, approver, key);
  const po = await approve<ApprovePurchaseOrderResult>(poApproval, 'approve-po');
  assert.equal(po.state, 'ok');
  assert.equal(po.output.status, 'approved');
  const afterPurchase = await usage();
  assert.deepEqual(await approve(poApproval, 'retry-po'), po);
  assert.deepEqual(await usage(), afterPurchase);

  for (const channel of ['email', 'voice', 'sms']) {
    const preview = await automation<{ state: string; output: MessagePreview }>(
      '/collections/preview',
      {
        invoiceId: 'inv-001',
        channel,
      },
    );
    assert.equal(preview.state, 'ok');
    assert.equal(preview.output.channel, channel);
  }
  for (const invoiceId of ['inv-003', 'inv-004']) {
    const blocked = await automation<{ code: string }>('/collections/preview', {
      invoiceId,
      channel: 'email',
    });
    assert.equal(blocked.code, 'suppressed');
  }
  const pendingEmail = await automation<SendEmailResult>('/collections/request', {
    channel: 'email',
    invoiceId: 'inv-001',
  });
  assert.equal(pendingEmail.state, 'pending_approval');
  const email = await approve<SendEmailResult>({
    approvalId: pendingEmail.approval.id,
  });
  assert.equal(email.state, 'ok');
  assert.equal(email.output.status, 'simulated');

  const workflow = (mode: 'preview' | 'run') =>
    automation<RunWorkflowTemplateResult>('/workflows/win-back-v1', { mode });
  const preview = await workflow('preview');
  assert.equal(preview.state, 'ok');
  assert.deepEqual(
    preview.output.previews.map(({ customerId }) => customerId),
    ['cust-008', 'cust-009'],
  );
  assert.deepEqual(preview.output.receipts, []);
  const pending = await workflow('run');
  assert.equal(pending.state, 'pending_approval');
  const history = await automation<Array<{ receipts: unknown[] }>>('/workflows/history');
  assert.equal(history.length, 2);
  assert.ok(history.every(({ receipts }) => receipts.length === 0));
  const beforeWinBack = await inject('/v1/governance/audit', undefined, approver);
  assert.ok(
    !beforeWinBack.body.split('\n').some((line) => {
      if (!line) return false;
      const entry: AuditLink = JSON.parse(line);
      return entry.tool === 'workflow.template.run' && entry.source === 'worker';
    }),
  );
  const run = await approve<RunWorkflowTemplateResult>({ approvalId: pending.approval.id });
  assert.equal(run.state, 'ok');
  assert.deepEqual(
    run.output.receipts.map(({ status }) => status),
    ['simulated', 'simulated'],
  );

  for (const orderId of ['ord-003', 'ord-004']) {
    const score = await rest<ScoreFraudResult>('fraud.score', { orderId });
    assert.equal(score.state, 'ok');
    assert.equal(score.output.orderId, orderId);
    assert.ok(score.output.rule.reasons.length && score.output.model.score > 0);
  }
  const forecast = await rest<RunForecastResult>('forecast.run', {
    series: 'sku_demand',
    skuId: 'sku-001',
    horizonWeeks: 3,
  });
  assert.equal(forecast.state, 'ok');
  assert.equal(forecast.output.points.length, 3);
  assert.ok(
    forecast.output.points.every(
      ({ lower, estimate, upper }) => lower < estimate && estimate < upper,
    ),
  );
  const sales = { series: 'weekly_sales', skuId: 'sku-001', horizonWeeks: 3 };
  assert.equal((await rest<RunForecastResult>('forecast.run', sales)).state, 'ok');
  assert.deepEqual(
    await rest('forecast.run', { ...sales, skuId: 'sku-isolation' }),
    await rest('forecast.run', { ...sales, skuId: 'sku-missing' }),
  );
  const profile = await rest<RunProfileResult>('profile.run', { customerId: 'cust-008' });
  assert.equal(profile.state, 'ok');
  assert.equal(profile.output.reviewRequired, true);
  assert.deepEqual(profile.output.evidenceIds, ['cust-008', 'ord-008']);

  const byo = { ...native, route: 'byo' };
  const switched = await automation<RunChatResult>('/chat', byo, operator, 'byo');
  assert.deepEqual(switched, chat);
  const afterSwitch = await usage();
  assert.deepEqual(await automation('/chat', byo, operator, 'byo'), switched);
  assert.deepEqual(await usage(), afterSwitch);
  const routeAudit = await automation<Array<{ providerId: string }>>('/llm/audit');
  assert.deepEqual(
    routeAudit.map(({ providerId }) => providerId),
    ['fixture-native', 'fixture-byo'],
  );
  assert.doesNotMatch(JSON.stringify(routeAudit), /ord-001|check order/);
  const audit = await inject('/v1/governance/audit', undefined, approver);
  assert.equal(audit.statusCode, 200);
  assert.match(audit.headers['content-type'] ?? '', /application\/x-ndjson/);
  assert.equal(verifyAuditExport(audit.body).valid, true);
  assert.doesNotMatch(audit.body, /\.example|inv-001|check order|materialHash/);
  const entries: AuditLink[] = audit.body
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const source of ['rest', 'mcp', 'chat', 'browser_voice']) {
    assert.ok(entries.some((entry) => entry.source === source && entry.tool === 'order.read'));
  }
  const purchaseDecision = entries.find(
    (entry) => entry.tool === 'purchase.order.approve' && entry.state === 'ok',
  );
  assert.ok(purchaseDecision);
  assert.equal(
    afterSwitch.filter((event) => event.outcomeId === purchaseDecision.actionId).length,
    1,
  );
  assert.equal((await inject('/v1/governance/audit', undefined, reader)).statusCode, 403);
});
