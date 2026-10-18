import { useEffect, useState } from "react";
import { localDb } from "../lib/localDb";
import { countUnresolvedOnlineOperations } from "../lib/queueExport/collect";
import { onQueueChanged } from "../stores/data/outbox";

/**
 * Online-only money operations (supplier payments, voids, refund requests …)
 * whose outcome is still unknown on this till — of the signed-in user's
 * organisation, or of the whole till when nobody is signed in. They are not
 * queued work: they may already have been applied, and they must be exportable
 * for recovery even when the sync queue is empty.
 */
export function useUnresolvedOnlineOperations(orgId: string | null | undefined): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const n = await countUnresolvedOnlineOperations(localDb, orgId ?? null);
        if (alive) setCount(n);
      } catch {
        // advisory only
      }
    };
    void read();
    const off = onQueueChanged(() => { void read(); });
    const timer = setInterval(() => { void read(); }, 10_000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [orgId]);
  return count;
}
