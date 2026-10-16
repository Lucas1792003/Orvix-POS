// Electron-level test of the updater guard: launches a real Electron
// process (electron/test/updater-guard.main.cjs) that runs the real
// electron/updater.cjs + electron/preload.cjs with a fake electron-updater.
// Skipped when the Electron binary is not installed (CI without
// `node node_modules/electron/install.js`) or with SKIP_ELECTRON_TESTS=1.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

function electronBinary(): string | null {
  try {
    const p = require("electron") as unknown as string; // the npm package exports the binary path
    return typeof p === "string" && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const bin = process.env.SKIP_ELECTRON_TESTS === "1" ? null : electronBinary();

interface GuardResult {
  scenario: string;
  quitAndInstall: { isSilent: boolean; forceRunAfter: boolean }[];
  dialogs: { title: string; detail: string }[];
  installButton: { ok: boolean; blocked?: { code: string; unsynced: number; message: string } } | null;
  beforeQuitPrevented: boolean | null;
  error?: string;
}

function run(scenario: string): GuardResult {
  const out = join(mkdtempSync(join(tmpdir(), "ug-")), "result.json");
  // ELECTRON_RUN_AS_NODE (set by some tool hosts) would start plain Node.
  const env: NodeJS.ProcessEnv = { ...process.env, SCENARIO: scenario, FAKE_PLATFORM: "win32", UPDATER_GUARD_RESULT: out };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawnSync(bin!, [join(ROOT, "electron", "test", "updater-guard.main.cjs")], {
    env,
    timeout: 60_000,
    encoding: "utf8",
  });
  if (!existsSync(out)) throw new Error(`electron produced no result (exit ${proc.status}): ${proc.stderr?.slice(0, 500)}`);
  return JSON.parse(readFileSync(out, "utf8")) as GuardResult;
}

describe.skipIf(!bin)("updater guard inside Electron (fake updater, real preload + updater.cjs)", () => {
  it("3 pending entries: no install from the button or on quit; the notice is shown; the app quits normally", () => {
    const r = run("pending");
    expect(r.error).toBeUndefined();
    expect(r.quitAndInstall).toEqual([]);
    expect(r.installButton).toMatchObject({ ok: false, blocked: { code: "unsynced", unsynced: 3 } });
    expect(r.beforeQuitPrevented).toBe(false);
    expect(r.dialogs.map((d) => d.title)).toEqual(["Update waiting"]);
    expect(r.dialogs[0].detail).toContain("3 sales/actions waiting to sync — update will install after they sync.");
  }, 70_000);

  it("a sale in progress: nothing installs and no dialog interrupts it", () => {
    const r = run("midsale");
    expect(r.error).toBeUndefined();
    expect(r.quitAndInstall).toEqual([]);
    expect(r.installButton).toMatchObject({ ok: false, blocked: { code: "sale-in-progress" } });
    expect(r.dialogs).toEqual([]);
  }, 70_000);

  it("queue empty, online, signed in: quitting installs silently (NSIS install-on-quit)", () => {
    const r = run("clear");
    expect(r.error).toBeUndefined();
    expect(r.dialogs.map((d) => d.title)).toEqual(["Update ready"]); // answered "Later"
    expect(r.beforeQuitPrevented).toBe(true);
    expect(r.quitAndInstall).toEqual([{ isSilent: true, forceRunAfter: false }]);
  }, 70_000);
});
