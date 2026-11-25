import { ProviderError, object, string } from '../llm/contracts.ts';
import { json, request, type HttpClient } from '../llm/http.ts';

export type CallStatus = 'queued' | 'ringing' | 'active' | 'transferred' | 'ended' | 'failed';
export type Call = { callId: string; status: CallStatus };
export type StartCall = { actionId: string; from: string; to: string };
export type CallEvent = Call & { eventId: string };

export interface TelephonyAdapter {
  start(input: StartCall): Promise<Call>;
  transfer(callId: string, target: string): Promise<Call>;
  hangup(callId: string): Promise<Call>;
  /** Parse an event after the caller has verified the webhook source. */
  parseStatus(body: unknown): CallEvent | null;
}

const fictionalNumber = /^\+1[2-9]\d{2}55501\d{2}$/;
const action = /^[a-zA-Z0-9._:-]{1,128}$/;

function checkStart(input: StartCall) {
  if (
    !action.test(input.actionId) ||
    !fictionalNumber.test(input.from) ||
    !fictionalNumber.test(input.to)
  ) {
    throw new ProviderError('rejected');
  }
}

const statuses: Record<string, CallStatus> = {
  QUEUED: 'queued',
  RINGING: 'ringing',
  CONNECTED: 'active',
  TRANSFERRED: 'transferred',
  DISCONNECTED: 'ended',
  FAILED: 'failed',
};

function decodeCall(value: unknown): Call {
  const data = object(value);
  const status = string(data.status);
  const callId = string(data.callId);
  if (!callId || !Object.hasOwn(statuses, status)) throw new ProviderError('invalid_response');
  return { callId, status: statuses[status] };
}

function parseStatus(value: unknown): CallEvent | null {
  try {
    const event = object(value);
    if (event.eventType !== 'CALL_STATUS') return null;
    const eventId = string(event.eventId);
    return eventId ? { eventId, ...decodeCall(event.data) } : null;
  } catch {
    return null;
  }
}

export function createFixtureTelephonyAdapter(): TelephonyAdapter {
  const calls = new Map<string, { status: CallStatus; input: StartCall }>();
  const existing = (id: string) => {
    const call = calls.get(id);
    if (!call) throw new ProviderError('rejected');
    return call;
  };
  return {
    async start(input) {
      checkStart(input);
      const callId = 'call-' + input.actionId;
      const prior = calls.get(callId);
      if (prior && (prior.input.from !== input.from || prior.input.to !== input.to)) {
        throw new ProviderError('rejected');
      }
      if (prior) return { callId, status: prior.status };
      calls.set(callId, { input: { ...input }, status: 'queued' });
      return { callId, status: 'queued' };
    },
    async transfer(callId, target) {
      const call = existing(callId);
      if (!fictionalNumber.test(target) || call.status === 'ended') {
        throw new ProviderError('rejected');
      }
      call.status = 'transferred';
      return { callId, status: call.status };
    },
    async hangup(callId) {
      const call = existing(callId);
      call.status = 'ended';
      return { callId, status: call.status };
    },
    parseStatus,
  };
}

/** SIP/WebRTC placeholder backed by a local deterministic call state machine. */
export const createNativeTelephonyAdapter = createFixtureTelephonyAdapter;

/** RingCX-shaped test bridge. Account credentials and transport belong to the caller. */
export function createRingCxAdapter(options: {
  mode: 'test';
  accountId: string;
  client: HttpClient;
}): TelephonyAdapter {
  if (options.mode !== 'test' || !options.accountId) throw new ProviderError('rejected');
  const base = '/ringcx/accounts/' + encodeURIComponent(options.accountId) + '/calls';
  const post = async (path: string, body?: unknown, actionId?: string) => {
    const response = await request(options.client, {
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        ...(actionId ? { 'idempotency-key': actionId } : {}),
      },
      body,
    });
    return decodeCall(await json(response));
  };
  return {
    async start(input) {
      checkStart(input);
      return post(base, { ani: input.from, destination: input.to }, input.actionId);
    },
    async transfer(callId, target) {
      if (!callId || !fictionalNumber.test(target)) throw new ProviderError('rejected');
      return post(base + '/' + encodeURIComponent(callId) + '/transfer', { destination: target });
    },
    async hangup(callId) {
      if (!callId) throw new ProviderError('rejected');
      return post(base + '/' + encodeURIComponent(callId) + '/hangup');
    },
    parseStatus,
  };
}
