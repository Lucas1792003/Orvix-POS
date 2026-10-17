// ----------------------------------------------------------------------
// Owner reconciliation of outbox entries (1.0.16 RC3).
// Design, state machine and security evidence: docs/desktop-app/
// release-1.0.16.md §11.
//
//   conflict | quarantined | archived (set aside)  --reconcile-->  reconciled
//   reconciled  --integrity check fails on load-->  archived (+ reconcileRejected)
//   pending | syncing | failed | reconciled  --reconcile-->  refused
//
// Reconciling only RECORDS the owner's decision on the till. It never sends
// the entry, never writes stock, payments or sales, and never deletes the
// row (payload, idempotency key and every earlier status field stay). A
// corrective transaction goes through the normal, idempotent sales/refund
// flows; the record only links to it ("recreated" -> the new server sale).
//
// Preconditions, all checked here again (the page only mirrors them):
//   * status conflict / quarantined / archived (never in the drain);
//   * an export in THIS session containing exactly this entry (entry id +
//     entryDigest recorded at export time);
//   * a read-only server check (lib/reconcile/serverCheck.ts) made for this
//     exact entry within the last 10 minutes;
//   * a resolution consistent with it (lib/reconcile/policy.ts) and a reason;
//   * the owner verified by the Electron MAIN process with the server at
//     this moment (electron/reconcileAuthority.cjs; no cache, refused
//     offline), which returns the owner's server identity and a seal.
// The status change and the log line are written in ONE Dexie transaction,
// with a compare-and-set on the whole row as the owner saw it.
// ----------------------------------------------------------------------
import { localDb, RECONCILE_LOG_PREFIX, type SyncOutboxEntry } from "../../lib/localDb";
import { newId } from "../../lib/id";
import { canonicalJson } from "../../lib/queueExport/format";
import { entryDigest, recordDigest } from "../../lib/reconcile/digest";
import { isReconcilableStatus, recordConsistencyProblem, validateResolution, type ResolutionInput } from "../../lib/reconcile/policy";
import type { ReconcileLogEntry, ReconcileOwner, ReconciliationRecord } from "../../lib/reconcile/types";
import type { ElectronReconcileAttestRequest, ElectronReconcileAttestResult, ElectronReconcileSealItem } from "../../types/electron";
import { isUndecided, refreshSyncStatus } from "./outbox";
import { executorCapability } from "./idempotentRpc";
import { belongsToBackend, currentBackendOrigin } from "../../lib/backendOrigin";

export type ReconcileErrorCode =
  | "not-found" | "already-reconciled" | "not-reconcilable" | "export-first" | "export-stale" | "invalid"
  | "no-desktop" | "owner-refused" | "offline" | "changed" | "sale-already-linked" | "undecided";

export class ReconcileError extends Error {
  readonly code: ReconcileErrorCode;
  constructor(code: ReconcileErrorCode, message: string) {
    super(message);
    this.name = "ReconcileError";
    this.code = code;
  }
}

export interface ReconcileDeps {
  /** Main-process owner check + seal (window.electronAPI.reconcileAttest). */
  attest?: (request: ElectronReconcileAttestRequest) => Promise<ElectronReconcileAttestResult>;
  /** The signed-in session's access token (only handed to main). */
  accessToken: () => Promise<string>;
  /** This session's export of the entry (exportRecord.exportedEntry). */
  exportedEntry: (localId: string) => { digest: string | null; at: string } | null;
  now?: () => Date;
}

export interface ReconcileInput extends ResolutionInput {
  /** canonicalJson of the row as the owner saw it (rowSnapshot()): the
   *  compare-and-set token. Any change since — a retry, restore, another
   *  window's reconciliation — refuses. */
  expectedRow: string;
}

/** Compare-and-set token of a row (sync, so it can run inside a Dexie transaction). */
export const rowSnapshot = (row: SyncOutboxEntry): string => canonicalJson(row);

function historyOf(row: SyncOutboxEntry): ReconciliationRecord["statusHistory"] {
  const h: ReconciliationRecord["statusHistory"] = [{ status: "queued", at: row.createdAt }];
  if (row.quarantinedAt || row.statusBeforeQuarantine) {
    h.push({ status: "quarantined", at: row.quarantinedAt ?? null, note: `was ${row.statusBeforeQuarantine ?? "unknown"}${row.quarantineReason ? `; ${row.quarantineReason.slice(0, 200)}` : ""}` });
  }
  if (row.status === "archived" || row.archivedAt) {
    h.push({ status: "archived", at: row.archivedAt ?? null, note: `set aside${row.archivedBy ? ` by ${row.archivedBy}` : ""}; was ${row.statusBeforeArchive ?? "unknown"}${row.archiveReason ? `; ${row.archiveReason.slice(0, 200)}` : ""}` });
  }
  if (row.status !== "archived" && row.status !== "quarantined") {
    h.push({ status: row.status, at: null, note: `${row.attempts} attempt(s)${row.lastError ? `; ${row.lastError.slice(0, 200)}` : ""}` });
  }
  return h;
}

