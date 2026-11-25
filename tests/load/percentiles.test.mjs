import assert from 'node:assert/strict';
import test from 'node:test';
import { latencyPercentiles } from './percentiles.mjs';

test('nearest-rank percentiles sort a copy and preserve ties', () => {
  const input = [90, 7, 45, 7, 3];
  assert.deepEqual(latencyPercentiles(input), { p50: 7, p95: 90, p99: 90 });
  assert.deepEqual(input, [90, 7, 45, 7, 3]);
});

test('percentiles handle empty, singleton and evenly ranked samples', () => {
  assert.deepEqual(latencyPercentiles([]), { p50: null, p95: null, p99: null });
  assert.deepEqual(latencyPercentiles([0.2]), { p50: 0.2, p95: 0.2, p99: 0.2 });
  assert.deepEqual(latencyPercentiles(Array.from({ length: 100 }, (_, i) => i + 1)), {
    p50: 50,
    p95: 95,
    p99: 99,
  });
});
