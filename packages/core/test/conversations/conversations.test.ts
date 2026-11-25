import assert from 'node:assert/strict';
import test from 'node:test';
import { Conversations, MemoryConversationRepository } from '../../src/conversations/index.ts';

const customer = { id: 'visitor-one', role: 'customer' } as const;
const bot = { id: 'channel-bot', role: 'bot' } as const;
const web = { channel: 'web' } as const;

test('hands off to skill-matched available staff, transfers, hands back and resolves with one transcript', () => {
  const conversations = new Conversations(new MemoryConversationRepository(), () => 100);
  const tenant = 'fictional-a';
  conversations.configureQueue(tenant, { id: 'general', skills: ['retail'], slaMs: 500 });
  conversations.configureQueue(tenant, { id: 'returns', skills: ['returns'], slaMs: 700 });
  const anne = { id: 'agent-a', available: false, skills: ['retail'] };
  const bill = { id: 'agent-b', available: true, skills: ['returns'] };
  conversations.setStaff(tenant, anne);
  conversations.setStaff(tenant, bill);
  const scope = conversations.open(tenant, 'web', customer.id);
  conversations.post(scope, customer, 'Fictional question', web);
  conversations.post(scope, bot, 'I can connect you to support.', web);
  assert.equal(conversations.handoff(scope, 'general').state, 'queued');
  assert.throws(() => conversations.post(scope, bot, 'Stale reply', web), /conflict/);
  assert.deepEqual(conversations.listForStaff(tenant, bill.id), []);
  assert.throws(() => conversations.claim(scope, anne.id), /conflict/);
  assert.throws(() => conversations.claim(scope, bill.id), /conflict/);
  conversations.setStaff(tenant, { ...anne, available: true });
  assert.equal(conversations.claim(scope, anne.id).state, 'assigned');
  assert.throws(() => conversations.claim(scope, anne.id), /conflict/);
  conversations.post(scope, { id: anne.id, role: 'staff' }, 'Fictional staff reply', web);
  assert.equal(conversations.transfer(scope, anne.id, 'returns').assignment?.deadline, 800);
  assert.throws(() => conversations.canReadAsStaff(scope, anne.id), /not_found/);
  conversations.claim(scope, bill.id);
  assert.equal(conversations.handback(scope, bill.id).state, 'bot');
  conversations.post(scope, bot, 'I am back.', web);
  conversations.handoff(scope, 'general');
  conversations.claim(scope, anne.id);
  assert.equal(conversations.resolve(scope, anne.id).state, 'resolved');
  assert.throws(() => conversations.post(scope, customer, 'Late question', web), /conflict/);
  assert.deepEqual(
    conversations.transcript(scope).map((message) => message.author.role),
    ['customer', 'bot', 'staff', 'bot'],
  );
  assert.equal(
    conversations.get(scope).participants.filter((person) => person.role === 'staff').length,
    2,
  );
  const other = { ...scope, tenantId: 'fictional-b' };
  assert.throws(() => conversations.get(other), /not_found/);
  assert.throws(() => conversations.claim(other, anne.id), /not_found/);
});

test('emits each queue SLA breach once, even when claim occurs before the next poll', () => {
  let now = 1000;
  const tenant = 'fictional-a';
  const repository = new MemoryConversationRepository();
  const conversations = new Conversations(repository, () => now);
  conversations.configureQueue(tenant, { id: 'general', skills: [], slaMs: 50 });
  conversations.setStaff(tenant, { id: 'staff', available: true, skills: [] });
  const scope = conversations.open(tenant, 'web', customer.id);
  conversations.handoff(scope, 'general');
  const events: string[] = [];
  const unsubscribe = conversations.subscribe(scope, (event) => events.push(event.type));
  now = 1049;
  conversations.checkSla();
  assert.deepEqual(events, []);
  now = 1050;
  conversations.checkSla();
  conversations.checkSla();
  assert.deepEqual(events, ['sla_breached']);
  assert.equal(conversations.get(scope).assignment?.breachedAt, now);
  conversations.claim(scope, 'staff');
  conversations.transfer(scope, 'staff', 'general');
  now = 1100;
  conversations.claim(scope, 'staff');
  unsubscribe();
  assert.deepEqual(events, ['sla_breached', 'state', 'state', 'sla_breached', 'state']);
  const snapshot = conversations.get(scope);
  snapshot.events.length = 0;
  assert.equal(new Conversations(repository).get(scope).events.length, 7);
});
