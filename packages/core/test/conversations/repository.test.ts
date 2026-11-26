import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Conversations,
  MemoryConversationRepository,
  PostgresConversationRepository,
  type Conversation,
  type ConversationExecutor,
  type ConversationRepository,
} from '../../src/conversations/index.ts';

class FakeConversationExecutor implements ConversationExecutor {
  private readonly tables = new Map<string, Map<string, unknown>>();

  async lease<T>(_tenant: string, _key: string, work: () => Promise<T>) {
    return work();
  }

  query(tenant: string, sql: string, values: readonly unknown[]) {
    assert.equal(values[0], tenant);
    const table = /runtime\.(\w+)/.exec(sql)![1];
    const rows = this.tables.get(table) ?? new Map<string, unknown>();
    this.tables.set(table, rows);
    const key = JSON.stringify([tenant, values[1]]);
    const withBody = (value: unknown) => ({ body: structuredClone(value) });
    if (sql.startsWith('WITH saved')) {
      const [, id, raw, expected, cursor, receiptRows] = values;
      const state = JSON.parse(String(raw)) as Conversation;
      assert.equal(state.events.length, cursor);
      const old = rows.get(key) as Conversation | undefined;
      if ((old?.events.length ?? 0) !== expected) return { rows: [] };
      const receipts = this.tables.get('channel_receipts') ?? new Map<string, unknown>();
      const pending = new Map<string, unknown>();
      for (const receipt of JSON.parse(String(receiptRows)) as { channel: string; id: string }[]) {
        const receiptKey = JSON.stringify([tenant, receipt.channel, receipt.id]);
        if (receipts.has(receiptKey) || pending.has(receiptKey))
          throw Object.assign(new Error(), { constraint: 'channel_receipts_pkey' });
        pending.set(receiptKey, id);
      }
      for (const [id, conversation] of pending) receipts.set(id, conversation);
      this.tables.set('channel_receipts', receipts);
      rows.set(key, state);
      return { rows: [{ id }] };
    }
    if (sql.startsWith('INSERT')) {
      rows.set(key, JSON.parse(String(values[2])));
      return { rows: [] };
    }
    assert(sql.startsWith('SELECT'));
    if (table === 'channel_receipts') {
      const id = rows.get(JSON.stringify(values));
      return { rows: id ? [{ conversation_id: id }] : [] };
    }
    if (table === 'voice_calls' && sql.includes("body->>'conversationId'")) {
      const value = [...rows.values()].find((item) => {
        const call = item as { tenantId: string; conversationId: string };
        return call.tenantId === tenant && call.conversationId === values[1];
      });
      return { rows: value ? [withBody(value)] : [] };
    }
    if (sql.includes("body->>'state'")) {
      return {
        rows: [...rows.values()]
          .map((value) => value as Conversation)
          .filter(
            ({ tenantId, state, assignment }) =>
              tenantId === tenant &&
              state === 'queued' &&
              assignment &&
              assignment.deadline <= Number(values[1]) &&
              assignment.breachedAt === undefined,
          )
          .map(({ conversationId }) => ({ id: conversationId })),
      };
    }
    if (sql.includes('AND id')) {
      return { rows: rows.has(key) ? [withBody(rows.get(key))] : [] };
    }
    return {
      rows: [...rows]
        .filter(([entry]) => JSON.parse(entry)[0] === tenant)
        .map(([, value]) => withBody(value)),
    };
  }
}

const tenantId = 'fictional-a';
const foreign = 'fictional-b';
const customer = { id: '+14165550100', role: 'customer' } as const;
const metadata = {
  channel: 'sms',
  messageSid: 'fictional-sms-1',
  from: customer.id,
  to: '+14165550101',
} as const;

for (const kind of ['memory', 'postgres']) {
  test(`${kind} conversation repository preserves queue, transcript, receipt, SLA and call state on restart`, () => {
    const memory = new MemoryConversationRepository();
    const sql = new FakeConversationExecutor();
    const make = (): ConversationRepository =>
      kind === 'memory'
        ? memory
        : new PostgresConversationRepository(sql, () => [tenantId, foreign]);
    let now = 10;
    const first = new Conversations(make(), () => now);
    first.configureQueue(tenantId, { id: 'help', slaMs: 20, skills: ['fixture'] });
    first.setStaff(tenantId, { id: 'staff', available: true, skills: ['fixture'] });
    const scope = first.open(tenantId, 'sms', customer.id, {
      queueId: 'help',
      firstMessage: { text: 'Fictional order question', metadata },
    });
    const voice = first.open(tenantId, 'voice', customer.id);
    const call = {
      tenantId,
      conversationId: voice.conversationId,
      callId: 'fixture-call',
      startedAt: 10,
      answeredAt: 11,
      endedAt: 13,
      digits: [],
      transfers: [],
    };
    first.saveCall(call);
    const restarted = new Conversations(make(), () => now);
    assert.deepEqual(restarted.getCall(voice, call.callId), call);
    assert.deepEqual(restarted.callForConversation(voice), call);
    assert.equal(restarted.getCall({ ...voice, tenantId: foreign }, call.callId), undefined);
    assert.equal(
      restarted.lookupInbound(tenantId, 'sms', metadata.messageSid)?.conversationId,
      scope.conversationId,
    );
    assert.equal(restarted.lookupInbound(foreign, 'sms', metadata.messageSid), undefined);
    assert.deepEqual(
      restarted.transcript(scope).map(({ text }) => text),
      ['Fictional order question'],
    );
    assert.equal(
      restarted.listForStaff(tenantId, 'staff', 'help')[0].conversationId,
      scope.conversationId,
    );
    assert.throws(() => restarted.post(scope, customer, 'Duplicate', metadata), {
      code: 'conflict',
    });
    assert.equal(restarted.get(scope).messages.length, 1);
    now = 31;
    restarted.checkSla();
    restarted.checkSla();
    const history = restarted.get(scope).events.filter(({ cursor }) => cursor > 1);
    assert.deepEqual(
      history.map(({ type }) => type),
      ['message', 'sla_breached'],
    );
    assert.equal(restarted.claim(scope, 'staff').state, 'assigned');
    const repository = make();
    const stale = repository.get(scope)!;
    restarted.activity(scope, { id: 'staff', role: 'staff' }, { active: true });
    assert.throws(() => repository.save(stale, stale.events.length), { code: 'conflict' });
  });
}
