import type { Denied, Failed, Unknown } from './generated/contracts.ts';

export class ApiError<Code extends string = string> extends Error {
  readonly code: Code;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(code: Code, status?: number, requestId?: string, retryAfterMs?: number) {
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
  }
}

export class DenialError extends ApiError<Denied['code']> {}
export class ToolFailure extends ApiError<Failed['code']> {
  readonly retryable: boolean;

  constructor(retryable: boolean, code: Failed['code']) {
    super(code);
    this.retryable = retryable;
  }
}
export class UnknownOutcome extends ApiError<'outcome_unknown'> {
  readonly actionId: string;

  constructor(actionId: string) {
    super('outcome_unknown');
    this.actionId = actionId;
  }
}

const denialCodes: Record<Denied['code'], true> = {
  forbidden: true,
  not_found: true,
  module_disabled: true,
  quota_exceeded: true,
  invalid_approval: true,
  suppressed: true,
  idempotency_conflict: true,
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorCode(payload: unknown, fallback: string): string {
  if (!isObject(payload)) return fallback;
  const candidate = isObject(payload.error) ? payload.error.code : (payload.error ?? payload.code);
  return typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(candidate)
    ? candidate
    : fallback;
}

export function responseError(
  response: Response,
  payload: unknown,
  retryAfterMs?: number,
): ApiError {
  const fallback = response.status === 404 ? 'not_found' : `http_${response.status}`;
  const code = errorCode(payload, fallback);
  const id = response.headers.get('x-request-id') ?? undefined;
  if (Object.hasOwn(denialCodes, code)) {
    return new DenialError(code as Denied['code'], response.status, id, retryAfterMs);
  }
  return new ApiError(code, response.status, id, retryAfterMs);
}

type ToolProblem = Denied | Failed | Unknown;
export type ToolSuccess<Result> = Exclude<Result, ToolProblem>;

export function unwrapTool<Result extends { state: string }>(result: Result): ToolSuccess<Result> {
  if (!isObject(result)) throw new ApiError('invalid_tool_result');
  switch (result.state) {
    case 'denied':
      if (!('code' in result) || !Object.hasOwn(denialCodes, String(result.code))) break;
      throw new DenialError(result.code as Denied['code']);
    case 'failed':
      if (
        !('code' in result) ||
        !['invalid_input', 'provider_error', 'unavailable'].includes(String(result.code))
      )
        break;
      throw new ToolFailure(
        'retryable' in result && result.retryable === true,
        result.code as Failed['code'],
      );
    case 'unknown':
      if (!('actionId' in result) || typeof result.actionId !== 'string') break;
      throw new UnknownOutcome(result.actionId);
    case 'ok':
    case 'pending_approval':
      return result as ToolSuccess<Result>;
  }
  throw new ApiError('invalid_tool_result');
}
