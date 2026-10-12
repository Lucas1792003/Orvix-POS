// Electron main process. Kept as plain CommonJS (not bundled) — the
// package is "type": "module" for the Vite/React app, but Electron's main
// process is simplest as a small, unbundled .cjs entry point; no build step
// needed for it.
const { app, BrowserWindow, ipcMain, shell, dialog, autoUpdater: nativeAutoUpdater } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

const isDev = !app.isPackaged;
// Vite's default dev server port (see vite.config.ts) — overridable for a
// non-default `npm run dev -- --port`.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

// End-to-end automation hook (Playwright drives the real app — see
// playwright.config.ts and e2e/). SHWE_POS_E2E=1 only (a) skips the
// detached DevTools window in dev, which would otherwise race the app
// window for Playwright's firstWindow(), and (b) when
// SHWE_POS_E2E_USER_DATA is also set, redirects userData there so an
// automated run never touches a real install's local database or session.
// Both are no-ops for real users (neither variable is ever set by the app).
const isE2E = process.env.SHWE_POS_E2E === "1";
if (isE2E && process.env.SHWE_POS_E2E_USER_DATA) {
  app.setPath("userData", process.env.SHWE_POS_E2E_USER_DATA);
}

let mainWindow = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

// Keep updater diagnostics on disk because a packaged Windows app normally
// has no visible console, and the process is intentionally gone by the time
// NSIS is doing its work. Paths are redacted before writing so logs are safe
// to share when an update needs support.
const UPDATE_LOG_MAX_BYTES = 1024 * 1024;

function updaterLogPath() {
  return path.join(app.getPath("userData"), "logs", "updater.log");
}

function sanitizeUpdateLog(value) {
  const text = value instanceof Error ? (value.stack || value.message) : String(value);
  const replacements = [
    [app.getPath("home"), "<home>"],
    [app.getPath("userData"), "<userData>"],
    [app.getPath("temp"), "<temp>"],
  ];
  return replacements.reduce(
    (safe, [privatePath, label]) => privatePath ? safe.split(privatePath).join(label) : safe,
    text,
  );
}

function logUpdate(level, message, ...details) {
  const suffix = details.length > 0 ? ` ${details.map(sanitizeUpdateLog).join(" ")}` : "";
  const line = `${new Date().toISOString()} [${level}] ${message}${suffix}`;

  const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[consoleMethod](`[update] ${message}`, ...details);

  try {
    const logPath = updaterLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > UPDATE_LOG_MAX_BYTES) {
      fs.renameSync(logPath, `${logPath}.previous`);
    }
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch (err) {
    console.error("[update] could not write updater log:", err);
  }
}

// Multiple installed instances can keep app files open after the instance
// that requested an update quits. NSIS then cannot replace those files and
// shows "cannot be closed" forever. Keep exactly one desktop instance and
// focus it when a second launch is attempted.
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // Matches the "Main desktop target" row in docs/06-ui-printing-hardware.md.
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.once("closed", () => {
    mainWindow = null;
  });

  // Open target="_blank" links (none expected today, but the QR phone-upload
  // flow and any future external links should open in the OS browser, not a
  // second app window). Restricted to https: — shell.openExternal hands the
  // URL straight to the OS opener, so an unrestricted file:/custom-protocol
  // URL (e.g. smuggled through a product name or QR payload) could trigger
  // something other than a normal web page.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === "https:") void shell.openExternal(url);
    } catch {
      // Malformed URL — ignore rather than pass it to the OS opener.
    }
    return { action: "deny" };
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    if (!isE2E) mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      // macOS: clicking the dock icon with no windows open should reopen one.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    if (!isDev) {
      // Give the window a moment to render before firing a network check.
      setTimeout(() => checkForUpdates(), 5_000);
      // Keep checking periodically for anyone who leaves the app open for days.
      setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

nativeAutoUpdater.on("before-quit-for-update", () => {
  logUpdate("info", "before-quit-for-update");
});
app.on("before-quit", () => {
  logUpdate("info", "before-quit", `installRequested=${updateInstallStarted}`);
});
app.on("will-quit", () => {
  logUpdate("info", "will-quit", `windows=${BrowserWindow.getAllWindows().length}`);
});

// ------------------------------------------------------------------
// Auto-update via electron-updater, checking GitHub Releases directly
// (see package.json's "build.publish") — no separate update server needed.
// A new version just needs `npm run electron:build:mac`/`:win` followed by
// `electron-builder --publish always` (with a GH_TOKEN set) so the release
// includes the latest.yml/latest-mac.yml metadata files this depends on;
// a manually-uploaded release without those files won't be detected.
//
// Real limitation, not yet worked around: on macOS, electron-updater's
// actual install step (Squirrel.Mac) requires the app to be code-signed —
// our builds aren't (no Apple Developer certificate set up), so an update
// will likely be DETECTED but fail to apply. Windows (NSIS) does not have
// this requirement and should auto-update even unsigned, aside from a
// possible SmartScreen prompt on the downloaded update itself.
// ------------------------------------------------------------------
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let updateCheckInFlight = false;
let updateInstallStarted = false;
// Set once a downloaded update's version is known (update-available /
// update-downloaded), purely so the restart/quitAndInstall log lines below
// can record which version is about to be installed, not just that a
// restart happened.
let pendingUpdateVersion = null;

function checkForUpdates() {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  logUpdate("info", "update check requested", `currentVersion=${app.getVersion()}`);
  autoUpdater.checkForUpdates().catch((err) => {
    logUpdate("error", "update check failed", err);
  }).finally(() => {
    updateCheckInFlight = false;
  });
}

