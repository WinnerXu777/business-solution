import { createHmac, timingSafeEqual } from 'node:crypto';

export class InboundError extends Error {
  readonly status: 400 | 401;

  constructor(status: 400 | 401) {
    super(status === 401 ? 'invalid_signature' : 'invalid_payload');
    this.status = status;
  }
}

const invalid = () => new InboundError(400);

function verify(expected: string, supplied: string | undefined) {
  if (
    !supplied ||
    supplied.length !== expected.length ||
    Buffer.byteLength(supplied) !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    throw new InboundError(401);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function field(value: unknown, length = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > length) throw invalid();
  return value.trim();
}

const phone = /^\+[1-9]\d{7,14}$/;

export function parseTwilioInbound(
  raw: string,
  signature: string | undefined,
  url: string,
  secret: string,
) {
  const form = new URLSearchParams(raw);
  const fields = new Map<string, string>();
  for (const [name, value] of form) {
    if (fields.has(name)) throw invalid();
    fields.set(name, value);
    if (fields.size > 100) throw invalid();
  }
  const material = [...fields.keys()]
    .sort()
    .reduce((input, name) => input + name + fields.get(name), url);
  verify(createHmac('sha1', secret).update(material).digest('base64'), signature);
  const from = field(fields.get('From'));
  const to = field(fields.get('To'));
  const messageSid = field(fields.get('MessageSid'));
  const text = field(fields.get('Body'), 4096);
  if (!phone.test(from) || !phone.test(to)) throw invalid();
  const command = text.toUpperCase();
  const keyword = [
    'STOP',
    'STOPALL',
    'UNSUBSCRIBE',
    'CANCEL',
    'END',
    'QUIT',
    'REVOKE',
    'OPTOUT',
  ].includes(command)
    ? 'STOP'
    : ['HELP', 'INFO'].includes(command)
      ? 'HELP'
      : undefined;
  return { from, to, messageSid, text, keyword } as const;
}

const messageIds = (value: unknown) =>
  typeof value === 'string'
    ? [...value.matchAll(/<([^<>\s]{1,250})>/g)].slice(-50).map((match) => match[1])
    : [];

function email(value: unknown) {
  const address = field(value, 320).toLowerCase();
  if (!/^[^<>\s@]+@[^<>\s@]+$/.test(address)) throw invalid();
  return address;
}

/**
 * A trusted SES receipt bridge adds decoded plain text and signs the raw delivery.
 * SES receipt metadata alone carries headers and routing, without a message body.
 */
export function parseSesInbound(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
  recipient: string,
) {
  verify(createHmac('sha256', secret).update(raw).digest('hex'), signature);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid();
  }
  const records = object(payload).Records;
  if (!Array.isArray(records) || !records.length || records.length > 20) throw invalid();

  return records.map((value: unknown) => {
    const record = object(value);
    if (record.eventSource !== 'aws:ses') throw invalid();
    const ses = object(record.ses);
    const mail = object(ses.mail);
    const receipt = object(ses.receipt);
    const to = email(recipient);
    if (
      !Array.isArray(receipt.recipients) ||
      !receipt.recipients.some((address) => email(address) === to)
    ) {
      throw invalid();
    }
    const headers = new Map<string, string>();
    if (!Array.isArray(mail.headers) || mail.headers.length > 1000) throw invalid();
    for (const value of mail.headers as unknown[]) {
      const header = object(value);
      const name = field(header.name, 100).toLowerCase();
      if (['message-id', 'in-reply-to', 'references', 'subject'].includes(name)) {
        headers.set(name, field(header.value, 8192));
      }
    }
    const receiptId = field(mail.messageId);
    const messageId = messageIds(headers.get('message-id'))[0] ?? receiptId;
    const references = [
      ...messageIds(headers.get('in-reply-to')),
      ...messageIds(headers.get('references')).reverse(),
    ];
    return {
      receiptId,
      messageId,
      references,
      from: email(mail.source),
      to,
      subject: headers.get('subject') ?? '',
      text: field(ses.text, 32_768),
    };
  });
}
