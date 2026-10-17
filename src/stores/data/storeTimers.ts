// Timers the data store schedules for itself (follow-up stock refreshes,
// recompute retries). They belong to the store that set them: a new store
// — and the test runner, between tests — cancels them. No imports on
// purpose: the global test setup loads this before any mocks.
const timers = new Set<ReturnType<typeof setTimeout>>();

export function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
  return t;
}

export function clearStoreTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}
