// Preload script — runs in an isolated context with access to Node APIs,
// bridged into the renderer as `window.electronAPI` (contextIsolation is on,
// nodeIntegration is off; see main.cjs's webPreferences). Keep this surface
// small and specific — anything exposed here is callable from the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,

  listPrinters: () => ipcRenderer.invoke("printers:list"),

  /**
   * Silent-prints the currently rendered page (respecting the app's
   * existing `@media print` CSS — see src/print/receipt.css) to a system
   * printer, no dialog. Pass `deviceName` to target a specific printer
   * (from listPrinters()); omitted uses the OS default.
   */
  printReceipt: (options) => ipcRenderer.invoke("printers:print-receipt", options ?? {}),

  appVersion: () => ipcRenderer.invoke("app:get-version"),

  /** Manually triggers an update check — progress/result arrives via onUpdateStatus. */
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),

  /** Quits and installs an already-downloaded update — only when the main
   *  process's install guard allows it (no unsynced sales, online, signed in,
   *  no sale in progress). Otherwise resolves { ok: false, blocked }. */
  installUpdate: () => ipcRenderer.invoke("updates:install"),

  /** Owner's recovery path: install although entries are unsynced, allowed
   *  only after they were exported in this session AND (RC2) when main
   *  itself verifies the session's access token as the owner with the
   *  backend; main asks for a native confirmation first. Only the token
   *  string crosses. */
  installUpdateRecovery: (request) => ipcRenderer.invoke("updates:install-recovery", {
    accessToken: request && typeof request.accessToken === "string" ? request.accessToken : "",
  }),

  /** RC2: let main verify (with the backend) that this session is the
   *  owner's while the server is reachable. Returns { ok, code }. */
  verifyOwnerSession: (request) => ipcRenderer.invoke("updates:verify-owner", {
    accessToken: request && typeof request.accessToken === "string" ? request.accessToken : "",
  }),

  /** RC3: owner reconciliation. Main verifies the session as the owner with
   *  the backend right now (no cache, refused offline) and seals the record
   *  digests. Only strings cross. */
  reconcileAttest: (request) => {
    const r = request && typeof request === "object" ? request : {};
    const s = (v) => (typeof v === "string" ? v : "");
    return ipcRenderer.invoke("reconcile:attest", {
      accessToken: s(r.accessToken), localId: s(r.localId), entryDigest: s(r.entryDigest), recordDigest: s(r.recordDigest),
    });
  },

  /** RC3: main checks stored reconciliation seals. Returns booleans. */
  reconcileVerifySeals: (items) => ipcRenderer.invoke("reconcile:verify-seals", Array.isArray(items) ? items.map((it) => {
    const r = it && typeof it === "object" ? it : {};
    const s = (v) => (typeof v === "string" ? v : "");
    return {
      localId: s(r.localId), entryDigest: s(r.entryDigest), recordDigest: s(r.recordDigest),
      ownerUserId: s(r.ownerUserId), ownerName: s(r.ownerName), verifiedAt: s(r.verifiedAt), seal: s(r.seal),
    };
  }) : []),

  /** Reports the facts the install guard needs (counts and flags only). */
  reportAppState: (state) => {
    const s = state && typeof state === "object" ? state : {};
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);
    ipcRenderer.send("updates:app-state", {
      unsynced: n(s.unsynced), pending: n(s.pending), conflict: n(s.conflict), quarantined: n(s.quarantined),
      online: s.online === true, authenticated: s.authenticated === true,
      saleInProgress: s.saleInProgress === true, exportCoversQueue: s.exportCoversQueue === true,
    });
  },

  /** Requests from the update notice: { action: "open-export" | "sync-now" }. */
  onUpdateRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("updates:request", listener);
    return () => ipcRenderer.removeListener("updates:request", listener);
  },

  /**
   * Saves an already-ENCRYPTED pending-queue export (see
   * src/lib/queueExport/) via the native save dialog. Only a string goes
   * across; the main process validates it is an encrypted envelope, asks
   * the user where to save, and writes it. No path or fs access is exposed.
   */
  saveQueueExport: (request) => ipcRenderer.invoke("queue-export:save", {
    defaultFileName: request && typeof request.defaultFileName === "string" ? request.defaultFileName : "",
    contents: request && typeof request.contents === "string" ? request.contents : "",
  }),

  /** Subscribes to update lifecycle events. Returns an unsubscribe function. */
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
});
