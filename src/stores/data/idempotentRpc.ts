import { supabase } from "../../lib/supabase";
import { EXECUTOR_RPCS } from "../../lib/executorRpcs";
import { isNetworkError } from "../../lib/errors";
import { classifyFailure, failureInfo, recoveryCodeOf, signalOf, type FailureInfo } from "../../lib/failureClass";
import { retryAfterRemainingMs } from "../../lib/retryAfter";
import { touchAuthCache } from "../authCache";
import { localDb, SYNC_STATE_KEYS } from "../../lib/localDb";
import { currentBackendOrigin } from "../../lib/backendOrigin";
import { RecoveryV1Blocked, requireRecoveryV1Write } from "../../recovery/client";
import { captureTransmission, EvidenceIntegrityError } from "../../recovery/journalCapture";
import { OFFLINE_HEADER, type OfflineAuth } from "../../recovery/offlineCapability";
import {
  currentOpEpoch, noteEpochStale, noteRecoveryRefusal, noteWitness, recoveryBlocksSending, recoveryCapability, recoveryMessage,
  recoveryView, storedEpoch, v87Context,
} from "./recoveryState";

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
  // Step 4 (PFIN-D)
  "fin_close_shift",
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
  if (typeof out[IDEMPOTENCY_KEY_ARG] !== "string") out[IDEMPOTENCY_KEY_ARG] = idempotencyKey ?? idempotencyKeyFor(name);
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
  /** Migration 087: the server-issued epoch the operation is created under
   *  (null on a server without 087, or when the till has no usable epoch —
   *  such an operation is refused before anything is saved). Never replaced. */
  opEpoch: string | null;
  /** Recovery V1 Step 4: set ONLY when the operation was recorded while disconnected under a server-issued offline
   *  capability (gateNewOperation). Sent with every attempt as the x-orvix-offline header; never changed afterwards. */
  offlineAuth?: OfflineAuth | null;
}

export function beginOperation(name?: string): OperationContext {
  return { idempotencyKey: name ? idempotencyKeyFor(name) : newIdempotencyKey(), createdAt: new Date().toISOString(), opEpoch: currentOpEpoch() };
}

// Step 4 (PFIN-D): keyed RPCs that are NOT on the executor's (pinned) list. 086's idem_begin runs a UUIDv7 key only
// inside op_execute, and op_execute can never dispatch these, so they are called directly with a random (v4) key — the
// 085 ledger rule, which 086 keeps and never prunes. Replays with the same key return the first result as before.
export const DIRECT_KEYED_RPCS = new Set(["fin_record_cash_movement", "fin_close_shift"]);

/** A random v4 key (crypto.randomUUID), for DIRECT_KEYED_RPCS only. */
export function newDirectIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The key kind the server accepts for this RPC. */
export function idempotencyKeyFor(name: string, now: number = Date.now()): string {
  return DIRECT_KEYED_RPCS.has(name) ? newDirectIdempotencyKey() : newIdempotencyKey(now);
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
  /** 087: the server's signed binding of the reply, as received (journal evidence). */
  signedReply?: { signed: unknown; sig: string };
}

// Loose view of what supabase-js resolves with — postgrest-js puts the HTTP
// status next to `error`, not inside it, and a mocked client may omit it.
interface RawResponse {
  data?: unknown;
  error?: { message?: string; code?: string; details?: string; hint?: string; status?: number } | null;
  status?: number;
}

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
    const outcome = await Promise.race([call, timeout]);
    // 087: any recovery refusal from any request puts the till in the mode it
    // means (durably) — whoever made the request (recoveryState.ts).
    const code = outcome.error?.failure.klass === "RECOVERY" ? recoveryCodeOf(outcome.error.message) : null;
    if (code) await noteRecoveryRefusal(code, outcome.error!.message).catch(() => undefined);
    return outcome;
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
  demonstratedHere.clear();
}

// Deployment-blocker pass (stale schema cache): once THIS backend has
// answered op_execute / op_status, it is known to have 086 — durably, per
// backend origin. A later "function not found" from it is a stale PostgREST
// schema cache (or a server being changed), never proof that 086 is absent:
// nothing is decided from it (no direct-path fallback, no manual close, no
// replacement). Only a server that never answered them keeps the 085 path.
const demonstratedHere = new Set<string>();
const demonstratedKey = (origin: string) => `${SYNC_STATE_KEYS.executorDemonstrated}${origin}`;

