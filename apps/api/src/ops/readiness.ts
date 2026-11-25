const dependencies = ['database', 'queue', 'providers'] as const;
type Dependency = (typeof dependencies)[number];
export type ReadinessChecks = Record<
  Dependency,
  (signal: AbortSignal) => boolean | Promise<boolean>
>;

async function probe(check: ReadinessChecks[Dependency], timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
        controller.abort();
      }, timeoutMs);
    });
    return (
      (await Promise.race([timeout, Promise.resolve().then(() => check(controller.signal))])) ===
      true
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReadiness(checks: ReadinessChecks, timeoutMs = 1000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Invalid readiness deadline');
  }
  const results = await Promise.all(
    dependencies.map(
      async (name) =>
        [name, (await probe(checks[name], timeoutMs)) ? 'ok' : 'unavailable'] as const,
    ),
  );
  return {
    status: results.every(([, state]) => state === 'ok') ? 'ready' : 'unavailable',
    checks: Object.fromEntries(results),
  };
}
