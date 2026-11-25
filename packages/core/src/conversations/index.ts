import { randomUUID } from 'node:crypto';
import type { ConversationRepository } from './repository.ts';
import { ConversationError } from './types.ts';
import type {
  Channel,
  ChannelMetadata,
  Conversation,
  ConversationEvent,
  EventData,
  Message,
  Participant,
  Queue,
  Scope,
  Staff,
  State,
} from './types.ts';

export * from './types.ts';
export * from './repository.ts';

const missing = () => new ConversationError('not_found');
const conflict = () => new ConversationError('conflict');
const invalid = () => new ConversationError('invalid_input');
const scopeKey = ({ tenantId, conversationId }: Scope) =>
  JSON.stringify([tenantId, conversationId]);
const supports = (staff: Staff, queue: Queue) =>
  queue.skills.every((skill) => staff.skills.includes(skill));
type Listener = (event: ConversationEvent) => void;

export class Conversations {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly repository: ConversationRepository;
  private readonly now: () => number;

  constructor(repository: ConversationRepository, now = Date.now) {
    this.repository = repository;
    this.now = now;
  }

  configureQueue(tenantId: string, queue: Queue) {
    if (!tenantId || !queue.id || !Number.isSafeInteger(queue.slaMs) || queue.slaMs <= 0)
      throw invalid();
    this.repository.saveQueue(tenantId, queue);
  }

  setStaff(tenantId: string, staff: Staff) {
    if (!tenantId || !staff.id) throw invalid();
    this.repository.saveStaff(tenantId, staff);
  }

  open(
    tenantId: string,
    channel: Channel,
    customerId: string,
    options: { thread?: string; queueId?: string } = {},
  ) {
    if (!tenantId || !customerId) throw invalid();
    const conversation: Conversation = {
      tenantId,
      conversationId: randomUUID(),
      channel,
      state: 'bot',
      routingVersion: 0,
      participants: [
        { id: customerId, role: 'customer' },
        { id: 'channel-bot', role: 'bot' },
      ],
      createdAt: this.now(),
      thread: options.thread,
      messages: [],
      events: [],
    };
    if (options.queueId) this.queue(conversation, options.queueId);
    else this.transition(conversation, 'bot');
    this.commit(conversation, 0);
    return conversation;
  }

  get(scope: Scope) {
    const conversation = this.repository.get(scope);
    if (!conversation) throw missing();
    return conversation;
  }

  transcript(scope: Scope) {
    return this.get(scope).messages;
  }

  lookupThread(tenantId: string, channel: Channel, thread: string) {
    return this.repository
      .list(tenantId)
      .reverse()
      .find(
        (item) => item.channel === channel && item.thread === thread && item.state !== 'resolved',
      );
  }

  lookupInbound(tenantId: string, channel: 'email' | 'sms', receiptId: string) {
    return this.repository
      .list(tenantId)
      .find(
        (item) =>
          item.channel === channel &&
          item.messages.some(
            ({ metadata }) =>
              (metadata.channel === 'email' && metadata.receiptId === receiptId) ||
              (metadata.channel === 'sms' && metadata.messageSid === receiptId),
          ),
      );
  }

  lookupEmailReference(tenantId: string, thread: string, references: string[]) {
    const conversations = this.repository
      .list(tenantId)
      .reverse()
      .filter(
        (item) => item.channel === 'email' && item.thread === thread && item.state !== 'resolved',
      );
    for (const reference of references) {
      const match = conversations.find((item) =>
        item.messages.some(
          ({ metadata }) => metadata.channel === 'email' && metadata.messageId === reference,
        ),
      );
      if (match) return match;
    }
  }

  post(scope: Scope, author: Participant, text: string, metadata: ChannelMetadata) {
    return this.update(scope, (conversation) => {
      this.authorize(conversation, author);
      if (metadata.channel !== conversation.channel || !text.trim() || text.length > 32_768)
        throw invalid();
      const message: Message = {
        id: randomUUID(),
        author: { ...author },
        text,
        at: this.now(),
        metadata: structuredClone(metadata),
      };
      conversation.messages.push(message);
      this.record(conversation, { type: 'message', message });
      return message;
    });
  }

  activity(scope: Scope, author: Participant, data: { active: boolean } | { messageId: string }) {
    this.update(scope, (conversation) => {
      this.authorize(conversation, author);
      const { role } = author;
      if (role === 'bot') throw invalid();
      if ('active' in data) {
        this.record(conversation, { type: 'typing', role, active: data.active });
      } else {
        const message = conversation.messages.find((entry) => entry.id === data.messageId);
        if (!message || message.author.role === role) throw missing();
        this.record(conversation, { type: 'read', role, messageId: data.messageId });
      }
    });
  }

  handoff(scope: Scope, queueId: string) {
    return this.update(scope, (conversation) => {
      if (conversation.state !== 'bot') throw conflict();
      this.queue(conversation, queueId);
      return conversation;
    });
  }

