import assert from 'node:assert/strict';
import test from 'node:test';
import { burnRate, SloMonitor } from '../../src/observability/index.ts';

test('burn rate is the observed failure fraction divided by the allowed fraction', () => {
  assert.equal(burnRate(0, 0, 0.99), null);
  assert.equal(burnRate(0, 40, 0.99), 0);
  assert.ok(Math.abs(burnRate(2, 100, 0.99)! - 2) < 1e-10);
  assert.throws(() => burnRate(2, 1, 0.99), RangeError);
  assert.throws(() => burnRate(0, 1, 1), RangeError);
});

test('rules require samples and burn across both windows for the same surface', () => {
  let time = 0;
  const slos = new SloMonitor(
    [
      { surface: 'rest', availability: 0.99, latency: 0.95, maxLatencySeconds: 0.5 },
      { surface: 'mcp', availability: 0.99, latency: 0.95, maxLatencySeconds: 0.5 },
    ],
    [
      {
        id: 'rest-up',
        surface: 'rest',
        objective: 'availability',
        shortWindowMs: 10_000,
        longWindowMs: 30_000,
        threshold: 3,
        minSamples: 2,
      },
      {
        id: 'mcp-latency',
        surface: 'mcp',
        objective: 'latency',
        shortWindowMs: 10_000,
        longWindowMs: 30_000,
        threshold: 3,
        minSamples: 2,
      },
    ],
    () => time,
  );
  assert.deepEqual(
    slos.evaluate().map(({ state }) => state),
    ['insufficient_data', 'insufficient_data'],
  );
  for (let i = 0; i < 100; i++) slos.record('rest', 200, 0.25);
  slos.record('mcp', 404, 0.5);
  time = 10_000;
  slos.record('rest', 503, 0.5);
  slos.record('rest', 200, 0.5);
  slos.record('mcp', 200, 0.6);
  slos.record('mcp', 200, 0.7);
  const [availability, latency] = slos.evaluate();
  assert.equal(availability.state, 'ok');
  assert.equal(availability.short.bad, 1);
  assert.equal(availability.long.total, 102);
  assert.equal(latency.state, 'firing');
  assert.equal(latency.long.bad, 2);
  for (let i = 0; i < 4; i++) slos.record('rest', 500, 0.5);
  assert.equal(slos.evaluate()[0].state, 'firing');
  time = 40_000;
  assert.equal(slos.evaluate()[0].long.total, 0);
});
