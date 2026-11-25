import assert from 'node:assert/strict';
import test from 'node:test';
import {
  events,
  harness,
  origin,
  otherId,
  otherOrigin,
  otherStaff,
  staffHeaders,
  tenantId,
  web,
} from './harness.ts';

const base = '/channels/widget/';
const staffPath = (id: string, action?: string) =>
  '/channels/staff/conversations/' + id + (action ? '/' + action : '');

test('rejects foreign origins and binds signed widget sessions to tenant, origin and expiry', async (t) => {
  const { app, advance } = await harness(t, { tokenTtlMs: 1000 });
  const client = web(app);
  const denied = await web(app, tenantId, 'https://evil.example')('POST', base + 'session');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const options = await client('OPTIONS', base + 'stream');
  assert.equal(options.statusCode, 204);
  assert.equal(options.headers['access-control-allow-origin'], origin);
  const session = await client('POST', base + 'session');
  assert.equal(session.statusCode, 201);
  const { token, conversationId } = session.json();
  const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  assert.equal((await client('GET', base + 'stream?once=1', tampered)).statusCode, 401);
  assert.equal(
    (await web(app, otherId, otherOrigin)('GET', base + 'stream?once=1', token)).statusCode,
    401,
  );
  advance(900);
  const renewed = (await client('POST', base + 'session', token)).json();
  assert.equal(renewed.conversationId, conversationId);
  advance(100);
  assert.equal((await client('GET', base + 'stream?once=1', token)).statusCode, 401);
  assert.equal((await client('GET', base + 'stream?once=1', renewed.token)).statusCode, 200);
  const script = await app.inject('/channels/widget.js');
  assert.match(script.headers['content-type']!, /javascript/);
  assert.match(script.body, /Talk to a person/);
  assert.doesNotThrow(() => new Function(script.body));
});

test('widget typing, read, SLA and human reply replay over SSE with cursor and staff routing', async (t) => {
  const { app, conversations, usage, modelInputs, advance } = await harness(t);
  const client = web(app);
  const { token, conversationId } = (await client('POST', base + 'session')).json();
  assert.equal(
    (await client('POST', base + 'events', token, { type: 'typing', active: true })).statusCode,
    204,
  );
  assert.equal(
    (await client('POST', base + 'messages', token, { text: 'Fictional product question' }))
      .statusCode,
    201,
  );
  const first = await client('GET', base + 'stream?once=1', token);
  assert.match(first.headers['content-type']!, /text\/event-stream/);
  const history = events(first.body);
  assert.deepEqual(
    history.map((event) => event.type),
    ['state', 'typing', 'message', 'message'],
  );
  assert.equal(history[3].message.text, 'Synthetic completion.');
  assert.equal(history[3].message.role, 'bot');
  assert.equal(history[3].message.author, undefined);
  assert.deepEqual(usage, [tenantId]);
  assert.equal(modelInputs.length, 1);
  assert.equal(
    (
      await client('POST', base + 'events', token, {
        type: 'read',
        messageId: history[3].message.id,
      })
    ).statusCode,
    204,
  );
  assert.equal((await client('POST', base + 'handoff', token)).json().state, 'queued');
  advance(90);
  conversations.checkSla();
  const list = await app.inject({
    url: '/channels/staff/queue?queue=general',
    headers: staffHeaders,
  });
  assert.equal(list.json().conversations[0].conversationId, conversationId);
  assert.equal(list.json().conversations[0].transcript, undefined);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: staffPath(conversationId, 'claim'),
        headers: otherStaff,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: staffPath(conversationId, 'claim'),
        headers: staffHeaders,
      })
    ).json().state,
    'assigned',
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: staffPath(conversationId, 'events'),
        headers: staffHeaders,
        payload: { type: 'typing', active: true },
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: staffPath(conversationId, 'messages'),
        headers: staffHeaders,
        payload: { text: 'Fictional staff response' },
      })
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: staffPath(conversationId, 'transfer'),
        headers: staffHeaders,
        payload: { queueId: 'returns' },
      })
    ).json().assignment.queueId,
    'returns',
  );
  await app.inject({
    method: 'POST',
    url: staffPath(conversationId, 'claim'),
    headers: staffHeaders,
  });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: staffPath(conversationId, 'resolve'),
        headers: staffHeaders,
      })
    ).json().state,
    'resolved',
  );
  const trace = events((await client('GET', base + 'stream?once=1&after=4', token)).body);
  assert.deepEqual(
    trace.map((event) => event.type),
    ['read', 'state', 'sla_breached', 'state', 'typing', 'message', 'state', 'state', 'state'],
  );
  assert.equal(trace[3].staffId, undefined);
  assert.equal(trace[4].role, 'staff');
  assert.equal(trace[5].message.text, 'Fictional staff response');
  assert.equal(trace[8].state, 'resolved');
  const details = await app.inject({ url: staffPath(conversationId), headers: staffHeaders });
  assert.equal(details.json().transcript.length, 3);
});

test('isolates native model bindings and rate limits anonymous session creation', async (t) => {
  const { app, usage } = await harness(t);
  const client = web(app, otherId, otherOrigin);
  const { token } = (await client('POST', base + 'session')).json();
  assert.equal(
    (await client('POST', base + 'messages', token, { text: 'Fictional second-tenant question' }))
      .statusCode,
    201,
  );
  assert.deepEqual(usage, [otherId]);
  for (let count = 1; count < 12; count++) {
    assert.equal((await client('POST', base + 'session')).statusCode, 201);
  }
  assert.equal((await client('POST', base + 'session')).statusCode, 429);
  assert.equal((await web(app)('POST', base + 'session')).statusCode, 201);
});
