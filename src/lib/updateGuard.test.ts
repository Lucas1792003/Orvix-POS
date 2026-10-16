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
const { createOwnerVerifier, loadBackendConfig } = require("../../electron/ownerVerify.cjs");

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

  it("recovery: only for a main-verified owner, only after the export covers the queue, never mid-sale, offline is fine", () => {
    const owner = { now: NOW, recovery: true, ownerVerified: true };
    expect(evaluateInstallGuard(state({ unsynced: 4 }), owner).code).toBe("recovery-needs-export");
    expect(evaluateInstallGuard(state({ unsynced: 4, exportCoversQueue: true, online: false, authenticated: false }), owner))
      .toMatchObject({ allowed: true, code: "recovery" });
    expect(evaluateInstallGuard(state({ unsynced: 4, exportCoversQueue: true, saleInProgress: true }), owner).allowed).toBe(false);
  });

  it("RC2 (D4): recovery without an owner verified by main is refused, whatever the renderer reports", () => {
    const covered = state({ unsynced: 4, exportCoversQueue: true, authenticated: true });
    expect(evaluateInstallGuard(covered, { now: NOW, recovery: true })).toMatchObject({ allowed: false, code: "recovery-needs-owner" });
    expect(evaluateInstallGuard(covered, { now: NOW, recovery: true, ownerVerified: "yes" })).toMatchObject({ allowed: false, code: "recovery-needs-owner" });
    // a renderer cannot smuggle an owner flag through the app-state report
    const forged = sanitizeAppState({ unsynced: 4, exportCoversQueue: true, saleInProgress: false, ownerVerified: true, role: "ADMIN" }, NOW);
    expect(forged).not.toHaveProperty("ownerVerified");
    expect(forged).not.toHaveProperty("role");
    expect(evaluateInstallGuard(forged, { now: NOW, recovery: true }).code).toBe("recovery-needs-owner");
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

type OwnerResult = { ok: boolean; code: string; source?: string; message: string };
const OWNER_OK: OwnerResult = { ok: true, code: "owner", source: "backend", message: "Owner verified by the server." };

function harness(platform = "win32", owner: (token: unknown) => Promise<OwnerResult> = async () => OWNER_OK) {
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
  const verifyOwner = vi.fn(owner);
  const u = setupUpdater({
    autoUpdater, app, dialog, ipcMain, getWindow: () => win, platform, now: () => now, verifyOwner,
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
  return { autoUpdater, app, sent, dialog, dialogResponses, handlers, listeners, report, quit, logs, u, verifyOwner, win, advance: (ms: number) => { now += ms; } };
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
    expect(h.logs.some((l) => /recovery install confirmed by the owner .*none marked synced/.test(l))).toBe(true);
  });

  it("RC2 (D4): a cashier (or no session) gets no recovery install, even after an export; no dialog, nothing installed", async () => {
    const c = harness("win32", async (token) => (token === "admin-token-0123456789"
      ? OWNER_OK
      : { ok: false, code: "not-owner", message: "Only the owner (administrator) can install anyway." }));
    c.report({ unsynced: 3, pending: 3, exportCoversQueue: true });
    c.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    await new Promise((r) => setTimeout(r, 0));
    c.dialog.showMessageBox.mockClear();
    const ev = { sender: c.win.webContents };
    expect(await c.handlers.get("updates:install-recovery")!(ev, { accessToken: "cashier-token-0123456789" }))
      .toMatchObject({ ok: false, blocked: { code: "recovery-needs-owner", message: expect.stringMatching(/owner/) } });
    expect(await c.handlers.get("updates:install-recovery")!(ev, {}))
      .toMatchObject({ ok: false, blocked: { code: "recovery-needs-owner" } });
    expect(c.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(c.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(c.logs.some((l) => /recovery owner check step=before-confirm result=not-owner/.test(l))).toBe(true);
    expect(c.logs.join("\n")).not.toContain("cashier-token");
    // the owner's token passes (and is re-checked after the confirmation)
    c.dialogResponses.length = 0;
    c.dialogResponses.push(1);
    expect(await c.handlers.get("updates:install-recovery")!(ev, { accessToken: "admin-token-0123456789" })).toMatchObject({ ok: true });
    expect(c.verifyOwner).toHaveBeenCalledTimes(4);
    expect(c.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("RC2 (D4): the owner losing the session while the dialog is open stops the install", async () => {
    let calls = 0;
    const c = harness("win32", async () => (++calls === 1 ? OWNER_OK : { ok: false, code: "session-rejected", message: "The server rejected this sign-in." }));
    c.report({ unsynced: 1, pending: 1, exportCoversQueue: true });
    c.autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    await new Promise((r) => setTimeout(r, 0));
    c.dialogResponses.length = 0;
    c.dialogResponses.push(1);
    expect(await c.handlers.get("updates:install-recovery")!(undefined, { accessToken: "admin-token-0123456789" }))
      .toMatchObject({ ok: false, blocked: { code: "recovery-needs-owner" } });
    expect(c.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("RC2 (D4): no verifier wired = recovery refused (fail closed); IPC from another frame is refused", async () => {
    const autoUpdater = new FakeUpdater();
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const listeners = new Map<string, (...a: unknown[]) => unknown>();
    const win = { isDestroyed: () => false, webContents: { send: () => undefined } };
    setupUpdater({
      autoUpdater, app: Object.assign(new EventEmitter(), { getVersion: () => "1.0.16" }),
      dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
      ipcMain: {
        handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
        on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
      },
      getWindow: () => win, platform: "win32", now: () => NOW, log: () => undefined,
    });
    listeners.get("updates:app-state")!({ sender: win.webContents }, {
      unsynced: 2, pending: 2, conflict: 0, quarantined: 0, online: false, authenticated: true, saleInProgress: false, exportCoversQueue: true,
    });
    autoUpdater.emit("update-downloaded", { version: "1.0.17" });
    expect(await handlers.get("updates:install-recovery")!(undefined, { accessToken: "admin-token-0123456789" }))
      .toMatchObject({ ok: false, blocked: { code: "recovery-needs-owner" } });
    expect(await h.handlers.get("updates:install-recovery")!({ sender: { other: true } }, { accessToken: "x" }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/not the app window/) });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
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

// ------------------------------------------------------- owner verify --

describe("ownerVerify.cjs (RC2, D4: main verifies the owner with the backend)", () => {
  const BACKEND = { origin: "https://pos.example.test", anonKey: "anon-public" };
  const TOKEN = "header.payload-of-the-owner.signature";
  const fakeFetch = (respond: () => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(); }) as unknown as typeof fetch;
    return { f, calls };
  };
  const role = (r: unknown, status = 200) => () => new Response(JSON.stringify(r), { status, headers: { "Content-Type": "application/json" } });

  it("asks the pinned backend's app_role() with the session token; only ADMIN passes", async () => {
    const { f, calls } = fakeFetch(role("ADMIN"));
    const v = createOwnerVerifier({ backend: BACKEND, fetchImpl: f });
    expect(await v.verify(TOKEN)).toMatchObject({ ok: true, source: "backend" });
    expect(calls[0].url).toBe("https://pos.example.test/rest/v1/rpc/app_role");
    expect(calls[0].init.headers).toMatchObject({ apikey: "anon-public", Authorization: `Bearer ${TOKEN}` });
    for (const r of ["MANAGER", "CASHIER", "BUYER", null]) {
      const x = createOwnerVerifier({ backend: BACKEND, fetchImpl: fakeFetch(role(r)).f });
      expect(await x.verify(TOKEN)).toMatchObject({ ok: false, code: "not-owner" });
    }
  });

  it("no token, no backend config, or a rejected session: refused", async () => {
    const v = createOwnerVerifier({ backend: BACKEND, fetchImpl: fakeFetch(role("ADMIN")).f });
    expect(await v.verify("")).toMatchObject({ ok: false, code: "no-session" });
    expect(await v.verify(undefined)).toMatchObject({ ok: false, code: "no-session" });
    expect(await createOwnerVerifier({ backend: null }).verify(TOKEN)).toMatchObject({ ok: false, code: "unavailable" });
    const r = createOwnerVerifier({ backend: BACKEND, fetchImpl: fakeFetch(role({ message: "JWT expired" }, 401)).f });
    expect(await r.verify(TOKEN)).toMatchObject({ ok: false, code: "session-rejected" });
  });

  it("server unreachable: passes only for the same token main itself verified online, within the TTL", async () => {
    let up = true;
    let now = NOW;
    const f = (async () => { if (!up) throw new TypeError("fetch failed"); return role("ADMIN")(); }) as unknown as typeof fetch;
    const v = createOwnerVerifier({ backend: BACKEND, fetchImpl: f, now: () => now, offlineTtlMs: 60_000 });
    up = false;
    expect(await v.verify(TOKEN)).toMatchObject({ ok: false, code: "offline" }); // never verified: refused
    up = true;
    expect(await v.verify(TOKEN)).toMatchObject({ ok: true, source: "backend" });
    up = false;
    expect(await v.verify(TOKEN)).toMatchObject({ ok: true, source: "cached" });
    expect(await v.verify(`${TOKEN}-other`)).toMatchObject({ ok: false, code: "offline" });
    now += 61_000;
    expect(await v.verify(TOKEN)).toMatchObject({ ok: false, code: "offline" });
  });

  it("a later non-owner answer clears the cached verification", async () => {
    let answer: unknown = "ADMIN";
    let up = true;
    const f = (async () => { if (!up) throw new TypeError("fetch failed"); return role(answer)(); }) as unknown as typeof fetch;
    const v = createOwnerVerifier({ backend: BACKEND, fetchImpl: f });
    await v.verify(TOKEN);
    answer = "CASHIER"; // demoted / deactivated (app_role() is NULL for an inactive user)
    expect(await v.verify(TOKEN)).toMatchObject({ ok: false, code: "not-owner" });
    up = false;
    expect(await v.verify(TOKEN)).toMatchObject({ ok: false, code: "offline" });
  });

  it("loadBackendConfig: needs an http(s) url and an anon key; missing file = null", () => {
    expect(loadBackendConfig("/nonexistent/backend.json")).toBeNull();
  });
});
