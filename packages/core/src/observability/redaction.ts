const replacement = '[REDACTED]';
const sensitiveKey =
  /authorization|cookie|secret|password|passwd|token|apikey|privatekey|signingkey|credential|connectionstring|databaseurl|email|phone|headers|prompt|stacktrace/;
const namedValue =
  /\b((?:[\w-]*(?:secret|token|password|passwd|credential)[\w-]*|(?:api|private|signing)[_ -]?key|connection[_ -]?string|database[_ -]?url)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi;

export function redactText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,
      replacement,
    )
    .replace(
      /\b((?:proxy-)?authorization|(?:set-)?cookie)["']?\s*[:=]\s*[^\r\n]+/gi,
      '$1: ' + replacement,
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, replacement)
    .replace(namedValue, '$1' + replacement)
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s/@]+@/gi, replacement + '@')
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk|rk|pk|xox[baprs]|gh[pousr]|github_pat)[_-][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
      replacement,
    )
    .replace(/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, replacement)
    .replace(
      /(?<![\p{L}\d])\+?(?:\(\d{1,4}\)|\d)(?:[ .()\u00a0-]*\d){6,14}(?:\s*(?:ext\.?|x|#)\s*\d+)?(?![\p{L}\d])/gu,
      replacement,
    );
}

export type TelemetryValue =
  | null
  | boolean
  | number
  | string
  | TelemetryValue[]
  | { [key: string]: TelemetryValue };

export function redact(value: unknown, ancestors = new Set<object>()): TelemetryValue {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return null;
  if (value instanceof Error) return '[Error]';
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    return replacement;
  if (ancestors.has(value) || ancestors.size >= 12) return replacement;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: Math.min(value.length, 100) }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(value, index);
        return redact(item?.value, ancestors);
      });
    }
    return Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(value))
        .filter(([, descriptor]) => descriptor.enumerable)
        .slice(0, 100)
        .map(([key, descriptor]) => [
          redactText(key),
          sensitiveKey.test(key.toLowerCase().replace(/[^a-z\d]/g, ''))
            ? replacement
            : redact(descriptor.value, ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}
