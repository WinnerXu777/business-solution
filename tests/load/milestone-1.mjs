import { randomUUID } from 'node:crypto';

const fixture = {
  tenantId: 'tenant-rivetquay',
};
const orderPrompt = 'Can you check order ord-001?';

function request(path, body, role = 'operator', key = randomUUID()) {
  return {
    path,
    init: {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer fixture-' + role,
        'idempotency-key': key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  };
}

function rest(tool, input, role = 'operator') {
  const key = randomUUID();
  return request(
    '/v1/tools/' + tool,
    {
      tool,
      input,
      envelope: {
        ...fixture,
        actor: { id: 'actor-' + role, kind: 'person' },
        version: 'v1',
        source: 'portal',
        traceId: key,
        correlationId: key,
        idempotencyKey: key,
      },
    },
    role,
    key,
  );
}

function automation(path, body, role, key) {
  return request('/automation' + path, body, role, key);
}

function orderMcp() {
  return request(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'order.read', arguments: { orderId: 'ord-001' } },
    },
    'reader',
  );
}

function ok(result) {
  if (result?.state !== 'ok') throw new Error('unexpected tool outcome');
  return result.output;
}

export const traffic = [
  {
    name: 'order-rest',
    request: () => rest('order.read', { orderId: 'ord-001' }, 'reader'),
    check: ok,
  },
  { name: 'order-mcp', request: orderMcp, check: (body) => ok(body?.result?.structuredContent) },
  {
    name: 'chat-native',
    request: () =>
      automation('/chat', { sessionId: randomUUID(), prompt: orderPrompt, route: 'native' }),
    check: ok,
  },
  {
    name: 'voice-fixture',
    request: () =>
      automation('/voice', {
        sessionId: randomUUID(),
        fixtureId: 'audio-order-001',
        route: 'native',
      }),
    check: (body) => ok(body?.result),
  },
  {
    name: 'collections-preview',
    request: () => automation('/collections/preview', { invoiceId: 'inv-001', channel: 'email' }),
    check: ok,
  },
  {
    name: 'workflow-preview',
    request: () => automation('/workflows/win-back-v1', { mode: 'preview' }),
    check: ok,
  },
  { name: 'fraud', request: () => rest('fraud.score', { orderId: 'ord-003' }), check: ok },
  {
    name: 'forecast',
    request: () =>
      rest('forecast.run', { series: 'sku_demand', skuId: 'sku-001', horizonWeeks: 3 }),
    check: ok,
  },
  { name: 'profile', request: () => rest('profile.run', { customerId: 'cust-008' }), check: ok },
  { name: 'usage', request: () => request('/v1/governance/usage', undefined, 'approver') },
];

export async function walkthrough(send) {
  const outputs = {};
  for (const step of traffic) {
    const response = await send(step.name, step.request());
    outputs[step.name] = step.check?.(response);
  }
  if (
    outputs['order-rest'].id !== 'ord-001' ||
    outputs['order-mcp'].id !== 'ord-001' ||
    outputs['chat-native'].order.id !== 'ord-001' ||
    outputs['voice-fixture'].order.id !== 'ord-001'
  ) {
    throw new Error('order paths disagreed');
  }
  for (const channel of ['voice', 'sms']) {
    const preview = ok(
      await send(
        'collections-preview-' + channel,
        automation('/collections/preview', { invoiceId: 'inv-001', channel }),
      ),
    );
    if (preview.channel !== channel) throw new Error('collections preview disagreed');
  }
  ok(await send('fraud-second-order', rest('fraud.score', { orderId: 'ord-004' })));

  const approval = (body, key) => automation('/approvals/approve', body, 'approver', key);
  const draft = ok(
    await send('purchase-draft', automation('/purchase-orders/draft', { requestId: 'pr-001' })),
  );
  const purchase = { approvalId: draft.approval.id };
  const key = randomUUID();
  const first = ok(await send('purchase-approve', approval(purchase, key)));
  const retry = ok(await send('purchase-retry', approval(purchase, key)));
  if (first.id !== retry.id || first.status !== 'approved')
    throw new Error('purchase retry disagreed');

  const email = await send(
    'collections-request',
    automation('/collections/request', { invoiceId: 'inv-001', channel: 'email' }),
  );
  if (email.state !== 'pending_approval') throw new Error('collections expected pending approval');
  ok(await send('collections-approve', approval({ approvalId: email.approval.id })));

  const workflow = await send(
    'workflow-request',
    automation('/workflows/win-back-v1', { mode: 'run' }),
  );
  if (workflow.state !== 'pending_approval') throw new Error('workflow expected pending approval');
  ok(await send('workflow-approve', approval({ approvalId: workflow.approval.id })));

  const chat = { sessionId: randomUUID(), prompt: orderPrompt, route: 'byo' };
  const chatKey = randomUUID();
  for (const name of ['chat-byo', 'chat-byo-retry']) {
    ok(await send(name, automation('/chat', chat, 'operator', chatKey)));
  }
  await send('route-audit', automation('/llm/audit', undefined));
  await send('audit', request('/v1/governance/audit', undefined, 'approver'));
}
