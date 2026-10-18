import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase", () => ({
  backendHost: "pos.example.test",
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-1" } } }, error: null }) },
  },
}));

import { localDb, SYNC_STATE_KEYS } from "../localDb";
import { drainOutbox, enqueueOutbox, recordIdMapping, registerOutboxReconciler } from "../../stores/data/outbox";
import { useAuthStore } from "../../stores/authStore";
import { collectQueueExport } from "./collect";
import { exportPendingQueue } from "./exportQueue";
import { MIN_KDF_ITERATIONS, canonicalJson, decryptQueueExport } from "./format";

const CANARY_ACCESS = "eyJhbGciOiJIUzI1NiJ9.CANARY-ACCESS-TOKEN-7f3a9.sig";
const CANARY_REFRESH = "CANARY-REFRESH-TOKEN-b81c2d4e";
const CANARY_ARG_TOKEN = "CANARY-ARG-TOKEN-55aa66bb77";
const CANARY_PASSWORD = "CANARY-PASSWORD-9988776655";
const CANARY_TOTP = "CANARY-TOTP-SECRET-JBSWY3DPEHPK3PXP";
const PASS = "a long test passphrase";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    ...Object.fromEntries(m),
  } as Storage;
}

/** Everything the queue consists of, as stored (raw rows, primary-key order).
 *  The one thing an export adds is its own durable time mark (post-checkpoint
 *  pass: queued entries no longer prove they were never sent) — never a queue row. */
async function rawQueueState(): Promise<string> {
  const [outbox, idMap, syncState, authCache] = await Promise.all([
    localDb.syncOutbox.toArray(), localDb.provisionalIdMap.toArray(), localDb.syncState.toArray(), localDb.authCache.toArray(),
  ]);
  return JSON.stringify({ outbox, idMap, syncState: syncState.filter((r) => r.key !== SYNC_STATE_KEYS.lastQueueExport), authCache });
}
const exportMark = async () => (await localDb.syncState.get(SYNC_STATE_KEYS.lastQueueExport))?.value ?? null;

const saveQueueExport = vi.fn();

// What stores/data/index.ts registers for open_shift, reduced to the id map.
registerOutboxReconciler("open_shift", (data, provisional) => {
  const id = (data as { shift: { id: string } }).shift.id;
  const prov = provisional?.find((p) => p.table === "shifts")?.ids[0];
  if (prov) void recordIdMapping(prov, id);
});

async function seedQueue(): Promise<void> {
  // A shift opened offline, three sales against it (refs to the provisional
  // shift), a catalog table write, and one entry the server already rejected.
  await enqueueOutbox({
    kind: "rpc", name: "open_shift", shopId: "shop-1",
    args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0, p_created_at: "2026-10-13T01:00:00.000Z" },
    provisional: [{ table: "shifts", ids: ["shift-prov-1"] }],
  });
  for (let i = 1; i <= 3; i++) {
    await enqueueOutbox({
      kind: "rpc", name: "complete_sale", shopId: "shop-1",
      args: {
        p_shop_id: "shop-1", p_shift_id: "shift-prov-1", p_payment_method: "CASH", p_paid_mmk: 1000 * i,
        p_cart_discount_pct: 0, p_items: [{ productId: "p1", qty: i }], p_created_at: `2026-10-13T01:0${i}:00.000Z`,
        // a credential that must never reach the file, even inside args
        access_token: CANARY_ARG_TOKEN, nested: { password: CANARY_PASSWORD, totp_secret: CANARY_TOTP },
      },
      refs: [{ field: "p_shift_id", provisionalId: "shift-prov-1" }],
      provisional: [{ table: "sales", ids: [`sale-prov-${i}`] }],
    });
  }
  await enqueueOutbox({ kind: "table_write", name: "categories.insert", table: "categories", op: "insert", id: "cat-1", row: { id: "cat-1", name: "Tea" }, shopId: null });
  const rows = ((await localDb.syncOutbox.toArray()) as (Awaited<ReturnType<typeof localDb.syncOutbox.toArray>>[number] & { seq: number })[])
    .sort((a, b) => a.seq - b.seq);
  const conflict = rows.find((r) => r.name === "categories.insert")!;
  await localDb.syncOutbox.update(conflict.localId, { status: "conflict", failureKind: "permanent", attempts: 1, lastError: "duplicate key" });
  const sale2 = rows.filter((r) => r.name === "complete_sale")[1];
  await localDb.syncOutbox.update(sale2.localId, { attempts: 4, failureKind: "transient", lastError: "Failed to fetch", nextAttemptAt: "2026-10-13T03:00:00.000Z" });
  await recordIdMapping("old-prov", "old-real");
  await localDb.authCache.put({ authId: "auth-1", userId: "user-1", role: "CASHIER", shopId: "shop-1", orgId: "org-1", isActive: true, hasTotp: false, cachedAt: CANARY_ACCESS });
}

