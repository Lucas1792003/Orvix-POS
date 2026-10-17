import { useEffect, useState } from "react";
import { localDb } from "../lib/localDb";
import { onQueueChanged } from "../stores/data/outbox";

/**
 * Sales of a shop whose outcome is unknown — a lost reply, or a request
 * left mid-send by a crash or restart (Batch 2A correction pass). Shown on
 * the POS so they are not rung up again under a new key; they are
 * confirmed automatically (same key) by the sync queue.
 */
export function useUnresolvedSales(shopId: string | null | undefined): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const rows = await localDb.syncOutbox.where("status").anyOf("pending", "syncing", "failed").toArray();
        const n = rows.filter((r) => r.name === "complete_sale" && r.writeAhead === true
          && (r.inDoubt === true || r.status === "syncing") && (!shopId || r.shopId === shopId)).length;
        if (alive) setCount(n);
      } catch {
        // the banner is advisory; the queue itself is unaffected
      }
    };
    void read();
    const off = onQueueChanged(() => { void read(); });
    const timer = setInterval(() => { void read(); }, 15_000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [shopId]);
  return count;
}
