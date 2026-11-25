import type { Conversation, Queue, Scope, Staff } from './types.ts';

/** A synchronous unit of work. Implementations return detached snapshots. */
export interface ConversationRepository {
  get(scope: Scope): Conversation | undefined;
  save(conversation: Conversation): void;
  list(tenantId: string): Conversation[];
  getQueue(tenantId: string, id: string): Queue | undefined;
  saveQueue(tenantId: string, queue: Queue): void;
  getStaff(tenantId: string, id: string): Staff | undefined;
  saveStaff(tenantId: string, staff: Staff): void;
  due(at: number): Scope[];
}

const key = (tenantId: string, id: string) => JSON.stringify([tenantId, id]);

export class MemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly queues = new Map<string, Queue>();
  private readonly staff = new Map<string, Staff>();

  get({ tenantId, conversationId }: Scope) {
    return structuredClone(this.conversations.get(key(tenantId, conversationId)));
  }

  save(conversation: Conversation) {
    this.conversations.set(
      key(conversation.tenantId, conversation.conversationId),
      structuredClone(conversation),
    );
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

  due(at: number) {
    const scopes: Scope[] = [];
    for (const { tenantId, conversationId, state, assignment } of this.conversations.values()) {
      if (
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
}