function noteDemonstrated(): void {
  const origin = currentBackendOrigin();
  if (!origin || demonstratedHere.has(origin)) return;
  demonstratedHere.add(origin);
  const at = new Date().toISOString();
  void localDb.syncState.put({ key: demonstratedKey(origin), value: at, updatedAt: at }).catch((err) => {
    console.error("[sync] could not record that this server has migration 086 (kept for this session):", err);
  });
}

/** Has THIS backend ever shown it has 086? true / false; a storage error
 *  counts as true (fail closed: nothing is decided from "not found"). */
export async function executorDemonstrated(): Promise<boolean> {
  const origin = currentBackendOrigin();
  if (!origin) return true;
  if (demonstratedHere.has(origin)) return true;
  try {
    return Boolean(await localDb.syncState.get(demonstratedKey(origin)));
  } catch {
    return true;
  }
}

/** "Function not found" from a backend that has answered 086 before. */
const staleSchemaError = (fn: string, status?: number): RpcError =>
  new RpcError(
    `The server answered that ${fn} does not exist, but it has migration 086 (it answered before): its schema cache is stale or it is being changed. Nothing ran and nothing was decided — this is retried later.`,
    { status, code: "OP_SCHEMA_UNAVAILABLE", failure: failureInfo("WAITING_BACKEND") },
  );

