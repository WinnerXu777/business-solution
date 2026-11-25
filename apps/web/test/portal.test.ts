import assert from 'node:assert/strict';
import test from 'node:test';
import { resultText } from '../src/presentation.ts';
import { localVoice } from '../src/speech.ts';

test('portal distinguishes a held message from unavailable records and captured email', () => {
  assert.equal(
    resultText({ state: 'denied', code: 'suppressed', message: 'suppressed' }),
    'Outreach is on hold for this invoice.',
  );
  assert.equal(
    resultText({ state: 'denied', code: 'not_found', message: 'not found' }),
    'Record unavailable.',
  );
  assert.equal(
    resultText({
      state: 'ok',
      output: { id: 'receipt-1', providerId: 'mailpit', channel: 'email', status: 'captured' },
    }),
    'Email captured in Mailpit.',
  );
});

test('fixture playback uses available local English voices only', () => {
  const voice = (lang: string, localService: boolean) =>
    ({ lang, localService }) as SpeechSynthesisVoice;
  const cloud = voice('en-CA', false);
  const english = voice('en-US', true);
  const canadian = voice('en-CA', true);
  assert.equal(localVoice([cloud]), undefined);
  assert.equal(localVoice([cloud, english]), english);
  assert.equal(localVoice([cloud, english, canadian]), canadian);
});
