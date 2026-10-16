// ----------------------------------------------------------------------
// Auto-update via electron-updater (GitHub Releases, see package.json
// "build.publish"), wired with the 1.0.16 install guard (updateGuard.cjs).
//
// Everything Electron-specific is injected (autoUpdater, app, dialog,
// ipcMain, the window getter, the logger) so electron/test/ can drive this
// exact code with a fake updater inside a real Electron process.
//
// Never installs while the till has unsynced outbox entries, while a sale
// is in progress, or before the renderer has reported its state:
//   * autoInstallOnAppQuit is OFF. Install-on-quit is done here, in
//     before-quit, only when the guard allows (Windows/NSIS; on macOS the
//     unsigned app cannot auto-update anyway, and a deferred quit there
//     would wait on Squirrel).
//   * "Restart now" / the sidebar Restart button go through the guard; when
//     it refuses, the user gets the notice ("N sales/actions waiting to sync —
//     update will install after they sync") with "Export pending" and
//     "Sync now".
//   * Recovery path (owner, documented in docs/desktop-app/release-1.0.16.md):
//     export pending → "Install anyway" → native confirmation here. Allowed
//     only when the export covers every unsynced entry, no sale is open, and
//     (RC2, D4) main itself verified the signed-in user as the owner
//     (deps.verifyOwner, electron/ownerVerify.cjs) — checked before the
//     dialog and again after it. Never changes or discards outbox entries.
// Updater settings: no prerelease, no downgrade, no channel (a channel would
// force allowDowngrade in electron-updater 6.x).
// ----------------------------------------------------------------------
const { evaluateInstallGuard, sanitizeAppState } = require("./updateGuard.cjs");

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function setupUpdater(deps) {
  const { autoUpdater, app, dialog, ipcMain, getWindow, log, isDev = false } = deps;
  // Without a verifier (older wiring, or a build without backend config)
  // the recovery path is refused: fail closed.
  const verifyOwner = deps.verifyOwner ?? (async () => ({ ok: false, code: "unavailable", message: "Owner verification is not available in this build." }));
  const now = deps.now ?? (() => Date.now());
  const platform = deps.platform ?? process.platform;

  let updateCheckInFlight = false;
  let updateInstallStarted = false;
  let downloadedVersion = null;
  let pendingUpdateVersion = null;
  let appState = null;
  let lastBlockCode = null;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (...args) => log("info", "electron-updater", ...args),
    warn: (...args) => log("warn", "electron-updater", ...args),
    error: (...args) => log("error", "electron-updater", ...args),
    debug: (...args) => log("debug", "electron-updater", ...args),
  };

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const sendUpdateStatus = (status) => send("updates:status", status);
  const guard = (recovery = false, owner = null) => evaluateInstallGuard(appState, {
    now: now(), recovery, ownerVerified: Boolean(owner && owner.ok), ownerMessage: owner && !owner.ok ? owner.message : undefined,
  });
  const fromAppWindow = (event) => {
    const win = getWindow();
    return !(win && event && event.sender && event.sender !== win.webContents);
  };
  const tokenOf = (request) => (request && typeof request === "object" && typeof request.accessToken === "string" ? request.accessToken : null);
  async function checkOwner(request, step) {
    let owner;
    try {
      owner = await verifyOwner(tokenOf(request));
    } catch (err) {
      owner = { ok: false, code: "error", message: "Owner verification failed." };
      log("error", "owner verification error", err);
    }
    log(owner.ok ? "info" : "warn", "recovery owner check", `step=${step}`, `result=${owner.code}`, `source=${owner.source ?? "-"}`);
    return owner;
  }

  function checkForUpdates() {
    if (updateCheckInFlight) return;
    updateCheckInFlight = true;
    log("info", "update check requested", `currentVersion=${app.getVersion()}`);
    Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .catch((err) => log("error", "update check failed", err))
      .finally(() => { updateCheckInFlight = false; });
  }

  function doInstall(trigger, { isSilent, forceRunAfter }) {
    if (updateInstallStarted) return false;
    updateInstallStarted = true;
    sendUpdateStatus({ state: "installing" });
    log(
      "info", "restart requested", `trigger=${trigger}`,
      `currentVersion=${app.getVersion()}`, `updateVersion=${pendingUpdateVersion ?? "unknown"}`,
      `platform=${platform}`, `unsynced=${appState ? appState.unsynced : "unknown"}`,
    );
    log("info", "quitAndInstall called", `isSilent=${isSilent}`, `forceRunAfter=${forceRunAfter}`);
    // electron-updater owns the installer path, arguments, elevation and
    // duplicate-install guard; never start the NSIS executable by hand.
    autoUpdater.quitAndInstall(isSilent, forceRunAfter);
    return true;
  }

  /** Install through the guard. Returns { ok, blocked? }. */
  function requestInstall(trigger) {
    if (!downloadedVersion) return { ok: false, error: "No update has been downloaded." };
    const decision = guard(false);
    if (!decision.allowed) {
      log("warn", "install refused by guard", `trigger=${trigger}`, `code=${decision.code}`, `unsynced=${decision.unsynced}`);
      announceBlocked(decision);
      return { ok: false, blocked: decision };
    }
    return { ok: doInstall(trigger, { isSilent: false, forceRunAfter: true }) };
  }

  function announceBlocked(decision) {
    lastBlockCode = decision.code;
    sendUpdateStatus({ state: "downloaded", version: downloadedVersion, blocked: decision });
  }

  async function showBlockedNotice(decision) {
    const win = getWindow();
    if (!win) return;
    const result = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["OK", "Export pending…", "Sync now"],
      defaultId: 0,
      cancelId: 0,
      title: "Update waiting",
      message: `Shwe Pha La POS ${downloadedVersion} is ready, but it will not install yet.`,
      detail: `${decision.message}\n\nNothing is lost by waiting. The app keeps working on this version.`,
    });
    if (result.response === 1) send("updates:request", { action: "open-export" });
    if (result.response === 2) send("updates:request", { action: "sync-now" });
  }

  async function requestRecoveryInstall(request) {
    if (!downloadedVersion) return { ok: false, error: "No update has been downloaded." };
    const owner = await checkOwner(request, "before-confirm");
    const decision = guard(true, owner);
    if (!decision.allowed) {
      log("warn", "recovery install refused", `code=${decision.code}`, `unsynced=${decision.unsynced}`);
      return { ok: false, blocked: decision };
    }
    const win = getWindow();
    if (!win) return { ok: false, error: "No window" };
    const n = decision.unsynced;
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Install now"],
      defaultId: 0,
      cancelId: 0,
      title: "Install the update now?",
      message: n > 0
        ? `Install ${downloadedVersion} with ${n} entries not yet synced?`
        : `Install ${downloadedVersion} now?`,
      detail: n > 0
        ? "They were exported to a file in this session. They stay on this till and sync after the update when the server accepts them. Keep the export file for the owner."
        : "Everything is synced.",
    });
    if (response !== 1) {
      log("info", "recovery install cancelled by the user");
      return { ok: false, canceled: true };
    }
    // Re-check: the state (and the session) may have changed while the
    // dialog was open.
    const ownerAgain = await checkOwner(request, "after-confirm");
    const again = guard(true, ownerAgain);
    if (!again.allowed) {
      log("warn", "recovery install refused after confirmation", `code=${again.code}`, `unsynced=${again.unsynced}`);
      return { ok: false, blocked: again };
    }
    log("warn", "recovery install confirmed by the owner", `unsynced=${n}`, `ownerSource=${ownerAgain.source ?? "-"}`, "entries kept on the till, none marked synced");
    return { ok: doInstall("recovery", { isSilent: false, forceRunAfter: true }) };
  }

  function onAppState(raw) {
    const next = sanitizeAppState(raw, now());
    if (!next) return;
    appState = next;
    if (!downloadedVersion || updateInstallStarted) return;
    const decision = guard(false);
    if (decision.allowed && lastBlockCode) {
      lastBlockCode = null;
      log("info", "install guard cleared", `updateVersion=${downloadedVersion}`);
      sendUpdateStatus({ state: "downloaded", version: downloadedVersion, installable: true });
    } else if (!decision.allowed && decision.code !== lastBlockCode) {
      announceBlocked(decision);
    }
  }

  function onBeforeQuit(event) {
    log("info", "before-quit", `installRequested=${updateInstallStarted}`);
    if (!downloadedVersion || updateInstallStarted) return;
    const decision = guard(false);
    if (!decision.allowed) {
      log("info", "install on quit deferred", `code=${decision.code}`, `unsynced=${decision.unsynced}`);
      return;
    }
    if (platform === "darwin") {
      log("info", "install on quit skipped on macOS (unsigned build; use Restart now)");
      return;
    }
    // Same semantics as electron-updater's own install-on-quit: silent, no
    // relaunch. preventDefault so the installer starts before we exit;
    // quitAndInstall quits the app itself.
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    doInstall("quit", { isSilent: true, forceRunAfter: false });
  }

  autoUpdater.on("checking-for-update", () => {
    log("info", "checking for update");
    sendUpdateStatus({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    pendingUpdateVersion = info.version;
    log("info", "update available; download started", `currentVersion=${app.getVersion()}`, `updateVersion=${info.version}`);
    sendUpdateStatus({ state: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => {
    log("info", "update not available", `version=${info && info.version}`);
    sendUpdateStatus({ state: "not-available", version: info && info.version });
  });
  autoUpdater.on("download-progress", (progress) =>
    sendUpdateStatus({ state: "downloading", percent: Math.round(progress.percent) }));
  autoUpdater.on("error", (err) => {
    log("error", "updater error", err);
    sendUpdateStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    pendingUpdateVersion = info.version;
    downloadedVersion = info.version;
    const decision = guard(false);
    log("info", "download complete", `currentVersion=${app.getVersion()}`, `updateVersion=${info.version}`,
      `guard=${decision.code}`, `unsynced=${decision.unsynced}`);
    const win = getWindow();
    if (!decision.allowed) {
      announceBlocked(decision);
      // A notice, never during a sale (it would interrupt the cashier).
      if (decision.code === "unsynced" && win) void showBlockedNotice(decision);
      return;
    }
    sendUpdateStatus({ state: "downloaded", version: info.version, installable: true });
    if (!win) return;
    Promise.resolve(dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Shwe Pha La POS ${info.version} has been downloaded.`,
      detail: "Restart now to install it, or it will install the next time you quit the app (only once every sale has synced).",
    })).then((result) => {
      if (result.response === 0) requestInstall("dialog");
    });
  });

  ipcMain.handle("updates:check", () => {
    if (isDev) return { ok: false, error: "Update checks are unavailable in dev mode." };
    checkForUpdates();
    return { ok: true };
  });
  ipcMain.handle("updates:install", () => requestInstall("button"));
  ipcMain.handle("updates:install-recovery", (event, request) => {
    if (!fromAppWindow(event)) return { ok: false, error: "Refused: not the app window." };
    return requestRecoveryInstall(request);
  });
  // The bridge primes main's own owner verification while the server is
  // reachable, so a later recovery install during an outage can still be
  // checked against what main itself verified (ownerVerify.cjs).
  ipcMain.handle("updates:verify-owner", async (event, request) => {
    if (!fromAppWindow(event)) return { ok: false };
    const owner = await checkOwner(request, "prime");
    return { ok: owner.ok, code: owner.code };
  });
  ipcMain.on("updates:app-state", (event, raw) => {
    if (!fromAppWindow(event)) return;
    onAppState(raw);
  });
  app.on("before-quit", onBeforeQuit);

  return {
    checkForUpdates,
    UPDATE_CHECK_INTERVAL_MS,
    // for tests / diagnostics
    _state: () => ({ appState, downloadedVersion, updateInstallStarted, lastBlockCode }),
    _onAppState: onAppState,
    _onBeforeQuit: onBeforeQuit,
    _requestInstall: requestInstall,
    _requestRecoveryInstall: requestRecoveryInstall,
  };
}

module.exports = { setupUpdater, UPDATE_CHECK_INTERVAL_MS };
