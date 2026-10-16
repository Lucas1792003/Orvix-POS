// Electron main process. Kept as plain CommonJS (not bundled) — the
// package is "type": "module" for the Vite/React app, but Electron's main
// process is simplest as a small, unbundled .cjs entry point; no build step
// needed for it.
const { app, BrowserWindow, ipcMain, shell, dialog, autoUpdater: nativeAutoUpdater } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const { setupUpdater } = require("./updater.cjs");

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
    logUpdate("info", "app start", `version=${app.getVersion()}`, `packaged=${app.isPackaged}`, `platform=${process.platform}`);
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
app.on("will-quit", () => {
  logUpdate("info", "will-quit", `windows=${BrowserWindow.getAllWindows().length}`);
});

// ------------------------------------------------------------------
// Auto-update via electron-updater, checking GitHub Releases directly
// (see package.json's "build.publish"). Wiring and the 1.0.16 install guard
// (never install while sales are unsynced or a sale is in progress) live in
// electron/updater.cjs + electron/updateGuard.cjs. Releases are built with
// `--publish never` and uploaded by hand (docs/desktop-app/release-1.0.16.md).
//
// Real limitation, not yet worked around: on macOS, electron-updater's
// actual install step (Squirrel.Mac) requires the app to be code-signed —
// our builds aren't (no Apple Developer certificate set up), so an update
// will likely be DETECTED but fail to apply. Windows (NSIS) does not have
// this requirement and should auto-update even unsigned, aside from a
// possible SmartScreen prompt on the downloaded update itself.
// ------------------------------------------------------------------
const updater = setupUpdater({
  autoUpdater,
  app,
  dialog,
  ipcMain,
  getWindow: () => mainWindow,
  log: logUpdate,
  isDev,
});
const UPDATE_CHECK_INTERVAL_MS = updater.UPDATE_CHECK_INTERVAL_MS;
const checkForUpdates = () => updater.checkForUpdates();

ipcMain.handle("app:get-version", () => app.getVersion());

// ------------------------------------------------------------------
// Pending-queue export (src/lib/queueExport/, docs/selfhost-migration/
// phase-f/queue-export.md). The renderer encrypts the export itself and
// sends only the finished envelope string; this handler is the narrow
// write path: it accepts nothing but an encrypted queue-export envelope,
// lets the user pick the location in the native save dialog, and writes
// the file (owner-only permissions, temp file + rename). The renderer never
// learns anything about the file system beyond the path the user chose.
// ------------------------------------------------------------------
const QUEUE_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

function isEncryptedQueueExport(contents) {
  if (typeof contents !== "string" || contents.length === 0 || contents.length > QUEUE_EXPORT_MAX_BYTES) return false;
  let env;
  try {
    env = JSON.parse(contents);
  } catch {
    return false;
  }
  return Boolean(env) && typeof env === "object" && !Array.isArray(env)
    && env.format === "shwephala-queue-export"
    && env.encrypted === true
    && typeof env.ciphertext === "string" && env.ciphertext.length > 0
    && env.kdf && typeof env.kdf.salt === "string"
    && env.cipher && typeof env.cipher.iv === "string"
    // plaintext must never be written: no decrypted fields at the top level
    && !("entries" in env) && !("payload" in env);
}

function safeExportFileName(name) {
  const base = path.basename(typeof name === "string" ? name : "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return base.endsWith(".spqx") ? base : `${base || "pending-queue"}.spqx`;
}

ipcMain.handle("queue-export:save", async (event, request) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: "Not allowed" };
  const contents = request && request.contents;
  if (!isEncryptedQueueExport(contents)) return { ok: false, error: "Refusing to write: not an encrypted queue export" };
  // Looked up at call time (not destructured) so automated tests can stub it.
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save pending transactions export",
    defaultPath: path.join(app.getPath("documents"), safeExportFileName(request.defaultFileName)),
    filters: [{ name: "Shwe Pha La queue export", extensions: ["spqx"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const target = result.filePath;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
    return { ok: true, filePath: target };
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

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