beforeEach(async () => {
  rpc.mockReset();
  saveQueueExport.mockReset();
  await Promise.all([localDb.syncOutbox.clear(), localDb.provisionalIdMap.clear(), localDb.syncState.clear(), localDb.authCache.clear()]);
  vi.stubGlobal("localStorage", memoryStorage({
    "sb-pos-auth-token": JSON.stringify({ access_token: CANARY_ACCESS, refresh_token: CANARY_REFRESH, user: { id: "auth-1" } }),
    "pos-till-id": "till-0a1b2c3d4e",
  }));
  vi.stubGlobal("window", {
    electronAPI: {
      appVersion: () => Promise.resolve("1.0.16-test"),
      saveQueueExport: (req: { defaultFileName: string; contents: string }) => saveQueueExport(req),
    },
  });
  useAuthStore.setState({ currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectQueueExport", () => {
  it("exports every entry in queue order with keys, payload, attempts and status", async () => {
    await seedQueue();
    const p = await collectQueueExport(localDb, {
      appVersion: "1.0.16", tillId: "till-x", backendHost: "pos.example.test",
      session: { userId: "user-1", orgId: "org-1", shopId: "shop-1", role: "CASHIER" },
    });
    expect(p.entries.map((e) => [e.seq, e.opType, e.status])).toEqual([
      [1, "open_shift", "pending"], [2, "complete_sale", "pending"], [3, "complete_sale", "pending"],
      [4, "complete_sale", "pending"], [5, "categories.insert", "conflict"],
    ]);
    const stored = (await localDb.syncOutbox.toArray()) as (typeof p.entries[number] & { localId: string; idempotencyKey?: string })[];
    for (const e of p.entries.filter((x) => x.kind === "rpc")) {
      const row = stored.find((r) => r.localId === e.opId)!;
      expect(e.idempotencyKey).toBe(row.idempotencyKey);
      expect(e.payload?.p_idempotency_key).toBe(row.idempotencyKey);
    }
    expect(p.entries[2]).toMatchObject({ attempts: 4, lastErrorClass: "transient", lastError: "Failed to fetch", ringUpAt: "2026-10-13T01:02:00.000Z" });
    expect(p.entries[1].refs).toEqual([{ field: "p_shift_id", provisionalId: "shift-prov-1" }]);
    expect(p.entries[4]).toMatchObject({ kind: "table_write", table: "categories", tableOp: "insert", rowId: "cat-1", lastErrorClass: "permanent" });
    expect(p.provisionalIdMap).toEqual([expect.objectContaining({ provisionalId: "old-prov", realId: "old-real" })]);
    expect(p.redactedFields).toBe(9); // 3 sales x (access_token, password, totp_secret)
  });

  it("orders by seq even when insertion / createdAt / localId order disagree", async () => {
    const base = { kind: "rpc" as const, shopId: "s", status: "pending" as const, attempts: 0 };
    await localDb.syncOutbox.bulkPut([
      { ...base, localId: "a-third", name: "complete_sale", createdAt: "2026-10-13T00:00:00.000Z", seq: 3 },
      { ...base, localId: "z-first", name: "open_shift", createdAt: "2026-10-13T00:00:00.000Z", seq: 1 },
      { ...base, localId: "m-second", name: "complete_sale", createdAt: "2026-10-12T00:00:00.000Z", seq: 2 },
    ] as never);
    const p = await collectQueueExport(localDb, { appVersion: "v", tillId: "t", backendHost: "h", session: { userId: null, orgId: null, shopId: null, role: null } });
    expect(p.entries.map((e) => e.opId)).toEqual(["z-first", "m-second", "a-third"]);
  });
});

describe("exportPendingQueue (read-only, encrypted, no secrets)", () => {
  it("leaves the queue byte-identical and the drain still works afterwards", async () => {
    await seedQueue();
    const before = await rawQueueState();
    saveQueueExport.mockResolvedValue({ ok: true, filePath: "/tmp/x.spqx" });

    const res = await exportPendingQueue(PASS);
    expect(res).toMatchObject({ status: "saved", filePath: "/tmp/x.spqx", summary: { total: 5 } });
    // a second export (e.g. a retry) changes nothing either
    await exportPendingQueue(PASS);
    expect(await rawQueueState()).toBe(before);
    expect(await exportMark()).toMatch(/^\d{4}-\d\d-\d\dT/);

    // the exported keys are what the drain sends, in the same order
    const { contents } = saveQueueExport.mock.calls[0][0] as { contents: string };
    const payload = await decryptQueueExport(contents, PASS);
    const exportedKeys = payload.entries.filter((e) => e.status !== "conflict").map((e) => e.idempotencyKey);

    rpc.mockImplementation((name: string) => Promise.resolve({
      data: name === "open_shift" ? { shift: { id: "shift-real-1" }, auditLogs: [] } : { sale: { id: "x" }, items: [], movements: [], inventory: [], auditLogs: [] },
      error: null, status: 200,
    }));
    await expect(drainOutbox()).resolves.toBe("drained");
    const sentKeys = rpc.mock.calls.map((c) => (c[1] as Record<string, unknown>).p_idempotency_key);
    expect(sentKeys).toEqual(exportedKeys.slice(0, 4));
    expect(rpc.mock.calls.slice(1).every((c) => (c[1] as Record<string, unknown>).p_shift_id === "shift-real-1")).toBe(true);
    // only the conflict (never auto-retried) is left
    expect((await localDb.syncOutbox.toArray()).map((r) => r.name)).toEqual(["categories.insert"]);
  });

  it("writes no auth token, refresh token, session, anon key, password or TOTP data (canaries)", async () => {
    await seedQueue();
    saveQueueExport.mockResolvedValue({ ok: true, filePath: "/tmp/x.spqx" });
    await exportPendingQueue(PASS);
    const { contents, defaultFileName } = saveQueueExport.mock.calls[0][0] as { contents: string; defaultFileName: string };
    expect(defaultFileName).toMatch(/^pending-queue-till-0a1b2c3d4e-\d{8}-\d{6}Z\.spqx$/);
    const decrypted = canonicalJson(await decryptQueueExport(contents, PASS));
    for (const canary of [CANARY_ACCESS, CANARY_REFRESH, CANARY_ARG_TOKEN, CANARY_PASSWORD, CANARY_TOTP, "test-anon-key", "CANARY"]) {
      expect(contents).not.toContain(canary);
      expect(decrypted).not.toContain(canary);
    }
    expect(decrypted).not.toMatch(/"(access_token|refresh_token|password|totp_secret|session)":"(?!\[REDACTED\])/);
    const p = JSON.parse(decrypted);
    expect(p.session).toEqual({ orgId: "org-1", role: "CASHIER", shopId: null, userId: "user-1" });
    expect(p.backendHost).toBe("pos.example.test");
    expect(p.appVersion).toBe("1.0.16-test");
    expect(p.tillId).toBe("till-0a1b2c3d4e");
  });

  it("aborts without writing when a live token turns up in a field the redactor cannot know about", async () => {
    await enqueueOutbox({ kind: "rpc", name: "adjust_stock", shopId: "shop-1", args: { p_reason: `pasted ${CANARY_ACCESS}` } });
    const before = await rawQueueState();
    await expect(exportPendingQueue(PASS)).rejects.toMatchObject({ code: "secret-detected" });
    expect(saveQueueExport).not.toHaveBeenCalled();
    expect(await rawQueueState()).toBe(before);
  });

  it("a canceled save dialog reports canceled and changes nothing", async () => {
    await seedQueue();
    const before = await rawQueueState();
    saveQueueExport.mockResolvedValue({ ok: false, canceled: true });
    await expect(exportPendingQueue(PASS)).resolves.toEqual({ status: "canceled" });
    expect(await rawQueueState()).toBe(before);
    expect(await exportMark()).not.toBeNull();       // conservative: marked before the file could leave
  });

  it("refuses a weak passphrase before anything is written", async () => {
    await seedQueue();
    await expect(exportPendingQueue("short")).rejects.toMatchObject({ code: "weak-passphrase" });
    expect(saveQueueExport).not.toHaveBeenCalled();
  });

  it("decrypts with the minimum KDF bound check intact", () => {
    expect(MIN_KDF_ITERATIONS).toBeGreaterThanOrEqual(100_000);
  });
});
