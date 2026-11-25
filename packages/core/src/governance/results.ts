import { createHash } from 'node:crypto';
import type { Denied, Failed, Unknown } from '@bs/contracts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function ok<Output>(output: Output) {
  return { state: 'ok' as const, output };
}

export function denied(code: Denied['code']): Denied {
  return { state: 'denied', code, message: code.replaceAll('_', ' ') };
}

export function lookup<Output>(output: Output | undefined) {
  return output === undefined ? denied('not_found') : ok(output);
}

export function unavailable(): Failed {
  return { state: 'failed', code: 'unavailable', message: 'Tool unavailable.', retryable: true };
}

export function invalidInput(message: string): Failed {
  return { state: 'failed', code: 'invalid_input', message, retryable: false };
}

export function unknownOutcome(actionId: string): Unknown {
  return { state: 'unknown', actionId, message: 'Action needs reconciliation.' };
}