  listForStaff(tenantId: string, staffId: string, queueId?: string) {
    const staff = this.requireStaff(tenantId, staffId);
    if (queueId) this.requireQueue(tenantId, queueId);
    return this.repository
      .list(tenantId)
      .filter(({ state, assignment }) => {
        if (!assignment || (queueId && assignment.queueId !== queueId)) return false;
        if (state === 'assigned') return assignment.staffId === staffId;
        return (
          state === 'queued' && supports(staff, this.requireQueue(tenantId, assignment.queueId))
        );
      })
      .sort((a, b) => a.assignment!.queuedAt - b.assignment!.queuedAt);
  }

  claim(scope: Scope, staffId: string) {
    return this.update(scope, (conversation) => {
      const staff = this.requireStaff(scope.tenantId, staffId);
      const assignment = conversation.assignment;
      if (
        conversation.state !== 'queued' ||
        !assignment ||
        !staff.available ||
        !supports(staff, this.requireQueue(scope.tenantId, assignment.queueId))
      )
        throw conflict();
      assignment.staffId = staffId;
      if (!conversation.participants.some((item) => item.role === 'staff' && item.id === staffId)) {
        conversation.participants.push({ id: staffId, role: 'staff' });
      }
      this.transition(conversation, 'assigned');
      return conversation;
    });
  }

  transfer(scope: Scope, staffId: string, queueId: string) {
    return this.update(scope, (conversation) => {
      this.authorize(conversation, { id: staffId, role: 'staff' });
      this.queue(conversation, queueId);
      return conversation;
    });
  }

  handback(scope: Scope, staffId: string) {
    return this.update(scope, (conversation) => {
      this.authorize(conversation, { id: staffId, role: 'staff' });
      delete conversation.assignment;
      this.transition(conversation, 'bot');
      return conversation;
    });
  }

  resolve(scope: Scope, staffId: string) {
    return this.update(scope, (conversation) => {
      this.authorize(conversation, { id: staffId, role: 'staff' });
      conversation.resolvedAt = this.now();
      this.transition(conversation, 'resolved');
      return conversation;
    });
  }

  checkSla() {
    for (const scope of this.repository.due(this.now())) {
      const conversation = this.get(scope);
      const cursor = conversation.events.length;
      if (this.breach(conversation)) this.commit(conversation, cursor);
    }
  }

  subscribe(scope: Scope, listener: Listener) {
    this.get(scope);
    const key = scopeKey(scope);
    const listeners = this.listeners.get(key) ?? new Set<Listener>();
    this.listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  canReadAsStaff(scope: Scope, staffId: string) {
    this.requireStaff(scope.tenantId, staffId);
    const conversation = this.get(scope);
    if (conversation.assignment?.staffId !== staffId) throw missing();
    return conversation;
  }

  private requireQueue(tenantId: string, id: string) {
    const queue = this.repository.getQueue(tenantId, id);
    if (!queue) throw missing();
    return queue;
  }

  private requireStaff(tenantId: string, id: string) {
    const staff = this.repository.getStaff(tenantId, id);
    if (!staff) throw missing();
    return staff;
  }

  private authorize(conversation: Conversation, author: Participant) {
    if (!conversation.participants.some(({ role, id }) => role === author.role && id === author.id))
      throw missing();
    if (
      conversation.state === 'resolved' ||
      (author.role === 'bot' && conversation.state !== 'bot')
    )
      throw conflict();
    if (
      author.role === 'staff' &&
      (conversation.state !== 'assigned' || conversation.assignment?.staffId !== author.id)
    )
      throw missing();
  }

  private update<T>(scope: Scope, change: (conversation: Conversation) => T): T {
    const conversation = this.get(scope);
    const cursor = conversation.events.length;
    this.breach(conversation);
    const result = change(conversation);
    this.commit(conversation, cursor);
    return result;
  }

  private queue(conversation: Conversation, queueId: string) {
    const queue = this.requireQueue(conversation.tenantId, queueId);
    const now = this.now();
    conversation.assignment = { queueId, queuedAt: now, deadline: now + queue.slaMs };
    this.transition(conversation, 'queued');
  }

  private transition(conversation: Conversation, state: State) {
    conversation.state = state;
    conversation.routingVersion += 1;
    const { queueId, staffId } = conversation.assignment ?? {};
    this.record(conversation, { type: 'state', state, queueId, staffId });
  }

  private breach(conversation: Conversation) {
    const { state, assignment } = conversation;
    const at = this.now();
    if (
      state !== 'queued' ||
      !assignment ||
      assignment.breachedAt !== undefined ||
      assignment.deadline > at
    )
      return false;
    assignment.breachedAt = at;
    this.record(
      conversation,
      { type: 'sla_breached', queueId: assignment.queueId, deadline: assignment.deadline },
      at,
    );
    return true;
  }

  private record(conversation: Conversation, data: EventData, at = this.now()) {
    conversation.events.push({ ...data, at, cursor: conversation.events.length + 1 });
  }

  private commit(conversation: Conversation, cursor: number) {
    this.repository.save(conversation);
    const listeners = this.listeners.get(scopeKey(conversation));
    for (const event of conversation.events.slice(cursor)) {
      for (const listener of listeners ?? []) {
        try {
          listener(structuredClone(event));
        } catch {
          // A disconnected subscriber cannot fail a committed write.
        }
      }
    }
  }
}
