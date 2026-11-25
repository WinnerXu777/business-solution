import { collect } from '../llm/collect.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpClient } from '../../src/llm/index.ts';
import {
  createElevenLabsAdapter,
  createFixtureSpeechToTextAdapter,
  createFixtureTextToSpeechAdapter,
  createNativeSpeechToTextAdapter,
  createNativeTextToSpeechAdapter,
  type SpeechToTextAdapter,
  type TextToSpeechAdapter,
} from '../../src/speech/index.ts';

const format = 'pcm_s16le_16000' as const;
const partial = { type: 'partial', segment: 0, text: 'Fictional' };
const final = { type: 'final', segment: 0, text: 'Fictional transcript.' };

async function* audio() {
  yield new Uint8Array([1, 2]);
  yield new Uint8Array([3, 4]);
}

function transcriptionContract(name: string, adapter: SpeechToTextAdapter) {
  test(name + ' streaming transcription contract', async () => {
    const signal = new AbortController().signal;
    const events = await collect(
      adapter.transcribe({ audio: audio(), sampleRateHz: 16000, signal }),
    );
    assert.deepEqual(events, [partial, final]);
    await assert.rejects(
      collect(
        adapter.transcribe({
          audio: audio(),
          sampleRateHz: 16000,
          signal: AbortSignal.abort(),
        }),
      ),
    );
  });
}

transcriptionContract('fixture', createFixtureSpeechToTextAdapter());
transcriptionContract(
  'native',
  createNativeSpeechToTextAdapter(async ({ method, path, headers, body, signal }) => {
    assert.equal(method, 'POST');
    assert.equal(path, '/speech/v1/transcriptions');
    assert.equal(headers['x-audio-sample-rate'], '16000');
    assert(signal instanceof AbortSignal);
    async function* stream() {
      const input = body as AsyncIterable<Uint8Array>;
      assert(input[Symbol.asyncIterator]);
      let count = 0;
      for await (const bytes of input) {
        assert.deepEqual([...bytes], count === 0 ? [1, 2] : [3, 4]);
        if (count++ === 0) yield Buffer.from('data: ' + JSON.stringify(partial) + '\n\n');
      }
      yield Buffer.from('data: ' + JSON.stringify(final) + '\n\ndata: [DONE]\n\n');
    }
    return {
      status: 200,
      async json() {
        assert.fail();
      },
      stream: stream(),
    };
  }),
);

function synthesisContract(name: string, adapter: TextToSpeechAdapter) {
  test(name + ' streaming synthesis contract', async () => {
    const signal = new AbortController().signal;
    const voices = await adapter.listVoices(signal);
    assert(voices.length >= 1);
    assert(voices.every(({ id, name }) => id && name));
    assert.equal(new Set(voices.map(({ id }) => id)).size, voices.length);
    const input = { voiceId: voices[0].id, text: 'Fictional utterance.', format, signal };
    const chunks = await collect(adapter.synthesize(input));
    assert.equal(chunks.length, 2);
    assert(
      chunks.every(
        (chunk) =>
          chunk.format === format && chunk.bytes instanceof Uint8Array && chunk.bytes.length > 0,
      ),
    );
    await assert.rejects(collect(adapter.synthesize({ ...input, signal: AbortSignal.abort() })));
  });
}

function speechFake(eleven: boolean): HttpClient {
  return async ({ method, path, headers, body, signal }) => {
    assert.equal(headers['xi-api-key'], eleven ? 'fictional-speech-key' : undefined);
    assert(signal instanceof AbortSignal);
    if (method === 'GET') {
      const voice = { name: 'Fictional voice', locale: 'en-CA' };
      if (!eleven) {
        assert.equal(path, '/speech/v1/voices');
        return {
          status: 200,
          async json() {
            return { voices: [{ ...voice, id: 'fictional/voice' }] };
          },
        };
      }
      if (path === '/v2/voices') {
        return {
          status: 200,
          async json() {
            return {
              voices: [{ ...voice, voice_id: 'fictional/voice' }],
              has_more: true,
              next_page_token: 'page+2',
            };
          },
        };
      }
      assert.equal(path, '/v2/voices?next_page_token=page%2B2');
      return {
        status: 200,
        async json() {
          return { voices: [{ ...voice, voice_id: 'fictional/voice2' }], has_more: false };
        },
      };
    }
    assert.equal(method, 'POST');
    const text = 'Fictional utterance.';
    if (eleven) {
      assert.equal(path, '/v1/text-to-speech/fictional%2Fvoice/stream?output_format=pcm_16000');
      assert.deepEqual(body, { text });
    } else {
      assert.equal(path, '/speech/v1/synthesize');
      assert.deepEqual(body, { text, voiceId: 'fictional/voice', format });
    }
    return {
      status: 200,
      async json() {
        assert.fail();
      },
      stream: audio(),
    };
  };
}

synthesisContract('fixture', createFixtureTextToSpeechAdapter());
synthesisContract('native', createNativeTextToSpeechAdapter(speechFake(false)));
synthesisContract('ElevenLabs', createElevenLabsAdapter(speechFake(true), 'fictional-speech-key'));
