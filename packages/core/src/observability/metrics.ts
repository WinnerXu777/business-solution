export type Labels = Readonly<Record<string, string>>;
type MetricType = 'counter' | 'gauge' | 'histogram';

const escapeLabel = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
const escapeHelp = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');

function labelText(labels: Labels): string {
  const pairs = Object.entries(labels).map(([key, value]) => key + '="' + escapeLabel(value) + '"');
  return pairs.length ? '{' + pairs.join(',') + '}' : '';
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Metric values must be finite');
  return value;
}

abstract class Metric<T> {
  abstract readonly type: MetricType;
  private readonly labelNames: string[];
  private readonly series = new Map<string, { labels: Labels; value: T }>();
  readonly name: string;
  readonly help: string;

  constructor(name: string, help: string, labelNames: readonly string[]) {
    if (!/^[a-zA-Z_:][a-zA-Z_:\d]*$/.test(name)) throw new Error('Invalid metric name');
    if (
      new Set(labelNames).size !== labelNames.length ||
      labelNames.some(
        (key) => !/^[a-zA-Z_][a-zA-Z_\d]*$/.test(key) || key.startsWith('__') || key === 'le',
      )
    ) {
      throw new Error('Invalid metric labels');
    }
    this.labelNames = [...labelNames].sort();
    this.name = name;
    this.help = help;
  }

  private key(labels: Labels): string {
    if (
      Object.keys(labels).length !== this.labelNames.length ||
      this.labelNames.some((key) => !Object.hasOwn(labels, key) || typeof labels[key] !== 'string')
    ) {
      throw new Error('Unexpected metric labels');
    }
    return JSON.stringify(this.labelNames.map((key) => labels[key]));
  }

  protected get(labels: Labels): T | undefined {
    return this.series.get(this.key(labels))?.value;
  }

  protected put(labels: Labels, value: T): void {
    this.series.set(this.key(labels), {
      labels: Object.fromEntries(this.labelNames.map((key) => [key, labels[key]])),
      value,
    });
  }

  expose(): string[] {
    return [
      '# HELP ' + this.name + ' ' + escapeHelp(this.help),
      '# TYPE ' + this.name + ' ' + this.type,
      ...[...this.series.values()].flatMap(({ labels, value }) => this.samples(labels, value)),
    ];
  }

  protected abstract samples(labels: Labels, value: T): string[];
}

abstract class Scalar extends Metric<number> {
  value(labels: Labels = {}): number {
    return this.get(labels) ?? 0;
  }

  protected samples(labels: Labels, value: number): string[] {
    return [this.name + labelText(labels) + ' ' + value];
  }
}

export class Counter extends Scalar {
  readonly type = 'counter';

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new RangeError('Counters cannot decrease');
    this.put(labels, finite(this.value(labels) + amount));
  }
}

export class Gauge extends Scalar {
  readonly type = 'gauge';

  set(value: number, labels: Labels = {}): void {
    this.put(labels, finite(value));
  }

  add(amount: number, labels: Labels = {}): void {
    this.set(this.value(labels) + amount, labels);
  }
}

interface HistogramSample {
  count: number;
  sum: number;
  buckets: number[];
}

export class Histogram extends Metric<HistogramSample> {
  readonly type = 'histogram';
  private readonly bounds: number[];

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    bounds: readonly number[],
  ) {
    super(name, help, labelNames);
    if (
      !bounds.length ||
      bounds.some(
        (bound, index) => !Number.isFinite(bound) || (index > 0 && bound <= bounds[index - 1]),
      )
    ) {
      throw new RangeError('Histogram bounds must be finite and strictly ascending');
    }
    this.bounds = [...bounds];
  }

  observe(value: number, labels: Labels = {}): void {
    if (value < 0) throw new RangeError('Histogram observations must be nonnegative');
    const sample = this.get(labels) ?? { count: 0, sum: 0, buckets: this.bounds.map(() => 0) };
    sample.sum = finite(sample.sum + value);
    sample.count++;
    this.bounds.forEach((bound, index) => {
      if (value <= bound) sample.buckets[index]++;
    });
    this.put(labels, sample);
  }

  protected samples(labels: Labels, sample: HistogramSample): string[] {
    const bucket = (le: string, count: number) =>
      this.name + '_bucket' + labelText({ ...labels, le }) + ' ' + count;
    return [
      ...this.bounds.map((bound, index) => bucket(String(bound), sample.buckets[index])),
      bucket('+Inf', sample.count),
      this.name + '_sum' + labelText(labels) + ' ' + sample.sum,
      this.name + '_count' + labelText(labels) + ' ' + sample.count,
    ];
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric<unknown>>();
  private readonly names = new Set<string>();

  counter(name: string, help: string, labels: readonly string[] = []): Counter {
    return this.register(new Counter(name, help, labels));
  }

  gauge(name: string, help: string, labels: readonly string[] = []): Gauge {
    return this.register(new Gauge(name, help, labels));
  }

  histogram(
    name: string,
    help: string,
    bounds: readonly number[],
    labels: readonly string[] = [],
  ): Histogram {
    return this.register(new Histogram(name, help, labels, bounds), ['_bucket', '_count', '_sum']);
  }

  expose(): string {
    const lines = [...this.metrics.values()].flatMap((metric) => metric.expose());
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  private register<T extends Metric<unknown>>(metric: T, suffixes: string[] = []): T {
    const names = [metric.name, ...suffixes.map((suffix) => metric.name + suffix)];
    if (names.some((name) => this.names.has(name))) throw new Error('Duplicate metric name');
    for (const name of names) this.names.add(name);
    this.metrics.set(metric.name, metric);
    return metric;
  }
}
