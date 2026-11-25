import { ProviderError, count, list, object, string } from '../llm/contracts.ts';
import { json, parseJson, request, sse, type ByteStream, type HttpClient } from '../llm/http.ts';

export type AudioFormat = 'pcm_s16le_16000' | 'mp3_44100_128';
export type Voice = { id: string; name: string; locale?: string };
export type AudioChunk = { bytes: Uint8Array; format: AudioFormat };
export type Synthesis = {
  text: string;
  voiceId: string;
  format: AudioFormat;
  signal?: AbortSignal;
};
export type Transcription = {
  audio: ByteStream;
  sampleRateHz: 8000 | 16000;
  locale?: string;
  signal?: AbortSignal;
};
export type Transcript = { type: 'partial' | 'final'; segment: number; text: string };

export interface SpeechToTextAdapter {
  transcribe(input: Transcription): AsyncIterable<Transcript>;
}
export interface TextToSpeechAdapter {
  listVoices(signal?: AbortSignal): Promise<Voice[]>;
  synthesize(input: Synthesis): AsyncIterable<AudioChunk>;
}

export function createFixtureSpeechToTextAdapter(
  text = 'Fictional transcript.',
): SpeechToTextAdapter {
  return {
    async *transcribe({ audio, signal }) {
      signal?.throwIfAborted();
      let receivedAudio = false;
      for await (const bytes of audio) {
        signal?.throwIfAborted();
        if (!receivedAudio && bytes.length) {
          receivedAudio = true;
          yield { type: 'partial', segment: 0, text: text.split(' ')[0] };
        }
      }
      signal?.throwIfAborted();
      if (receivedAudio) yield { type: 'final', segment: 0, text };
    },
  };
}

export function createNativeSpeechToTextAdapter(client: HttpClient): SpeechToTextAdapter {
  return {
    async *transcribe({ audio, sampleRateHz, locale, signal }) {
      const response = await request(client, {
        method: 'POST',
        path: '/speech/v1/transcriptions',
        headers: {
          'content-type': 'application/octet-stream',
          accept: 'text/event-stream',
          'x-audio-sample-rate': String(sampleRateHz),
          ...(locale ? { 'x-speech-locale': locale } : {}),
        },
        body: audio,
        signal,
      });
      for await (const data of sse(response.stream)) {
        signal?.throwIfAborted();
        if (data === '[DONE]') return;
        const event = object(parseJson(data));
        if (event.type !== 'partial' && event.type !== 'final')
          throw new ProviderError('invalid_response');
        yield { type: event.type, segment: count(event.segment), text: string(event.text) };
      }
      throw new ProviderError('unavailable');
    },
  };
}

export function createFixtureTextToSpeechAdapter(): TextToSpeechAdapter {
  const voice = { id: 'fixture-voice', name: 'Fictional voice', locale: 'en-CA' };
  return {
    async listVoices(signal) {
      signal?.throwIfAborted();
      return [{ ...voice }];
    },
    async *synthesize({ text, voiceId, format, signal }) {
      signal?.throwIfAborted();
      if (voiceId !== voice.id || format !== 'pcm_s16le_16000')
        throw new ProviderError('unsupported');
      // Emit two small, deterministic PCM buffers. No codec or model process is required.
      for (const value of [text.length, 0]) {
        signal?.throwIfAborted();
        const bytes = Buffer.alloc(320);
        bytes.writeInt16LE(value % 32768);
        yield { bytes, format };
      }
    },
  };
}

function httpSpeech(client: HttpClient, apiKey?: string): TextToSpeechAdapter {
  const eleven = apiKey !== undefined;
  const headers: Record<string, string> = eleven ? { 'xi-api-key': apiKey } : {};
  return {
    async listVoices(signal) {
      const voices: Voice[] = [];
      let next: string | undefined;
      const seen = new Set<string>();
      do {
        const path = eleven
          ? '/v2/voices' + (next ? '?next_page_token=' + encodeURIComponent(next) : '')
          : '/speech/v1/voices';
        const response = await request(client, { method: 'GET', path, headers, signal });
        const result = object(await json(response));
        for (const raw of list(result.voices)) {
          const item = object(raw);
          const locale = typeof item.locale === 'string' ? item.locale : undefined;
          voices.push({
            id: string(eleven ? item.voice_id : item.id),
            name: string(item.name),
            ...(locale ? { locale } : {}),
          });
        }
        if (!eleven || result.has_more !== true) break;
        next = string(result.next_page_token);
        if (!next || seen.has(next) || seen.size >= 100)
          throw new ProviderError('invalid_response');
        seen.add(next);
      } while (next);
      return voices;
    },
    async *synthesize({ text, voiceId, format, signal }) {
      const output = format === 'pcm_s16le_16000' ? 'pcm_16000' : 'mp3_44100_128';
      const response = await request(client, {
        method: 'POST',
        path: eleven
          ? '/v1/text-to-speech/' + encodeURIComponent(voiceId) + '/stream?output_format=' + output
          : '/speech/v1/synthesize',
        headers: { ...headers, 'content-type': 'application/json' },
        body: eleven ? { text } : { text, voiceId, format },
        signal,
      });
      if (!response.stream) throw new ProviderError('invalid_response');
      for await (const bytes of response.stream) {
        signal?.throwIfAborted();
        if (bytes.length) yield { bytes, format };
      }
    },
  };
}

export const createNativeTextToSpeechAdapter = (client: HttpClient) => httpSpeech(client);

export function createElevenLabsAdapter(client: HttpClient, apiKey: string): TextToSpeechAdapter {
  if (!apiKey) throw new ProviderError('rejected');
  return httpSpeech(client, apiKey);
}
