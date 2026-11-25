import type { BotModel } from '../../../../packages/adapters/src/llm/bot.ts';
import type { ChatMessage } from '../../../../packages/adapters/src/llm/contracts.ts';
import type {
  ChannelMetadata,
  Conversations,
  Participant,
  Scope,
} from '../../../../packages/core/src/conversations/index.ts';

export class ChannelBot {
  private readonly conversations: Conversations;
  private readonly model: BotModel;

  constructor(conversations: Conversations, model: BotModel) {
    this.conversations = conversations;
    this.model = model;
  }

  async turn(
    scope: Scope,
    customer: Participant,
    text: string,
    metadata: ChannelMetadata,
    signal: AbortSignal,
  ) {
    const message = this.conversations.post(scope, customer, text, metadata);
    return { message, reply: await this.reply(scope, metadata, signal) };
  }

  async reply(scope: Scope, metadata: ChannelMetadata, signal: AbortSignal) {
    const before = this.conversations.get(scope);
    if (signal.aborted || before.state !== 'bot') return;
    const messages: ChatMessage[] = before.messages
      .filter(({ author }) => author.role !== 'staff')
      .slice(-12)
      .map(({ author, text }) => ({
        role: author.role === 'customer' ? 'user' : 'assistant',
        content: text.slice(0, 4096),
      }));
    messages.unshift({
      role: 'system',
      content:
        'You are an automated support assistant. Give general support only. Do not ask for credentials or claim access to account records.',
    });
    const reply = await this.model(scope.tenantId, messages, signal);
    const current = this.conversations.get(scope);
    if (
      signal.aborted ||
      current.routingVersion !== before.routingVersion ||
      current.state !== 'bot'
    )
      return;
    const bot = current.participants.find(({ role }) => role === 'bot')!;
    return this.conversations.post(scope, bot, reply, metadata);
  }
}
