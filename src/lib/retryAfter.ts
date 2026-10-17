// ----------------------------------------------------------------------
// Server-requested back-off (Retry-After on 429/503), Batch 2A.
//
// supabase-js does not hand response headers to its callers, so the
// client's fetch wrapper (lib/supabase.ts) reports them here. A delay the
// server asked for applies to the whole backend — the next queue attempt
// and the next online retry wait at least that long. The value is capped so
// a bad header cannot park the queue for hours.
// ----------------------------------------------------------------------

export const RETRY_AFTER_CAP_MS = 10 * 60_000;

let backoffUntil = 0;

/** Parse a Retry-After header (delta-seconds or an HTTP date) to ms from `now`. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(RETRY_AFTER_CAP_MS, Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - now));
}

/** Record a response's Retry-After (only 429 and 503 carry a meaningful one). */
export function noteResponseForRetryAfter(status: number, header: string | null, now: number = Date.now()): void {
  if (status !== 429 && status !== 503) return;
  const ms = parseRetryAfter(header, now);
  if (ms === undefined) return;
  backoffUntil = Math.max(backoffUntil, now + ms);
}

/** Remaining server-requested delay, or undefined when none applies. */
export function retryAfterRemainingMs(now: number = Date.now()): number | undefined {
  const left = backoffUntil - now;
  return left > 0 ? left : undefined;
}

/** Tests only. */
export function resetRetryAfterForTests(): void {
  backoffUntil = 0;
}

/** fetch wrapper: passes every request through, records Retry-After. */
export function retryAfterAwareFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    try {
      noteResponseForRetryAfter(res.status, res.headers.get("retry-after"));
    } catch {
      // headers unavailable (opaque response): nothing to record
    }
    return res;
  };
}
