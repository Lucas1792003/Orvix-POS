// EXTRACTED (not a git file). v1.0.15 has no classifier module: the decisions
// are inline. Each function below copies the decision code VERBATIM from the
// cited lines; only the Dexie/Zustand side effects are replaced by a returned
// description of what the real code writes. isNetworkError is the REAL
// v1.0.15 src/lib/errors.ts (exported with `git show v1.0.15:src/lib/errors.ts`).
import { isNetworkError } from "./src/lib/errors";

type Resp = { data?: unknown; error: { message: string } | null };

/** v1.0.15 src/stores/data/outbox.ts:150-178 (drainOutbox, per entry). */
export async function drainDecision(send: () => PromiseLike<Resp>) {
  let response: Resp;
  try {
    response = await send(); // :152-154  supabase.rpc(entry.name, args) / replayTableWrite(...)
  } catch (networkErr) {
    // :155-161 -> status "pending", attempts+1, `return` (pass stops)
    return { state: "pending", passEnds: true, why: "fetch threw (outbox.ts:155-161)", detail: String(networkErr) };
  }
  if (response.error) {
    // :164-170 -> status "conflict", attempts+1, lastError, `continue` (next entry)
    return { state: "conflict", passEnds: false, why: "response.error (outbox.ts:164-170)", detail: response.error.message };
  }
  // :176-178 reconcile + delete
  return { state: "synced", passEnds: false, why: "outbox.ts:176-178", detail: "" };
}

/** v1.0.15 src/stores/data/slices/saleSlice.ts:114-120 (createSaleOnline) + :308-317 (createSale). */
export async function onlineSaleDecision(send: () => PromiseLike<Resp>) {
  try {
    const { data, error } = await send();          // :115-118
    if (error) throw new Error(error.message);      // :119
    if (!data) throw new Error("Checkout returned no data."); // :120
    return { result: "ONLINE_OK", detail: "" };
  } catch (err) {
    if (isNetworkError(err)) return { result: "OFFLINE_SALE_QUEUED", detail: "saleSlice.ts:315 -> createSaleOffline (enqueueOutbox)" };
    return { result: "ERROR_SHOWN", detail: `saleSlice.ts:316 throw: ${(err as Error).message}` };
  }
}

/** v1.0.15 src/stores/data/tableWrite.ts:70-85 (writeTableRow, online branch). */
export async function tableWriteDecision(send: () => PromiseLike<Resp>) {
  try {
    const { error } = await send();                                     // :71-76
    if (error && isNetworkError(error)) return { result: "QUEUED_LOCAL_SUCCESS", detail: "tableWrite.ts:77-79" };
    if (!error) return { result: "OK", detail: "" };
    return { result: "ERROR_RETURNED", detail: `tableWrite.ts:81 ${error.message}` };
  } catch (err) {
    if (isNetworkError(err)) return { result: "QUEUED_LOCAL_SUCCESS", detail: "tableWrite.ts:83" };
    return { result: "ERROR_RETURNED", detail: "tableWrite.ts:84" };
  }
}
