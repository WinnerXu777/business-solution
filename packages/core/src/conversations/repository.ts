import {
  ConversationError,
  type CallRecord,
  type Conversation,
  type Queue,
  type Scope,
  type Staff,
} from './types.ts';

/** A synchronous unit of work. Implementations return detached snapshots. */
export interface ConversationRepository {
  get(scope: Scope): Conversation | undefined;
  save(conversation: Conversation, expectedCursor?: number): void;
  list(tenantId: string): Conversation[];
  getQueue(tenantId: string, id: string): Queue | undefined;
  saveQueue(tenantId: string, queue: Queue): void;
  getStaff(tenantId: string, id: string): Staff | undefined;
  saveStaff(tenantId: string, staff: Staff): void;
  due(at: number, tenantId?: string): Scope[];
  receipt(tenantId: string, channel: 'email' | 'sms', id: string): Scope | undefined;
  withReceipt<T>(tenantId: string, key: string, work: () => Promise<T>): Promise<T>;
  saveCall(call: CallRecord): void;
  getCall(scope: Scope, callId: string): CallRecord | undefined;
  callForConversation(scope: Scope): CallRecord | undefined;
}

const key = (tenantId: string, id: string) => JSON.stringify([tenantId, id]);

export function receipts(conversation: Conversation, after: number) {
  return conversation.events
    .slice(after)
    .flatMap<{ channel: 'email' | 'sms'; id: string }>((event) => {
      if (event.type !== 'message') return [];
      const { metadata } = event.message;
      switch (metadata.channel) {
        case 'email':
          return [{ channel: metadata.channel, id: metadata.receiptId }];
        case 'sms':
          return [{ channel: metadata.channel, id: metadata.messageSid }];
        default:
          return [];
      }
    });
}

export class MemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly queues = new Map<string, Queue>();
  private readonly staff = new Map<string, Staff>();
  private readonly calls = new Map<string, CallRecord>();
  private readonly inbound = new Map<string, Scope>();
  private readonly receiptLocks = new Map<string, Promise<unknown>>();

  get({ tenantId, conversationId }: Scope) {
    return structuredClone(this.conversations.get(key(tenantId, conversationId)));
  }

  save(conversation: Conversation, expectedCursor = 0) {
    const { tenantId, conversationId } = conversation;
    if (
      (this.conversations.get(key(tenantId, conversationId))?.events.length ?? 0) !== expectedCursor
    )
      throw new ConversationError('conflict');
    const incoming = receipts(conversation, expectedCursor).map(({ channel, id }) =>
      JSON.stringify([tenantId, channel, id]),
    );
    if (
      incoming.some((item) => this.inbound.has(item)) ||
      new Set(incoming).size !== incoming.length
    )
      throw new ConversationError('conflict');
    this.conversations.set(
      key(conversation.tenantId, conversation.conversationId),
      structuredClone(conversation),
    );
    for (const receipt of incoming) this.inbound.set(receipt, { tenantId, conversationId });
  }

  list(tenantId: string) {
    return [...this.conversations.values()]
      .filter((item) => item.tenantId === tenantId)
      .map((item) => structuredClone(item));
  }

  getQueue(tenantId: string, id: string) {
    return structuredClone(this.queues.get(key(tenantId, id)));
  }

  saveQueue(tenantId: string, queue: Queue) {
    this.queues.set(key(tenantId, queue.id), structuredClone(queue));
  }

  getStaff(tenantId: string, id: string) {
    return structuredClone(this.staff.get(key(tenantId, id)));
  }

  saveStaff(tenantId: string, staff: Staff) {
    this.staff.set(key(tenantId, staff.id), structuredClone(staff));
  }

  due(at: number, tenant?: string) {
    const scopes: Scope[] = [];
    for (const { tenantId, conversationId, state, assignment } of this.conversations.values()) {
      if (
        (tenant === undefined || tenantId === tenant) &&
        state === 'queued' &&
        assignment &&
        assignment.deadline <= at &&
        assignment.breachedAt === undefined
      ) {
        scopes.push({ tenantId, conversationId });
      }
    }
    return scopes;
  }

  receipt(tenantId: string, channel: 'email' | 'sms', id: string) {
    return structuredClone(this.inbound.get(JSON.stringify([tenantId, channel, id])));
  }

  async withReceipt<T>(tenantId: string, id: string, work: () => Promise<T>) {
    const scoped = key(tenantId, id);
    const pending = (this.receiptLocks.get(scoped) ?? Promise.resolve()).then(work);
    const tail = pending.catch(() => undefined);
    this.receiptLocks.set(scoped, tail);
    try {
      return await pending;
    } finally {
      if (this.receiptLocks.get(scoped) === tail) this.receiptLocks.delete(scoped);
    }
  }

  saveCall(call: CallRecord) {
    this.calls.set(key(call.tenantId, call.callId), structuredClone(call));
  }

  getCall({ tenantId, conversationId }: Scope, callId: string) {
    const call = this.calls.get(key(tenantId, callId));
    return call?.conversationId === conversationId ? structuredClone(call) : undefined;
  }

  callForConversation({ tenantId, conversationId }: Scope) {
    const call = [...this.calls.values()].find(
      (item) => item.tenantId === tenantId && item.conversationId === conversationId,
    );
    return structuredClone(call);
  }
}
