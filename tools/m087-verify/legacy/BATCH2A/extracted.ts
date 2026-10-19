// EXTRACTED (not a git file). BATCH2A (ae51e69) classifies with the REAL
// src/lib/failureClass.ts via the REAL src/stores/data/idempotentRpc.ts
// (callRpc/runRequest/toRpcError) — both exported with `git show ae51e69:...`.
// The callers' decisions are copied VERBATIM from the cited lines; Dexie /
// Zustand side effects are replaced by a returned description.
import { holdBackoffMs, type FailureInfo } from "./src/lib/failureClass";
import { callRpc, runRequest, type RpcOutcome } from "./src/stores/data/idempotentRpc";

/** ae51e69 src/stores/data/outbox.ts:835-869 holdOrRetry (side effects described). */
function holdOrRetry(failure: FailureInfo, entryInDoubt = false) {
  const delayFloorMs = Math.max(holdBackoffMs(failure.hold), failure.retryAfterMs ?? 0); // :839 (plus computeBackoffMs)
  const inDoubt = entryInDoubt || failure.mayHaveCommitted;                                // :846
  const heldReason = failure.klass === "MALFORMED_SUCCESS" ? "unrecognised-reply" : failure.hold ?? undefined; // :847
  let passEnds: string = failure.hold === null && failure.klass !== "MALFORMED_SUCCESS" ? "network" : "backoff"; // :869
  if (failure.klass === "AUTH_REAUTH") passEnds = "refreshSession; 2nd consecutive -> needs-reauth (:854-867)";
  return { state: "pending (kept, same key)", heldReason, inDoubt, delayFloorMs, passEnds };
}

/** ae51e69 src/stores/data/outbox.ts:741-776 (runDrainPass, per entry). Reply-shape check (:747-750) not modelled. */
export async function drainDecision(entry: { kind: "rpc" | "table_write"; name: string; args?: Record<string, unknown> },
  sendTableWrite?: () => PromiseLike<unknown>) {
  const outcome: RpcOutcome = entry.kind === "table_write"
    ? await runRequest(sendTableWrite!() as never, entry.name) // :742 runTableWrite -> runRequest (tableWrite.ts:149)
    : await callRpc(entry.name, entry.args ?? {});            // :743
  if (outcome.error) {
    const { failure } = outcome.error;                         // :760
    if (failure.retryable) return { klass: failure.klass, why: "outbox.ts:761-764 -> holdOrRetry", ...holdOrRetry(failure), outcome };
    // :765-775 status "conflict", failureKind permanent; continue
    return { klass: failure.klass, why: "outbox.ts:765-775", state: "conflict", heldReason: undefined, inDoubt: false, delayFloorMs: 0, passEnds: "continue", outcome };
  }
  return { klass: "SUCCESS", why: "outbox.ts:785-815", state: "synced", heldReason: undefined, inDoubt: false, delayFloorMs: 0, passEnds: "continue", outcome };
}

/** ae51e69 src/stores/data/writeAhead.ts:259-331 (sendAndResolve, online checkout after write-ahead). */
export async function onlineSaleDecision(args: Record<string, unknown>) {
  const outcome = await callRpc("complete_sale", args);   // :261
  const error = outcome.error;
  if (!error) return { result: "ONLINE_OK", klass: "SUCCESS", detail: "writeAhead.ts:273-279 (reply-shape check :263-271 not modelled)" };
  const { failure } = error;                               // :282
  if (!failure.retryable || failure.hold === "suspended" || failure.hold === "reauth" || failure.hold === "backend-version") { // :284
    return { result: "ERROR_SHOWN (write-ahead discarded)", klass: failure.klass, detail: "writeAhead.ts:284-287" };
  }
  if (!failure.mayHaveCommitted) {                          // :304
    return { result: "OFFLINE_SALE_QUEUED (not in doubt)", klass: failure.klass, detail: "writeAhead.ts:304-312 stageAndCommit offline, same key" };
  }
  return { result: "IN_DOUBT_STAGED (PendingConfirmation)", klass: failure.klass, detail: "writeAhead.ts:314-331 same key; if offline rules refuse, row kept pending+inDoubt" };
}

/** ae51e69 src/stores/data/tableWrite.ts:75-80 (writeTableRow online branch); request = replayTableWrite :107-109. */
export async function tableWriteDecision(send: () => PromiseLike<unknown>, label: string) {
  const outcome = await runRequest(send() as never, label); // runTableWrite :149 (evaluateTableWrite :124 passes errors through)
  if (outcome.error) {
    const { failure } = outcome.error;
    if (failure.retryable && failure.hold === null) return { result: "QUEUED_LOCAL_SUCCESS", klass: failure.klass, detail: "tableWrite.ts:78" };
    return { result: "ERROR_RETURNED", klass: failure.klass, detail: "tableWrite.ts:79" };
  }
  return { result: "OK", klass: "SUCCESS", detail: "" };
}
