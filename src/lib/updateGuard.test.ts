// Release 1.0.16, task 3: the desktop updater never installs while the
// outbox has unsynced entries (or a sale is in progress, or the renderer
// has not reported), on any path: "Restart now", the sidebar button,
// install-on-quit, and only the documented owner recovery path (export
// first, then a native confirmation) may install with entries left.
// electron/updateGuard.cjs (pure) and electron/updater.cjs (wiring, with a
// fake electron-updater) are exercised here; electron/test/ runs the same
// wiring inside a real Electron process.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { buildAppState } from "./updateGuardBridge";

const require = createRequire(import.meta.url);
const { evaluateInstallGuard, sanitizeAppState, STATE_MAX_AGE_MS } = require("../../electron/updateGuard.cjs");
const { setupUpdater } = require("../../electron/updater.cjs");

const NOW = 1_800_000_000_000;
const state = (over: Record<string, unknown> = {}) => sanitizeAppState({
  unsynced: 0, pending: 0, conflict: 0, quarantined: 0, online: true, authenticated: true,
  saleInProgress: false, exportCoversQueue: false, ...over,
}, NOW);

describe("evaluateInstallGuard", () => {
  it("allows only an empty queue, online, signed in, no sale", () => {
    expect(evaluateInstallGuard(state(), { now: NOW })).toMatchObject({ allowed: true, code: "ok" });
  });

  it("refuses with N entries waiting, with the staff-facing notice", () => {
    const d = evaluateInstallGuard(state({ unsynced: 3, pending: 3 }), { now: NOW });
    expect(d).toMatchObject({ allowed: false, code: "unsynced", unsynced: 3 });
    expect(d.message).toBe("3 sales/actions waiting to sync — update will install after they sync.");
  });

  it("counts conflicts and quarantined entries as unsynced (export them)", () => {
    const d = evaluateInstallGuard(state({ unsynced: 2, conflict: 1, quarantined: 1 }), { now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.message).toMatch(/1 of them belong to another server/);
  });

  it("refuses offline, signed out, mid-sale, unknown and stale state", () => {
    expect(evaluateInstallGuard(state({ online: false }), { now: NOW }).code).toBe("offline");
    expect(evaluateInstallGuard(state({ authenticated: false }), { now: NOW }).code).toBe("signed-out");
    expect(evaluateInstallGuard(state({ saleInProgress: true }), { now: NOW }).code).toBe("sale-in-progress");
    expect(evaluateInstallGuard(null, { now: NOW }).code).toBe("no-state");
    expect(evaluateInstallGuard(state(), { now: NOW + STATE_MAX_AGE_MS + 1 }).code).toBe("no-state");
    expect(sanitizeAppState({ unsynced: "3" }, NOW)).toBeNull();
    expect(sanitizeAppState({ unsynced: 0 }, NOW)?.saleInProgress).toBe(true); // unknown = assume a sale
  });

  it("recovery: only after the export covers the queue, never mid-sale, offline is fine", () => {
    expect(evaluateInstallGuard(state({ unsynced: 4 }), { now: NOW, recovery: true }).code).toBe("recovery-needs-export");
    expect(evaluateInstallGuard(state({ unsynced: 4, exportCoversQueue: true, online: false, authenticated: false }), { now: NOW, recovery: true }))
      .toMatchObject({ allowed: true, code: "recovery" });
    expect(evaluateInstallGuard(state({ unsynced: 4, exportCoversQueue: true, saleInProgress: true }), { now: NOW, recovery: true }).allowed).toBe(false);
  });
});

describe("buildAppState (renderer report)", () => {
  it("counts every outbox status as unsynced", () => {
    expect(buildAppState({
      outboxIds: ["a", "b", "c", "d"], statuses: ["pending", "syncing", "conflict", "quarantined"],
      online: true, authenticated: true, saleInProgress: false, exportCoversQueue: false,
    })).toMatchObject({ unsynced: 4, pending: 2, conflict: 1, quarantined: 1 });
  });
});

// ------------------------------------------------------------- wiring --

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  disableWebInstaller = false;
  allowPrerelease = true;
  allowDowngrade = true;
  logger: unknown = null;
  quitAndInstall = vi.fn();
  checkForUpdates = vi.fn(async () => null);
}

