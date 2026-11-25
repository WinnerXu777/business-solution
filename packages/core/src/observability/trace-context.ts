export interface TraceContext {
  traceId: string;
  spanId: string;
  flags: number;
}

const hex = /^[0-9a-f]+$/;
export function validTraceId(id: string, length = 32): boolean {
  return id.length === length && hex.test(id) && /[1-9a-f]/.test(id);
}

export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const match = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(.*)$/.exec(value);
  if (!match || match[0] !== value) return undefined;
  const [, version, traceId, spanId, flags, extra] = match;
  if (
    version === 'ff' ||
    (extra && (version === '00' || !extra.startsWith('-') || /[\s,]/.test(extra))) ||
    !validTraceId(traceId) ||
    !validTraceId(spanId, 16)
  ) {
    return undefined;
  }
  return { traceId, spanId, flags: Number.parseInt(flags, 16) };
}

export function formatTraceparent({ traceId, spanId, flags }: TraceContext): string {
  if (
    !validTraceId(traceId) ||
    !validTraceId(spanId, 16) ||
    !Number.isInteger(flags) ||
    flags < 0 ||
    flags > 255
  ) {
    throw new RangeError('Invalid trace context');
  }
  return '00-' + traceId + '-' + spanId + '-' + flags.toString(16).padStart(2, '0');
}
