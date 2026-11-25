import { MetricsRegistry, type Counter } from './metrics.ts';

export interface SurfaceSlo {
  surface: string;
  availability: number;
  latency: number;
  maxLatencySeconds: number;
}

export interface AlertRule {
  id: string;
  surface: string;
  objective: 'availability' | 'latency';
  shortWindowMs: number;
  longWindowMs: number;
  threshold: number;
  minSamples: number;
}

export const surfaceSlos: readonly SurfaceSlo[] = [
  { surface: 'rest', availability: 0.999, latency: 0.95, maxLatencySeconds: 0.5 },
  { surface: 'mcp', availability: 0.999, latency: 0.95, maxLatencySeconds: 0.5 },
  { surface: 'automation', availability: 0.99, latency: 0.95, maxLatencySeconds: 5 },
  { surface: 'platform', availability: 0.999, latency: 0.95, maxLatencySeconds: 0.5 },
];

export const alertRules: readonly AlertRule[] = surfaceSlos.flatMap(({ surface }) =>
  (['availability', 'latency'] as const).map((objective) => ({
    id: surface + '-' + objective + '-burn',
    surface,
    objective,
    shortWindowMs: 5 * 60_000,
    longWindowMs: 60 * 60_000,
    threshold: 4,
    minSamples: 20,
  })),
);

export function burnRate(bad: number, total: number, target: number): number | null {
  if (
    !Number.isSafeInteger(bad) ||
    !Number.isSafeInteger(total) ||
    bad < 0 ||
    total < bad ||
    !(target > 0 && target < 1)
  ) {
    throw new RangeError('Invalid SLO observations or target');
  }
  return total === 0 ? null : bad / total / (1 - target);
}

const resolutionMs = 10_000;

interface SloSlice {
  requests: Counter;
  unavailable: Counter;
  slow: Counter;
}

export class SloMonitor {
  private readonly definitions: Map<string, SurfaceSlo>;
  private readonly rules: readonly AlertRule[];
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly slices = new Map<number, SloSlice>();

  constructor(
    definitions: readonly SurfaceSlo[] = surfaceSlos,
    rules: readonly AlertRule[] = alertRules,
    now: () => number = Date.now,
  ) {
    this.definitions = new Map(definitions.map((slo) => [slo.surface, slo]));
    for (const slo of definitions) {
      burnRate(0, 0, slo.availability);
      burnRate(0, 0, slo.latency);
      if (!Number.isFinite(slo.maxLatencySeconds) || slo.maxLatencySeconds <= 0) {
        throw new RangeError('Invalid latency objective');
      }
    }
    for (const rule of rules) {
      if (
        !this.definitions.has(rule.surface) ||
        ![rule.shortWindowMs, rule.longWindowMs].every(
          (window) =>
            Number.isSafeInteger(window) && window >= resolutionMs && window % resolutionMs === 0,
        ) ||
        rule.shortWindowMs > rule.longWindowMs ||
        !Number.isSafeInteger(rule.minSamples) ||
        rule.minSamples < 1 ||
        !Number.isFinite(rule.threshold) ||
        rule.threshold <= 0
      )
        throw new RangeError('Invalid alert rule');
    }
    this.rules = rules;
    this.now = now;
    this.retentionMs = Math.max(0, ...rules.map((rule) => rule.longWindowMs));
  }

  record(surface: string, status: number, seconds: number): void {
    const slo = this.definitions.get(surface);
    if (!slo || this.retentionMs === 0) return;
    const slot = this.currentSlot();
    let slice = this.slices.get(slot);
    if (!slice) {
      const registry = new MetricsRegistry();
      slice = {
        requests: registry.counter('requests_total', 'Eligible requests', ['surface']),
        unavailable: registry.counter('unavailable_total', 'Server errors', ['surface']),
        slow: registry.counter('slow_total', 'Requests above the latency objective', ['surface']),
      };
      this.slices.set(slot, slice);
    }
    const labels = { surface };
    slice.requests.inc(labels);
    if (status >= 500) slice.unavailable.inc(labels);
    if (seconds > slo.maxLatencySeconds) slice.slow.inc(labels);
  }

  evaluate() {
    const now = this.currentSlot();
    return this.rules.map((rule) => {
      const labels = { surface: rule.surface };
      const target = this.definitions.get(rule.surface)![rule.objective];
      const measure = (windowMs: number) => {
        let bad = 0;
        let total = 0;
        for (const [start, slice] of this.slices) {
          if (start <= now - windowMs || start > now) continue;
          total += slice.requests.value(labels);
          bad += (rule.objective === 'availability' ? slice.unavailable : slice.slow).value(labels);
        }
        return { total, bad, burnRate: burnRate(bad, total, target) };
      };
      const short = measure(rule.shortWindowMs);
      const long = measure(rule.longWindowMs);
      const enough = short.total >= rule.minSamples && long.total >= rule.minSamples;
      const breached = [short, long].every(
        (window) => window.burnRate !== null && window.burnRate >= rule.threshold * (1 - 1e-12),
      );
      const state = enough ? (breached ? 'firing' : 'ok') : 'insufficient_data';
      return { ...rule, target, short, long, state };
    });
  }

  private currentSlot(): number {
    const current = Math.floor(this.now() / resolutionMs) * resolutionMs;
    for (const start of this.slices.keys()) {
      if (start <= current - this.retentionMs || start > current) this.slices.delete(start);
    }
    return current;
  }
}
