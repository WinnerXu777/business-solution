import type { MessageAdapter } from '../index.ts';
import { ProviderError, object, string } from '../llm/contracts.ts';
import { json, parseJson, request, type HttpClient } from '../llm/http.ts';

export type MessageStatus = {
  receiptId: string;
  channel: 'email' | 'sms';
  status: 'accepted' | 'sent' | 'delivered' | 'failed';
};

export interface TestMessageAdapter extends MessageAdapter {
  /** Parse verified webhook payloads into redacted status records. */
  parseStatus(body: unknown): MessageStatus | null;
}

const emailAddress = /^[a-z0-9._+-]+@[a-z0-9.-]+\.example$/i;
const phoneNumber = /^\+1[2-9]\d{2}55501\d{2}$/;
const sesStatuses = new Map<string, MessageStatus['status']>([
  ['Send', 'accepted'],
  ['Delivery', 'delivered'],
  ['Bounce', 'failed'],
  ['Complaint', 'failed'],
  ['Reject', 'failed'],
  ['Rendering Failure', 'failed'],
]);
const twilioStatuses = new Map<string, MessageStatus['status']>([
  ['accepted', 'accepted'],
  ['queued', 'accepted'],
  ['sending', 'accepted'],
  ['sent', 'sent'],
  ['delivered', 'delivered'],
  ['undelivered', 'failed'],
  ['failed', 'failed'],
  ['canceled', 'failed'],
]);

function sesStatus(raw: unknown): MessageStatus | null {
  const outer = object(raw);
  const event = outer.Type === 'Notification' ? object(parseJson(string(outer.Message))) : outer;
  const status = sesStatuses.get(string(event.eventType ?? event.notificationType));
  if (!status) return null;
  const receiptId = string(object(event.mail).messageId);
  return receiptId ? { receiptId, channel: 'email', status } : null;
}

function twilioStatus(raw: unknown): MessageStatus | null {
  const event =
    typeof raw === 'string' || raw instanceof URLSearchParams
      ? Object.fromEntries(new URLSearchParams(raw))
      : object(raw);
  const status = twilioStatuses.get(string(event.MessageStatus ?? event.SmsStatus));
  const receiptId = string(event.MessageSid ?? event.SmsSid);
  return status && receiptId ? { receiptId, channel: 'sms', status } : null;
}

type Options = { mode: 'test'; from: string; client: HttpClient };
type TwilioOptions = Options & { accountSid: string };

function createAdapter(
  options: Options | TwilioOptions,
  channel: 'email' | 'sms',
): TestMessageAdapter {
  const email = channel === 'email';
  const allowed = email ? emailAddress : phoneNumber;
  const account = 'accountSid' in options ? options.accountSid : '';
  if (options.mode !== 'test' || !allowed.test(options.from) || (!email && !account)) {
    throw new ProviderError('rejected');
  }
  const providerId = email ? 'ses-test' : 'twilio-test';
  return {
    async send(preview, actionId) {
      if (
        preview.channel !== channel ||
        !allowed.test(preview.recipient) ||
        !/^[a-zA-Z0-9._:-]{1,128}$/.test(actionId)
      ) {
        return {
          state: 'failed',
          code: 'invalid_input',
          retryable: false,
          message: 'Invalid fixture message.',
        };
      }
      try {
        const response = await request(options.client, {
          method: 'POST',
          path: email
            ? '/v2/email/outbound-emails'
            : '/2010-04-01/Accounts/' + encodeURIComponent(account) + '/Messages.json',
          headers: {
            'content-type': email ? 'application/json' : 'application/x-www-form-urlencoded',
          },
          body: email
            ? {
                FromEmailAddress: options.from,
                Destination: { ToAddresses: [preview.recipient] },
                Content: {
                  Simple: {
                    Subject: { Data: preview.subject ?? 'Fictional message' },
                    Body: { Text: { Data: preview.body } },
                  },
                },
                EmailTags: [{ Name: 'action_id', Value: actionId }],
              }
            : new URLSearchParams({
                From: options.from,
                To: preview.recipient,
                Body: preview.body,
              }).toString(),
        });
        const data = object(await json(response));
        const receiptId = string(email ? data.MessageId : data.sid);
        if (!receiptId) throw new ProviderError('invalid_response');
        return { id: receiptId, channel, status: 'simulated', providerId };
      } catch (error) {
        if (error instanceof ProviderError && error.code === 'rejected') {
          return {
            state: 'failed',
            code: 'provider_error',
            retryable: false,
            message: 'Fixture delivery rejected.',
          };
        }
        return {
          state: 'unknown',
          actionId,
          message: 'Reconcile the fixture delivery before retrying.',
        };
      }
    },
    parseStatus(payload) {
      try {
        return email ? sesStatus(payload) : twilioStatus(payload);
      } catch {
        return null;
      }
    },
  };
}

export const createSesTestAdapter = (options: Options) => createAdapter(options, 'email');
export const createTwilioTestAdapter = (options: TwilioOptions) => createAdapter(options, 'sms');
