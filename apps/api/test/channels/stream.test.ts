import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import { sendEvents } from '../../src/channels/stream.ts';
import { events } from './harness.ts';

test(
  'SSE delivers events published after subscription and releases the slot at expiry',
  { timeout: 5000 },
  async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    const keepAlive = setTimeout(() => {}, 2000);
    t.after(() => clearTimeout(keepAlive));
    type Event = { cursor: number; type: string; active?: boolean };
    const subscribed = Promise.withResolvers<(event: Event) => void>();
    let unsubscribed = 0;
    let released = 0;
    app.get('/stream', (_request, reply) =>
      sendEvents<Event>(
        reply,
        [{ cursor: 1, type: 'state' }],
        (listener) => {
          subscribed.resolve(listener);
          return () => {
            unsubscribed++;
          };
        },
        100,
        () => {
          released++;
        },
        false,
        new AbortController().signal,
      ),
    );
    const result = app.inject('/stream').then((response) => response);
    const listener = await subscribed.promise;
    listener({ cursor: 2, type: 'typing', active: true });
    assert.deepEqual(events((await result).body), [
      { cursor: 1, type: 'state' },
      { cursor: 2, type: 'typing', active: true },
    ]);
    assert.equal(unsubscribed, 1);
    assert.equal(released, 1);
  },
);
