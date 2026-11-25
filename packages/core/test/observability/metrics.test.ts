import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsRegistry } from '../../src/observability/index.ts';

test('Prometheus exposition escapes labels and uses cumulative buckets', () => {
  const registry = new MetricsRegistry();
  const count = registry.counter('events_total', 'Events\nprocessed', ['route', 'method']);
  const label = { route: '/a"b\\c\nd', method: 'GET' };
  count.inc(label);
  count.inc({ method: label.method, route: label.route }, 2);
  registry.gauge('temperature', 'Demo temperature').set(-1);
  const durations = registry.histogram('duration_seconds', 'Request duration', [0.1, 1], ['route']);
  durations.observe(0.1, { route: '/orders' });
  durations.observe(2, { route: '/orders' });
  assert.equal(
    registry.expose(),
    [
      '# HELP events_total Events\\nprocessed',
      '# TYPE events_total counter',
      'events_total{method="GET",route="/a\\"b\\\\c\\nd"} 3',
      '# HELP temperature Demo temperature',
      '# TYPE temperature gauge',
      'temperature -1',
      '# HELP duration_seconds Request duration',
      '# TYPE duration_seconds histogram',
      'duration_seconds_bucket{route="/orders",le="0.1"} 1',
      'duration_seconds_bucket{route="/orders",le="1"} 1',
      'duration_seconds_bucket{route="/orders",le="+Inf"} 2',
      'duration_seconds_sum{route="/orders"} 2.1',
      'duration_seconds_count{route="/orders"} 2',
      '',
    ].join('\n'),
  );
  assert.throws(() => count.inc(label, -1));
  assert.throws(() => durations.observe(Infinity, { route: '/orders' }));
  assert.throws(() => count.inc({ method: 'GET' }));
  assert.throws(() => registry.gauge('duration_seconds_sum', 'duplicate'));
});
