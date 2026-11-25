import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeProviders } from '@bs/adapters';
import {
  loadDemoFixtures,
  type CallEnvelope,
  type ToolInputMap,
  type ToolName,
  type ToolRequestMap,
} from '@bs/contracts';
import { FakeGateway } from '@bs/core';

const fixtures = loadDemoFixtures();
const [operator, approver, reader, , isolation] = fixtures.grants;
const [native, byo] = fixtures.llmRoutes;

function envelope(
  key: string,
  grant = operator,
  source: CallEnvelope['source'] = 'rest',
): CallEnvelope {
  return {
    version: 'v1',
    tenantId: grant.tenantId,
    actor: grant.actor,
    source,
    traceId: 'trace-' + key,
    correlationId: 'scenario-1',
    idempotencyKey: key,
  };
}

function request<Tool extends ToolName>(
  tool: Tool,
  input: ToolInputMap[Tool],
  key: string,
  grant = operator,
  source?: CallEnvelope['source'],
): ToolRequestMap[Tool] {
  return { tool, envelope: envelope(key, grant, source), input } as ToolRequestMap[Tool];
}

function output<Output>(result: { state: 'ok'; output: Output } | { state: string }): Output {
  assert.equal(result.state, 'ok', JSON.stringify(result));
  assert.ok('output' in result);
  return result.output;
}

test('reads, fixture chat and audio return the same order; workspace scope is enforced', async () => {
  const gateway = new FakeGateway();
  const rest = output(
    await gateway.call(request('order.read', { orderId: 'ord-001' }, 'lookup', reader)),
  );
  const mcp = output(
    await gateway.call(request('order.read', { orderId: 'ord-001' }, 'mcp', reader, 'mcp')),
  );
  assert.deepEqual(mcp, rest);
  assert.equal(
    output(
      await gateway.call(request('customer.read', { customerId: rest.customerId }, 'customer')),
    ).id,
    'cust-001',
  );
  assert.equal(
    output(await gateway.call(request('invoice.read', { invoiceId: 'inv-001' }, 'invoice'))).status,
    'overdue',
  );
  const forbidden = await gateway.call(
    request('order.read', { orderId: 'ord-isolation' }, 'isolated', reader),
  );
  assert.equal(forbidden.state === 'denied' && forbidden.code, 'not_found');
  assert.equal(
    output(
      await gateway.call(request('order.read', { orderId: 'ord-isolation' }, 'own', isolation)),
    ).id,
    'ord-isolation',
  );
  const fakeIdentity = request('order.read', { orderId: 'ord-001' }, 'fake', isolation);
  fakeIdentity.envelope.tenantId = operator.tenantId;
  const denied = await gateway.call(fakeIdentity);
  assert.equal(denied.state === 'denied' && denied.code, 'forbidden');

  const chat = {
    sessionId: 'chat-1',
    turns: [],
    orderId: rest.id,
    audioFixtureId: null,
    route: native,
  };
  assert.deepEqual(
    output(await gateway.call(request('chat.run', chat, 'chat', operator, 'chat'))).order,
    rest,
  );
  const voice = { ...chat, orderId: null, audioFixtureId: 'audio-order-001' };
  assert.deepEqual(
    output(await gateway.call(request('chat.run', voice, 'voice', operator, 'browser_voice')))
      .order,
    rest,
  );
});

test('an approved purchase request creates one fake PO and records one usage event across a retry', async () => {
  const gateway = new FakeGateway();
  const purchase = output(
    await gateway.call(request('purchase.request.read', { requestId: 'pr-001' }, 'pr')),
  );
  const draft = output(
    await gateway.call(request('purchase.order.draft', { requestId: purchase.id }, 'draft')),
  );
  const input = { draftId: draft.draft.id, approvalId: draft.approval.id };
  assert.equal(
    (await gateway.call(request('purchase.order.approve', input, 'denied'))).state,
    'denied',
  );
  const action = request('purchase.order.approve', input, 'approve', approver);
  const [first, retry] = await Promise.all([gateway.call(action), gateway.call(action)]);
  assert.equal(output(first).status, 'approved');
  assert.deepEqual(first, retry);
  const replay = await gateway.call(request('purchase.order.approve', input, 'replay', approver));
  assert.equal(replay.state === 'denied' && replay.code, 'invalid_approval');
  const conflict = await gateway.call(
    request('purchase.order.approve', { ...input, draftId: 'other' }, 'approve', approver),
  );
  assert.equal(conflict.state === 'denied' && conflict.code, 'idempotency_conflict');
  const audit = gateway
    .audit()
    .find((entry) => entry.tool === 'purchase.order.approve' && entry.state === 'ok');
  assert.ok(audit);
  assert.equal(gateway.usage().filter((event) => event.outcomeId === audit.actionId).length, 1);
  assert.equal(
    output(await gateway.call(request('purchase.order.draft', { requestId: purchase.id }, 'draft')))
      .approval.state,
    'pending',
  );
});

