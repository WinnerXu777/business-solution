import { receipts, type ConversationRepository } from './repository.ts';
import {
  ConversationError,
  type CallRecord,
  type Conversation,
  type Queue,
  type Scope,
  type Staff,
} from './types.ts';

export interface ConversationExecutor {
  /** Execute a statement in a transaction with app.tenant_id set locally. */
  query(
    tenantId: string,
    sql: string,
    values: readonly unknown[],
  ): {
    rows: Record<string, unknown>[];
  };
  /** A session lease whose lifetime spans independently committed statements. */
  lease<T>(tenantId: string, key: string, work: () => Promise<T>): Promise<T>;
}

export class PostgresConversationRepository implements ConversationRepository {
  private readonly executor: ConversationExecutor;
  private readonly tenants: () => Iterable<string>;

  constructor(executor: ConversationExecutor, tenants: () => Iterable<string>) {
    this.executor = executor;
    this.tenants = tenants;
  }

  get({ tenantId, conversationId }: Scope) {
    return this.read<Conversation>(tenantId, 'conversations', conversationId);
  }

  save(conversation: Conversation, expectedCursor = 0) {
    const { tenantId, conversationId, events } = conversation;
    try {
      const { rows } = this.executor.query(
        tenantId,
        `WITH saved AS (
           INSERT INTO runtime.conversations (tenant_id, id, body, cursor)
           SELECT $1, $2, $3::jsonb, $5
           WHERE $4 = 0 OR EXISTS (
             SELECT 1 FROM runtime.conversations WHERE tenant_id = $1 AND id = $2
           )
           ON CONFLICT (tenant_id, id) DO UPDATE SET body = EXCLUDED.body, cursor = EXCLUDED.cursor
           WHERE runtime.conversations.cursor = $4
           RETURNING tenant_id, id
         ), accepted AS (
           INSERT INTO runtime.channel_receipts (tenant_id, channel, receipt_id, conversation_id)
           SELECT saved.tenant_id, receipt.channel, receipt.id, saved.id
           FROM saved CROSS JOIN jsonb_to_recordset($6::jsonb) AS receipt(channel text, id text)
         )
         SELECT id FROM saved`,
        [
          tenantId,
          conversationId,
          JSON.stringify(conversation),
          expectedCursor,
          events.length,
          JSON.stringify(receipts(conversation, expectedCursor)),
        ],
      );
      if (!rows.length) throw new ConversationError('conflict');
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'channel_receipts_pkey')
        throw new ConversationError('conflict');
      throw error;
    }
  }

  list(tenantId: string) {
    return this.executor
      .query(
        tenantId,
        'SELECT body FROM runtime.conversations WHERE tenant_id = $1 ORDER BY ordinal',
        [tenantId],
      )
      .rows.map(({ body }) => body as Conversation);
  }

  getQueue(tenantId: string, id: string) {
    return this.read<Queue>(tenantId, 'conversation_queues', id);
  }

  saveQueue(tenantId: string, queue: Queue) {
    this.put(tenantId, 'conversation_queues', queue.id, queue);
  }

  getStaff(tenantId: string, id: string) {
    return this.read<Staff>(tenantId, 'conversation_staff', id);
  }

  saveStaff(tenantId: string, staff: Staff) {
    this.put(tenantId, 'conversation_staff', staff.id, staff);
  }

  due(at: number, tenantId?: string) {
    const result: Scope[] = [];
    for (const tenant of tenantId === undefined ? this.tenants() : [tenantId]) {
      const { rows } = this.executor.query(
        tenant,
        `SELECT id FROM runtime.conversations
         WHERE tenant_id = $1 AND body->>'state' = 'queued'
         AND (body #>> '{assignment,deadline}')::bigint <= $2
         AND body #>> '{assignment,breachedAt}' IS NULL`,
        [tenant, at],
      );
      for (const { id } of rows) result.push({ tenantId: tenant, conversationId: id as string });
    }
    return result;
  }

  receipt(tenantId: string, channel: 'email' | 'sms', id: string) {
    const { rows } = this.executor.query(
      tenantId,
      `SELECT conversation_id FROM runtime.channel_receipts
       WHERE tenant_id = $1 AND channel = $2 AND receipt_id = $3`,
      [tenantId, channel, id],
    );
    return rows[0] && { tenantId, conversationId: rows[0].conversation_id as string };
  }

  withReceipt<T>(tenantId: string, key: string, work: () => Promise<T>) {
    return this.executor.lease(tenantId, JSON.stringify(['channel-receipt', key]), work);
  }

  saveCall(call: CallRecord) {
    this.put(call.tenantId, 'voice_calls', call.callId, call);
  }

  getCall({ tenantId, conversationId }: Scope, callId: string) {
    const call = this.read<CallRecord>(tenantId, 'voice_calls', callId);
    return call?.conversationId === conversationId ? call : undefined;
  }

  callForConversation({ tenantId, conversationId }: Scope) {
    return this.executor.query(
      tenantId,
      "SELECT body FROM runtime.voice_calls WHERE tenant_id = $1 AND body->>'conversationId' = $2 ORDER BY id LIMIT 1",
      [tenantId, conversationId],
    ).rows[0]?.body as CallRecord | undefined;
  }

  private read<T>(tenantId: string, table: Table, id: string) {
    return this.executor.query(
      tenantId,
      `SELECT body FROM runtime.${table} WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    ).rows[0]?.body as T | undefined;
  }

  private put(tenantId: string, table: Exclude<Table, 'conversations'>, id: string, body: unknown) {
    this.executor.query(
      tenantId,
      `INSERT INTO runtime.${table} (tenant_id, id, body) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET body = EXCLUDED.body`,
      [tenantId, id, JSON.stringify(body)],
    );
  }
}

type Table = 'conversations' | 'conversation_queues' | 'conversation_staff' | 'voice_calls';
