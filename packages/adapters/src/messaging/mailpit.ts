import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import type { MessagePreview, DeliveryReceipt, Failed, Unknown } from '@bs/contracts';

export type MailpitOptions = { host?: string; port?: number };

const sender = 'automation@rivetquay.example';
const fixtureEmail = /^[a-z0-9._+-]+@[a-z0-9.-]+\.example$/i;

export async function sendToMailpit(
  preview: MessagePreview,
  actionId: string,
  { host = '127.0.0.1', port = 1025 }: MailpitOptions,
  connect: (host: string, port: number) => Duplex = (host, port) =>
    createConnection({ host, port }),
): Promise<DeliveryReceipt | Failed | Unknown> {
  const subject = preview.subject ?? 'Fixture message';
  if (
    process.env.CI ||
    !['127.0.0.1', '::1', 'localhost'].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    preview.channel !== 'email' ||
    !fixtureEmail.test(preview.recipient) ||
    /[\r\n]/.test(subject) ||
    !/^[a-zA-Z0-9._:-]+$/.test(actionId)
  ) {
    return {
      state: 'failed',
      code: 'invalid_input',
      message: 'Invalid local Mailpit configuration or fixture message.',
      retryable: false,
    };
  }

  let submitted = false;
  let socket: Duplex | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    socket = connect(host === 'localhost' ? '127.0.0.1' : host, port);
    const stream = socket;
    timeout = setTimeout(() => stream.destroy(new Error('SMTP timeout')), 5000);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      const responses = lines[Symbol.asyncIterator]();
      async function expect(code: number) {
        for (;;) {
          const { value, done } = await responses.next();
          if (done || !value.startsWith(String(code))) throw new Error('Unexpected SMTP reply');
          if (value[3] === ' ') return;
          if (value[3] !== '-') throw new Error('Invalid SMTP reply');
        }
      }
      async function command(line: string, code: number) {
        stream.write(line + '\r\n');
        await expect(code);
      }
      await expect(220);
      await command('EHLO rivetquay.example', 250);
      await command('MAIL FROM:<' + sender + '>', 250);
      await command('RCPT TO:<' + preview.recipient + '>', 250);
      await command('DATA', 354);
      const body = preview.body.replace(/\r\n|\r|\n/g, '\r\n').replace(/^\./gm, '..');
      submitted = true;
      await command(
        [
          'From: ' + sender,
          'To: ' + preview.recipient,
          'Subject: ' + subject,
          'Message-ID: <' + actionId + '@rivetquay.example>',
          'Content-Type: text/plain; charset=UTF-8',
          '',
          body,
          '.',
        ].join('\r\n'),
        250,
      );
      stream.end('QUIT\r\n');
      return {
        id: 'receipt-' + actionId,
        channel: 'email',
        status: 'captured',
        providerId: 'mailpit',
      };
    } finally {
      lines.close();
    }
  } catch {
    return submitted
      ? {
          state: 'unknown',
          actionId,
          message: 'Check Mailpit before retrying this fixture delivery.',
        }
      : {
          state: 'failed',
          code: 'provider_error',
          message: 'Mailpit did not accept the fixture message.',
          retryable: true,
        };
  } finally {
    clearTimeout(timeout);
    socket?.destroy();
  }
}
