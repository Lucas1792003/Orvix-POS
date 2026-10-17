import { supabase } from "../../lib/supabase";
import { EXECUTOR_RPCS } from "../../lib/executorRpcs";
import { isNetworkError } from "../../lib/errors";
import { classifyFailure, failureInfo, signalOf, type FailureInfo } from "../../lib/failureClass";
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

/** The app user acting right now (null when unknown). */
export function currentActorId(): string | null {
  return actorSource();
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

/**
 * A new operation key: an RFC 9562 UUIDv7 (48-bit millisecond time, version
 * 7, variant 10, 74 random bits). Migration 086 executes a v7 key only
 * inside its window (server clock) and can therefore prune its decision
 * safely later; the time is never trusted as the operation's time. Servers
 * without 086 accept it like any other uuid.
 */
export function newIdempotencyKey(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
  /** Which server path answered: the 086 executor or the RPC itself. */
  via?: "executor" | "direct";
  /** What the server's ledger says about this key (executor only). */
  serverOutcome?: "committed" | "rejected" | "abandoned" | "mismatch";
  /** The server answered from its ledger (an earlier attempt decided it). */
  replayed?: boolean;
  /** Committed, but its reply cannot be read here: it belongs to another
   *  user (withheld) or was purged. Reconcile by a verified reload. */
  responseUnavailable?: "withheld" | "purged";
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

// ----------------------------------------------------------------------
// Migration 086: the guarded executor (op_execute) and the status lookup
// (op_status). When the server has them, every allow-listed RPC is sent
// through op_execute: a definitive refusal is recorded there and replayed
// (B2), a fenced key never executes (C1). A server without 086 answers
// PGRST202 for op_execute — nothing ran, so the same attempt goes to the RPC
// directly (085 behaviour) and the capability is remembered for a while.
// ----------------------------------------------------------------------

/** The 29 RPCs migration 086 executes (create_app_user stays direct-only).
 *  Defined in a dependency-free module so tools/queue-recovery shares it. */
export { EXECUTOR_RPCS };

export type ExecutorCapability = "unknown" | "available" | "absent";
const ABSENT_RECHECK_MS = 10 * 60_000;
// The unit suites mock individual RPCs: under vitest the capability starts
// PINNED to "absent" (the 085 direct path) unless a test opts in.
let pinned = import.meta.env?.MODE === "test";
let capability: ExecutorCapability = pinned ? "absent" : "unknown";
let capabilitySince = 0;

export function executorCapability(): ExecutorCapability {
  return capability;
}

/** Tests only: set (and by default pin) what the client believes. */
export function setExecutorCapabilityForTests(next: ExecutorCapability, pin = true): void {
  capability = next;
  pinned = pin;
  capabilitySince = Date.now();
}

const noteCapability = (next: ExecutorCapability): void => {
  if (pinned) return;
  capability = next;
  capabilitySince = Date.now();
};
const mayUseExecutor = (): boolean =>
  pinned ? capability !== "absent" : capability !== "absent" || Date.now() - capabilitySince > ABSENT_RECHECK_MS;
/** The server does not have the 086 function: PostgREST's PGRST202, or —
 *  with a stale schema cache — PostgreSQL's 42883 for it. Either way the
 *  statement never ran. */
const isMissingFunction = (error: RpcError | null, fn: string): boolean =>
  error?.code === "PGRST202" || (error?.code === "42883" && (error.message ?? "").includes(fn));
/** The legacy path refused a UUIDv7 key: it must go through op_execute (nothing ran). */
const executorRequired = (error: RpcError | null): boolean => (error?.message ?? "").startsWith("OP_EXECUTOR_REQUIRED");

const finalError = (message: string, code: string, klass: "REJECTED" | "ABANDONED" | "CONTRACT", status?: number): RpcError =>
  new RpcError(message, { status, code, failure: failureInfo(klass) });

/** The executor's envelope, as an RpcOutcome. Exported for tests. */
export function fromExecutorReply(rpc: string, data: unknown, status?: number): RpcOutcome {
  const d = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const replayed = d.replayed === true;
  const base = { status, via: "executor" as const, replayed };
  switch (d.outcome) {
    case "committed":
      if (d.withheld === true || d.response_purged === true || d.response === null || d.response === undefined) {
        return { ...base, data: null, error: null, serverOutcome: "committed", responseUnavailable: d.withheld === true ? "withheld" : "purged" };
      }
      return { ...base, data: d.response, error: null, serverOutcome: "committed" };
    case "rejected":
      return {
        ...base, data: null, serverOutcome: "rejected",
        error: finalError(
          typeof d.message === "string" && d.message ? d.message
            : "Refused by the server (recorded). The details are visible to the person who entered it or an administrator.",
          typeof d.code === "string" && d.code ? d.code : "OP_REJECTED", "REJECTED", status,
        ),
      };
    case "abandoned":
      return {
        ...base, data: null, serverOutcome: "abandoned",
        error: finalError(
          "This operation was stopped before the server applied it and will never be applied. Enter it again as a new operation if it is still needed.",
          "OP_ABANDONED", "ABANDONED", status,
        ),
      };
    case "mismatch":
      return {
        ...base, data: null, serverOutcome: "mismatch",
        error: finalError(`IDEMPOTENCY_MISMATCH: the key of this ${rpc} was used for a different request`, "23505", "CONTRACT", status),
      };
    default:
      // A 2xx we cannot read: the executor may have committed.
      return {
        ...base, data: null,
        error: new RpcError(`Unrecognised reply from the operation executor (${rpc})`, {
          status, code: "MALFORMED_REPLY", failure: failureInfo("MALFORMED_SUCCESS"),
        }),
      };
  }
}

async function viaExecutor(name: string, args: Record<string, unknown>, timeoutMs: number, actorId: string | null): Promise<RpcOutcome | "absent"> {
  const { [IDEMPOTENCY_KEY_ARG]: key, ...rest } = args;
  // p_actor_id: who CREATED the operation. The server runs it only in that
  // user's session (a queue drained by someone else is never executed).
  const outcome = await runRequest(
    supabase.rpc("op_execute", { p_key: key, p_rpc: name, p_args: rest, p_actor_id: actorId }), name, timeoutMs,
  );
  if (outcome.error) {
    if (isMissingFunction(outcome.error, "op_execute")) return "absent";
    return { ...outcome, via: "executor" };
  }
  noteCapability("available");
  return fromExecutorReply(name, outcome.data, outcome.status);
}

export interface OperationStatus {
  status: "committed" | "rejected" | "abandoned" | "in_flight" | "not_found" | "unavailable";
  response?: unknown;
  code?: string | null;
  message?: string | null;
  withheld?: boolean;
  responsePurged?: boolean;
  /** not_found only: false when the key can never execute any more. */
  executable?: boolean;
  /** A fence was requested: whether this call decided the key as abandoned. */
  fenced?: boolean;
  reason?: string;
}

export interface LookupResult {
  /** The server has no 086 (op_status missing). */
  absent: boolean;
  status: OperationStatus | null;
  error: RpcError | null;
}

const STATUSES = new Set(["committed", "rejected", "abandoned", "in_flight", "not_found", "unavailable"]);

/**
 * Ask the server what became of an operation (op_status). With `fence`, a
 * key the server has never seen is atomically decided as abandoned, so a
 * late copy of the request can never execute. `actorId`: the app user who
 * created the operation (the server lets only that user, or an
 * administrator of the same organisation, fence it). One request per call.
 */
export async function lookupOperation(
  rpc: string, key: string,
  opts: { fence?: boolean; actorId?: string | null; args?: Record<string, unknown> | null; timeoutMs?: number } = {},
): Promise<LookupResult> {
  // p_args: the operation's own arguments (key removed), so the server can
  // verify from its own rows which organisation the operation belongs to.
  const { [IDEMPOTENCY_KEY_ARG]: _key, ...args } = opts.args ?? {};
  void _key;
  const outcome = await runRequest(
    supabase.rpc("op_status", {
      p_key: key, p_rpc: rpc, p_fence: opts.fence === true, p_expected_actor_id: opts.actorId ?? null,
      p_args: opts.args ? args : null,
    }),
    `${rpc} status`, opts.timeoutMs ?? RPC_TIMEOUT_MS,
  );
  if (outcome.error) {
    if (isMissingFunction(outcome.error, "op_status")) {
      noteCapability("absent");
      return { absent: true, status: null, error: null };
    }
    return { absent: false, status: null, error: outcome.error };
  }
  noteCapability("available");
  const d = (outcome.data ?? {}) as Record<string, unknown>;
  if (typeof d.status !== "string" || !STATUSES.has(d.status)) {
    return {
      absent: false, status: null,
      error: new RpcError(`Unrecognised status reply for ${rpc}`, { status: outcome.status, code: "MALFORMED_REPLY", failure: failureInfo("MALFORMED_SUCCESS") }),
    };
  }
  return {
    absent: false, error: null,
    status: {
      status: d.status as OperationStatus["status"],
      response: d.response ?? undefined,
      code: typeof d.code === "string" ? d.code : null,
      message: typeof d.message === "string" ? d.message : null,
      withheld: d.withheld === true,
      responsePurged: d.response_purged === true,
      executable: typeof d.executable === "boolean" ? d.executable : undefined,
      fenced: typeof d.fenced === "boolean" ? d.fenced : undefined,
      reason: typeof d.reason === "string" ? d.reason : undefined,
    },
  };
}

interface CallOptions {
  timeoutMs?: number;
  /** Automatic retries on a *transient* failure, with the same args (and
   *  therefore the same idempotency key). Only used for online-only RPCs;
   *  offline-capable ones fall back to the outbox instead. */
  retries?: number;
  /** The app user who CREATED the operation (default: who acts now). Null
   *  only for a legacy queue entry recorded without one. */
  actorId?: string | null;
}

/** One attempt: through the executor when the server has it, else direct.
 *  Each supabase-js builder is created and awaited exactly once. */
async function attempt(name: string, args: Record<string, unknown>, timeoutMs: number, actorId: string | null): Promise<RpcOutcome> {
  if (EXECUTOR_RPCS.has(name) && mayUseExecutor()) {
    const viaExec = await viaExecutor(name, args, timeoutMs, actorId);
    if (viaExec !== "absent") return viaExec;
    // op_execute does not exist on this server: nothing ran. 085 behaviour.
    noteCapability("absent");
  }
  const direct = { ...(await runRequest(supabase.rpc(name, args), name, timeoutMs)), via: "direct" as const };
  if (EXECUTOR_RPCS.has(name) && executorRequired(direct.error)) {
    // An 086 server refused the legacy path for this key (nothing ran): the
    // executor exists after all (e.g. a stale schema cache). Ask it.
    noteCapability("unknown");
    const viaExec = await viaExecutor(name, args, timeoutMs, actorId);
    if (viaExec !== "absent") return viaExec;
  }
  return direct;
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
  const actorId = options.actorId !== undefined ? options.actorId : currentActorId();
  // Same rule as the queue (stampOperationArgs): every in-scope caller mints
  // the key up front; the actor is stamped exactly as a queued replay is.
  args = stampOperationArgs(name, args);
  let outcome = await attempt(name, args, timeoutMs, actorId);
  // An attempt whose outcome is unknown (timeout, lost reply) stays unknown
  // until the SERVER answers for this key: a later attempt that never
  // reached the operation (401, edge block, network, another session…) does
  // not prove the earlier one did not commit (stabilization C).
  let uncertain = Boolean(outcome.error?.failure.mayHaveCommitted);
  for (let n = 0; n < retries && outcome.error?.transient; n++) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)]));
    outcome = await attempt(name, args, timeoutMs, actorId);
    if (outcome.error?.failure.mayHaveCommitted) uncertain = true;
  }
  if (uncertain) outcome = keepUnknown(outcome);
  if (!outcome.error) void touchAuthCache();
  return outcome;
}

/** After an unknown attempt, ONLY a server decision (committed / rejected /
 *  abandoned, from the ledger) or a success settles the operation. Every
 *  other failure — 401, 503, timeout, network, an unrecorded refusal (a
 *  delayed copy could still be waiting before the lock), a gateway 4xx — is
 *  reported as UNKNOWN (may have committed), never as "not applied". */
export function keepUnknown(outcome: RpcOutcome): RpcOutcome {
  const err = outcome.error;
  if (!err || outcome.serverOutcome || err.failure.mayHaveCommitted) return outcome;
  return {
    ...outcome,
    error: new RpcError(`${err.message} — and an earlier attempt's outcome is unknown: it may already have been applied`, {
      status: err.status, code: err.code, details: err.details, hint: err.hint,
      failure: { ...failureInfo("UNKNOWN_OUTCOME"), retryAfterMs: err.failure.retryAfterMs },
    }),
  };
}
