// Step 4 (Part B): the till's own enforcement of a server-issued offline capability. The server is the verifier at
// sync; here the till must never extend, renew or invent authority while disconnected.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/supabase", async () => ({ supabase: (await import("../stores/data/testing/fakeSupabase")).fakeSupabase }));
import { fakeSupabase as fake } from "../stores/data/testing/fakeSupabase";
import { localDb } from "../lib/localDb";
import {
  authorizeOfflineOperation, maintainOfflineCapability, offlineAuthorizationView, OfflineAuthorizationUnavailable,
  resetOfflineCapabilityForTests, withdrawOfflineCapability, type OfflineCapability,
} from "./offlineCapability";
// Step 5: offline authority belongs to an owner-approved till; the tests run on a synthetic one (testing.ts)
import { installSyntheticTrustedTill } from "./testing";
import { resetTillVaultForTests } from "./deviceTrust";
import { currentBackendOrigin } from "../lib/backendOrigin";
let tillDeviceId = "";

const T0 = Date.parse("2026-10-21T08:00:00Z");
let reply: () => { data: unknown; error: unknown; status: number } = () => ({ data: null, error: { code: "PGRST202", message: "missing" }, status: 404 });
let capCalls = 0;

const capability = async (over: Partial<OfflineCapability> = {}): Promise<OfflineCapability> => ({
  protocol: "orvix-offline-capability-v1", id: `cap-${++capCalls}`, orgId: "org-1", shopId: "shop-1", deviceId: tillDeviceId,
  userId: "user-1", offlineEpoch: 0, policyScope: "*", policyStatus: "DEFAULT_UNAPPROVED",
  issuedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
  syncDeadline: new Date(Date.now() + 9 * 86400_000).toISOString(), maxOps: 3, maxAmountMmk: 10_000, allowedOps: ["complete_sale"], ...over,
});
const issue = async (over: Partial<OfflineCapability> = {}) => {
  const cap = await capability(over);
  reply = () => ({ data: { outcome: "issued", capability: cap, serverTime: new Date(Date.now()).toISOString() }, error: null, status: 200 });
  await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
  return cap;
};
const sale = (amountMmk = 1000, userId: string | null = "user-1") =>
  authorizeOfflineOperation({ orgId: "org-1", shopId: "shop-1", userId, rpc: "complete_sale", amountMmk });
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof OfflineAuthorizationUnavailable) return e.state; throw e; }
  return "authorized";
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  fake.reset(); resetOfflineCapabilityForTests(); capCalls = 0;
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await resetTillVaultForTests(); tillDeviceId = (await installSyntheticTrustedTill({ origin: currentBackendOrigin() })).deviceId;
  vi.stubGlobal("navigator", { onLine: true });
  const real = fake.rpc;
  vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
    if (name !== "recovery_v1_offline_capability") return real(name, args);
    fake.calls.push({ name, args, mode: "succeed", replayed: false });
    const promise = Promise.resolve(reply());
    const builder = { abortSignal: () => builder, setHeader: () => builder, then: promise.then.bind(promise) };
    return builder as ReturnType<typeof real>;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const capRequests = () => fake.calls.filter((c) => c.name === "recovery_v1_offline_capability").length;

