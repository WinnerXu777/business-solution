import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { loadDemoFixtures, type CompleteLlmInput, type MessagePreview } from '@bs/contracts';
import { createFixtureRouter } from '../../../../packages/adapters/src/llm/index.ts';
import { createMessagingAdapters } from '../../../../packages/adapters/src/messaging/index.ts';
import { sendToMailpit } from '../../../../packages/adapters/src/messaging/mailpit.ts';

const preview: MessagePreview = {
  id: 'preview-1',
  tenantId: 'tenant-rivetquay',
  channel: 'email',
  customerId: 'cust-001',
  customerVersion: 1,
  recipient: 'orders1@rivetquay.example',
  sourceId: 'inv-001',
  sourceVersion: 1,
  subject: 'Fixture reminder',
  body: 'Test message\n.line',
};

test('fixture model routes truncate deterministically and propose the same typed tool', async () => {
  const router = createFixtureRouter();
  for (const route of loadDemoFixtures().llmRoutes) {
    const input: CompleteLlmInput = {
      model: 'fixture-chat',
      turns: [{ role: 'user', content: 'Draft voice for inv-001' }],
      maxOutputTokens: 3,
      route,
    };
    const reply = await router.complete(input);
    assert.deepEqual(reply, await router.complete(input));
    assert.equal(reply.outputTokens, 3);
    assert.equal(reply.route.providerId, route.providerId);
    assert.deepEqual(router.propose(input), {
      tool: 'message.preview',
      input: { invoiceId: 'inv-001', channel: 'voice' },
    });
    assert.throws(() => router.propose({ ...input, route: { ...route, fixtureMode: false } }));
  }
});

test('local SMTP captures only after DATA acceptance, with a fake SMTP stream', async (t) => {
  const ci = process.env.CI;
  delete process.env.CI;
  t.after(() => {
    if (ci !== undefined) process.env.CI = ci;
  });
  const writes: string[] = [];
  let acceptData = true;
  function connect(host: string, port: number) {
    assert.equal(host, '127.0.0.1');
    assert.equal(port, 2025);
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        writes.push(text);
        const reply = text.startsWith('EHLO')
          ? '250-Hello\r\n250 SMTP\r\n'
          : text === 'DATA\r\n'
            ? '354 Ready\r\n'
            : text.startsWith('From:') && !acceptData
              ? null
              : '250 Accepted\r\n';
        this.push(reply);
        callback();
      },
    });
    socket.push('220 Mailpit\r\n');
    return socket;
  }
  const options = { host: 'localhost', port: 2025 };
  const result = await sendToMailpit(preview, 'action-1', options, connect);
  assert.deepEqual(result, {
    id: 'receipt-action-1',
    status: 'captured',
    channel: 'email',
    providerId: 'mailpit',
  });
  assert.equal(writes[2], 'RCPT TO:<orders1@rivetquay.example>\r\n');
  assert.match(writes[4], /\r\n\r\nTest message\r\n\.\.line\r\n\.\r\n$/);
  acceptData = false;
  const unknown = await sendToMailpit(preview, 'action-2', options, connect);
  assert.equal('state' in unknown && unknown.state, 'unknown');
  const outside = await sendToMailpit(preview, 'action-3', { host: 'smtp.example' }, () => {
    assert.fail('SMTP must not connect outside loopback');
  });
  assert.equal('state' in outside && outside.state, 'failed');
});

test('CI disables email capture and voice and SMS always use simulated receipts', async (t) => {
  const ci = process.env.CI;
  process.env.CI = 'true';
  t.after(() => {
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
  });
  const adapters = createMessagingAdapters({ enabled: true }, () =>
    assert.fail('SMTP must remain off in CI'),
  );
  for (const channel of ['email', 'voice', 'sms'] as const) {
    const receipt = await adapters[channel].send({ ...preview, channel }, 'action-1');
    assert.deepEqual(receipt, {
      id: 'receipt-action-1',
      status: 'simulated',
      channel,
      providerId: 'fixture-' + channel,
    });
  }
});