// Pushes live update status to the renderer (see preload.cjs's
// onUpdateStatus) so the sidebar's "Check for Updates" button can show
// checking/downloading/ready state without the user polling or restarting
// the app to find out.
function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("updates:status", status);
}

function installDownloadedUpdate() {
  if (updateInstallStarted) return false;
  updateInstallStarted = true;
  sendUpdateStatus({ state: "installing" });
  logUpdate(
    "info", "restart requested",
    `currentVersion=${app.getVersion()}`, `updateVersion=${pendingUpdateVersion ?? "unknown"}`,
    `platform=${process.platform}`,
  );
  logUpdate("info", "quitAndInstall called", "isSilent=false", "forceRunAfter=true");

  // electron-updater owns the downloaded installer path, launch arguments,
  // elevation fallback, and duplicate-install guard. Do not start the NSIS
  // executable manually here. The installer-side lock probe in
  // build/installer.nsh waits for actual write access after this graceful quit.
  autoUpdater.quitAndInstall(false, true);

  return true;
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.autoRunAppAfterInstall = true;
autoUpdater.disableWebInstaller = true;
autoUpdater.logger = {
  info: (...args) => logUpdate("info", "electron-updater", ...args),
  warn: (...args) => logUpdate("warn", "electron-updater", ...args),
  error: (...args) => logUpdate("error", "electron-updater", ...args),
  debug: (...args) => logUpdate("debug", "electron-updater", ...args),
};

autoUpdater.on("checking-for-update", () => {
  logUpdate("info", "checking for update");
  sendUpdateStatus({ state: "checking" });
});
autoUpdater.on("update-available", (info) => {
  pendingUpdateVersion = info.version;
  logUpdate(
    "info", "update available; download started",
    `currentVersion=${app.getVersion()}`, `updateVersion=${info.version}`,
  );
  sendUpdateStatus({ state: "available", version: info.version });
});
autoUpdater.on("update-not-available", (info) => {
  logUpdate("info", "update not available", `version=${info.version}`);
  sendUpdateStatus({ state: "not-available", version: info.version });
});
autoUpdater.on("download-progress", (progress) =>
  sendUpdateStatus({ state: "downloading", percent: Math.round(progress.percent) }),
);

autoUpdater.on("error", (err) => {
  logUpdate("error", "updater error", err);
  sendUpdateStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
});

autoUpdater.on("update-downloaded", (info) => {
  pendingUpdateVersion = info.version;
  logUpdate("info", "download complete", `currentVersion=${app.getVersion()}`, `updateVersion=${info.version}`);
  sendUpdateStatus({ state: "downloaded", version: info.version });
  if (!mainWindow) return;
  dialog
    .showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Shwe Pha La POS ${info.version} has been downloaded.`,
      detail: "Restart now to install it, or it'll install automatically the next time you quit the app.",
    })
    .then((result) => {
      if (result.response === 0) installDownloadedUpdate();
    });
});

// Manual "Check for Updates" button in the sidebar — lets a user pull the
// latest build without deleting and reinstalling. Status is reported back
// via the "updates:status" events above, not this handler's return value,
// since checkForUpdates() is async/event-driven under the hood.
ipcMain.handle("updates:check", () => {
  if (isDev) return { ok: false, error: "Update checks are unavailable in dev mode." };
  checkForUpdates();
  return { ok: true };
});

ipcMain.handle("updates:install", () => {
  return { ok: installDownloadedUpdate() };
});

ipcMain.handle("app:get-version", () => app.getVersion());

// ------------------------------------------------------------------
// Receipt printing: silent-print to a system printer (no dialog, no
// --kiosk-printing launch flag needed — see docs/06-ui-printing-hardware.md
// for the browser-only workaround this replaces). Most ESC/POS thermal
// receipt printers install as a normal OS printer via the manufacturer's
// driver, so this works with the existing 80mm receipt HTML/CSS
// (src/print/receipt.css) unchanged — no raw ESC/POS byte protocol needed.
//
// NOT implemented here: opening a cash drawer as a standalone action. That
// typically needs either a drawer-kick command embedded in the print job
// (printer-model-specific) or a direct USB/serial connection — both need
// real hardware to wire up and verify, which wasn't available while
// building this. `listPrinters` below at least lets a future settings page
// show what's connected.
// ------------------------------------------------------------------

ipcMain.handle("printers:list", async () => {
  if (!mainWindow) return [];
  return mainWindow.webContents.getPrintersAsync();
});

ipcMain.handle("printers:print-receipt", async (_event, options) => {
  if (!mainWindow) return { ok: false, error: "No window" };
  const requestedDeviceName =
    options && typeof options.deviceName === "string" ? options.deviceName : undefined;
  let deviceName;
  if (requestedDeviceName) {
    const printers = await mainWindow.webContents.getPrintersAsync();
    const match = printers.find((p) => p.name === requestedDeviceName);
    if (!match) {
      return { ok: false, error: `Printer "${requestedDeviceName}" is not connected` };
    }
    deviceName = match.name;
  }
  // webContents.print() is callback-based and returns void — awaiting it
  // directly always "succeeded", so a missing printer never reached the
  // renderer's dialog fallback (found by the Phase E print-path check).
  // Resolve from the callback: `success=false` with Chromium's reason (e.g.
  // no valid printers) becomes a clean { ok: false, error } reply.
  try {
    const result = await new Promise((resolve) => {
      mainWindow.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName,
          margins: { marginType: "none" },
        },
        (success, failureReason) => resolve(success ? { ok: true } : { ok: false, error: failureReason || "Print failed" }),
      );
    });
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
