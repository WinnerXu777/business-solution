import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { traffic, walkthrough } from './milestone-1.mjs';
import { latencyPercentiles } from './percentiles.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:3000' },
    concurrency: { type: 'string', default: '2' },
    duration: { type: 'string', default: '10' },
    ramp: { type: 'string', default: '2' },
    timeout: { type: 'string', default: '15' },
    walkthrough: { type: 'boolean' },
  },
});

function numberOption(key, max, min = 0) {
  const raw = values[key];
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('Invalid --' + key);
  const value = Number(raw);
  if (value < min || value > max) throw new Error('Invalid --' + key);
  return value;
}

const base = new URL(values.url);
if (base.hostname === 'localhost') base.hostname = '127.0.0.1';
if (
  !['127.0.0.1', '[::1]'].includes(base.hostname) ||
  base.protocol !== 'http:' ||
  base.username ||
  base.password ||
  base.pathname !== '/' ||
  base.search ||
  base.hash
)
  throw new Error('Use an HTTP base URL on loopback for the fixture server.');

const concurrency = numberOption('concurrency', 256, 1);
const duration = numberOption('duration', 3600, 0.1) * 1000;
const ramp = numberOption('ramp', duration / 1000) * 1000;
const timeout = numberOption('timeout', 60, 0.1) * 1000;
if (!Number.isInteger(concurrency)) throw new Error('Concurrency must be an integer.');

const results = new Map();

async function measure(name, request, check) {
  let stats = results.get(name);
  if (!stats) {
    stats = { latencies: [], errors: 0 };
    results.set(name, stats);
  }
  const started = performance.now();
  try {
    const response = await fetch(new URL(request.path, base), {
      ...request.init,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.ceil(timeout)),
    });
    const body = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status);
    check?.(body);
    return body;
  } catch {
    stats.errors++;
    throw new Error('Step failed: ' + name);
  } finally {
    stats.latencies.push(performance.now() - started);
  }
}

const started = performance.now();
let failed = false;
if (values.walkthrough) {
  try {
    await walkthrough(measure);
  } catch (error) {
    failed = true;
    console.error(error.message);
  }
} else {
  const stop = started + duration;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      if (index > 0 && ramp > 0) await pause((ramp * index) / (concurrency - 1));
      while (performance.now() < stop) {
        const step = traffic[next++ % traffic.length];
        await measure(step.name, step.request(), step.check).catch(() => {});
      }
    }),
  );
}
const elapsedSeconds = (performance.now() - started) / 1000;
const samples = [...results.values()];
const errors = samples.reduce((sum, stats) => sum + stats.errors, 0);
const latencies = samples.flatMap((stats) => stats.latencies);
console.log(
  JSON.stringify(
    {
      elapsedSeconds,
      requests: latencies.length,
      errors,
      requestsPerSecond: latencies.length / elapsedSeconds,
      latencyMs: latencyPercentiles(latencies),
      steps: Object.fromEntries(
        [...results].map(([name, stats]) => [
          name,
          {
            requests: stats.latencies.length,
            errors: stats.errors,
            latencyMs: latencyPercentiles(stats.latencies),
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
if (failed || errors || latencies.length === 0) process.exitCode = 1;
