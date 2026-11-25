export function latencyPercentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Object.fromEntries(
    [50, 95, 99].map((percent) => [
      'p' + percent,
      sorted.length ? sorted[Math.ceil((percent / 100) * sorted.length) - 1] : null,
    ]),
  );
}
