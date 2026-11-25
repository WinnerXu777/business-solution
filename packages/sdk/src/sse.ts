import { ApiError } from './errors.ts';

export type SseEvent = { event: string; data: string; id?: string };

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let skipLf = false;
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  let finished = false;
  function readLine(value: string): SseEvent | undefined {
    if (!value) {
      const frame = data.length
        ? { event: event || 'message', data: data.join('\n'), id }
        : undefined;
      data = [];
      event = '';
      return frame;
    }
    const delimiter = value.indexOf(':');
    const field = delimiter < 0 ? value : value.slice(0, delimiter);
    const fieldValue = delimiter < 0 ? '' : value.slice(delimiter + 1).replace(/^ /, '');
    if (field === 'data') data.push(fieldValue);
    if (field === 'event') event = fieldValue;
    if (field === 'id' && !fieldValue.includes('\0')) id = fieldValue;
  }

  try {
    for (;;) {
      const chunk = await reader.read();
      finished = chunk.done;
      const text = decoder.decode(chunk.value, { stream: !finished });
      for (const char of text) {
        const ignore = skipLf && char === '\n';
        skipLf = char === '\r';
        if (ignore) continue;
        if (char === '\r' || char === '\n') {
          const frame = readLine(line);
          line = '';
          if (frame) yield frame;
        } else {
          line += char;
        }
      }
      if (finished) return;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* responseEvents(response: Response): AsyncGenerator<SseEvent> {
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream'
  ) {
    await response.body?.cancel().catch(() => {});
    throw new ApiError('expected_event_stream', response.status);
  }
  yield* parseSse(response.body);
}

export function eventJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new ApiError('invalid_event_json');
  }
}
