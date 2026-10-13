import { supabase } from "../../lib/supabase";
import { isNetworkError, isTransientError } from "../../lib/errors";
import { touchAuthCache } from "../authCache";

// ----------------------------------------------------------------------
// Idempotent RPC calls — client half of
// docs/selfhost-migration/phase-d/idempotency-contract.md.
//
// Every in-scope RPC is sent through callRpc() with a `p_idempotency_key`
// minted when the operation was *created* (beginOperation), so an online
// attempt, its offline fallback and every outbox replay carry the same key
// and the server can hand back the original response instead of applying
// the operation twice. The helper also normalises supabase-js's two
// failure shapes (a resolved `{ error }` with the HTTP status beside it,
// or — rarely — a rejection) into one RpcError that already knows whether
// it is transient, and bounds every call with an AbortSignal so a hung
// connection cannot block the caller (or the outbox drain) forever.
// ----------------------------------------------------------------------

export const RPC_TIMEOUT_MS = 30_000;
export const IDEMPOTENCY_KEY_ARG = "p_idempotency_key";

/** Bounded automatic retries for online-only RPCs (no outbox fallback):
 *  with the key fixed, a retry after a lost response is safe, so a
 *  gateway blip no longer surfaces as a failed desk action. */
export const ONLINE_ONLY_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1500];

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Minted once per user action, before the first network attempt, and
 *  shared by the online call and any offline fallback so both send the
 *  same key and the same event time. */
export interface OperationContext {
  idempotencyKey: string;
  createdAt: string;
}

export function beginOperation(): OperationContext {
  return { idempotencyKey: newIdempotencyKey(), createdAt: new Date().toISOString() };
}

export class RpcError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly details: string | undefined;
  /** True when a later retry with the same idempotency key may succeed
   *  (network/gateway failure, timeout, 5xx, 429, expired JWT). False for
   *  a permanent rejection of this exact request. */
  readonly transient: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string; details?: string; transient: boolean },
  ) {
    super(message);
    this.name = "RpcError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.transient = options.transient;
  }
}

export interface RpcOutcome {
  data: unknown;
  error: RpcError | null;
  status?: number;
}

// Loose view of what supabase-js resolves with — postgrest-js puts the HTTP
// status next to `error`, not inside it, and a mocked client may omit it.
interface RawResponse {
  data?: unknown;
  error?: { message?: string; code?: string; details?: string; hint?: string; status?: number } | null;
  status?: number;
}

const IDEMPOTENCY_MISMATCH = "IDEMPOTENCY_MISMATCH";
const IDEMPOTENCY_KEY_REQUIRED = "IDEMPOTENCY_KEY_REQUIRED";

/** Classify a raw error (resolved or thrown) into an RpcError. */
export function toRpcError(raw: unknown, status?: number): RpcError {
  const err = (raw ?? {}) as { message?: unknown; code?: unknown; details?: unknown; status?: unknown };
  const message =
    typeof raw === "string" ? raw
    : typeof err.message === "string" && err.message.trim() ? err.message
    : String(raw);
  const code = typeof err.code === "string" ? err.code : undefined;
  const details = typeof err.details === "string" ? err.details : undefined;
  const effectiveStatus = status ?? (typeof err.status === "number" ? err.status : isNetworkError(raw) ? 0 : undefined);
  // Contract: a key reused for a different request, or a missing key, is
  // never retried — regardless of the SQLSTATE/status it is reported with.
  const contractViolation = message.includes(IDEMPOTENCY_MISMATCH) || message.includes(IDEMPOTENCY_KEY_REQUIRED);
  const transient = !contractViolation && isTransientError(raw, effectiveStatus);
  return new RpcError(message, { status: effectiveStatus, code, details, transient });
}

function normalise(res: RawResponse | null | undefined): RpcOutcome {
  if (!res) return { data: null, error: null };
  if (res.error) return { data: null, error: toRpcError(res.error, res.status), status: res.status };
  return { data: res.data ?? null, error: null, status: res.status };
}

interface Abortable {
  abortSignal?: (signal: AbortSignal) => unknown;
}

/**
 * Await a supabase-js request (a thenable builder) with a hard timeout.
 * The AbortSignal is attached when the builder supports it (the real
 * client does; a bare promise from a mocked client does not) and a race
 * timer guarantees the await returns either way. A timeout is reported as
 * a transient RpcError with status 0, like a fetch failure.
 */
export async function runRequest(
  request: PromiseLike<RawResponse> | RawResponse,
  label: string,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<RpcOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RpcOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        data: null,
        status: 0,
        error: new RpcError(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, {
          status: 0, code: "TIMEOUT", transient: true,
        }),
      });
    }, timeoutMs);
  });
  try {
    const abortable = request as Abortable;
    const bound = typeof abortable.abortSignal === "function"
      ? (abortable.abortSignal(controller.signal) as PromiseLike<RawResponse>)
      : request;
    const call = Promise.resolve(bound).then(normalise, (thrown: unknown) => ({
      data: null,
      error: toRpcError(thrown),
    }));
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CallOptions {
  timeoutMs?: number;
  /** Automatic retries on a *transient* failure, with the same args (and
   *  therefore the same idempotency key). Only used for online-only RPCs;
   *  offline-capable ones fall back to the outbox instead. */
  retries?: number;
}

/**
 * Call an RPC with an idempotency key already present in `args`. Resolves
 * with a normalised outcome; never rejects. A successful reply counts as an
 * authenticated server round trip and refreshes the offline auth window.
 */
export async function callRpc(
  name: string,
  args: Record<string, unknown>,
  options: CallOptions = {},
): Promise<RpcOutcome> {
  const { timeoutMs = RPC_TIMEOUT_MS, retries = 0 } = options;
  if (typeof args[IDEMPOTENCY_KEY_ARG] !== "string") {
    // Every in-scope caller mints the key up front; reaching here is a
    // programming error, but sending without a key would be rejected by
    // the server (IDEMPOTENCY_KEY_REQUIRED) — mint one so the call stays
    // idempotent for its own retries.
    args = { ...args, [IDEMPOTENCY_KEY_ARG]: newIdempotencyKey() };
  }
  let outcome = await runRequest(supabase.rpc(name, args), name, timeoutMs);
  for (let n = 0; n < retries && outcome.error?.transient; n++) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)]));
    outcome = await runRequest(supabase.rpc(name, args), name, timeoutMs);
  }
  if (!outcome.error) void touchAuthCache();
  return outcome;
}
