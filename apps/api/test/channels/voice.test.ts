import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { Transcript } from '../../../../packages/adapters/src/speech/index.ts';
import type { IceCandidate, PeerInput } from '../../../../packages/adapters/src/voice/peer.ts';
import type { SettledTurn } from '../../src/channels/settled.ts';
import { events, harness, otherStaff, staffHeaders, tenantId, web } from './harness.ts';

test(
  'relays SDP and ICE and cancels active playback on partial speech before transferring the call',
  { timeout: 10_000 },
  async (t) => {
    const audio = new Readable({ objectMode: true, read() {} });
    let callbacks: PeerInput | undefined;
    let closed = false;
    let stopped = 0;
    const plays: AbortSignal[] = [];
    const candidates: (IceCandidate | null)[] = [];
    const firstPlaying = Promise.withResolvers<void>();
    const secondPlaying = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const outcomes: SettledTurn[] = [];
    const transcripts: Transcript[] = [
      { type: 'partial', segment: 0, text: 'Fictional' },
      { type: 'final', segment: 0, text: 'Fictional first question' },
      { type: 'partial', segment: 1, text: 'Another' },
      { type: 'final', segment: 1, text: 'Another synthetic question' },
    ];
    const { app, advance, conversations, usage } = await harness(t, {
      onSettledTurn(outcome) {
        outcomes.push(outcome);
        if (outcomes.length === 2) settled.resolve();
      },
      voice: {
        voiceId: 'voice-fictional',
        peer(input) {
          callbacks = input;
          return {
            audio,
            async acceptOffer(sdp) {
              assert.equal(sdp, 'v=0 fixture offer');
              input.onIce({ candidate: 'fixture-peer-ice' });
              return 'v=0 fixture answer';
            },
            async addIce(candidate) {
              candidates.push(candidate);
            },
            async play(_chunk, signal) {
              plays.push(signal);
              if (plays.length === 1) {
                firstPlaying.resolve();
                await new Promise<void>((resolve) =>
                  signal.addEventListener('abort', () => resolve(), { once: true }),
                );
              }
              if (plays.length === 3) secondPlaying.resolve();
            },
            stopPlayback() {
              stopped++;
            },
            close() {
              closed = true;
              audio.push(null);
            },
          };
        },
        stt: {
          async *transcribe(input) {
            assert.equal(input.sampleRateHz, 16000);
            for await (const frame of input.audio) yield transcripts[frame[0]];
          },
        },
        tts: {
          async listVoices() {
            return [];
          },
          async *synthesize({ text, format, signal }) {
            assert.equal(text, 'Synthetic completion.');
            yield { bytes: Uint8Array.of(1, 0), format };
            signal?.throwIfAborted();
            yield { bytes: Uint8Array.of(2, 0), format };
          },
        },
      },
    });
    const client = web(app);
    const base = '/channels/voice/';
    const opened = await client('POST', base + 'session');
    assert.equal(opened.statusCode, 201);
    const { token, conversationId, callId } = opened.json();
    assert.equal((await client('GET', '/channels/widget/stream?once=1', token)).statusCode, 401);
    const signal = (payload: object) => client('POST', base + 'signal', token, payload);
    assert.equal((await signal({ type: 'offer', sdp: 'v=0 fixture offer' })).statusCode, 204);
    assert.equal(
      (
        await signal({
          type: 'ice',
          candidate: { candidate: 'fixture-client-ice', sdpMid: 'audio', sdpMLineIndex: 0 },
        })
      ).statusCode,
      204,
    );
    assert.equal((await signal({ type: 'ice', candidate: null })).statusCode, 204);
    assert.deepEqual(candidates, [
      {
        candidate: 'fixture-client-ice',
        sdpMid: 'audio',
        sdpMLineIndex: 0,
        usernameFragment: undefined,
      },
      null,
    ]);
    audio.push(Uint8Array.of(0, 0));
    audio.push(Uint8Array.of(1, 0));
    await firstPlaying.promise;
    assert.equal(plays[0].aborted, false);
    audio.push(Uint8Array.of(2, 0));
    audio.push(Uint8Array.of(3, 0));
    await secondPlaying.promise;
    await settled.promise;
    assert.equal(plays[0].aborted, true);
    assert.equal(stopped, 1);
    assert.deepEqual(usage, [tenantId, tenantId]);
    assert.equal(outcomes.length, 2);
    assert(
      outcomes.every((turn) => turn.conversationId === conversationId && turn.channel === 'voice'),
    );
    assert(outcomes.every((turn) => turn.audioSeconds !== null && turn.audioSeconds > 0));
    assert.deepEqual(
      outcomes.map((turn) => turn.outcome),
      ['cancelled', 'completed'],
    );
    assert.equal((await signal({ type: 'dtmf', digit: '8' })).statusCode, 204);
    callbacks!.onDtmf('0');
    assert.equal(conversations.get({ tenantId, conversationId }).state, 'queued');
    const staff = '/channels/staff/conversations/' + conversationId;
    assert.equal(
      (await app.inject({ method: 'POST', url: staff + '/claim', headers: staffHeaders }))
        .statusCode,
      200,
    );
    assert.equal((await app.inject({ url: staff, headers: otherStaff })).statusCode, 404);
    advance(100);
    assert.equal((await signal({ type: 'hangup' })).statusCode, 204);
    assert.equal(closed, true);
    const details = (await app.inject({ url: staff, headers: staffHeaders })).json();
    assert.equal(details.call.callId, callId);
    assert.equal(details.call.endedAt - details.call.startedAt, 100);
    assert.deepEqual(
      details.call.digits.map((digit: { digit: string }) => digit.digit),
      ['8', '0'],
    );
    assert.deepEqual(
      details.call.transfers.map((transfer: { queueId: string }) => transfer.queueId),
      ['general'],
    );
    assert.deepEqual(
      details.transcript.map((message: { text: string }) => message.text),
      [
        'Fictional first question',
        'Synthetic completion.',
        'Another synthetic question',
        'Synthetic completion.',
      ],
    );
    const history = events((await client('GET', base + 'stream?once=1', token)).body);
    assert.equal(history.find((event) => event.type === 'answer').sdp, 'v=0 fixture answer');
    assert.equal(
      history.find((event) => event.type === 'ice').candidate.candidate,
      'fixture-peer-ice',
    );
    assert.equal(history.filter((event) => event.type === 'playback_cancelled').length, 1);
    assert(history.some((event) => event.type === 'transfer'));
    assert.equal(history.at(-1).type, 'ended');
  },
);