test('approval expires and a disabled or exhausted module rejects requests', async () => {
  let now = fixtures.asOf;
  const local = loadDemoFixtures();
  for (const grant of local.entitlements) {
    if (grant.flag.module === 'insights') grant.flag.enabled = false;
    if (grant.flag.module === 'records') grant.allowance = 1;
  }
  const gateway = new FakeGateway({ fixtures: local, now: () => now });
  const draft = output(
    await gateway.call(request('purchase.order.draft', { requestId: 'pr-001' }, 'draft')),
  );
  now = '2026-11-25T17:00:00Z';
  const stale = await gateway.call(
    request(
      'purchase.order.approve',
      { draftId: draft.draft.id, approvalId: draft.approval.id },
      'stale',
      approver,
    ),
  );
  assert.equal(stale.state === 'denied' && stale.code, 'invalid_approval');
  const disabled = await gateway.call(request('fraud.score', { orderId: 'ord-003' }, 'fraud'));
  assert.equal(disabled.state === 'denied' && disabled.code, 'module_disabled');
  assert.equal(
    (await gateway.call(request('order.read', { orderId: 'ord-001' }, 'first'))).state,
    'ok',
  );
  const capped = await gateway.call(request('order.read', { orderId: 'ord-002' }, 'second'));
  assert.equal(capped.state === 'denied' && capped.code, 'quota_exceeded');
});

test('collections and win-back preview and deliver only fixture messages', async () => {
  const gateway = new FakeGateway();
  const email = output(
    await gateway.call(request('collections.email.draft', { invoiceId: 'inv-001' }, 'draft')),
  );
  assert.equal(email.channel, 'email');
  for (const channel of ['email', 'voice', 'sms'] as const) {
    const preview = output(
      await gateway.call(request('message.preview', { invoiceId: 'inv-001', channel }, channel)),
    );
    const tool = `collections.${channel}.send` as const;
    const input = { previewId: preview.id, approvalId: null };
    const pending = await gateway.call(request(tool, input, 'prepare-' + channel));
    assert.equal(pending.state, 'pending_approval');
    assert.ok(pending.state === 'pending_approval');
    gateway.approveFixture(envelope('sign-' + channel, approver), pending.approval.id);
    const receipt = output(
      await gateway.call(
        request(tool, { ...input, approvalId: pending.approval.id }, 'send-' + channel),
      ),
    );
    assert.equal(receipt.channel, channel);
    assert.equal(receipt.status, 'simulated');
  }
  const suppressed = await gateway.call(
    request('collections.email.draft', { invoiceId: 'inv-004' }, 'suppressed'),
  );
  assert.equal(suppressed.state === 'denied' && suppressed.code, 'suppressed');

  const template = { templateId: 'win-back-v1', approvalId: null } as const;
  const preview = output(
    await gateway.call(
      request('workflow.template.run', { ...template, mode: 'preview' }, 'preview'),
    ),
  );
  assert.deepEqual(
    preview.previews.map((item) => item.customerId),
    ['cust-008', 'cust-009'],
  );
  assert.deepEqual(preview.receipts, []);
  const prepared = await gateway.call(
    request('workflow.template.run', { ...template, mode: 'run' }, 'prepare'),
  );
  assert.ok(prepared.state === 'pending_approval');
  gateway.approveFixture(envelope('sign', approver), prepared.approval.id);
  const run = output(
    await gateway.call(
      request(
        'workflow.template.run',
        { ...template, mode: 'run', approvalId: prepared.approval.id },
        'run',
      ),
    ),
  );
  assert.equal(run.receipts.length, 2);
});

