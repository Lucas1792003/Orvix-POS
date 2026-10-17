// Timers the data store schedules for itself (follow-up stock refreshes,
// recompute retries). They belong to the store that set them: a new store
// — and the test runner, between tests — cancels them. No imports on
// purpose: the global test setup loads this before any mocks.
const timers = new Set<ReturnType<typeof setTimeout>>();
/** Work a fired timer started and that has not finished yet (e.g. a
 *  follow-up stock refresh writing the mirror): a test must not tear the
 *  database down under it. */
const running = new Set<Promise<unknown>>();

export function later(fn: () => void | Promise<unknown>, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    timers.delete(t);
    const work = fn();
    if (work && typeof (work as Promise<unknown>).then === "function") {
      const p = (work as Promise<unknown>).catch(() => undefined).finally(() => running.delete(p));
      running.add(p);
    }
  }, ms);
  timers.add(t);
  return t;
}

export function clearStoreTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

/** Resolves once no work started by a store timer is still running (bounded). */
export async function storeWorkIdle(maxMs = 8_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (running.size && Date.now() < until) {
    await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, until - Date.now()))]);
  }
}
