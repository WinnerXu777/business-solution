import { PassThrough, Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { invalid } from './access.ts';

type Event = { cursor: number; type: string };
const frame = (event: Event) =>
  `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export function cursor(value: unknown) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) throw invalid();
  return Number(value);
}

export function sendEvents<T extends Event>(
  reply: FastifyReply,
  history: T[],
  subscribe: (listener: (event: T) => void) => () => void,
  maxMs: number,
  release: () => void,
  once: boolean,
  shutdown: AbortSignal,
) {
  reply.type('text/event-stream; charset=utf-8').header('x-accel-buffering', 'no');
  if (once) {
    release();
    return reply.send(history.map(frame).join(''));
  }
  const live = new PassThrough({ highWaterMark: 64 * 1024 });
  const write = (data: string) => {
    if (!live.destroyed && !live.write(data)) live.destroy();
  };
  const unsubscribe = subscribe((event) => write(frame(event)));
  const expiry = setTimeout(() => {
    live.end();
    if (!output.readableFlowing) output.destroy();
  }, maxMs).unref();
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000).unref();
  const output = Readable.from(
    (async function* () {
      yield ': connected\n\n';
      for (const event of history) yield frame(event);
      yield* live;
    })(),
  );
  const destroy = () => live.destroy();
  reply.raw.once('close', destroy);
  shutdown.addEventListener('abort', destroy, { once: true });
  live.once('close', () => {
    unsubscribe();
    shutdown.removeEventListener('abort', destroy);
    clearTimeout(expiry);
    clearInterval(heartbeat);
    release();
  });
  return reply.send(output);
}
