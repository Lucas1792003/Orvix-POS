// Recovery Script 2 -- offline-authorization adversarial tests (till side, capability store).
// New file; product code untouched. Same mocking pattern as offlineCapability.test.ts (fake server, fake IndexedDB,
// fake Date). Checks named "C.." assert the CORRECT behaviour; a failing one is a demonstrated defect.
// "LIMITATION:" tests pass when the documented limitation is demonstrated.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/supabase", async () => ({ supabase: (await import("../stores/data/testing/fakeSupabase")).fakeSupabase }));
import { fakeSupabase as fake } from "../stores/data/testing/fakeSupabase";
import { localDb } from "../lib/localDb";
import { currentBackendOrigin } from "../lib/backendOrigin";
import {
  authorizeOfflineOperation, maintainOfflineCapability, offlineAuthorizationView, offlineDeviceId, OfflineAuthorizationUnavailable,
  resetOfflineCapabilityForTests, withdrawOfflineCapability, type OfflineCapability,
} from "./offlineCapability";

const T0 = Date.parse("2026-10-21T08:00:00Z");
const HOUR = 3600_000;
let reply: () => { data: unknown; error: unknown; status: number } = () => ({ data: null, error: { code: "PGRST202", message: "missing" }, status: 404 });
let n = 0;

const capability = async (over: Partial<OfflineCapability> = {}): Promise<OfflineCapability> => ({
  protocol: "orvix-offline-capability-v1", id: `cap-${++n}`, orgId: "org-1", shopId: "shop-1", deviceId: await offlineDeviceId(),
  userId: "user-1", offlineEpoch: 0, policyScope: "*", policyStatus: "OWNER_APPROVED",
  issuedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + HOUR).toISOString(),
  syncDeadline: new Date(Date.now() + 25 * HOUR).toISOString(), maxOps: 3, maxAmountMmk: 20_000, allowedOps: ["complete_sale"], ...over,
});
const deliver = async (cap: OfflineCapability, serverTime = new Date(Date.now()).toISOString()) => {
  reply = () => ({ data: { outcome: "issued", capability: cap, serverTime }, error: null, status: 200 });
  await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
};
const issue = async (over: Partial<OfflineCapability> = {}) => { const c = await capability(over); await deliver(c); return c; };
const sale = (amountMmk = 1000, userId: string | null = "user-1", shopId = "shop-1", orgId = "org-1") =>
  authorizeOfflineOperation({ orgId, shopId, userId, rpc: "complete_sale", amountMmk });
const outcome = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof OfflineAuthorizationUnavailable) return e.state; throw e; }
  return "authorized";
};
const view = () => offlineAuthorizationView("org-1", "shop-1", "user-1");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  fake.reset(); resetOfflineCapabilityForTests(); n = 0;
  await Promise.all(localDb.tables.map((t) => t.clear()));
  vi.stubGlobal("navigator", { onLine: true });
  const real = fake.rpc;
  vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
    if (name !== "recovery_v1_offline_capability") return real(name, args);
    fake.calls.push({ name, args, mode: "succeed", replayed: false });
    const promise = Promise.resolve(reply());
    const builder = { abortSignal: () => builder, then: promise.then.bind(promise) };
    return builder as ReturnType<typeof real>;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Script 2 / offline capability: clock", () => {
  it("C01 clock rolled back beyond the tolerance stops offline selling, also after an app restart", async () => {
    await issue();
    await sale();
    vi.setSystemTime(T0 + 30 * 60_000); await view();             // the till saw T0+30m
    vi.setSystemTime(T0 + 10 * 60_000);                            // rolled back 20 minutes
    expect(await outcome(sale())).toBe("clock");
    resetOfflineCapabilityForTests();                              // restart: the high-water mark is persisted
    expect(await outcome(sale())).toBe("clock");
  });

  it("C02 once the till has SEEN a time past the expiry, a small clock rollback (< 2 min tolerance) must not make the capability valid again", async () => {
    const cap = await issue();
    vi.setSystemTime(Date.parse(cap.expiresAt) + 60_000);
    expect((await view()).state).toBe("expired");                 // observed: past expiry (high-water mark persisted)
    vi.setSystemTime(Date.parse(cap.expiresAt) - 50_000);          // rolled back 110 s: inside the rollback tolerance
    // correct behaviour: expiry is judged against the highest time this till has seen, not the rolled-back clock
    expect(await outcome(sale())).not.toBe("authorized");
  });

  it("C03 a clock running FAST at issuance never lets the till sell past the server's expiry", async () => {
    const serverTime = new Date(T0).toISOString();
    vi.setSystemTime(T0 + 10 * 60_000);                            // till 10 min ahead of the server
    const cap = await capability({ issuedAt: serverTime, expiresAt: new Date(T0 + HOUR).toISOString() });
    await deliver(cap, serverTime);
    vi.setSystemTime(T0 + HOUR + 10 * 60_000 - 1);                  // server time ~ T0+60m-1ms
    expect(await outcome(sale())).toBe("expired");                 // conservative: the till's own (fast) clock is used
  });
});