function harness(platform = "win32") {
  const autoUpdater = new FakeUpdater();
  const app = Object.assign(new EventEmitter(), { getVersion: () => "1.0.16" });
  const sent: { channel: string; payload: unknown }[] = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
  const dialogResponses: number[] = [];
  const dialog = { showMessageBox: vi.fn(async () => ({ response: dialogResponses.shift() ?? 0 })) };
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const listeners = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
  };
  const logs: string[] = [];
  let now = NOW;
  const u = setupUpdater({
    autoUpdater, app, dialog, ipcMain, getWindow: () => win, platform, now: () => now,
    log: (level: string, msg: string, ...d: unknown[]) => logs.push(`${level} ${msg} ${d.join(" ")}`),
  });
  const report = (over: Record<string, unknown> = {}) =>
    listeners.get("updates:app-state")!({ sender: win.webContents }, {
      unsynced: 0, pending: 0, conflict: 0, quarantined: 0, online: true, authenticated: true,
      saleInProgress: false, exportCoversQueue: false, ...over,
    });
  const quit = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit("before-quit", event);
    return event;
  };
  return { autoUpdater, app, sent, dialog, dialogResponses, handlers, listeners, report, quit, logs, u, advance: (ms: number) => { now += ms; } };
}

describe("setupUpdater with a fake electron-updater", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it("configures: no auto install on quit, no prerelease, no downgrade", () => {
    expect(h.autoUpdater).toMatchObject({ autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false, autoDownload: true });
  });

  it("pending entries: no install from the dialog, the button, or quit; the notice offers Export/Sync", async () => {
    h.report({ unsynced: 2, pending: 2 });
    h.dialogResponses.push(1); // "Export pending…"
    h.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect((h.dialog.showMessageBox.mock.calls[0] as unknown as [unknown, { detail: string }])[1].detail)
      .toMatch(/2 sales\/actions waiting to sync — update will install after they sync/);
    expect(h.sent).toContainEqual({ channel: "updates:request", payload: { action: "open-export" } });

    expect(await h.handlers.get("updates:install")!()).toMatchObject({ ok: false, blocked: { code: "unsynced", unsynced: 2 } });
    const ev = h.quit();
    expect(ev.defaultPrevented).toBe(false); // quit proceeds, no install
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(h.logs.some((l) => /install on quit deferred code=unsynced/.test(l))).toBe(true);
  });

  it("no report from the renderer yet: never installs", async () => {
    h.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    expect(await h.handlers.get("updates:install")!()).toMatchObject({ ok: false, blocked: { code: "no-state" } });
    h.quit();
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("mid-sale: no install even on the recovery path, and no dialog interrupts the cashier", async () => {
    h.report({ saleInProgress: true });
    h.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    expect(h.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(await h.handlers.get("updates:install-recovery")!()).toMatchObject({ ok: false, blocked: { code: "sale-in-progress" } });
    h.quit();
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("queue drained + online + signed in: the button installs, and quit installs silently", async () => {
    h.report({ unsynced: 1, pending: 1 });
    h.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    h.report({ unsynced: 0 });
    expect(h.sent).toContainEqual({ channel: "updates:status", payload: { state: "downloaded", version: "1.0.17", installable: true } });
    const ev = h.quit();
    expect(ev.defaultPrevented).toBe(true);
    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, false);
    expect(await h.handlers.get("updates:install")!()).toMatchObject({ ok: false }); // already started, no second install
    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("a stale report blocks again (renderer gone quiet)", async () => {
    h.report();
    h.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    h.advance(STATE_MAX_AGE_MS + 1000);
    h.quit();
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("recovery path: refused before an export; after export it asks, and Cancel installs nothing", async () => {
    h.report({ unsynced: 3, pending: 3, online: false });
    h.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    expect(await h.handlers.get("updates:install-recovery")!()).toMatchObject({ ok: false, blocked: { code: "recovery-needs-export" } });
    h.report({ unsynced: 3, pending: 3, online: false, exportCoversQueue: true });
    h.dialogResponses.length = 0;
    h.dialogResponses.push(0); // Cancel
    expect(await h.handlers.get("updates:install-recovery")!()).toMatchObject({ ok: false, canceled: true });
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    h.dialogResponses.push(1); // Install now
    expect(await h.handlers.get("updates:install-recovery")!()).toMatchObject({ ok: true });
    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("macOS: never installs on quit (unsigned; Squirrel would hold the quit)", () => {
    const m = harness("darwin");
    m.report();
    m.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    const ev = m.quit();
    expect(ev.defaultPrevented).toBe(false);
    expect(m.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("ignores app-state reports from anything but the app window", () => {
    h.listeners.get("updates:app-state")!({ sender: { other: true } }, { unsynced: 0, online: true, authenticated: true, saleInProgress: false });
    expect((h.u as { _state: () => { appState: unknown } })._state().appState).toBeNull();
  });
});
