import { localDb } from "../../lib/localDb";
import type { InventoryMovement } from "../../types";

export const inventoryKey = (shopId: string, productId: string): string => `${shopId}|${productId}`;

/**
 * Net provisional stock change per (shop, product) for everything still
 * waiting in the outbox. Every offline write path (sale, adjustment,
 * receive, transfer — see the *Offline functions in slices/) applies its
 * stock effect locally through a provisional `inventory_movements` row
 * whose id is listed in the outbox entry's `provisional` refs, so the
 * queued movements ARE the pending deltas — no per-RPC payload parsing.
 *
 * Only `pending` and `failed` entries count. A `syncing` entry is being
 * sent right now: its effect may already be on the server, and the drain
 * reconciles the authoritative row the moment the reply lands, so leaving
 * it out can only under-count for milliseconds, whereas counting it could
 * double-count until the next event. `conflict` entries were rejected by
 * the server and moved no stock.
 *
 * Movements are read from the local mirror (where every offline write
 * puts them), with the in-memory list as a fallback for a row whose mirror
 * write has not landed yet.
 */
export async function pendingStockDeltas(movementsInState: InventoryMovement[] = []): Promise<Map<string, number>> {
  const deltas = new Map<string, number>();
  let provisionalIds: Set<string>;
  try {
    const entries = await localDb.syncOutbox.where("status").anyOf("pending", "failed").toArray();
    provisionalIds = new Set<string>();
    for (const entry of entries) {
      for (const ref of entry.provisional ?? []) {
        if (ref.table !== "movements") continue;
        for (const id of ref.ids) provisionalIds.add(id);
      }
    }
  } catch (err) {
    console.error("[DB] Failed to read the outbox for pending stock deltas:", err);
    return deltas;
  }
  if (provisionalIds.size === 0) return deltas;

  const byId = new Map<string, InventoryMovement>();
  try {
    const mirrored = await localDb.movements.bulkGet([...provisionalIds]);
    for (const movement of mirrored) if (movement) byId.set(movement.id, movement);
  } catch (err) {
    console.error("[DB] Failed to read provisional movements:", err);
  }
  for (const movement of movementsInState) {
    if (provisionalIds.has(movement.id) && !byId.has(movement.id)) byId.set(movement.id, movement);
  }

  for (const movement of byId.values()) {
    const key = inventoryKey(movement.shopId, movement.productId);
    deltas.set(key, (deltas.get(key) ?? 0) + movement.qtyChange);
  }
  return deltas;
}
