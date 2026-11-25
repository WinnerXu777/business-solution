import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFixtureTelephonyAdapter,
  createNativeTelephonyAdapter,
  createRingCxAdapter,
  type TelephonyAdapter,
} from '../../src/voice/index.ts';

const action = { actionId: 'fixture-call', from: '+14165550100', to: '+14165550101' };
const target = '+14165550102';

function telephonyContract(name: string, create: () => TelephonyAdapter) {
  test(name + ' telephony contract', async () => {
    const adapter = create();
    await assert.rejects(adapter.start({ ...action, to: '+14165550200' }), { code: 'rejected' });
    const call = await adapter.start(action);
    assert(call.callId);
    assert.equal(call.status, 'queued');
    assert.deepEqual(await adapter.start(action), call);
    await assert.rejects(adapter.transfer(call.callId, 'invalid'), { code: 'rejected' });
    assert.deepEqual(await adapter.transfer(call.callId, target), {
      ...call,
      status: 'transferred',
    });
    assert.deepEqual(await adapter.hangup(call.callId), { ...call, status: 'ended' });
    assert.deepEqual(
      await adapter.parseStatus({
        eventType: 'CALL_STATUS',
        eventId: 'evt-01',
        data: { callId: call.callId, status: 'DISCONNECTED', phone: target },
      }),
      { eventId: 'evt-01', callId: call.callId, status: 'ended' },
    );
    assert.equal(
      adapter.parseStatus({ eventType: 'CALL_STATUS', data: { status: 'UNKNOWN' } }),
      null,
    );
  });
}

telephonyContract('fixture', createFixtureTelephonyAdapter);
telephonyContract('native SIP/WebRTC placeholder', createNativeTelephonyAdapter);
telephonyContract('RingCX test bridge', () =>
  createRingCxAdapter({
    mode: 'test',
    accountId: 'fictional-account',
    async client({ method, path, body, headers }) {
      const base = '/ringcx/accounts/fictional-account/calls';
      assert.equal(method, 'POST');
      let status: string;
      switch (path) {
        case base:
          assert.deepEqual(body, { ani: action.from, destination: action.to });
          assert.equal(headers['idempotency-key'], action.actionId);
          status = 'QUEUED';
          break;
        case base + '/fictional-leg/transfer':
          assert.deepEqual(body, { destination: target });
          status = 'TRANSFERRED';
          break;
        case base + '/fictional-leg/hangup':
          assert.equal(body, undefined);
          status = 'DISCONNECTED';
          break;
        default:
          assert.fail(path);
      }
      return {
        status: 200,
        async json() {
          return { callId: 'fictional-leg', status };
        },
      };
    },
  }),
);
