import { useEffect, useState } from "react";
import { localDb } from "../lib/localDb";
import { countOnlineRecords } from "../lib/queueExport/collect";
import { onQueueChanged } from "../stores/data/outbox";

export interface OnlineRecordCounts {
  /** Unresolved operations (they may already have been applied). */
  unresolved: number;
  /** Records this till cannot read (each may be an unresolved payment). */
  unreadable: number;
  total: number;
  /** The records could not be read at all: shown, never taken as "none". */
  readError: boolean;
}

/**
 * Online-only money operations (supplier payments, voids, refund requests …)
 * whose outcome is still unknown on this till — of the signed-in user's
 * organisation, or of the whole till when nobody is signed in — plus the
 * records it cannot read (deployment-blocker pass: never silently dropped).
 * They are not queued work: they may already have been applied, and they
 * must be exportable for recovery even when the sync queue is empty.
 */
export function useUnresolvedOnlineOperations(orgId: string | null | undefined, ownUserId: string | null = null): OnlineRecordCounts {
  const [counts, setCounts] = useState<OnlineRecordCounts>({ unresolved: 0, unreadable: 0, total: 0, readError: false });
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const c = await countOnlineRecords(localDb, orgId ?? null, ownUserId);
        if (alive) setCounts({ ...c, readError: false });
      } catch (err) {
        console.error("[sync] could not read the online-operation records:", err);
        if (alive) setCounts((prev) => ({ ...prev, readError: true }));
      }
    };
    void read();
    const off = onQueueChanged(() => { void read(); });
    const timer = setInterval(() => { void read(); }, 10_000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [orgId, ownUserId]);
  return counts;
}
