import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  emailAddress,
  emailSecret,
  harness,
  otherId,
  smsNumber,
  smsSecret,
  smsUrl,
  staffHeaders,
  tenantId,
} from './harness.ts';

test('verifies SES bridge deliveries, deduplicates retries and threads scoped references', async (t) => {
  const { app, conversations } = await harness(t);
  function send(
    receipt: string,
    id: string,
    reference?: string,
    source = 'visitor@customer.example',
    valid = true,
    target = tenantId,
  ) {
    const payload = JSON.stringify({
      Records: [
        {
          eventSource: 'aws:ses',
          ses: {
            mail: {
              source,
              messageId: receipt,
              headers: [
                { name: 'Message-ID', value: '<' + id + '>' },
                { name: 'Subject', value: 'Fictional stock question' },
                ...(reference ? [{ name: 'References', value: '<' + reference + '>' }] : []),
              ],
            },
            receipt: { recipients: [emailAddress] },
            text: 'Synthetic email ' + receipt,
          },
        },
      ],
    });
    return app.inject({
      method: 'POST',
      url: '/channels/inbound/email/' + target,
      payload,
      headers: {
        'content-type': 'application/json',
        'x-channel-signature': valid
          ? createHmac('sha256', emailSecret).update(payload).digest('hex')
          : '0'.repeat(64),
      },
    });
  }
  assert.equal(
    (await send('receipt-1', 'root@customer.example', undefined, undefined, false)).statusCode,
    401,
  );
  const first = await send('receipt-1', 'root@customer.example');
  assert.equal(first.statusCode, 202);
  assert.equal(
    (await send('receipt-1', 'root@customer.example', undefined, undefined, true, otherId))
      .statusCode,
    401,
  );
  const [{ conversationId, duplicate }] = first.json().receipts;
  assert.equal(duplicate, false);
  assert.deepEqual((await send('receipt-1', 'root@customer.example')).json().receipts, [
    { conversationId, duplicate: true },
  ]);
  const reply = await send('receipt-2', 'reply@customer.example', 'root@customer.example');
  assert.deepEqual(reply.json().receipts, [{ conversationId, duplicate: false }]);
  const differentSender = await send(
    'receipt-3',
    'foreign@customer.example',
    'root@customer.example',
    'other@customer.example',
  );
  assert.notEqual(differentSender.json().receipts[0].conversationId, conversationId);
  const transcript = conversations.transcript({ tenantId, conversationId });
  assert.equal(transcript.length, 2);
  assert.equal(transcript[0].metadata.channel, 'email');
  assert.equal(transcript[1].text, 'Synthetic email receipt-2');
});

test('checks SMS signatures, deduplicates concurrent retries and records STOP and HELP once', async (t) => {
  const { app, consent } = await harness(t);
  const from = '+14165550107';
  function send(sid: string, text: string, valid = true, to = smsNumber, target = tenantId) {
    const form = { From: from, To: to, MessageSid: sid, Body: text };
    const payload = new URLSearchParams(form).toString();
    const material = Object.entries(form)
      .sort(([a], [b]) => (a < b ? -1 : Number(a !== b)))
      .reduce((str, [name, value]) => str + name + value, smsUrl);
    return app.inject({
      method: 'POST',
      url: '/channels/inbound/sms/' + target,
      payload,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': valid
          ? createHmac('sha1', smsSecret).update(material).digest('base64')
          : 'not-valid',
      },
    });
  }
  assert.equal((await send('SM-original', 'Fictional question', false)).statusCode, 401);
  assert.equal(
    (await send('SM-wrong-recipient', 'Fictional question', true, '+14165550103')).statusCode,
    400,
  );
  assert.equal((await send('SM-original', 'Fictional question')).body, '<Response/>');
  assert.equal(
    (await send('SM-original', 'Fictional question', true, smsNumber, otherId)).statusCode,
    401,
  );
  const results = await Promise.all([
    send('SM-stop', ' stop '),
    send('SM-stop', ' stop '),
    send('SM-help', 'HELP'),
  ]);
  assert(results.every(({ statusCode }) => statusCode === 200));
  assert.deepEqual(
    consent.sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      {
        tenantId,
        channel: 'sms',
        address: from,
        recipient: smsNumber,
        receiptId: 'SM-help',
        kind: 'help_requested',
      },
      {
        tenantId,
        channel: 'sms',
        address: from,
        recipient: smsNumber,
        receiptId: 'SM-stop',
        kind: 'opt_out',
      },
    ],
  );
  const queue = await app.inject({ url: '/channels/staff/queue', headers: staffHeaders });
  const [item] = queue.json().conversations;
  assert.equal(queue.json().conversations.length, 1);
  const url = '/channels/staff/conversations/' + item.conversationId;
  await app.inject({ method: 'POST', url: url + '/claim', headers: staffHeaders });
  const details = (await app.inject({ url, headers: staffHeaders })).json();
  assert.deepEqual(
    details.transcript
      .map(({ metadata }: { metadata: { messageSid: string } }) => metadata.messageSid)
      .sort(),
    ['SM-help', 'SM-original', 'SM-stop'],
  );
});
