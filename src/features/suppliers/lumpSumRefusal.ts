import { localDb } from "../../lib/localDb";
import { RpcError } from "../../stores/data/idempotentRpc";
import { isPendingConfirmation, isUnresolvedOperation } from "../../stores/data/operationPrompt";

// ----------------------------------------------------------------------
// Owner decision (086): a definitive "more than the outstanding balance"
// refusal of a lump-sum supplier payment is FINAL. Nothing was recorded;
// the operation is settled as refused (its key is never sent again) and it
// is never retried automatically — not when a delayed receipt arrives, not
// after a restart, not from another window. Paying again is a NEW payment:
// the cashier re-checks the balance (reloaded from the server) and
// confirms it explicitly; it gets a new key.
// ----------------------------------------------------------------------

// The server's balance refusals of pay_supplier_lump_sum (086): the amount is
// more than is owed, or nothing is owed any more (paid elsewhere meanwhile).
const BALANCE_REFUSAL = /exceeds (the )?(total )?outstanding balance|has no outstanding balance/i;

/** True only for the server's definitive refusal of a lump sum because the
 *  amount exceeds the supplier's outstanding balance. An unknown outcome,
 *  a send the cashier declined, or any other failure is never this. */
export function isLumpSumBalanceRefusal(err: unknown): boolean {
  if (isPendingConfirmation(err) || isUnresolvedOperation(err)) return false;
  if (!(err instanceof RpcError)) return false;
  return err.failure.klass === "REJECTED" && BALANCE_REFUSAL.test(err.message);
}

// The refusal gate is kept on the till (IndexedDB), not in the dialog: closing
// and re-opening it, a restart or another window of the till all start from
// the refusal until a NEW payment for that supplier and shop is recorded.
const PREFIX = "lump-refusal:";
const keyOf = (orgId: string | null, supplierId: string, shopId: string) => `${PREFIX}${orgId ?? "-"}|${supplierId}|${shopId}`;

export interface LumpSumRefusalMark {
  amountMmk: number;
  at: string;
}

/** The pending refusal of this supplier and shop, if any. A record that
 *  cannot be read counts as a refusal (the dialog then re-checks). */
export async function readLumpSumRefusal(orgId: string | null, supplierId: string, shopId: string): Promise<LumpSumRefusalMark | null> {
  try {
    const row = await localDb.syncState.get(keyOf(orgId, supplierId, shopId));
    if (!row) return null;
    const v = JSON.parse(row.value ?? "") as Partial<LumpSumRefusalMark>;
    return { amountMmk: typeof v.amountMmk === "number" ? v.amountMmk : 0, at: typeof v.at === "string" ? v.at : "" };
  } catch {
    return { amountMmk: 0, at: "" };
  }
}

export async function markLumpSumRefusal(orgId: string | null, supplierId: string, shopId: string, amountMmk: number): Promise<void> {
  const at = new Date().toISOString();
  await localDb.syncState.put({ key: keyOf(orgId, supplierId, shopId), value: JSON.stringify({ amountMmk, at }), updatedAt: at });
}

/** After a NEW payment of this supplier and shop was recorded. */
export async function clearLumpSumRefusal(orgId: string | null, supplierId: string, shopId: string): Promise<void> {
  await localDb.syncState.delete(keyOf(orgId, supplierId, shopId));
}
