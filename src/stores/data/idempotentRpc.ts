import { supabase } from "../../lib/supabase";
import { isNetworkError } from "../../lib/errors";
import { classifyFailure, signalOf, type FailureInfo } from "../../lib/failureClass";
import { retryAfterRemainingMs } from "../../lib/retryAfter";
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

// RPCs that accept p_expected_actor_id (migration 055): the acting user's
// app id is part of the request, so a queued action cannot silently execute
// under whoever is signed in when the device reconnects. complete_sale is
// excluded — it checks shift ownership itself and has no such parameter.
export const ACTOR_STAMPED_RPCS = new Set([
  "adjust_stock",
  "receive_purchase_order",
  "record_supplier_payment",
  "open_shift",
  "close_shift",
  "create_refund_void_request",
  "dispatch_stock_transfer",
  "receive_stock_transfer",
]);

let actorSource: () => string | null = () => null;

/** Wired once by the auth store: who is acting right now. */
export function setActorSource(source: () => string | null): void {
  actorSource = source;
}

/**
 * The ONE argument rule shared by the online call and the queued replay
 * (Q-M1, plan v2 §5.1 rule 1): the idempotency key and, for actor-stamped
 * RPCs, p_expected_actor_id. A value already present is kept, so a queued
 * payload is never re-stamped with a later user. Returns a new object.
 */
export function stampOperationArgs(name: string, args: Record<string, unknown>, idempotencyKey?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof out[IDEMPOTENCY_KEY_ARG] !== "string") out[IDEMPOTENCY_KEY_ARG] = idempotencyKey ?? newIdempotencyKey();
  if (ACTOR_STAMPED_RPCS.has(name) && !("p_expected_actor_id" in out)) out.p_expected_actor_id = actorSource();
  return out;
}

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
  readonly hint: string | undefined;
  /** What the failure means for the operation (lib/failureClass.ts). */
  readonly failure: FailureInfo;
  /** True when the operation is kept and resent later with the same
   *  idempotency key (everything except a definitive refusal). Derived from
   *  `failure.retryable`; kept for existing callers. */
  readonly transient: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string; details?: string; hint?: string; failure: FailureInfo },
  ) {
    super(message);
    this.name = "RpcError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.hint = options.hint;
    this.failure = options.failure;
    this.transient = options.failure.retryable;
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

/** Classify a raw error (resolved or thrown) into an RpcError. The class
 *  (lib/failureClass.ts) decides everything; IDEMPOTENCY_MISMATCH /
 *  IDEMPOTENCY_KEY_REQUIRED are contract violations, never retried. */
export function toRpcError(raw: unknown, status?: number): RpcError {
  const err = (raw ?? {}) as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown; status?: unknown };
  const message =
    typeof raw === "string" ? raw
    : typeof err.message === "string" && err.message.trim() ? err.message
    : String(raw);
  const code = typeof err.code === "string" && err.code ? err.code : undefined;
  const details = typeof err.details === "string" ? err.details : undefined;
  const hint = typeof err.hint === "string" ? err.hint : undefined;
  const effectiveStatus = status ?? (typeof err.status === "number" ? err.status : isNetworkError(raw) ? 0 : undefined);
  // Classify on the body as received: an EMPTY message is evidence (a
  // gateway answered, not PostgREST), so it must not become "[object Object]".
  const bodyMessage = typeof raw === "string" ? raw : typeof err.message === "string" ? err.message : message;
  const failure = classifyFailure({ ...signalOf(raw, effectiveStatus), message: bodyMessage, retryAfterMs: retryAfterRemainingMs() });
  return new RpcError(message, { status: effectiveStatus, code, details, hint, failure });
}

/** Contract markers (kept exported for diagnostics/tests). */
export const IDEMPOTENCY_CONTRACT_MARKERS = [IDEMPOTENCY_MISMATCH, IDEMPOTENCY_KEY_REQUIRED] as const;

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
          status: 0, code: "TIMEOUT", failure: classifyFailure({ status: 0, code: "TIMEOUT", timedOut: true }),
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
  // Same rule as the queue (stampOperationArgs): every in-scope caller mints
  // the key up front; the actor is stamped exactly as a queued replay is.
  args = stampOperationArgs(name, args);
  let outcome = await runRequest(supabase.rpc(name, args), name, timeoutMs);
  for (let n = 0; n < retries && outcome.error?.transient; n++) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)]));
    outcome = await runRequest(supabase.rpc(name, args), name, timeoutMs);
  }
  if (!outcome.error) void touchAuthCache();
  return outcome;
}
