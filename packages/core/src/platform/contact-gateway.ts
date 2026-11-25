import type { MessageAdapter } from '@bs/adapters';
import type { MessagePreview } from '@bs/contracts';
import type { ContactLedger, ContactPurpose } from './contacts.ts';

/** Wrap the effect adapter so campaign fan-out rechecks each individual recipient. */
export function guardMessageAdapter(
  ledger: ContactLedger,
  adapter: MessageAdapter,
  purposeFor: (preview: Readonly<MessagePreview>) => ContactPurpose,
): MessageAdapter {
  return {
    async send(preview, actionId) {
      const decision = await ledger.reserveContact(
        preview.tenantId,
        {
          contactId: preview.customerId,
          channel: preview.channel,
          purpose: purposeFor(preview),
        },
        actionId,
        preview.recipient,
      );
      if (!decision.allow)
        return {
          state: 'failed',
          code: 'invalid_input',
          message: decision.reasons.join(', '),
          retryable: false,
        };
      return adapter.send(preview, actionId);
    },
  };
}