test('an uncertain send holds the approved action on retry without dispatching twice', async () => {
  let attempts = 0;
  const providers = createFakeProviders();
  providers.messages.sms = {
    send() {
      attempts++;
      throw new Error('Simulated transport interruption');
    },
  };
  const gateway = new FakeGateway({ providers });
  const preview = output(
    await gateway.call(
      request('message.preview', { invoiceId: 'inv-001', channel: 'sms' }, 'preview'),
    ),
  );
  const pending = await gateway.call(
    request('collections.sms.send', { previewId: preview.id, approvalId: null }, 'prepare'),
  );
  assert.ok(pending.state === 'pending_approval');
  gateway.approveFixture(envelope('sign', approver), pending.approval.id);
  const input = { previewId: preview.id, approvalId: pending.approval.id };
  const send = request('collections.sms.send', input, 'send');
  const first = await gateway.call(send);
  assert.equal(first.state, 'unknown');
  assert.deepEqual(await gateway.call(send), first);
  assert.equal(
    (await gateway.call(request('collections.sms.send', input, 'resend'))).state,
    'denied',
  );
  assert.equal(attempts, 1);
});

test('insight and completion adapters have deterministic fixture outcomes', async () => {
  const gateway = new FakeGateway();
  const fraud = output(await gateway.call(request('fraud.score', { orderId: 'ord-003' }, 'fraud')));
  assert.ok(fraud.rule.reasons.length > 0);
  assert.equal(fraud.disposition, 'review');
  assert.ok(fraud.model.artifactId);
  const forecast = output(
    await gateway.call(
      request(
        'forecast.run',
        { series: 'sku_demand', skuId: 'sku-001', horizonWeeks: 3 },
        'forecast',
      ),
    ),
  );
  assert.equal(forecast.points.length, 3);
  assert.ok(forecast.points.every((p) => p.lower <= p.estimate && p.estimate <= p.upper));
  const profile = output(
    await gateway.call(request('profile.run', { customerId: 'cust-008' }, 'profile')),
  );
  assert.equal(profile.segment, 'win_back');
  assert.deepEqual(profile.evidenceIds, ['cust-008']);
  for (const route of [native, byo]) {
    const completion = output(
      await gateway.call(
        request(
          'llm.complete',
          { model: 'fixture-model', turns: [], maxOutputTokens: 8, route },
          route.kind,
        ),
      ),
    );
    assert.equal(completion.route.providerId, route.providerId);
  }
});
test('a win-back failure with zero receipts permits a matching retry and protects its key', async () => {
  const providers = createFakeProviders();
  const send = providers.messages.email.send;
  let attempts = 0;
  providers.messages.email.send = (preview, actionId) => {
    attempts++;
    if (attempts === 1) {
      return {
        state: 'failed',
        code: 'provider_error',
        message: 'Fixture retry',
        retryable: true,
      };
    }
    return send(preview, actionId);
  };
  const gateway = new FakeGateway({ providers });
  const input = { templateId: 'win-back-v1', mode: 'run', approvalId: null } as const;
  const pending = await gateway.call(request('workflow.template.run', input, 'prepare-retry'));
  assert.ok(pending.state === 'pending_approval');
  const grant = gateway.approveFixture(envelope('sign-retry', approver), pending.approval.id);
  assert.equal(grant.state, 'approved');
  const run = request(
    'workflow.template.run',
    {
      ...input,
      approvalId: pending.approval.id,
    },
    'run-retry',
  );
  assert.equal((await gateway.call(run)).state, 'failed');
  const changed = await gateway.call({ ...run, input });
  assert.equal(changed.state === 'denied' && changed.code, 'idempotency_conflict');
  const recovered = await gateway.call(run);
  assert.equal(output(recovered).receipts.length, 2);
  assert.deepEqual(await gateway.call(run), recovered);
  assert.equal(attempts, 3);
  assert.equal(gateway.usage().length, 1);
});