async function appendLog(entry: Omit<ReconcileLogEntry, "id" | "at">, now: Date): Promise<void> {
  const line: ReconcileLogEntry = { id: newId("rlog"), at: now.toISOString(), ...entry };
  await localDb.syncState.put({ key: `${RECONCILE_LOG_PREFIX}${line.id}`, value: JSON.stringify(line), updatedAt: line.at });
}

/**
 * Reconcile one entry. Throws ReconcileError (nothing written) on any
 * refusal. Returns the stored row.
 */
export async function reconcileOutboxEntry(localId: string, input: ReconcileInput, deps: ReconcileDeps): Promise<SyncOutboxEntry> {
  const now = deps.now ?? (() => new Date());
  const row = await localDb.syncOutbox.get(localId);
  if (!row) throw new ReconcileError("not-found", "This entry is no longer on this till.");
  if (row.status === "reconciled") throw new ReconcileError("already-reconciled", "This entry is already reconciled.");
  if (!isReconcilableStatus(row.status)) {
    throw new ReconcileError("not-reconcilable", "This entry is still in the sync queue. Set it aside first, then reconcile it.");
  }
  if (rowSnapshot(row) !== input.expectedRow) {
    throw new ReconcileError("changed", "This entry changed since you opened it (another window or a sync). Close the dialog and look again.");
  }
  if (!deps.attest) throw new ReconcileError("no-desktop", "Reconciling needs the desktop app: the owner is checked with the server by the app itself.");

  const digest = await entryDigest(row);
  const exp = deps.exportedEntry(localId);
  if (!exp) throw new ReconcileError("export-first", "Export pending transactions first (in this session): the file must contain this entry.");
  if (!exp.digest || exp.digest !== digest) throw new ReconcileError("export-stale", "This entry changed after the last export. Export again first.");

  // M3: "recreated" / "cancelled" assert the original never ran. For an
  // entry whose outcome is not established, that must rest on the server's
  // durable decision (abandoned = fenced, or rejected) — not on a records
  // search a delayed copy could still contradict. "Confirm with server"
  // asks and fences first. Only a server without migration 086 (no fence
  // exists there) keeps the legacy records-search path for UUIDv4 entries.
  if ((input.resolution === "recreated" || input.resolution === "cancelled") && isUndecided(row)) {
    // An entry queued for ANOTHER backend: nothing this server says (or
    // lacks) proves it never ran there (stabilization B).
    const foreign = row.status === "quarantined" || row.statusBeforeArchive === "quarantined" || !belongsToBackend(row, currentBackendOrigin());
    if (foreign) {
      throw new ReconcileError("undecided",
        "This entry was queued for another server and its outcome there is unknown. It can only be documented as recreated or cancelled after it has been checked against that server (export it); nothing was reconciled.");
    }
    const legacyServer = !/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(row.idempotencyKey ?? "") && executorCapability() === "absent";
    if (!legacyServer) {
      throw new ReconcileError("undecided",
        "The server has not decided this operation yet, so it could still be applied. Use \"Confirm with server\" first: it is stopped there if it never arrived, or recorded if it did. Then export again and reconcile.");
    }
  }

  const at = now();
  const v = validateResolution(input, { entryDigest: digest, now: at.getTime() });
  if (!v.ok) throw new ReconcileError("invalid", v.message);

  const idMap = await localDb.provisionalIdMap.bulkGet((row.refs ?? []).map((r) => r.provisionalId));
  const draft: Omit<ReconciliationRecord, "owner" | "recordDigest" | "seal"> = {
    v: 1,
    id: newId("rec"),
    localId: row.localId,
    idempotencyKey: row.idempotencyKey ?? (typeof row.args?.p_idempotency_key === "string" ? row.args.p_idempotency_key : null),
    entryDigest: digest,
    resolution: input.resolution,
    serverRef: v.serverRef,
    check: input.check!,
    reason: v.reason,
    reconciledAt: at.toISOString(),
    statusBefore: row.status as ReconciliationRecord["statusBefore"],
    statusHistory: historyOf(row),
    export: { exportedAt: exp.at, digest: exp.digest },
    resolvedRefs: (row.refs ?? []).map((r, i) => ({ field: r.field, provisionalId: r.provisionalId, realId: idMap[i]?.realId ?? null })),
  };
  const rd = await recordDigest(draft);

  // The owner, verified by main with the server NOW (never cached).
  let att: ElectronReconcileAttestResult;
  try {
    att = await deps.attest({ accessToken: await deps.accessToken(), localId, entryDigest: digest, recordDigest: rd });
  } catch {
    att = { ok: false, code: "error", message: "Owner verification failed. Nothing was reconciled." };
  }
  if (!att.ok || !att.owner || !att.seal || att.owner.role !== "ADMIN") {
    await appendLog({ event: "refused", localId, entryDigest: digest, detail: `owner check ${att.code}: ${att.message ?? ""}`.slice(0, 300) }, now()).catch(() => undefined);
    throw new ReconcileError(att.code === "offline" ? "offline" : "owner-refused", att.message ?? "The server did not confirm the owner. Nothing was reconciled.");
  }
  const owner: ReconcileOwner = {
    userId: att.owner.userId, name: att.owner.name, orgId: att.owner.orgId ?? null,
    role: "ADMIN", verifiedAt: att.owner.verifiedAt, source: "backend",
  };
  const record: ReconciliationRecord = { ...draft, owner, recordDigest: rd, seal: att.seal };

  const stored = await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
    const cur = await localDb.syncOutbox.get(localId);
    if (!cur) throw new ReconcileError("not-found", "This entry is no longer on this till.");
    if (cur.status === "reconciled") throw new ReconcileError("already-reconciled", "This entry was reconciled meanwhile (another window).");
    if (rowSnapshot(cur) !== input.expectedRow) throw new ReconcileError("changed", "This entry changed while you were reconciling it. Nothing was written; look again.");
    if (record.serverRef) {
      const saleId = record.serverRef.saleId;
      const others = await localDb.syncOutbox.where("status").equals("reconciled").toArray();
      const holder = others.find((o) => o.localId !== localId && o.reconciliation?.serverRef?.saleId === saleId);
      if (holder) throw new ReconcileError("sale-already-linked", `Server sale ${saleId} is already the reconciliation of another entry.`);
    }
    const next: SyncOutboxEntry = {
      ...cur,
      status: "reconciled",
      statusBeforeReconcile: record.statusBefore,
      reconciliation: record,
      nextAttemptAt: undefined,
    };
    await localDb.syncOutbox.put(next);
    const line: ReconcileLogEntry = {
      id: newId("rlog"), at: record.reconciledAt, event: "reconciled", localId, recordId: record.id,
      resolution: record.resolution, serverSaleId: record.serverRef?.saleId ?? null,
      ownerUserId: owner.userId, ownerName: owner.name, entryDigest: digest,
      detail: `${record.resolution}${record.serverRef ? ` -> sale ${record.serverRef.saleId}${record.serverRef.receiptNo ? ` (${record.serverRef.receiptNo})` : ""}` : ""}; check ${record.check.result}; was ${record.statusBefore}; ${record.reason.slice(0, 200)}`,
    };
    await localDb.syncState.put({ key: `${RECONCILE_LOG_PREFIX}${line.id}`, value: JSON.stringify(line), updatedAt: line.at });
    return next;
  });
  void refreshSyncStatus();
  return stored;
}