describe("offline capability (client enforcement)", () => {
  it("no capability: nothing is authorized (it is issued only while connected)", async () => {
    expect(await refusal(sale())).toBe("missing");
    expect((await offlineAuthorizationView("org-1", "shop-1", "user-1")).state).toBe("missing");
  });

  it("issued while connected: sequential device numbers, counts and value are reserved before anything is saved", async () => {
    const cap = await issue();
    expect(await sale(1000)).toEqual({ capabilityId: cap.id, deviceSeq: 1 });
    expect(await sale(2000)).toEqual({ capabilityId: cap.id, deviceSeq: 2 });
    const v = await offlineAuthorizationView("org-1", "shop-1", "user-1");
    expect(v).toMatchObject({ state: "valid", remainingOps: 1, remainingAmountMmk: 7000 });
  });

  it("Step 5 regression: an EXHAUSTED capability is not 'fresh' — while connected the till asks for a new one before half its lifetime", async () => {
    await issue({ maxOps: 1 });
    await sale(1000);
    expect(await refusal(sale(1000))).toBe("exhausted");
    const next = await capability();
    reply = () => ({ data: { outcome: "issued", capability: next, serverTime: new Date(Date.now()).toISOString() }, error: null, status: 200 });
    resetOfflineCapabilityForTests();                               // past the 30 s ask throttle; still within the first half of the lifetime
    await maintainOfflineCapability("org-1", "shop-1", "user-1");   // not forced
    expect(await refusal(sale(1000))).toBe("authorized");
  });

  it("exhaustion: the count and the value limits stop offline selling", async () => {
    await issue({ maxOps: 2, maxAmountMmk: 5000 });
    expect(await refusal(sale(6000))).toBe("exhausted");      // over the value: nothing reserved
    await sale(1000); await sale(1000);
    expect(await refusal(sale(1))).toBe("exhausted");          // count used up
  });

  it("expiry: the capability stops at its expiry and is never extended locally", async () => {
    const cap = await issue();
    vi.setSystemTime(Date.parse(cap.expiresAt) + 1);
    expect(await refusal(sale())).toBe("expired");
    vi.stubGlobal("navigator", { onLine: false });
    await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
    expect(await refusal(sale())).toBe("expired");
  });

  it("clock rollback: a clock earlier than one this till already saw stops offline selling", async () => {
    await issue();
    await sale();
    vi.setSystemTime(T0 - 3600_000);
    expect(await refusal(sale())).toBe("clock");
    // putting the clock forward again does not hide the earlier high-water mark gap from the server (seq continues)
    vi.setSystemTime(T0 + 60_000);
    expect((await sale()).deviceSeq).toBe(2);
  });

  it("another cashier on the same till: the capability does not transfer", async () => {
    await issue();
    expect(await refusal(sale(1000, "user-2"))).toBe("other-user");
  });

  it("withdrawal (organization left ACTIVE / device revoked): stops at once", async () => {
    await issue();
    await withdrawOfflineCapability("org-1", "shop-1", "the organization is not active");
    expect(await refusal(sale())).toBe("withdrawn");
  });

  it("the server refusing to issue (organization not active) withdraws the local copy", async () => {
    await issue();
    vi.setSystemTime(T0 + 90 * 60_000); // past the refresh point
    reply = () => ({ data: { outcome: "refused", reason: "organization_not_active" }, error: null, status: 200 });
    await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
    expect(await refusal(sale())).toBe("withdrawn");
  });

  it("never renewed offline; a failed request keeps the old capability with its own expiry", async () => {
    const cap = await issue();
    const before = capRequests();
    vi.stubGlobal("navigator", { onLine: false });
    await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
    expect(capRequests()).toBe(before);                       // nothing asked while offline
    vi.stubGlobal("navigator", { onLine: true });
    reply = () => ({ data: null, error: { code: "", message: "TypeError: Failed to fetch" }, status: 0 });
    await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
    const v = await offlineAuthorizationView("org-1", "shop-1", "user-1");
    expect(v).toMatchObject({ state: "valid", expiresAt: cap.expiresAt });
  });

  it("a capability issued for another device or shop is ignored; a new capability keeps the device sequence", async () => {
    await issue();
    await sale();
    const other = await capability({ deviceId: "till-someone-else" });
    reply = () => ({ data: { outcome: "issued", capability: other, serverTime: new Date().toISOString() }, error: null, status: 200 });
    await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
    expect((await sale()).capabilityId).not.toBe(other.id);
    const next = await issue();
    expect(await sale()).toEqual({ capabilityId: next.id, deviceSeq: 3 });
  });

  it("only sales are eligible offline", async () => {
    await issue();
    await expect(authorizeOfflineOperation({ orgId: "org-1", shopId: "shop-1", userId: "user-1", rpc: "close_shift", amountMmk: 0 }))
      .rejects.toBeInstanceOf(OfflineAuthorizationUnavailable);
  });

  it("two windows reserving at the same moment never get the same device sequence or exceed the limit", async () => {
    await issue({ maxOps: 3 });
    const results = await Promise.allSettled([sale(), sale(), sale(), sale()]);
    const ok = results.filter((r): r is PromiseFulfilledResult<{ capabilityId: string; deviceSeq: number }> => r.status === "fulfilled").map((r) => r.value.deviceSeq);
    expect(ok.sort()).toEqual([1, 2, 3]);                     // three distinct numbers, the fourth refused
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("a capability reply that arrives after a withdrawal never revives offline authority", async () => {
    await issue();
    vi.setSystemTime(T0 + 90 * 60_000);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const late = await capability({ id: "cap-late" });
    reply = () => ({ data: { outcome: "issued", capability: late, serverTime: new Date().toISOString() }, error: null, status: 200 });
    const real = fake.rpc;
    vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
      if (name !== "recovery_v1_offline_capability") return real(name, args);
      const promise = gate.then(() => reply());
      const builder = { abortSignal: () => builder, setHeader: () => builder, then: promise.then.bind(promise) };
      return builder as ReturnType<typeof real>;
    });
    const pending = maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
    await withdrawOfflineCapability("org-1", "shop-1", "the organization is not active");
    release();
    await pending;
    expect(await refusal(sale())).toBe("withdrawn");
  });

  it("the rollback high-water mark is re-anchored to the server's clock when a capability is issued", async () => {
    vi.setSystemTime(T0 + 7 * 86400_000);                     // the till's clock was a week ahead once
    await offlineAuthorizationView("org-1", "shop-1", "user-1");
    vi.setSystemTime(T0);                                       // corrected
    await issue();                                              // the server's time re-anchors the mark
    expect((await sale()).deviceSeq).toBe(1);
  });
});
