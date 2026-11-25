import { redact, redactText } from './redaction.ts';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof levels;

export interface LoggerOptions {
  level?: LogLevel;
  sampleRate?: number;
  random?: () => number;
  now?: () => Date;
  write?: (line: string) => void;
}

export class JsonLogger {
  private readonly options: Required<LoggerOptions>;

  constructor(options: LoggerOptions = {}) {
    this.options = {
      level: options.level ?? 'info',
      sampleRate: options.sampleRate ?? 1,
      random: options.random ?? Math.random,
      now: options.now ?? (() => new Date()),
      write: options.write ?? ((line) => console.log(line)),
    };
    const { sampleRate } = this.options;
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
      throw new RangeError('Invalid log sample rate');
    }
  }

  log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    const { level: minimum, sampleRate, random, now, write } = this.options;
    if (levels[level] < levels[minimum]) return;
    if (levels[level] < levels.warn && sampleRate < 1 && random() >= sampleRate) return;
    try {
      write(
        JSON.stringify({
          time: now().toISOString(),
          level,
          message: redactText(message),
          fields: redact(fields),
        }),
      );
    } catch {
      // Telemetry failures must not interrupt application requests.
    }
  }
}
