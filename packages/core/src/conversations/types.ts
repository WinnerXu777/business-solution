export type Channel = 'web' | 'email' | 'sms' | 'voice';
export type State = 'bot' | 'queued' | 'assigned' | 'resolved';
export type Role = 'customer' | 'bot' | 'staff';
export type Participant = { id: string; role: Role };
export type Scope = { tenantId: string; conversationId: string };
export type Queue = { id: string; skills: string[]; slaMs: number };
export type Staff = { id: string; available: boolean; skills: string[] };

export type ChannelMetadata =
  | { channel: 'web' }
  | {
      channel: 'email';
      receiptId: string;
      messageId: string;
      from: string;
      to: string;
      subject: string;
    }
  | { channel: 'sms'; messageSid: string; from: string; to: string; keyword?: 'STOP' | 'HELP' }
  | { channel: 'voice'; callId: string; segment?: number };

export type Message = {
  id: string;
  author: Participant;
  text: string;
  at: number;
  metadata: ChannelMetadata;
};

export type EventData =
  | { type: 'message'; message: Message }
  | { type: 'state'; state: State; queueId?: string; staffId?: string }
  | { type: 'sla_breached'; queueId: string; deadline: number }
  | { type: 'typing'; role: 'customer' | 'staff'; active: boolean }
  | { type: 'read'; role: 'customer' | 'staff'; messageId: string };
export type ConversationEvent = EventData & { cursor: number; at: number };

export type Conversation = Scope & {
  channel: Channel;
  state: State;
  routingVersion: number;
  participants: Participant[];
  createdAt: number;
  resolvedAt?: number;
  assignment?: {
    queueId: string;
    queuedAt: number;
    deadline: number;
    breachedAt?: number;
    staffId?: string;
  };
  thread?: string;
  messages: Message[];
  events: ConversationEvent[];
};

export class ConversationError extends Error {
  readonly code: 'not_found' | 'conflict' | 'invalid_input';

  constructor(code: ConversationError['code']) {
    super(code);
    this.code = code;
  }
}