// ----------------------------------------------------------------------
// Integrity check of stored reconciliations (on load, before every
// update-guard report, when the Sync page lists the queue).
// ----------------------------------------------------------------------

export interface VerifyResult {
  /** Reconciled rows whose record, digests and seal all check out. */
  verified: Set<string>;
  /** Rows sent back to "Set aside" (needs attention) by this call. */
  reverted: string[];
  /** Reconciled rows that could not be verified (no main process): they
   *  keep blocking updates but are not reverted. */
  unverifiable: string[];
}

export interface VerifyDeps {
  verifySeals?: (items: ElectronReconcileSealItem[]) => Promise<boolean[]>;
  now?: () => Date;
}

const sealItem = (rec: ReconciliationRecord): ElectronReconcileSealItem => ({
  localId: rec.localId, entryDigest: rec.entryDigest, recordDigest: rec.recordDigest,
  ownerUserId: rec.owner?.userId ?? "", ownerName: rec.owner?.name ?? "", verifiedAt: rec.owner?.verifiedAt ?? "", seal: rec.seal ?? "",
});

export async function verifyReconciledEntries(deps: VerifyDeps = {}): Promise<VerifyResult> {
  const now = deps.now ?? (() => new Date());
  const rows = await localDb.syncOutbox.where("status").equals("reconciled").toArray();
  const result: VerifyResult = { verified: new Set(), reverted: [], unverifiable: [] };
  if (rows.length === 0) return result;

  const problems = new Map<string, string>();
  const sealed: { row: SyncOutboxEntry; rec: ReconciliationRecord }[] = [];
  for (const row of rows) {
    const rec = row.reconciliation;
    if (!rec || typeof rec !== "object") { problems.set(row.localId, "no reconciliation record"); continue; }
    const p = recordConsistencyProblem(row, rec);
    if (p) { problems.set(row.localId, p); continue; }
    if ((await entryDigest(row)) !== rec.entryDigest) { problems.set(row.localId, "the entry (payload, key or id) was changed after it was reconciled"); continue; }
    if ((await recordDigest(rec)) !== rec.recordDigest) { problems.set(row.localId, "the reconciliation record was changed"); continue; }
    sealed.push({ row, rec });
  }
  if (sealed.length) {
    let ok: boolean[] | null = null;
    if (deps.verifySeals) {
      try {
        ok = await deps.verifySeals(sealed.map((s) => sealItem(s.rec)));
      } catch {
        ok = null;
      }
    }
    sealed.forEach((s, i) => {
      if (!ok) result.unverifiable.push(s.row.localId);
      else if (ok[i] === true) result.verified.add(s.row.localId);
      else problems.set(s.row.localId, "the seal does not match (not made by this till's owner check)");
    });
  }

  for (const row of rows) {
    const reason = problems.get(row.localId);
    if (!reason) continue;
    const snapshot = rowSnapshot(row);
    const at = now().toISOString();
    const reverted = await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
      const cur = await localDb.syncOutbox.get(row.localId);
      if (!cur || cur.status !== "reconciled" || rowSnapshot(cur) !== snapshot) return false; // changed meanwhile: next pass
      const prior = cur.statusBeforeReconcile;
      const next: SyncOutboxEntry = {
        ...cur,
        // Back to "Set aside": never sent, blocks updates, the owner looks at it again.
        status: "archived",
        statusBeforeArchive: prior === "conflict" || prior === "quarantined"
          ? prior
          : cur.statusBeforeArchive && cur.statusBeforeArchive !== "syncing" && cur.statusBeforeArchive !== "pending" && cur.statusBeforeArchive !== "failed"
            ? cur.statusBeforeArchive
            : "conflict",
        archivedAt: cur.archivedAt ?? at,
        archiveReason: `Reconciliation rejected by the integrity check: ${reason}`,
        reconcileRejected: { record: cur.reconciliation ?? null, detectedAt: at, reason },
      };
      delete next.reconciliation;
      delete next.statusBeforeReconcile;
      await localDb.syncOutbox.put(next);
      const line: ReconcileLogEntry = {
        id: newId("rlog"), at, event: "tamper-detected", localId: cur.localId,
        recordId: typeof cur.reconciliation?.id === "string" ? cur.reconciliation.id : undefined,
        detail: `reconciliation rejected (${reason}); entry back under Set aside, blocks updates again`,
      };
      await localDb.syncState.put({ key: `${RECONCILE_LOG_PREFIX}${line.id}`, value: JSON.stringify(line), updatedAt: at });
      return true;
    });
    if (reverted) result.reverted.push(row.localId);
  }
  if (result.reverted.length) void refreshSyncStatus();
  return result;
}

/** Every outbox row that blocks an ordinary update install: everything
 *  except reconciled rows that passed the integrity check. */
export async function blockingOutboxRows(deps: VerifyDeps = {}): Promise<SyncOutboxEntry[]> {
  const v = await verifyReconciledEntries(deps);
  const rows = await localDb.syncOutbox.toArray();
  return rows.filter((r) => r.status !== "reconciled" || !v.verified.has(r.localId));
}

export async function listReconciliationLog(): Promise<ReconcileLogEntry[]> {
  const rows = await localDb.syncState.where("key").startsWith(RECONCILE_LOG_PREFIX).toArray();
  const out: ReconcileLogEntry[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.value ?? "") as ReconcileLogEntry);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id)));
}

/** Deps for the desktop app (Electron preload API). */
export function desktopVerifyDeps(): VerifyDeps {
  const api = typeof window === "undefined" ? undefined : window.electronAPI;
  return { verifySeals: api?.reconcileVerifySeals ? (items) => api.reconcileVerifySeals!(items) : undefined };
}