const noteCapability = (next: ExecutorCapability): void => {
  if (next === "available") noteDemonstrated();
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

// ----------------------------------------------------------------------
// Step 4: how a request is actually sent.
//  - a split / mixed-payment sale (complete_sale with p_payments) is sent through fin_complete_sale_split, which calls the
//    SAME complete_sale on the route the server needs (direct, 086 op_execute or 087 op_execute_v87) and binds the payment
//    list to that one sale; the reply shape is exactly that route's reply;
//  - an operation recorded offline under a capability carries the x-orvix-offline header on every attempt.
// ----------------------------------------------------------------------
export interface SendContext { payments: unknown[] | null; offlineAuth: OfflineAuth | null }
const NO_SEND: SendContext = { payments: null, offlineAuth: null };
export const SPLIT_RPC = "fin_complete_sale_split";
type Builder = PromiseLike<RawResponse> & { setHeader?: (name: string, value: string) => unknown };
function rpcRequest(fn: string, params: Record<string, unknown>, send: SendContext): PromiseLike<RawResponse> {
  let builder: Builder;
  if (send.payments) {
    const route = fn === "op_execute_v87" ? "v87" : fn === "op_execute" ? "op_execute" : "direct";
    const split = route === "direct"
      ? { p_route: route, p_key: params[IDEMPOTENCY_KEY_ARG], p_args: params, p_payments: send.payments, p_actor_id: null, p_ctx: null }
      : { p_route: route, p_key: params.p_key, p_args: params.p_args, p_payments: send.payments, p_actor_id: params.p_actor_id ?? null, p_ctx: params.p_ctx ?? null };
    builder = supabase.rpc(SPLIT_RPC, split) as unknown as Builder;
  } else {
    builder = supabase.rpc(fn, params) as unknown as Builder;
  }
  if (send.offlineAuth) {
    // fail closed: an operation recorded offline is never sent as an ordinary online one
    if (typeof builder.setHeader !== "function") {
      // nothing is sent; the queue holds it for an owner like any refused offline sale ([offline_…])
      return Promise.resolve({ data: null, status: 0, error: { code: "PT503", message:
        "OFFLINE_HEADER_UNSUPPORTED: this client cannot attach its offline authorization; not sent [offline_header_unsupported]" } } as unknown as RawResponse);
    }
    builder = builder.setHeader(OFFLINE_HEADER, JSON.stringify({ capabilityId: send.offlineAuth.capabilityId, deviceSeq: send.offlineAuth.deviceSeq })) as Builder;
  }
  return builder;
}
/** The server has no split-payment entry point (an 085/086 server without PFIN-D): nothing ran; never converted. */
const splitUnsupportedError = (status?: number): RpcError => new RpcError(
  "This sale has a split payment, which this server does not support yet (it needs the PFIN-D migration). Nothing was sent; the sale is kept with its key for review.",
  { status, code: "FIN_SPLIT_UNSUPPORTED", failure: failureInfo("CONTRACT") });

async function viaExecutor(name: string, args: Record<string, unknown>, timeoutMs: number, actorId: string | null, send: SendContext = NO_SEND): Promise<RpcOutcome | "absent"> {
  const { [IDEMPOTENCY_KEY_ARG]: key, ...rest } = args;
  // p_actor_id: who CREATED the operation. The server runs it only in that
  // user's session (a queue drained by someone else is never executed).
  const outcome = await runRequest(
    rpcRequest("op_execute", { p_key: key, p_rpc: name, p_args: rest, p_actor_id: actorId }, send), name, timeoutMs,
  );
  if (outcome.error) {
    if (send.payments && isMissingFunction(outcome.error, SPLIT_RPC)) return { data: null, status: outcome.status, via: "executor", error: splitUnsupportedError(outcome.status) };
    if (isMissingFunction(outcome.error, "op_execute")) {
      if (await executorDemonstrated()) return { data: null, status: outcome.status, via: "executor", error: staleSchemaError("op_execute", outcome.status) };
      return "absent";
    }
    // op_execute itself raised (OP_… refusals): it exists — the backend has 086.
    if ((outcome.error.message ?? "").startsWith("OP_")) noteDemonstrated();
    return { ...outcome, via: "executor" };
  }
  noteCapability("available");
  return fromExecutorReply(name, outcome.data, outcome.status);
}

// ----------------------------------------------------------------------
// Migration 087: on a backend that has shown 087, every executor RPC goes
// through op_execute_v87 with the till context and the operation's OWN
// creation epoch; fences through op_status_v87. Lookups stay read-only
// (op_status). Nothing here ever creates, guesses or replaces an epoch.
// ----------------------------------------------------------------------

/** The 087 path is used once the backend has shown 087 (durable, per origin). */
export const v87Routing = (): boolean => recoveryCapability() === "present";

const RECOVERY_PREFIX = "ORG_SUSPENDED: server recovery in progress";

/** An operation created without an epoch, on an 087 server: never sent automatically. */
export const LEGACY_OPERATION = "LEGACY_OPERATION";
export const legacyOperationError = (name: string): RpcError =>
  new RpcError(
    `This ${name} was created before this till had a recovery epoch from the server (an older version or queue). It is never sent or stopped automatically: it keeps its original key and an owner reviews it.`,
    { code: LEGACY_OPERATION, failure: failureInfo("RECOVERY") },
  );

/** The till is in recovery mode: nothing is sent or stopped automatically. */
export const recoveryModeError = (): RpcError => {
  const view = recoveryView();
  return new RpcError(`${RECOVERY_PREFIX} [${view.code ?? "TILL_RECOVERY_MODE"}] (this till is in recovery mode: ${recoveryMessage(view.mode === "legacy-server" ? "normal" : view.mode, view.code)})`,
    { code: "PT429", failure: failureInfo("RECOVERY") });
};

/** The committed {outcome:'held'} reply of a v87 function: the server held the organisation; nothing ran. */
const heldReplyError = (status?: number): RpcError =>
  new RpcError(`${RECOVERY_PREFIX} [CONTINUITY_ROLLBACK] (the server held this organisation: this till had seen history the server no longer has)`,
    { status, code: "PT429", failure: failureInfo("RECOVERY") });

/** PRE_EPOCH_OPERATION for an operation stamped with OUR current epoch: our epoch is stale. */
async function notePreEpoch(error: RpcError | null, opEpoch: string | null | undefined): Promise<void> {
  if (recoveryCodeOf(error?.message) !== "PRE_EPOCH_OPERATION") return;
  if (opEpoch && opEpoch === storedEpoch()?.epoch) await noteEpochStale(error!.message).catch(() => undefined);
}

async function viaExecutor87(name: string, args: Record<string, unknown>, timeoutMs: number, actorId: string | null, opEpoch: string | null | undefined,
  send: SendContext = NO_SEND): Promise<RpcOutcome> {
  if (!opEpoch) return { data: null, via: "executor", error: legacyOperationError(name) };
  const { [IDEMPOTENCY_KEY_ARG]: key, ...rest } = args;
  const outcome = await runRequest(
    rpcRequest("op_execute_v87", { p_key: key, p_rpc: name, p_args: rest, p_actor_id: actorId, p_ctx: v87Context(opEpoch) }, send), name, timeoutMs,
  );
  if (outcome.error) {
    if (send.payments && isMissingFunction(outcome.error, SPLIT_RPC)) return { data: null, status: outcome.status, via: "executor", error: splitUnsupportedError(outcome.status) };
    if (isMissingFunction(outcome.error, "op_execute_v87")) return { data: null, status: outcome.status, via: "executor", error: staleSchemaError("op_execute_v87", outcome.status) };
    await notePreEpoch(outcome.error, opEpoch);
    return { ...outcome, via: "executor" };
  }
  const d = (outcome.data && typeof outcome.data === "object" && !Array.isArray(outcome.data) ? outcome.data : {}) as Record<string, unknown>;
  if (d.outcome === "held") {
    await noteRecoveryRefusal("CONTINUITY_ROLLBACK", "op_execute_v87 answered {outcome: held}").catch(() => undefined);
    return { data: null, status: outcome.status, via: "executor", error: heldReplyError(outcome.status) };
  }
  noteCapability("available");
  await noteWitness(d.witness);
  const res = fromExecutorReply(name, d, outcome.status);
  if (d.signed !== undefined && typeof d.sig === "string") res.signedReply = { signed: d.signed, sig: d.sig };
  return res;
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
  opts: { fence?: boolean; actorId?: string | null; args?: Record<string, unknown> | null; timeoutMs?: number; opEpoch?: string | null } = {},
): Promise<LookupResult> {
  // p_args: the operation's own arguments (key removed), so the server can
  // verify from its own rows which organisation the operation belongs to.
  const { [IDEMPOTENCY_KEY_ARG]: _key, ...args } = opts.args ?? {};
  void _key;
  // 087: a fence goes through op_status_v87 with the operation's OWN epoch —
  // never while the till is in recovery mode, never for a legacy operation
  // (an old operation is fenced only by an owner-approved decision).
  const fence87 = opts.fence === true && v87Routing();
  if (fence87 && recoveryBlocksSending()) return { absent: false, status: null, error: recoveryModeError() };
  if (fence87 && !opts.opEpoch) return { absent: false, status: null, error: legacyOperationError(rpc) };
  const outcome = await runRequest(
    fence87
      ? supabase.rpc("op_status_v87", {
        p_key: key, p_rpc: rpc, p_fence: true, p_expected_actor_id: opts.actorId ?? null, p_args: opts.args ? args : null,
        p_ctx: v87Context(opts.opEpoch ?? null),
      })
      : supabase.rpc("op_status", {
        p_key: key, p_rpc: rpc, p_fence: opts.fence === true, p_expected_actor_id: opts.actorId ?? null,
        p_args: opts.args ? args : null,
      }),
    `${rpc} status`, opts.timeoutMs ?? RPC_TIMEOUT_MS,
  );
  if (fence87 && !outcome.error) {
    const d = (outcome.data ?? {}) as Record<string, unknown>;
    if (d.outcome === "held") {
      await noteRecoveryRefusal("CONTINUITY_ROLLBACK", "op_status_v87 answered {outcome: held}").catch(() => undefined);
      return { absent: false, status: null, error: heldReplyError(outcome.status) };
    }
    await noteWitness(d.witness);
  }
  if (fence87 && outcome.error) {
    await notePreEpoch(outcome.error, opts.opEpoch);
    // FENCE_NOT_APPLIED: the key is in flight, decided or not this till's to stop:
    // nothing changed — read what the server holds instead (read-only).
    if (recoveryCodeOf(outcome.error.message) === "FENCE_NOT_APPLIED") return lookupOperation(rpc, key, { ...opts, fence: false });
  }
  if (outcome.error) {
    if (isMissingFunction(outcome.error, "op_status")) {
      if (await executorDemonstrated()) return { absent: false, status: null, error: staleSchemaError("op_status", outcome.status) };
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
  /** 087: the epoch the operation was created under (never replaced). */
  opEpoch?: string | null;
  /** Step 4: the operation was recorded offline under this capability (sent as x-orvix-offline; never replaced). */
  offlineAuth?: OfflineAuth | null;
}

/** One attempt: through the executor when the server has it, else direct.
 *  Each supabase-js builder is created and awaited exactly once. */
async function attempt(name: string, args: Record<string, unknown>, timeoutMs: number, actorId: string | null, opEpoch?: string | null,
  offlineAuth?: OfflineAuth | null): Promise<RpcOutcome> {
  // Final common financial boundary, including automatic retries. No signed
  // identity is regenerated and no old operation is given a replacement key.
  try {
    const { useAuthStore } = await import("../authStore");
    const { useAppStore } = await import("../appStore");
    const { getJournalRecord } = await import("./opJournal");
    const key = String(args[IDEMPOTENCY_KEY_ARG]);
    const original = await getJournalRecord(key);
    const orgId = original?.orgId ?? useAuthStore.getState().currentOrgId ?? null;
    const shopId = original?.shopId ?? (typeof args.p_shop_id === "string" ? args.p_shop_id : useAppStore.getState().currentShopId ?? null);
    if (await requireRecoveryV1Write(orgId, shopId)) {
      await captureTransmission({ orgId, shopId, backendOrigin: original?.backendOrigin ?? currentBackendOrigin(), actorId,
        key, rpc: name, args, opEpoch: opEpoch ?? null, createdAt: original?.createdAt ?? new Date().toISOString() });
    }
  } catch (error) {
    // Nothing was sent in any of these cases. A communication failure with a
    // recovery-aware server, a verified restriction or an unavailable device
    // authorization is a HOLD: the operation stays pending with its original key
    // and is retried later under the existing idempotency rules (never re-keyed).
    // Only contradictory local evidence stops it for a person (conflict).
    const message = error instanceof Error ? error.message : "Recovery evidence unavailable";
    const integrity = error instanceof EvidenceIntegrityError || (error instanceof RecoveryV1Blocked && error.reason === "integrity");
    return { data: null, error: new RpcError(message, { code: "PT503", status: 503,
      failure: integrity ? { ...failureInfo("RECOVERY"), mayHaveCommitted: false, retryable: false } : { ...failureInfo("RECOVERY"), mayHaveCommitted: false } }) };
  }
  // Step 4: a split payment travels beside the sale's own (hashed) arguments, never inside them
  const payments = name === "complete_sale" && Array.isArray(args.p_payments) ? (args.p_payments as unknown[]) : null;
  if (payments) { const { p_payments: _drop, ...rest } = args; void _drop; args = rest; }
  const send: SendContext = { payments, offlineAuth: offlineAuth ?? null };
  // 087 backend: executor RPCs only through op_execute_v87 (legacy paths are closed there)
  // (an operation that carries an epoch was created against an 087 server: always the v87 path)
  if (EXECUTOR_RPCS.has(name) && (v87Routing() || opEpoch)) return viaExecutor87(name, args, timeoutMs, actorId, opEpoch, send);
  if (EXECUTOR_RPCS.has(name) && mayUseExecutor()) {
    const viaExec = await viaExecutor(name, args, timeoutMs, actorId, send);
    if (viaExec !== "absent") return viaExec;
    // op_execute does not exist on this server: nothing ran. 085 behaviour.
    noteCapability("absent");
  }
  const direct = { ...(await runRequest(rpcRequest(name, args, send), name, timeoutMs)), via: "direct" as const };
  if (payments && direct.error && isMissingFunction(direct.error, SPLIT_RPC)) return { data: null, status: direct.status, via: "direct", error: splitUnsupportedError(direct.status) };
  if (EXECUTOR_RPCS.has(name) && executorRequired(direct.error)) {
    // An 086 server refused the legacy path for this key (nothing ran): the
    // executor exists after all (e.g. a stale schema cache). Ask it.
    noteDemonstrated();
    noteCapability("unknown");
    const viaExec = await viaExecutor(name, args, timeoutMs, actorId, send);
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
  let outcome = await attempt(name, args, timeoutMs, actorId, options.opEpoch, options.offlineAuth);
  // An attempt whose outcome is unknown (timeout, lost reply) stays unknown
  // until the SERVER answers for this key: a later attempt that never
  // reached the operation (401, edge block, network, another session…) does
  // not prove the earlier one did not commit (stabilization C).
  let uncertain = Boolean(outcome.error?.failure.mayHaveCommitted);
  // a recovery refusal is never retried automatically (the till is in recovery mode)
  for (let n = 0; n < retries && outcome.error?.transient && outcome.error.failure.klass !== "RECOVERY"; n++) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)]));
    outcome = await attempt(name, args, timeoutMs, actorId, options.opEpoch, options.offlineAuth);
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
