export class FixedWindowLimiter {
  readonly #counts = new Map<string, number>();
  readonly #windowMs: number;
  readonly #capacity: number;
  readonly #now: () => number;
  #window = -Infinity;

  constructor(windowMs: number, capacity: number, now: () => number) {
    this.#windowMs = windowMs;
    this.#capacity = capacity;
    this.#now = now;
  }

  // Return the retry delay in seconds when the budget is exhausted.
  take(key: readonly string[], limit: number): number {
    const now = this.#now();
    const window = Math.floor(now / this.#windowMs);
    if (window !== this.#window) {
      this.#counts.clear();
      this.#window = window;
    }
    const id = JSON.stringify(key);
    const count = this.#counts.get(id) ?? 0;
    if (count >= limit || (!this.#counts.has(id) && this.#counts.size >= this.#capacity)) {
      return Math.max(1, Math.ceil(((window + 1) * this.#windowMs - now) / 1000));
    }
    this.#counts.set(id, count + 1);
    return 0;
  }
}
