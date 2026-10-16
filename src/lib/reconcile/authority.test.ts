// RC3: electron/reconcileAuthority.cjs, the main-process owner check of a
// reconciliation. Fresh server verification every time (app_role +
// app_user_id + own users row), never cached, refused offline; seals only
// main can make and verify.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKEND, OWNER_TOKEN, fakeAuthBackend, memoryKeyStore } from "../../test/reconcileFakes";

const require = createRequire(import.meta.url);
const { createReconcileAuthority, fileKeyStore } = require("../../../electron/reconcileAuthority.cjs");

const HEX = (c: string) => c.repeat(64);
const TOKEN = OWNER_TOKEN;
const fakeBackend = fakeAuthBackend;

const req = { localId: "outbox-1", entryDigest: HEX("a"), recordDigest: HEX("b") };

describe("reconcileAuthority.cjs (RC3: main verifies the owner with the server at the moment of reconciling)", () => {
  it("ADMIN confirmed by the server -> owner identity (server user id + name) and a seal that verifies", async () => {
    const b = fakeBackend();
    const a = createReconcileAuthority({ backend: BACKEND, keyStore: memoryKeyStore(), fetchImpl: b.fetchImpl, now: () => Date.parse("2026-10-16T12:00:00Z") });
    const r = await a.attest(TOKEN, req);
    expect(r).toMatchObject({ ok: true, owner: { userId: "admin-1", name: "Owner One", orgId: "org-1", role: "ADMIN", verifiedAt: "2026-10-16T12:00:00.000Z", source: "backend" } });
    expect(r.seal).toMatch(/^[0-9a-f]{64}$/);
    expect(b.calls.map((c) => `${c.method} ${c.url.replace(BACKEND.origin, "")}`)).toEqual([
      "POST /rest/v1/rpc/app_role", "POST /rest/v1/rpc/app_user_id", "GET /rest/v1/users?select=id,name,role,is_active,org_id&id=eq.admin-1",
    ]);
    expect(b.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const item = { ...req, ownerUserId: "admin-1", ownerName: "Owner One", verifiedAt: r.owner.verifiedAt, seal: r.seal };
    expect(a.verifySeals([item])).toEqual([true]);
    // any field changed -> false
    for (const k of ["localId", "entryDigest", "recordDigest", "ownerUserId", "ownerName", "verifiedAt"] as const) {
      expect(a.verifySeals([{ ...item, [k]: k.endsWith("Digest") ? HEX("c") : `${item[k]}x` }])).toEqual([false]);
    }
    expect(a.verifySeals([{ ...item, seal: HEX("0") }])).toEqual([false]);
    // another till's key -> false
    const other = createReconcileAuthority({ backend: BACKEND, keyStore: memoryKeyStore("cd".repeat(32)), fetchImpl: b.fetchImpl });
    expect(other.verifySeals([item])).toEqual([false]);
  });

  it("the server says CASHIER / inactive / no profile -> refused, no seal", async () => {
    for (const user of [
      { id: "c-1", name: "Cashier", role: "CASHIER", is_active: true, org_id: "org-1" },
      { id: "a-2", name: "Old owner", role: "ADMIN", is_active: false, org_id: "org-1" },
      null,
    ]) {
      const a = createReconcileAuthority({ backend: BACKEND, keyStore: memoryKeyStore(), fetchImpl: fakeBackend({ user }).fetchImpl });
      const r = await a.attest(TOKEN, req);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("not-owner");
      expect(r.seal).toBeUndefined();
    }
  });

  it("a rejected session (401/403) is refused", async () => {
    for (const status of [401, 403]) {
      const a = createReconcileAuthority({ backend: BACKEND, keyStore: memoryKeyStore(), fetchImpl: fakeBackend({ status }).fetchImpl });
      expect(await a.attest(TOKEN, req)).toMatchObject({ ok: false, code: "session-rejected" });
    }
  });

  it("OFFLINE is refused even right after a successful verification of the same token (no cached shortcut)", async () => {
    let down = false;
    const up = fakeBackend();
    const a = createReconcileAuthority({
      backend: BACKEND, keyStore: memoryKeyStore(),
      fetchImpl: (u: string, i: RequestInit) => (down ? Promise.reject(new TypeError("fetch failed")) : up.fetchImpl(u, i)),
    });
    expect((await a.attest(TOKEN, req)).ok).toBe(true);
    down = true;
    const r = await a.attest(TOKEN, req);
    expect(r).toMatchObject({ ok: false, code: "offline" });
    expect(r.message).toMatch(/live owner check/);
    // 5xx counts as unreachable too
    const a5 = createReconcileAuthority({ backend: BACKEND, keyStore: memoryKeyStore(), fetchImpl: fakeBackend({ status: 503 }).fetchImpl });
    expect(await a5.attest(TOKEN, req)).toMatchObject({ ok: false, code: "offline" });
  });

  it("fails closed: no backend config, no key, no token, malformed request", async () => {
    const b = fakeBackend();
    expect(await createReconcileAuthority({ backend: null, keyStore: memoryKeyStore(), fetchImpl: b.fetchImpl }).attest(TOKEN, req)).toMatchObject({ ok: false, code: "unavailable" });
    const noKey = createReconcileAuthority({ backend: BACKEND, keyStore: { load: () => { throw new Error("EACCES"); } }, fetchImpl: b.fetchImpl });
    expect(await noKey.attest(TOKEN, req)).toMatchObject({ ok: false, code: "unavailable" });
    expect(noKey.verifySeals([{ ...req, ownerUserId: "a", ownerName: "b", verifiedAt: "c", seal: HEX("1") }])).toEqual([false]);
    const a = createReconcileAuthority({ backend: BACKEND, keyStore: memoryKeyStore(), fetchImpl: b.fetchImpl });
    expect(await a.attest("", req)).toMatchObject({ ok: false, code: "no-session" });
    expect(await a.attest(TOKEN, { ...req, entryDigest: "nothex" })).toMatchObject({ ok: false, code: "bad-request" });
    expect(await a.attest(TOKEN, null)).toMatchObject({ ok: false, code: "bad-request" });
    expect(b.calls).toHaveLength(0); // nothing was even asked
  });

  it("fileKeyStore: creates a 0600 key once and reuses it (seals survive a restart)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rc3-key-"));
    const file = path.join(dir, "reconcile-seal.key");
    const k1 = fileKeyStore(file).load();
    expect(k1).toHaveLength(32);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const k2 = fileKeyStore(file).load(); // "restart": a new store reads the same file
    expect(k2.equals(k1)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(k1.toString("hex"));
  });
});
