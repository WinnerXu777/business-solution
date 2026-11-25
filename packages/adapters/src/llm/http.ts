import { ProviderError } from './contracts.ts';

export type ByteStream = AsyncIterable<Uint8Array>;
export type HttpClient = (request: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown>; stream?: ByteStream }>;

export async function request(client: HttpClient, input: Parameters<HttpClient>[0]) {
  input.signal?.throwIfAborted();
  let response: Awaited<ReturnType<HttpClient>>;
  try {
    response = await client(input);
  } catch {
    throw new ProviderError('unavailable');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ProviderError(
      response.status === 408 || response.status === 429 || response.status >= 500
        ? 'unavailable'
        : 'rejected',
    );
  }
  return response;
}

export async function json(response: Awaited<ReturnType<HttpClient>>) {
  try {
    return await response.json();
  } catch {
    throw new ProviderError('invalid_response');
  }
}

export async function* sse(stream: ByteStream | undefined): AsyncGenerator<string> {
  if (!stream) throw new ProviderError('invalid_response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data: string[] = [];
  let frameSize = 0;
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        frameSize += line.length + 1;
        if (frameSize > 1_048_576) throw new ProviderError('invalid_response');
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
          frameSize = 0;
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (pending.length + frameSize > 1_048_576) throw new ProviderError('invalid_response');
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('unavailable');
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('invalid_response');
  }
}
