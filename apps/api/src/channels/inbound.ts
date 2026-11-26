import type {
  ChannelMetadata,
  Conversation,
  Conversations,
} from '../../../../packages/core/src/conversations/index.ts';
import type {
  parseSesInbound,
  parseTwilioInbound,
} from '../../../../packages/adapters/src/messaging/inbound.ts';

export type ConsentEvent = {
  tenantId: string;
  channel: 'sms';
  address: string;
  recipient: string;
  receiptId: string;
  kind: 'opt_out' | 'help_requested';
};

type Receipt = { conversationId: string; duplicate: boolean };

export class Inbound {
  private readonly conversations: Conversations;
  private readonly consent: (event: ConsentEvent) => void | Promise<void>;

  constructor(
    conversations: Conversations,
    consent: (event: ConsentEvent) => void | Promise<void>,
  ) {
    this.conversations = conversations;
    this.consent = consent;
  }

  email(tenantId: string, queueId: string, input: ReturnType<typeof parseSesInbound>[number]) {
    const { text, references, ...mail } = input;
    const thread = JSON.stringify([mail.from, mail.to]);
    return this.ingest(tenantId, 'email', mail.receiptId, () => {
      const conversation = this.conversations.lookupEmailReference(tenantId, thread, references);
      return this.add(tenantId, queueId, thread, text, { channel: 'email', ...mail }, conversation);
    });
  }

  sms(tenantId: string, queueId: string, input: ReturnType<typeof parseTwilioInbound>) {
    const { text, ...sms } = input;
    const thread = JSON.stringify([sms.from, sms.to]);
    return this.ingest(tenantId, 'sms', sms.messageSid, async () => {
      if (sms.keyword)
        await this.consent({
          tenantId,
          channel: 'sms',
          address: sms.from,
          recipient: sms.to,
          receiptId: sms.messageSid,
          kind: sms.keyword === 'STOP' ? 'opt_out' : 'help_requested',
        });
      const conversation = this.conversations.lookupThread(tenantId, 'sms', thread);
      return this.add(tenantId, queueId, thread, text, { channel: 'sms', ...sms }, conversation);
    });
  }

  private ingest(
    tenantId: string,
    channel: 'email' | 'sms',
    id: string,
    accept: () => Conversation | Promise<Conversation>,
  ): Promise<Receipt> {
    return this.conversations.withReceipt(tenantId, channel, id, async () => {
      const prior = this.conversations.lookupInbound(tenantId, channel, id);
      if (prior) return { conversationId: prior.conversationId, duplicate: true };
      return { conversationId: (await accept()).conversationId, duplicate: false };
    });
  }

  private add(
    tenantId: string,
    queueId: string,
    thread: string,
    text: string,
    metadata: Extract<ChannelMetadata, { channel: 'sms' | 'email' }>,
    prior?: Conversation,
  ) {
    const customer = { id: metadata.from, role: 'customer' } as const;
    if (!prior) {
      return this.conversations.open(tenantId, metadata.channel, customer.id, {
        queueId,
        thread,
        firstMessage: { text, metadata },
      });
    }
    this.conversations.post(prior, customer, text, metadata);
    return prior;
  }
}
