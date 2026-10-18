// ----------------------------------------------------------------------
// "Export pending transactions": collect (read-only) -> secret check ->
// encrypt with the passphrase typed in the dialog -> hand the ENCRYPTED
// envelope to the Electron main process, which shows the save dialog and
// writes the file (the renderer has no file-system access). In a plain
// browser (second terminal / dev) the encrypted file is offered as a
// download instead. The passphrase is never stored or logged.
// ----------------------------------------------------------------------
import { localDb, SYNC_STATE_KEYS } from "../localDb";
import { backendHost } from "../supabase";
import { getTillId } from "../tillId";
import { APP_VERSION } from "../clientInfo";
import { useAuthStore } from "../../stores/authStore";
import { useAppStore } from "../../stores/appStore";
import { collectQueueExportSnapshot } from "./collect";
import { recordQueueExport } from "./exportRecord";
import { ONLINE_OP_PREFIX } from "../onlineOpRecord";
import {
  assertNoSecretValues, defaultExportFileName, encryptQueueExport, summarizePayload, type QueueExportSummary,
} from "./format";

export type ExportQueueResult =
  | { status: "saved"; filePath: string; summary: QueueExportSummary }
  | { status: "downloaded"; fileName: string; summary: QueueExportSummary }
  | { status: "canceled" };

/** Every credential value this renderer can see: the persisted Supabase
 *  session's tokens and the anon key. None of them may occur in an export. */
export function knownSecretValues(): string[] {
  const out: string[] = [];
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (typeof anon === "string") out.push(anon);
  try {
    for (const k of Object.keys(localStorage)) {
      if (!/^sb-.*-auth-token/.test(k)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      out.push(raw);
      try {
        const s = JSON.parse(raw) as Record<string, unknown>;
        for (const f of ["access_token", "refresh_token", "provider_token", "provider_refresh_token"]) {
          if (typeof s[f] === "string") out.push(s[f] as string);
        }
      } catch {
        /* not JSON: the raw value alone is checked */
      }
    }
  } catch {
    /* no localStorage */
  }
  return out;
}

async function appVersion(): Promise<string> {
  try {
    return (await window.electronAPI?.appVersion()) ?? `web-${APP_VERSION}`;
  } catch {
    return "unknown";
  }
}

export async function exportPendingQueue(passphrase: string): Promise<ExportQueueResult> {
  const auth = useAuthStore.getState();
  const tillId = getTillId();
  const now = new Date();
  const { payload, digests } = await collectQueueExportSnapshot(localDb, {
    appVersion: await appVersion(),
    tillId,
    backendHost,
    session: {
      userId: auth.currentUserId,
      orgId: auth.currentOrgId,
      shopId: useAppStore.getState().currentShopId,
      role: auth.currentRole,
    },
    now,
  });
  assertNoSecretValues(JSON.stringify(payload), knownSecretValues());
  const envelope = await encryptQueueExport(payload, passphrase);
  const contents = JSON.stringify(envelope, null, 1);
  const fileName = defaultExportFileName(tillId, now);
  const summary = summarizePayload(payload);
  // Durable BEFORE the file leaves the till: every entry in it was queued
  // before this time, and once it may be replayed elsewhere none of them can
  // prove it was never sent. (A failed write still leaves this session's
  // in-memory record, recordQueueExport below.)
  // What this file covers, for the updater guard: the queue rows, plus the
  // unresolved online operations and unreadable records it carries.
  const covered = [
    ...digests,
    ...payload.onlineOperations.map((o) => `${ONLINE_OP_PREFIX}${o.id}`),
    ...payload.unreadableOnlineRecords.map((r) => r.key),
  ];
  const markedAt = new Date().toISOString();
  await localDb.syncState.put({ key: SYNC_STATE_KEYS.lastQueueExport, value: markedAt, updatedAt: markedAt }).catch(() => undefined);

  const api = window.electronAPI;
  if (api?.saveQueueExport) {
    const res = await api.saveQueueExport({ defaultFileName: fileName, contents });
    if (res.canceled) return { status: "canceled" };
    if (!res.ok || !res.filePath) throw new Error(res.error ?? "The file could not be saved.");
    recordQueueExport(covered);
    return { status: "saved", filePath: res.filePath, summary };
  }

  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  recordQueueExport(covered);
  return { status: "downloaded", fileName, summary };
}
