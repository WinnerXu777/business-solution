import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { loadDemoFixtures } from '@bs/contracts';
import { createApp } from '../../apps/api/src/app.ts';
import {
  webhookSignature,
  type WebhookDispatch,
} from '../../packages/core/src/platform/events.ts';

const tenant = 'tenant-rivetquay';
const operator = { authorization: 'Bearer fixture-operator' };
const approver = { authorization: 'Bearer fixture-approver' };
const admin = { authorization: 'Bearer fixture-admin' };

test('widget visitors get a native fixture bot reply and hand off to staff', async (t) => {
  const app = createApp({ BS_FIXTURE_LOGIN: '1' }, { fixturePlugins: true });
  t.after(() => app.close());
  const origin = 'http://127.0.0.1:5173';
  const widget = (path: string) => '/channels/widget/' + path + '?tenant=' + tenant;
  const session = await app.inject({ method: 'POST', url: widget('session'), headers: { origin } });
  assert.equal(session.statusCode, 201, session.body);
  const { token, conversationId } = session.json();
  const headers = { origin, authorization: 'Bearer ' + token };
  const message = await app.inject({
    method: 'POST', url: widget('messages'), headers, payload: { text: 'Do you stock work gloves?' },
  });
  assert.equal(message.statusCode, 201, message.body);
  const history = await app.inject({ url: widget('stream') + '&once=1', headers });
  assert.match(history.body, /"role":"bot"/);
  const handoff = await app.inject({ method: 'POST', url: widget('handoff'), headers });
  assert.equal(handoff.json().state, 'queued', handoff.body);
  const staff = '/channels/staff/conversations/' + conversationId;
  const claimed = await app.inject({ method: 'POST', url: staff + '/claim', headers: operator });
  assert.equal(claimed.json().assignment.staffId, 'actor-operator');
  const reply = await app.inject({
    method: 'POST', url: staff + '/messages', headers: operator, payload: { text: 'How can I help?' },
  });
  assert.equal(reply.statusCode, 201, reply.body);
  const read = await app.inject({ url: staff, headers: operator });
  assert.deepEqual(read.json().transcript.map((line: { author: { role: string } }) => line.author.role),
    ['customer', 'bot', 'staff']);
});

test('a signed inbound SMS STOP blocks execution of an already queued reminder', async (t) => {
  const app = createApp({ BS_FIXTURE_LOGIN: '1' }, { fixturePlugins: true });
  t.after(() => app.close());
  const contact = loadDemoFixtures().customers.find(({ id }) => id === 'cust-002')!;
  const decision = () => app.inject({
    method: 'POST', url: '/platform/v1/contact-check', headers: admin,
    payload: { contactId: contact.id, channel: 'sms', purpose: 'collections' },
  });
  assert.equal((await decision()).json().allow, true);
  const request = await app.inject({
    method: 'POST', url: '/automation/collections/request', headers: operator,
    payload: { invoiceId: 'inv-001', channel: 'sms' },
  });
  assert.equal(request.json().state, 'pending_approval', request.body);
  const url = '/channels/inbound/sms/' + tenant;
  const params = { Body: 'STOP', From: contact.phone, MessageSid: 'SM' + '1'.repeat(32), To: '+14165550190' };
  const material = 'http://127.0.0.1:3000' + url +
    Object.entries(params).map(([key, value]) => key + value).join('');
  const inbound = await app.inject({
    method: 'POST', url, payload: new URLSearchParams(params).toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': createHmac('sha1', 'fixture-sms-token').update(material).digest('base64'),
    },
  });
  assert.equal(inbound.statusCode, 200, inbound.body);
  assert.deepEqual((await decision()).json(), { allow: false, reasons: ['tenant_suppression'] });
  const approved = await app.inject({
    method: 'POST', url: '/automation/approvals/approve', headers: approver,
    payload: { approvalId: request.json().approval.id },
  });
  assert.equal(approved.json().state, 'denied', approved.body);
  assert.equal(approved.json().code, 'suppressed', approved.body);
});

