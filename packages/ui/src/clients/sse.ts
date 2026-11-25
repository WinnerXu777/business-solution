import { PlatformError } from '../platform-client.ts';

export type OpenStream = (path: string, init: RequestInit) => Promise<Response>;

export async function* sseData(response: Response, signal: AbortSignal) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new PlatformError('unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done || signal.aborted) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !signal.aborted) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (!line && data.length) {
          yield data.join('\n');
          data = [];
        }
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
