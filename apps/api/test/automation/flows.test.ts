import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DeliveryReceipt, MessageChannel, MessagePreview, RunChatResult } from '@bs/contracts';
import { FakeGateway } from '@bs/core';
import { createFakeProviders } from '../../../../packages/adapters/src/fake-providers.ts';
import { createFixtureRouter } from '../../../../packages/adapters/src/llm/index.ts';
import { createMessagingAdapters } from '../../../../packages/adapters/src/messaging/index.ts';
import { createAutomationDemo } from '../../src/automation/demo.ts';

function demo(t: TestContext) {
  const deliveries: MessagePreview[] = [];
  const adapters = createMessagingAdapters();
  const messages = Object.fromEntries(
    Object.entries(adapters).map(([channel, adapter]) => [
      channel,
      {
        send(preview: MessagePreview, actionId: string) {
          deliveries.push(preview);
          return adapter.send(preview, actionId);
        },
      },
    ]),
  ) as typeof adapters;
  const gateway = new FakeGateway({
    providers: { ...createFakeProviders(), llm: createFixtureRouter(), messages },
  });
  const app = createAutomationDemo({ gateway });
  t.after(() => app.close());
  async function call(path: string, body?: object, key?: string) {
    const response = await app.inject({
      url: '/automation' + path,
      method: body ? 'POST' : 'GET',
      payload: body,
      headers: key ? { 'idempotency-key': key } : {},
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  return { call, gateway, deliveries };
}

test('chat and fixture voice agree with order lookup and redact deterministic route audit', async (t) => {
  const { call, gateway } = demo(t);
  const native = {
    sessionId: 'session-1',
    prompt: 'Can you check order ord-001?',
    route: 'native',
  };
  const order = await call('/orders/ord-001');
  const chat: RunChatResult = await call('/chat', native, 'native-read');
  const byo = { ...native, route: 'byo' };
  const alternate: RunChatResult = await call('/chat', byo, 'byo-read');
  const voice = await call('/voice', {
    sessionId: 'session-1',
    fixtureId: 'audio-order-001',
    route: 'byo',
  });
  assert.equal(voice.transcript, native.prompt);
  assert.equal(chat.state, 'ok');
  assert.deepEqual(voice.result, chat);
  assert.deepEqual(alternate, chat);
  assert.deepEqual(chat.output.order, order.output);
  const usage = gateway.usage().length;
  assert.deepEqual(await call('/chat', native, 'native-read'), chat);
  assert.equal(gateway.usage().length, usage);
  assert.equal((await call('/chat', byo, 'native-read')).code, 'idempotency_conflict');
  const audit = await call('/llm/audit');
  assert.deepEqual(
    audit.map((entry: { providerId: string }) => entry.providerId),
    ['fixture-native', 'fixture-byo'],
  );
  assert.equal(audit[1].previousProviderId, 'fixture-native');
  assert.doesNotMatch(JSON.stringify(audit), /ord-001|check order/);
  assert.deepEqual(await call('/orders/ord-isolation'), await call('/orders/ord-missing'));
  assert.deepEqual(
    await call('/chat', { ...native, prompt: 'Check ord-isolation' }),
    await call('/chat', { ...native, prompt: 'Check ord-missing' }),
  );
});

test('direct and interrupted purchase drafts use the shared approver and cached outcome', async (t) => {
  const { call, gateway } = demo(t);
  const pending = await call(
    '/chat',
    { sessionId: 'session-1', prompt: 'Draft PO for pr-001', route: 'native' },
    'draft-chat',
  );
  assert.equal(pending.state, 'pending_approval');
  const draft = await call('/purchase-orders/draft', { requestId: 'pr-001' });
  assert.equal(draft.output.draft.vendorId, 'vendor-002');
  const approvalId = pending.approval.id;
  assert.equal(draft.output.approval.id, approvalId);
  assert.equal((await call('/approvals')).length, 1);
  const [result, retry] = await Promise.all([
    call('/approvals/approve', { approvalId }, 'approve-1'),
    call('/approvals/approve', { approvalId }, 'approve-2'),
  ]);
  assert.equal(result.output.status, 'approved');
  assert.deepEqual(retry, result);
  assert.equal(
    gateway.audit().filter((entry) => entry.tool === 'purchase.order.approve').length,
    1,
  );
  assert.equal(
    gateway.audit().find((entry) => entry.tool === 'purchase.order.approve')?.actor.id,
    'actor-approver',
  );
});

test('collection previews and chat requests have zero effects until approved for every channel', async (t) => {
  const { call, deliveries } = demo(t);
  for (const channel of ['email', 'voice', 'sms'] satisfies MessageChannel[]) {
    const preview = await call('/collections/preview', { invoiceId: 'inv-001', channel });
    assert.equal(preview.output.channel, channel);
    const result =
      channel === 'sms'
        ? await call('/chat', {
            sessionId: 'session-1',
            prompt: 'Draft SMS for inv-001',
            route: 'byo',
          })
        : await call('/collections/request', { invoiceId: 'inv-001', channel });
    assert.equal(result.state, 'pending_approval');
  }
  assert.equal(deliveries.length, 0);
  assert.equal(
    (await call('/collections/preview', { invoiceId: 'inv-003', channel: 'email' })).code,
    'suppressed',
  );
  assert.equal(
    (await call('/collections/request', { invoiceId: 'inv-004', channel: 'email' })).code,
    'suppressed',
  );
  for (const item of await call('/approvals')) {
    const action = { approvalId: item.approval.id };
    const sent = await call('/approvals/approve', action);
    assert.equal(sent.output.status, 'simulated');
    assert.deepEqual(await call('/approvals/approve', action), sent);
  }
  assert.deepEqual(
    deliveries.map(({ channel }) => channel),
    ['email', 'voice', 'sms'],
  );
});

test('win-back previews exclude suppression and only approved runs create delivery receipts', async (t) => {
  const { call, deliveries } = demo(t);
  const path = '/workflows/win-back-v1';
  const preview = await call(path, { mode: 'preview' }, 'preview-1');
  assert.deepEqual(
    preview.output.previews.map((message: MessagePreview) => message.customerId),
    ['cust-008', 'cust-009'],
  );
  assert.deepEqual(preview.output.receipts, []);
  const request = await call(path, { mode: 'run' });
  assert.equal(request.state, 'pending_approval');
  assert.equal(deliveries.length, 0);
  const action = { approvalId: request.approval.id };
  const approved = await call('/approvals/approve', action);
  assert.deepEqual(await call('/approvals/approve', action), approved);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(
    approved.output.receipts.map(({ status }: DeliveryReceipt) => status),
    ['simulated', 'simulated'],
  );
  const history = await call('/workflows/history');
  assert.equal(history[0].id, approved.output.runId);
  assert.equal(history[0].receipts.length, 2);
  assert.equal(history[1].status, 'previewed');
});
