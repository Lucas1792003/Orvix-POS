// EXTRACTED (not a git file). PHASE0 (93ad308) classifies with the REAL
// src/lib/failureClass.ts via the REAL src/stores/data/idempotentRpc.ts
// (callRpc -> attempt -> op_execute(p_key,p_rpc,p_args,p_actor_id) with the
// PGRST202 direct-path fallback, toRpcError, fromExecutorReply) — exported
// with `git show 93ad308:...`. Callers' decisions are copied VERBATIM from the
// cited lines; Dexie/Zustand side effects are replaced by a returned description.
import { holdBackoffMs, type FailureInfo } from "./src/lib/failureClass";
import { callRpc, runRequest, type RpcOutcome } from "./src/stores/data/idempotentRpc";

/** 93ad308 src/stores/data/outbox.ts:1484-1519 holdOrRetry (side effects described). */
function holdOrRetry(failure: FailureInfo, entry: { inDoubt?: boolean; fenceRequired?: boolean } = {}) {
  const delayFloorMs = Math.max(holdBackoffMs(failure.hold), failure.retryAfterMs ?? 0); // :1488 (plus computeBackoffMs)
  const state = entry.fenceRequired === true ? "conflict (held recovery)" : "pending (kept, same key)"; // :1491
  const inDoubt = entry.inDoubt === true || failure.mayHaveCommitted;                     // :1496
  const heldReason = failure.klass === "MALFORMED_SUCCESS" ? "unrecognised-reply" : failure.hold ?? undefined; // :1497
  let passEnds: string = failure.hold === null && failure.klass !== "MALFORMED_SUCCESS" ? "network" : "backoff"; // :1519
  if (failure.klass === "AUTH_REAUTH") passEnds = "refreshSession; 2nd consecutive -> needs-reauth (:1504-1518)";
  return { state, heldReason, inDoubt, delayFloorMs, passEnds };
}

/** 93ad308 src/stores/data/outbox.ts:1108-1201 (runDrainPass, per entry; staged entry of the current user). */
export async function drainDecision(entry: { kind: "rpc" | "table_write"; name: string; args?: Record<string, unknown>; actorId?: string | null },
  sendTableWrite?: () => PromiseLike<unknown>) {
  const outcome: RpcOutcome = entry.kind === "table_write"
    ? await runRequest(sendTableWrite!() as never, entry.name)                       // :1109 runTableWrite
    : await callRpc(entry.name, entry.args ?? {}, { actorId: entry.actorId ?? null }); // :1110
  const via = outcome.via;
  if (!outcome.error && outcome.responseUnavailable) return { klass: "COMMITTED_NO_REPLY", via, why: "outbox.ts:1117-1121", state: "verified reload", heldReason: "committed-verifying", inDoubt: true, delayFloorMs: 60_000, passEnds: "next", outcome };
  if (outcome.error && (outcome.serverOutcome === "rejected" || outcome.serverOutcome === "abandoned")) {
    return { klass: outcome.error.failure.klass, via, why: "outbox.ts:1123-1126 markFinal", state: "conflict (FINAL, server-recorded)", heldReason: undefined, inDoubt: false, delayFloorMs: 0, passEnds: "continue", outcome };
  }
  if (outcome.error?.failure.klass === "WRONG_ACTOR") return { klass: "WRONG_ACTOR", via, why: "outbox.ts:1129-1132 park", state: "pending (parked)", heldReason: "needs-original-user", inDoubt: false, delayFloorMs: 300_000, passEnds: "backoff", outcome };
  if (outcome.error?.failure.klass === "DEPENDENCY") return { klass: "DEPENDENCY", via, why: "outbox.ts:1133-1151 park (conflict after 24h)", state: "pending (parked)", heldReason: "dependency", inDoubt: false, delayFloorMs: 300_000, passEnds: "backoff", outcome };
  if (outcome.error) {
    const { failure } = outcome.error;                                                // :1168
    if (failure.retryable) return { klass: failure.klass, via, why: "outbox.ts:1169-1172 -> holdOrRetry", ...holdOrRetry(failure), outcome };
    const dead = failure.klass === "CONTRACT" || failure.klass === "KEY_EXPIRED";     // :1186
    return {
      klass: failure.klass, via, why: "outbox.ts:1186-1200", state: dead ? "conflict (dead)" : "conflict (NOT final; blocksQueue)",
      heldReason: undefined, inDoubt: false, delayFloorMs: 0, passEnds: dead ? "continue" : "backoff (queue blocked behind it)", outcome,
    };
  }
  return { klass: "SUCCESS", via, why: "outbox.ts:1211 applyServerReply", state: "synced", heldReason: undefined, inDoubt: false, delayFloorMs: 0, passEnds: "continue", outcome };
}

/** 93ad308 src/stores/data/writeAhead.ts:338-417 (sendAndResolve; empty queue so :299 blockingEarlierWork is skipped). */
export async function onlineSaleDecision(args: Record<string, unknown>, actorId: string | null) {
  void actorId;
  const outcome = await callRpc("complete_sale", args);  // :340 (actor = currentActorId())
  const error = outcome.error;
  if (!error && outcome.responseUnavailable) return { result: "IN_DOUBT_STAGED (reply unavailable)", klass: "MALFORMED_SUCCESS", via: outcome.via, detail: "writeAhead.ts:342-349" };
  if (!error) return { result: "ONLINE_OK", klass: "SUCCESS", via: outcome.via, detail: "reply-shape check :350-358 not modelled" };
  const { failure } = error;                                                         // :379
  if (!failure.retryable || failure.hold === "suspended" || failure.hold === "reauth" || failure.hold === "backend-version"
      || failure.klass === "DEPENDENCY" || failure.klass === "WRONG_ACTOR" || failure.klass === "NOT_RECORDED") { // :386-387
    return { result: "ERROR_SHOWN (write-ahead discarded)", klass: failure.klass, via: outcome.via, detail: "writeAhead.ts:386-390" };
  }
  if (!failure.mayHaveCommitted) {                                                    // :409
    return { result: "OFFLINE_SALE_QUEUED (not in doubt)", klass: failure.klass, via: outcome.via, detail: "writeAhead.ts:409-417 stageAndCommit offline, same key" };
  }
  return { result: "IN_DOUBT_STAGED (PendingConfirmation)", klass: failure.klass, via: outcome.via, detail: "writeAhead.ts:419-452 same key; if offline rules refuse -> conflict+fenceRequired (lookup only)" };
}

/** 93ad308 src/stores/data/tableWrite.ts:75-80 (writeTableRow online branch); request = replayTableWrite :107-109. */
export async function tableWriteDecision(send: () => PromiseLike<unknown>, label: string) {
  const outcome = await runRequest(send() as never, label);
  if (outcome.error) {
    const { failure } = outcome.error;
    if (failure.retryable && failure.hold === null) return { result: "QUEUED_LOCAL_SUCCESS", klass: failure.klass, detail: "tableWrite.ts:78" };
    return { result: "ERROR_RETURNED", klass: failure.klass, detail: "tableWrite.ts:79" };
  }
  return { result: "OK", klass: "SUCCESS", detail: "" };
}
