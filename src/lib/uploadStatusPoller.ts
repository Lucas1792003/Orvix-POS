import type { ProductImageUploadSessionStatusResult } from "./productImagePhoneUpload";

// Desktop QR modal: keep checking the upload session until the phone's
// upload lands or the session ends. Before this, ONE failed status request
// (a network blip, a 502 from the proxy, a 429) put the modal into FAILED and
// polling stopped for good, so an upload that then succeeded on the phone was
// never shown on the desktop.
//
// Rules:
//  - one request at a time (no overlapping polls), every `intervalMs` while
//    healthy;
//  - transient failures (network / timeout, 5xx, 408/425/429, 401 or "Not
//    authenticated" while the auth session refreshes) retry with bounded
//    exponential backoff, honouring Retry-After; the caller is told it is
//    "reconnecting" so the UI never stalls silently;
//  - permanent answers stop: COMPLETED / EXPIRED / CANCELED, the session not
//    found (404 or the RPC's "Upload session not found"), any other 4xx;
//  - retries end when the session's expiry (+ a grace period for the server
//    to stamp EXPIRED) has passed: one last check is made at that point.

/** A failed status request, with what the transport knew about it. */
export class UploadStatusRequestError extends Error {
  /** HTTP status; 0 = no response (network error, timeout). */
  readonly httpStatus: number;
  readonly code?: string;
  /** From the Retry-After header (seconds form). */
  readonly retryAfterSeconds?: number;
  constructor(message: string, httpStatus: number, opts: { code?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "UploadStatusRequestError";
    this.httpStatus = httpStatus;
    this.code = opts.code;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export type StatusPollFailure =
  | { kind: "transient"; retryAfterMs?: number }
  | { kind: "permanent" };

const NOT_FOUND = /not found/i;
const AUTH_REFRESH = /not authenticated|jwt expired|invalid jwt/i;

export function classifyStatusPollError(error: unknown): StatusPollFailure {
  if (!(error instanceof UploadStatusRequestError)) {
    // Anything the transport did not classify (fetch TypeError, abort, a
    // thrown string): no answer from the server, so try again.
    return { kind: "transient" };
  }
  const s = error.httpStatus;
  if (NOT_FOUND.test(error.message) || s === 404) return { kind: "permanent" };
  const transient = s === 0 || s >= 500 || s === 408 || s === 425 || s === 429 || s === 401 || AUTH_REFRESH.test(error.message);
  if (!transient) return { kind: "permanent" };
  return error.retryAfterSeconds !== undefined
    ? { kind: "transient", retryAfterMs: error.retryAfterSeconds * 1000 }
    : { kind: "transient" };
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into SECONDS,
 *  uncapped (the poller's own schedule). Not to be confused with
 *  `lib/retryAfter.parseRetryAfter`, which returns capped milliseconds for
 *  the RPC failure classifier. */
export function parseRetryAfterSeconds(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  return undefined;
}

export type UploadStatusPollStop =
  /** The server reported a final status (COMPLETED / EXPIRED / CANCELED). */
  | { kind: "status"; result: ProductImageUploadSessionStatusResult }
  /** A permanent error (session not found, refused). */
  | { kind: "error"; message: string }
  /** The session expired locally while the server could not be reached. */
  | { kind: "expired"; message: string };

export interface ReconnectingInfo {
  /** Consecutive failed requests. */
  failures: number;
  /** When the next attempt is made (epoch ms). */
  nextAttemptAt: number;
  message: string;
}

export interface UploadStatusPollerOptions {
  sessionId: string;
  expiresAt: string;
  fetchStatus: (sessionId: string) => Promise<ProductImageUploadSessionStatusResult>;
  /** Every PENDING answer. */
  onPending?: (result: ProductImageUploadSessionStatusResult) => void;
  /** Called with info when a request fails transiently, with null once a request succeeds again. */
  onReconnecting?: (info: ReconnectingInfo | null) => void;
  /** Called once when polling ends for good. */
  onStop: (stop: UploadStatusPollStop) => void;
  intervalMs?: number;
  maxBackoffMs?: number;
  /** Longest Retry-After honoured; longer values are capped. */
  maxRetryAfterMs?: number;
  /** After expiresAt, keep trying this long for the server's EXPIRED. */
  expiryGraceMs?: number;
  now?: () => number;
}

export const UPLOAD_STATUS_POLL_INTERVAL_MS = 2_000;
export const UPLOAD_STATUS_MAX_BACKOFF_MS = 15_000;
export const UPLOAD_STATUS_MAX_RETRY_AFTER_MS = 60_000;
export const UPLOAD_STATUS_EXPIRY_GRACE_MS = 10_000;

/** Start polling; returns a stop function (idempotent). */
export function startUploadStatusPolling(opts: UploadStatusPollerOptions): () => void {
  const intervalMs = opts.intervalMs ?? UPLOAD_STATUS_POLL_INTERVAL_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? UPLOAD_STATUS_MAX_BACKOFF_MS;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? UPLOAD_STATUS_MAX_RETRY_AFTER_MS;
  const graceMs = opts.expiryGraceMs ?? UPLOAD_STATUS_EXPIRY_GRACE_MS;
  const now = opts.now ?? (() => Date.now());

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let expiresAtMs = Date.parse(opts.expiresAt);
  const deadline = () => (Number.isFinite(expiresAtMs) ? expiresAtMs + graceMs : Infinity);

  const finish = (stop: UploadStatusPollStop) => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    opts.onStop(stop);
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), Math.max(0, delayMs));
  };

  const tick = async () => {
    if (stopped) return;
    const startedAt = now();
    try {
      const result = await opts.fetchStatus(opts.sessionId);
      if (stopped) return;
      if (failures > 0) {
        failures = 0;
        opts.onReconnecting?.(null);
      }
      const nextExpiry = Date.parse(result.expiresAt);
      if (Number.isFinite(nextExpiry)) expiresAtMs = nextExpiry;
      if (result.status !== "PENDING") {
        finish({ kind: "status", result });
        return;
      }
      opts.onPending?.(result);
      schedule(intervalMs);
    } catch (error) {
      if (stopped) return;
      const message = error instanceof Error && error.message ? error.message : "Could not check the upload status.";
      const failure = classifyStatusPollError(error);
      if (failure.kind === "permanent") {
        finish({ kind: "error", message });
        return;
      }
      failures += 1;
      const t = now();
      if (t >= deadline() || startedAt >= deadline()) {
        finish({ kind: "expired", message: "The upload link expired while the connection was lost." });
        return;
      }
      const backoff = Math.min(maxBackoffMs, intervalMs * 2 ** (failures - 1));
      const wanted = failure.retryAfterMs !== undefined ? Math.min(maxRetryAfterMs, Math.max(failure.retryAfterMs, intervalMs)) : backoff;
      // Never sleep past the deadline: one last attempt is made right at it.
      const delay = Math.min(wanted, Math.max(0, deadline() - t));
      opts.onReconnecting?.({ failures, nextAttemptAt: t + delay, message });
      schedule(delay);
    }
  };

  schedule(0);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
