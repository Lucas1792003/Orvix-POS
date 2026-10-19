// EXTRACTED (not a git file). RC3 (a722aa3) classifies with the REAL
// src/stores/data/idempotentRpc.ts toRpcError/runRequest/callRpc and the REAL
// src/lib/errors.ts (both exported with `git show a722aa3:...`). The callers'
// decisions below are copied VERBATIM from the cited lines; Dexie/Zustand side
// effects are replaced by a returned description.
import { isDuplicateError, isGatewayStatus, isNetworkError } from "./src/lib/errors";
import { callRpc, runRequest, type RpcOutcome } from "./src/stores/data/idempotentRpc";

/** a722aa3 src/stores/data/outbox.ts:539-586 (runDrainPass, per entry). */
export async function drainDecision(
  entry: { kind: "rpc" | "table_write"; op?: string; name: string; args?: Record<string, unknown> },
  sendTableWrite?: () => PromiseLike<unknown>,
) {
  const outcome: RpcOutcome = entry.kind === "table_write"
    ? await runRequest(sendTableWrite!() as never, entry.name)   // :540
    : await callRpc(entry.name, entry.args ?? {});              // :541
  if (outcome.error) {
    const alreadyApplied =
      entry.kind === "table_write" && entry.op === "insert" && isDuplicateError(outcome.error); // :547-548
    if (!alreadyApplied && outcome.error.transient) {
      // :550-561 status "pending", attempts+1, failureKind transient, nextAttemptAt = backoff; return "network"
      return { state: "pending+backoff", passEnds: true, transient: true, status: outcome.error.status, why: "outbox.ts:550-561", outcome };
    }
    if (!alreadyApplied) {
      // :564-573 status "conflict", failureKind permanent; continue
      return { state: "conflict", passEnds: false, transient: false, status: outcome.error.status, why: "outbox.ts:564-573", outcome };
    }
  }
  return { state: "synced", passEnds: false, transient: false, status: outcome.status, why: "outbox.ts:583-586", outcome };
}

/** a722aa3 src/stores/data/slices/saleSlice.ts:120-123 (createSaleOnline) + :318-332 (createSale). */
export async function onlineSaleDecision(args: Record<string, unknown>) {
  try {
    const { data, error } = await callRpc("complete_sale", args); // :121
    if (error) throw error;                                       // :122
    if (!data) throw new Error("Checkout returned no data.");     // :123
    return { result: "ONLINE_OK", detail: "" };
  } catch (err) {
    if (isNetworkError(err)) return { result: "OFFLINE_SALE_QUEUED", detail: "saleSlice.ts:330 -> createSaleOffline (same key)" };
    return { result: "ERROR_SHOWN", detail: `saleSlice.ts:331 ${(err as Error).message}` };
  }
}

/** a722aa3 src/stores/data/tableWrite.ts:70-88 (writeTableRow, online branch). */
export async function tableWriteDecision(send: () => PromiseLike<{ error: unknown; status?: number }>) {
  try {
    const { error, status } = await send();                                   // :71-76
    if (error && (isNetworkError(error) || isGatewayStatus(status))) {         // :80
      return { result: "QUEUED_LOCAL_SUCCESS", detail: "tableWrite.ts:80-82" };
    }
    if (!error) return { result: "OK", detail: "" };
    return { result: "ERROR_RETURNED", detail: "tableWrite.ts:84" };
  } catch (err) {
    if (isNetworkError(err)) return { result: "QUEUED_LOCAL_SUCCESS", detail: "tableWrite.ts:86" };
    return { result: "ERROR_RETURNED", detail: "tableWrite.ts:87" };
  }
}
