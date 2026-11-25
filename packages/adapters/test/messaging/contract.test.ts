import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessagePreview } from '@bs/contracts';
import type { HttpClient } from '../../src/llm/index.ts';
import {
  createSesTestAdapter,
  createTwilioTestAdapter,
  type TestMessageAdapter,
} from '../../src/messaging/index.ts';

const email = 'recipient@rivetquay.example';
const sms = '+14165550101';
const fromEmail = 'fixture@rivetquay.example';
const fromNumber = '+14165550100';
const body = 'Synthetic message';
const accountSid = 'fictional-account';
const actionId = 'action-01';
const receiptId = 'receipt-01';

function messagingContract(
  channel: 'email' | 'sms',
  create: (client: HttpClient) => TestMessageAdapter,
  provider: string,
  callback: unknown,
  inspect: HttpClient,
) {
  test(provider + ' messaging contract', async () => {
    const adapter = create(inspect);
    const preview: MessagePreview = {
      id: 'preview-01',
      tenantId: 'fictional-tenant',
      channel,
      customerId: 'fictional-customer',
      customerVersion: 1,
      recipient: channel === 'email' ? email : sms,
      subject: null,
      sourceId: 'fixture-note',
      sourceVersion: 1,
      body,
    };
    assert.deepEqual(await adapter.send(preview, actionId), {
      id: receiptId,
      channel,
      status: 'simulated',
      providerId: provider,
    });
    assert.deepEqual(adapter.parseStatus(callback), { receiptId, channel, status: 'delivered' });
    assert.equal(adapter.parseStatus({ data: 'fictional malformed payload' }), null);
    const invalid = await adapter.send({ ...preview, recipient: 'not-a-fixture' }, actionId);
    assert('state' in invalid && invalid.state === 'failed' && invalid.code === 'invalid_input');
    const lost = create(async () => {
      throw new Error('fictional message body that must not appear');
    });
    assert.deepEqual(await lost.send(preview, actionId), {
      state: 'unknown',
      actionId,
      message: 'Reconcile the fixture delivery before retrying.',
    });
  });
}

messagingContract(
  'email',
  (client) => createSesTestAdapter({ mode: 'test', from: fromEmail, client }),
  'ses-test',
  {
    Type: 'Notification',
    Message: JSON.stringify({
      eventType: 'Delivery',
      mail: {
        messageId: receiptId,
        destination: [email],
      },
    }),
  },
  async (request) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v2/email/outbound-emails');
    assert.deepEqual(request.body, {
      FromEmailAddress: fromEmail,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: { Subject: { Data: 'Fictional message' }, Body: { Text: { Data: body } } },
      },
      EmailTags: [{ Name: 'action_id', Value: actionId }],
    });
    return {
      status: 200,
      async json() {
        return { MessageId: receiptId };
      },
    };
  },
);

messagingContract(
  'sms',
  (client) => createTwilioTestAdapter({ mode: 'test', from: fromNumber, accountSid, client }),
  'twilio-test',
  new URLSearchParams({ MessageSid: receiptId, MessageStatus: 'delivered', To: sms }).toString(),
  async (request) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/2010-04-01/Accounts/fictional-account/Messages.json');
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(request.body))), {
      From: fromNumber,
      To: sms,
      Body: body,
    });
    return {
      status: 201,
      async json() {
        return { sid: receiptId };
      },
    };
  },
);
