import type { MessageChannel, MessagePreview } from '@bs/contracts';
import type { MessageAdapter } from '../index.ts';
import { sendToMailpit, type MailpitOptions } from './mailpit.ts';

function simulated(channel: MessageChannel): MessageAdapter {
  return {
    send(_preview, actionId) {
      return {
        id: 'receipt-' + actionId,
        channel,
        status: 'simulated',
        providerId: 'fixture-' + channel,
      };
    },
  };
}

export function createMessagingAdapters(
  options: MailpitOptions & { enabled?: boolean } = {},
  capture: (
    preview: MessagePreview,
    actionId: string,
    options: MailpitOptions,
  ) => ReturnType<MessageAdapter['send']> = sendToMailpit,
): Record<MessageChannel, MessageAdapter> {
  return {
    email:
      options.enabled && !process.env.CI
        ? { send: (preview, actionId) => capture(preview, actionId, options) }
        : simulated('email'),
    voice: simulated('voice'),
    sms: simulated('sms'),
  };
}
