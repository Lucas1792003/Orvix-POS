// ----------------------------------------------------------------------
// Updater guard (release 1.0.16). Pure decision logic, no Electron import,
// so it is unit-tested directly (src/lib/updateGuard.test.ts) and used by
// electron/updater.cjs for every install path:
//   * "Restart now" in the update-downloaded dialog,
//   * the sidebar "Restart" button (updates:install),
//   * install-on-quit (electron-updater's own autoInstallOnAppQuit is OFF;
//     updater.cjs installs on quit itself, only when this guard allows),
//   * the owner's documented recovery path (export first, then install).
//
// The renderer reports its state (lib/updateGuardBridge.ts):
//   unsynced        every outbox entry the server does not have yet
//                   (pending, syncing, failed, conflict, quarantined)
//   online          navigator.onLine / connectivity store
//   authenticated   a signed-in app user and no "sign in again" flag
//   saleInProgress  cart has lines / payment open / checkout in flight
//   exportCoversQueue  every current outbox entry was exported to an
//                   encrypted file in this app session
// No report (renderer not loaded yet) or an old one counts as UNSAFE.
//
// Normal install: queue empty AND online AND authenticated AND no sale in
// progress. Recovery install (owner chose it explicitly, main shows a native
// confirmation): no sale in progress AND an owner verified by the main
// process (RC2) AND (queue empty OR export covers the queue). Nothing else
// ever installs, and no path changes or discards an outbox entry.
// ----------------------------------------------------------------------

/** A renderer report older than this is not trusted (heartbeat is 30 s). */
const STATE_MAX_AGE_MS = 2 * 60 * 1000;

function toCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Validate a renderer report. Returns a clean object or null (anything
 * malformed is treated as "no report").
 */
function sanitizeAppState(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const unsynced = toCount(raw.unsynced);
  if (unsynced === null) return null;
  const count = (k) => toCount(raw[k]) ?? 0;
  return {
    unsynced,
    pending: count("pending"),
    conflict: count("conflict"),
    quarantined: count("quarantined"),
    online: raw.online === true,
    authenticated: raw.authenticated === true,
    saleInProgress: raw.saleInProgress !== false, // unknown = assume a sale is running
    exportCoversQueue: raw.exportCoversQueue === true,
    reportedAt: now,
  };
}

function waitingMessage(n) {
  return `${n} ${n === 1 ? "sale/action" : "sales/actions"} waiting to sync — update will install after they sync.`;
}

/**
 * @param {ReturnType<typeof sanitizeAppState>} state
 * @param {{ now?: number, recovery?: boolean, ownerVerified?: boolean, ownerMessage?: string }} [opts]
 * @returns {{ allowed: boolean, code: string, unsynced: number, message: string }}
 */
function evaluateInstallGuard(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const recovery = opts.recovery === true;
  if (!state || typeof state.reportedAt !== "number" || now - state.reportedAt > STATE_MAX_AGE_MS) {
    return {
      allowed: false, code: "no-state", unsynced: -1,
      message: "The app has not confirmed that every sale is synced yet. The update will install later.",
    };
  }
  const n = state.unsynced;
  if (state.saleInProgress) {
    return {
      allowed: false, code: "sale-in-progress", unsynced: n,
      message: "A sale is in progress. The update will install after the sale is finished.",
    };
  }
  if (recovery) {
    // RC2 (D4): the recovery path is for the owner only. `ownerVerified` is
    // decided by the main process itself (electron/ownerVerify.cjs: the
    // backend's app_role() for the session's access token), never by a
    // renderer flag. Absent = refused.
    if (opts.ownerVerified !== true) {
      return {
        allowed: false, code: "recovery-needs-owner", unsynced: n,
        message: opts.ownerMessage || "Only the owner (administrator), signed in on this till, can install anyway.",
      };
    }
    if (n === 0 || state.exportCoversQueue) {
      return { allowed: true, code: "recovery", unsynced: n, message: n === 0 ? "Nothing waiting to sync." : `${n} unsynced entries were exported in this session.` };
    }
    return {
      allowed: false, code: "recovery-needs-export", unsynced: n,
      message: `${waitingMessage(n)} To install anyway, first use "Export pending" to save them to a file.`,
    };
  }
  if (n > 0) {
    const extra = state.quarantined > 0
      ? ` ${state.quarantined} of them belong to another server and will never sync here: export them for the owner.`
      : "";
    return { allowed: false, code: "unsynced", unsynced: n, message: waitingMessage(n) + extra };
  }
  if (!state.online) {
    return { allowed: false, code: "offline", unsynced: 0, message: "This till is offline. The update will install once it is back online and every sale has synced." };
  }
  if (!state.authenticated) {
    return { allowed: false, code: "signed-out", unsynced: 0, message: "Sign in first. The update installs once a signed-in till has confirmed every sale is synced." };
  }
  return { allowed: true, code: "ok", unsynced: 0, message: "Everything is synced." };
}

module.exports = { STATE_MAX_AGE_MS, sanitizeAppState, evaluateInstallGuard, waitingMessage };
