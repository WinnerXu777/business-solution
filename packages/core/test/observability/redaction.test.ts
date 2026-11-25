import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonLogger, redactText } from '../../src/observability/index.ts';

test('logger enforces redaction in messages, field names and nested values', () => {
  const lines: string[] = [];
  const logger = new JsonLogger({ write: (line) => lines.push(line), now: () => new Date(0) });
  const fields: Record<string, unknown> = {
    Authorization: 'unknown-auth',
    signing_key: 'unknown-key',
    nested: [
      { refreshToken: 'unknown-refresh', info: 'person@example.test or +1 (416) 555-0101 x34' },
    ],
    'name@example.test': 'an ordinary value',
    error: new Error('private stack data'),
  };
  fields.cycle = fields;
  logger.log(
    'info',
    'Bearer unknown-bearer secret="fictional phrase" with sk_test_1234567890',
    fields,
  );
  assert.equal(lines.length, 1);
  assert.doesNotMatch(
    lines[0],
    /unknown-|fictional phrase|sk_test|@example|416|0101|private stack/,
  );
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'info');
  assert.deepEqual(record.fields.nested, [
    { refreshToken: '[REDACTED]', info: '[REDACTED] or [REDACTED]' },
  ]);
  assert.equal(record.fields.cycle, '[REDACTED]');
  assert.equal(record.fields['[REDACTED]'], 'an ordinary value');
  assert.equal(redactText('Basic ZmljdGlvbg=='), '[REDACTED]');
  assert.equal(redactText('Cookie: a=first; session=second'), 'Cookie: [REDACTED]');
  assert.equal(redactText('Authorization: Bearer opaque'), 'Authorization: [REDACTED]');
});

test('log levels and sampling keep warnings and errors', () => {
  const seen: string[] = [];
  const logger = new JsonLogger({
    sampleRate: 0.5,
    random: () => 0.9,
    write: (line) => seen.push(JSON.parse(line).level),
  });
  logger.log('debug', 'fixture');
  logger.log('info', 'fixture');
  logger.log('warn', 'fixture');
  logger.log('error', 'fixture');
  assert.deepEqual(seen, ['warn', 'error']);
});