test('a consent withdrawal produces a signed tenant delivery', async (t) => {
  let received!: (value: WebhookDispatch) => void;
  const delivered = new Promise<WebhookDispatch>((resolve) => { received = resolve; });
  const app = createApp({ BS_FIXTURE_LOGIN: '1' }, {
    fixturePlugins: true,
    eventPollMs: 20,
    platform: { webhookTransport: async (request) => {
      received(request);
      return { status: 204 };
    } },
  });
  t.after(() => app.close());
  const url = 'https://receipts.rivetquay.example/events';
  const hook = await app.inject({
    method: 'POST', url: '/platform/v1/webhooks', headers: admin,
    payload: { url, events: ['consent.withdrawn'] },
  });
  assert.equal(hook.statusCode, 201, hook.body);
  const consents = await app.inject({ url: '/platform/v1/consents', headers: admin });
  const [{ id }] = consents.json();
  const withdrawn = await app.inject({
    method: 'POST', url: '/platform/v1/consents/' + id + '/withdraw', headers: admin,
  });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  const delivery = await Promise.race([
    delivered,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Fixture webhook did not arrive')), 3_000).unref(),
    ),
  ]);
  assert.equal(delivery.url, url);
  const event = JSON.parse(delivery.body);
  assert.equal(event.tenantId, tenant);
  assert.equal(event.type, 'consent.withdrawn');
  assert.equal(event.data.consentId, id);
  assert.equal(delivery.headers['x-platform-signature'], webhookSignature(
    hook.json().signingSecret,
    delivery.headers['x-platform-timestamp'],
    delivery.headers['x-platform-delivery'],
    delivery.body,
  ));
});

test('the mounted procurement bot requires a manager and flags invoice variance', async (t) => {
  const app = createApp({ BS_FIXTURE_LOGIN: '1' }, { fixturePlugins: true });
  t.after(() => app.close());
  const post = (path: string, payload: object, headers = operator) =>
    app.inject({ method: 'POST', url: '/v1/bots' + path, payload,
      headers: { ...headers, 'idempotency-key': randomUUID() } });
  const draft = await post('/procurement/requests', {
    text: 'Draft pr-001', source: 'chat', sourceId: 'host-e2e-request',
  });
  assert.equal(draft.statusCode, 202, draft.body);
  const run = draft.json();
  assert.equal(run.status, 'pending_approval', draft.body);
  assert.match(draft.body, /manager/);
  const resume = '/runs/' + run.id + '/resume';
  const decision = { approvalId: run.pending.approval.id };
  assert.equal((await post(resume, decision)).statusCode, 403);
  const approved = await post(resume, decision, approver);
  assert.equal(approved.json().status, 'completed', approved.body);
  const order = '/procurement/orders/' + approved.json().result.output.id;
  const receipt = await post(order + '/receipts', {
    id: 'host-e2e-receipt', lines: [{ skuId: 'sku-001', quantity: 15 }],
  });
  assert.equal(receipt.json().state, 'partial', receipt.body);
  const match = await post(order + '/matches', {
    id: 'host-e2e-invoice', vendorId: 'vendor-002', currency: 'CAD',
    lines: [{ skuId: 'sku-001', quantity: 20, unitCostCents: 420 }],
  });
  assert.deepEqual(match.json().reasons, ['insufficient_receipts:sku-001']);
});

test('readiness reports fixture dependencies and metrics reflect completed requests', async (t) => {
  const app = createApp({ BS_FIXTURE_LOGIN: '1' }, { fixturePlugins: true });
  t.after(() => app.close());
  const ready = await app.inject('/ops/ready');
  assert.equal(ready.statusCode, 200);
  assert.match(ready.body, /database/);
  assert.match(ready.body, /queue/);
  assert.match(ready.body, /providers/);
  assert.equal((await app.inject({ url: '/platform/v1/me', headers: operator })).statusCode, 200);
  assert.equal((await app.inject({ url: '/ops/metrics', headers: operator })).statusCode, 403);
  assert.equal((await app.inject({ url: '/ops/alerts', headers: operator })).statusCode, 403);
  const metrics = await app.inject({ url: '/ops/metrics', headers: admin });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.body, /http_requests_total\{method="GET",route="\/platform\/v1\/me",status="200"\} 1/);
});

test('concurrent cold and warm chat turn submissions return results and deduplicate retries', async (t) => {
  const app = createApp({ BS_FIXTURE_LOGIN: '1' });
  t.after(() => app.close());
  for (const batch of ['cold', 'warm']) {
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      app.inject({
        method: 'POST', url: '/automation/chat',
        headers: { ...operator, 'idempotency-key': batch + '-' + (index % 6) },
        payload: { sessionId: 'concurrent-chat', prompt: 'Check order ord-001', route: 'native' },
      }),
    ));
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().state, 'ok', response.body);
      assert.equal(response.json().output.order.id, 'ord-001');
    }
    for (let index = 0; index < 6; index++) {
      assert.deepEqual(responses[index].json(), responses[index + 6].json());
    }
  }
});
