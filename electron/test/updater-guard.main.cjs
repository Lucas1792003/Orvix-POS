// Electron-level test of the 1.0.16 updater guard (run by
// src/lib/updateGuard.electron.test.ts; not part of the packaged app —
// package.json "build.files" ships electron/** but nothing loads this file).
//
// Runs the REAL electron/updater.cjs and the REAL electron/preload.cjs in a
// real Electron main process + sandboxed renderer, with a fake
// electron-updater (an EventEmitter whose quitAndInstall only records the
// call). The renderer reports its queue through the preload bridge exactly
// like the app does; then the fake updater announces a downloaded update,
// the sidebar button path is tried, and the app is quit. Writes a JSON
// result to UPDATER_GUARD_RESULT and exits.
//
// SCENARIO=pending  → 3 unsynced entries: nothing may install, quit proceeds
// SCENARIO=midsale  → queue empty but a sale in progress: nothing installs
// SCENARIO=clear    → queue empty, online, signed in: quit installs (silent)
// FAKE_PLATFORM=win32 exercises the Windows (NSIS) install-on-quit path.
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setupUpdater } = require("../updater.cjs");

const scenario = process.env.SCENARIO || "pending";
const resultPath = process.env.UPDATER_GUARD_RESULT;
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "updater-guard-")));

const result = { scenario, quitAndInstall: [], dialogs: [], installButton: null, beforeQuitPrevented: null, logs: [] };
const finish = (code = 0) => {
  if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result, null, 1));
  app.exit(code);
};

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoInstallOnAppQuit = true;
  }
  checkForUpdates() { return Promise.resolve(null); }
  quitAndInstall(isSilent, forceRunAfter) {
    result.quitAndInstall.push({ isSilent, forceRunAfter });
    // a real updater would spawn the installer and quit; end the test here
    setTimeout(() => finish(0), 50);
  }
}

// Native dialogs answered automatically ("OK" / "Later"), recorded.
dialog.showMessageBox = async (_win, options) => {
  result.dialogs.push({ title: options.title, detail: options.detail });
  return { response: options.title === "Update ready" ? 1 : 0 };
};

let win = null;
const autoUpdater = new FakeUpdater();
setupUpdater({
  autoUpdater, app, dialog, ipcMain,
  getWindow: () => win,
  // the NSIS install-on-quit path is what tills use; exercise it on any host
  platform: process.env.FAKE_PLATFORM || process.platform,
  log: (level, msg, ...d) => result.logs.push(`${level} ${msg} ${d.join(" ")}`),
});
app.on("before-quit", (event) => {
  // registered after the updater's own handler, so this sees its decision
  result.beforeQuitPrevented = event.defaultPrevented;
});
app.on("will-quit", () => finish(0));

const STATES = {
  pending: { unsynced: 3, pending: 3, conflict: 0, quarantined: 0, online: true, authenticated: true, saleInProgress: false, exportCoversQueue: false },
  midsale: { unsynced: 0, pending: 0, conflict: 0, quarantined: 0, online: true, authenticated: true, saleInProgress: true, exportCoversQueue: false },
  clear: { unsynced: 0, pending: 0, conflict: 0, quarantined: 0, online: true, authenticated: true, saleInProgress: false, exportCoversQueue: false },
};

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, "..", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL("data:text/html,<title>guard</title><p>updater guard test</p>");
  const reported = new Promise((resolve) => ipcMain.once("updates:app-state", () => setTimeout(resolve, 20)));
  await win.webContents.executeJavaScript(`window.electronAPI.reportAppState(${JSON.stringify(STATES[scenario])}); true`);
  await reported;
  autoUpdater.emit("update-downloaded", { version: "9.9.9" });
  await new Promise((r) => setTimeout(r, 100));
  if (scenario !== "clear") {
    // the sidebar "Restart" button path (preload → updates:install)
    result.installButton = await win.webContents.executeJavaScript("window.electronAPI.installUpdate()");
    if (result.quitAndInstall.length > 0) return; // (would be a failure) finish() is pending
  }
  app.quit();
}).catch((err) => {
  result.error = String(err && err.stack || err);
  finish(1);
});

setTimeout(() => { result.error = "timeout"; finish(2); }, 20_000);