describe("Script 2 / offline capability: replay, binding, identities", () => {
  it("C04 a capability that was WITHDRAWN never becomes valid again when the same capability is delivered later", async () => {
    const cap = await issue();
    await withdrawOfflineCapability("org-1", "shop-1", "the organization is not active");
    vi.setSystemTime(T0 + 60_000);
    await deliver(cap);                                            // replayed / duplicated reply with the SAME capability id
    expect(await outcome(sale())).toBe("withdrawn");
  });

  it("C05 re-delivery of the SAME capability id never resets its local usage (count / value / sequence)", async () => {
    const cap = await issue();
    await sale(5000); await sale(5000);
    vi.setSystemTime(T0 + 31 * 60_000);                            // past the refresh point
    await deliver(cap);                                            // the same capability again (replayed reply)
    const v = await view();
    expect(v.remainingOps).toBe(1);
    expect(v.remainingAmountMmk).toBe(10_000);
    expect((await sale(1000)).deviceSeq).toBe(3);
    expect(await outcome(sale(1000))).toBe("exhausted");          // never more than maxOps local sales under one capability
  });

  for (const [label, over] of [
    ["another organization", { orgId: "org-2" }], ["another shop", { shopId: "shop-2" }],
    ["another device", { deviceId: "till-someone-else-0001" }], ["another cashier", { userId: "user-2" }],
  ] as const) {
    it(`C06 a capability reply bound to ${label} is ignored (nothing stored, nothing authorized; an existing one is kept)`, async () => {
      expect(await outcome(sale())).toBe("missing");
      await deliver(await capability(over));
      expect(await outcome(sale())).toBe("missing");
      const good = await issue();
      await deliver(await capability(over));
      expect((await sale()).capabilityId).toBe(good.id);
    });
  }

  it("C07 a capability for shop-1 authorizes nothing in shop-2, nor for org-2, nor for another cashier", async () => {
    await issue();
    expect(await outcome(sale(1000, "user-1", "shop-2"))).toBe("missing");
    expect(await outcome(sale(1000, "user-1", "shop-1", "org-2"))).toBe("missing");
    expect(await outcome(sale(1000, "user-2"))).toBe("other-user");
  });

  it("C08 device id and device sequence survive restarts; a new capability never re-uses a sequence number", async () => {
    const dev = await offlineDeviceId();
    await issue(); await sale(); await sale();
    resetOfflineCapabilityForTests();
    expect(await offlineDeviceId()).toBe(dev);
    vi.setSystemTime(T0 + 40 * 60_000);
    const next = await issue();
    expect(await sale()).toEqual({ capabilityId: next.id, deviceSeq: 3 });
  });

  it("C09 a refused issuance for an unrelated reason (rate_limited / policy) keeps the old capability with its own expiry, never extended", async () => {
    const cap = await issue();
    vi.setSystemTime(T0 + 40 * 60_000);
    for (const reason of ["rate_limited", "offline_policy_not_approved"]) {
      reply = () => ({ data: { outcome: "refused", reason }, error: null, status: 200 });
      await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
      expect(await view()).toMatchObject({ state: "valid", expiresAt: cap.expiresAt });
    }
  });

  it("C10 LIMITATION: a locally tampered capability copy (maxOps raised in IndexedDB) lets the till record more sales; only the server's check bounds them", async () => {
    await issue({ maxOps: 1 });
    await sale();
    const key = `rv1:offline-cap:${JSON.stringify([currentBackendOrigin(), "org-1", "shop-1"])}`;
    const row = await localDb.syncState.get(key);
    const s = JSON.parse(row!.value!); s.capability.maxOps = 100;
    await localDb.syncState.put({ key, value: JSON.stringify(s), updatedAt: new Date().toISOString() });
    expect((await sale()).deviceSeq).toBe(2);                      // demonstrated: the till accepts its own tampered copy
  });
});
