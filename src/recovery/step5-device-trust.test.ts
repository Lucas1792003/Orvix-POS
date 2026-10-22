// Step 5 (docs/recovery-v1/STEP5-DESIGN.md §1): this till's owner-approved device identity, on the till side.
// The server-side verifier (PostgreSQL) is tested by tools/recovery-v1/step5/s5_suite.py; here: what the till generates,
// signs, stores and refuses.
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/supabase", async () => ({ supabase: (await import("../stores/data/testing/fakeSupabase")).fakeSupabase }));
vi.mock("../stores/authStore", async () => {
  const actual = await vi.importActual<typeof import("../stores/authStore")>("../stores/authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" }) } };
});
import { fakeSupabase as fake } from "../stores/data/testing/fakeSupabase";
import { localDb } from "../lib/localDb";
import { currentBackendOrigin } from "../lib/backendOrigin";
import { useAppStore } from "../stores/appStore";
import { createSaleSlice } from "../stores/data/slices/saleSlice";
import { registerOutboxReconciler, simulateNewAppInstanceForTests } from "../stores/data/outbox";
import { resetWriteAheadForTests } from "../stores/data/writeAhead";
import { setExecutorCapabilityForTests } from "../stores/data/idempotentRpc";
import { registerVerifiedReload } from "../stores/data/verifiedReload";
import { resetRecoveryStateForTests } from "../stores/data/recoveryState";
import { resetRecoveryGateForTests } from "../stores/data/recoveryGate";
import { refreshRecoveryV1, resetRecoveryV1ForTests } from "./client";
import {
  currentTill, DEVICE_HEADER, keyFingerprint, refreshTill, requestEnrollment, requestMessage, resetTillVaultForTests, rsaSignHex, rsaVerifyHex,
  setOwnerTrustAnchorsForTests, signOperation, signRequest, tillVault, tillView, trustedTill, verifyApproval, type TillIdentity,
} from "./deviceTrust";
import { installSyntheticTrustedTill } from "./testing";

const ORG = "org-1", SHOP = "shop-1";
let statusReply: Record<string, unknown> = {};
let v1State = "ACTIVE";
const origin = () => currentBackendOrigin();

beforeEach(async () => {
  vi.restoreAllMocks(); fake.reset(); fake.enableExecutor(); setExecutorCapabilityForTests("available");
  simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryStateForTests(); resetRecoveryGateForTests(); resetRecoveryV1ForTests();
  await Promise.all(localDb.tables.map((t) => t.clear())); await resetTillVaultForTests(); setOwnerTrustAnchorsForTests(null);
  useAppStore.setState({ currentShopId: SHOP });
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: SHOP, isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true }); registerVerifiedReload(async () => true);
  statusReply = { state: "NONE" }; v1State = "ACTIVE";
  const real = fake.rpc;
  vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
    let r: unknown;
    if (name === "recovery_v1_status") r = { data: { protocol: "orvix-recovery-v1", org_id: ORG, state: v1State, recovered_as_of: null, uncertainties: [], required_evidence: true }, error: null, status: 200 };
    else if (name === "recovery_v1_call") {
      fake.calls.push({ name, args, mode: "succeed", replayed: false });
      const a = args as { p_action: string; p_args: Record<string, unknown> };
      r = { data: a.p_action === "device.request" ? { outcome: "pending" } : statusReply, error: null, status: 200 };
    } else return real(name, args);
    const promise = Promise.resolve(r);
    const builder = { abortSignal: () => builder, setHeader: () => builder, then: promise.then.bind(promise) };
    return builder as ReturnType<typeof real>;
  });
});
afterEach(() => { setOwnerTrustAnchorsForTests(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ownerKey = async () => {
  const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey("jwk", k.publicKey);
  const n = Buffer.from(j.n!, "base64url").toString("hex").replace(/^0+/, "");
  return { pair: k, n, fingerprint: await keyFingerprint(n) };
};
const approvalFor = async (t: TillIdentity, owner: Awaited<ReturnType<typeof ownerKey>>, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => {
  const authorization = JSON.stringify({ protocol: "orvix-owner-authorization-v1", purpose: "enroll-device", keyId: "owner-1", scope: t.orgId, ...top,
    device: { requestId: t.requestId, orgId: t.orgId, shopId: t.shopId, deviceId: t.deviceId, keyFingerprint: t.fingerprint, requestNonce: t.requestNonce,
      notAfter: new Date(Date.now() + 86400_000).toISOString(), replacesEnrollmentId: t.replacesEnrollmentId, ...over } });
  return { state: "ACTIVE", enrollmentId: t.requestId, authorization, signature: await rsaSignHex(owner.pair.privateKey, authorization),
    ownerKey: { keyId: "owner-1", n: owner.n, e: 65537, fingerprint: owner.fingerprint, scope: "*" } };
};

describe("Step 5 till identity", () => {
  it("the till's key fingerprint is exactly the server's formula (sha256 of '<hex modulus>:65537')", async () => {
    const o = await ownerKey();
    expect(o.fingerprint).toBe(createHash("sha256").update(`${o.n}:65537`, "utf8").digest("hex"));
  });

  it("without an owner trust anchor provisioned, enrollment is disabled and nothing is generated or sent", async () => {
    expect((await tillView(origin(), ORG, SHOP)).phase).toBe("no-anchor");
    await expect(requestEnrollment(origin(), ORG, SHOP)).rejects.toThrow(/trust anchor/);
    expect(await currentTill(origin(), ORG, SHOP)).toBeNull();
    expect(fake.calls.filter((c) => c.name === "recovery_v1_call")).toHaveLength(0);
  });

  it("enrollment request: non-extractable keys, self-signed request (proof of possession), persisted BEFORE it is sent; a resend re-uses the same request", async () => {
    const o = await ownerKey(); setOwnerTrustAnchorsForTests([o.fingerprint]);
    const v = await requestEnrollment(origin(), ORG, SHOP);
    const t = (await currentTill(origin(), ORG, SHOP))!;
    expect(v.phase).toBe("pending");
    expect(t.signingKey.extractable).toBe(false); expect(t.evidenceKey.extractable).toBe(false);
    expect(t.fingerprint).toBe(await keyFingerprint(t.publicN));
    const req = JSON.parse(t.requestText);
    expect(req).toMatchObject({ protocol: "orvix-device-enrollment-request-v1", orgId: ORG, shopId: SHOP, deviceId: t.deviceId, keyFingerprint: t.fingerprint,
      publicKey: { n: t.publicN, e: 65537 }, evidencePublicKey: t.evidencePublicKey });
    expect(await rsaVerifyHex(t.publicN, t.requestText, t.requestSig)).toBe(true);
    const sent = fake.calls.filter((c) => c.name === "recovery_v1_call").map((c) => c.args as { p_args: { request: string } });
    expect(sent[0].p_args.request).toBe(t.requestText);
    await requestEnrollment(origin(), ORG, SHOP);                               // no second identity, the same request again
    const again = (await currentTill(origin(), ORG, SHOP))!;
    expect(again.fingerprint).toBe(t.fingerprint);
    expect(fake.calls.filter((c) => c.name === "recovery_v1_call").map((c) => (c.args as { p_args: { request: string } }).p_args.request)).toEqual([t.requestText, t.requestText]);
  });

  it("an owner approval is verified by the TILL against its own anchor and request: forged, other-key, other-device, other-shop, other-nonce, expired and replacement mismatches are refused", async () => {
    const o = await ownerKey(); const evil = await ownerKey(); setOwnerTrustAnchorsForTests([o.fingerprint]);
    await requestEnrollment(origin(), ORG, SHOP);
    const t = (await currentTill(origin(), ORG, SHOP))!;
    const ok = await approvalFor(t, o);
    expect(await verifyApproval(t, ok, [o.fingerprint])).not.toBeNull();
    expect(await verifyApproval(t, { ...ok, authorization: ok.authorization.replace(SHOP, "shop-2") }, [o.fingerprint])).toBeNull();   // tampered text
    expect(await verifyApproval(t, await approvalFor(t, evil), [o.fingerprint])).toBeNull();                                          // key not anchored
    expect(await verifyApproval(t, await approvalFor(t, o), [evil.fingerprint])).toBeNull();                                          // anchor is someone else
    for (const over of [{ deviceId: "till-other" }, { shopId: "shop-2" }, { requestNonce: crypto.randomUUID() }, { keyFingerprint: "0".repeat(64) },
      { notAfter: new Date(Date.now() - 1000).toISOString() }, { replacesEnrollmentId: crypto.randomUUID() }, { requestId: crypto.randomUUID() }]) {
      expect(await verifyApproval(t, await approvalFor(t, o, over), [o.fingerprint])).toBeNull();
    }
    expect(await verifyApproval(t, await approvalFor(t, o, {}, { purpose: "reopen-organization" }), [o.fingerprint])).toBeNull();
    expect(await verifyApproval(t, await approvalFor(t, o, {}, { scope: "org-2" }), [o.fingerprint])).toBeNull();
  });

  it("server ACTIVE + verifying approval => trusted; an approval that does not verify on the till stays untrusted; revoked / suspended / expired are refused", async () => {
    const o = await ownerKey(); const evil = await ownerKey(); setOwnerTrustAnchorsForTests([o.fingerprint]);
    await requestEnrollment(origin(), ORG, SHOP);
    const t = (await currentTill(origin(), ORG, SHOP))!;
    statusReply = await approvalFor(t, evil);
    expect((await refreshTill(origin(), ORG, SHOP)).phase).toBe("unverified");
    await expect(trustedTill(origin(), ORG, SHOP, { online: false })).rejects.toThrow(/Independent device authorization unavailable/);
    await tillVault.tills.update(t.scope, { lastStatus: null });
    statusReply = await approvalFor(t, o);
    expect((await refreshTill(origin(), ORG, SHOP)).phase).toBe("trusted");
    expect((await trustedTill(origin(), ORG, SHOP, { online: false })).deviceId).toBe(t.deviceId);
    for (const [state, phase] of [["SUSPENDED", "suspended"], ["REVOKED", "revoked"], ["EXPIRED", "expired"], ["REPLACED", "replaced"]] as const) {
      statusReply = { state, enrollmentId: t.requestId };
      expect((await refreshTill(origin(), ORG, SHOP)).phase).toBe(phase);
      await expect(trustedTill(origin(), ORG, SHOP, { online: false })).rejects.toThrow();
    }
  });

  it("operation signatures verify for the exact (enrollment, org, shop, key, rpc, counter); a retry re-uses its counter; counters survive a restart and never go back", async () => {
    const t = await installSyntheticTrustedTill({ origin: origin() });
    const till = (await currentTill(origin(), ORG, SHOP))!;
    const k1 = crypto.randomUUID(), k2 = crypto.randomUUID();
    const h1 = JSON.parse(await signOperation(till, k1, "complete_sale"));
    const h1b = JSON.parse(await signOperation(till, k1, "complete_sale"));
    const h2 = JSON.parse(await signOperation(till, k2, "complete_sale"));
    expect(h1.counter).toBe(1); expect(h1b.counter).toBe(1); expect(h2.counter).toBe(2);
    expect(await rsaVerifyHex(t.publicN, requestMessage(t.enrollment.enrollmentId, ORG, SHOP, k1, "complete_sale", 1), h1.sig)).toBe(true);
    expect(await rsaVerifyHex(t.publicN, requestMessage(t.enrollment.enrollmentId, ORG, SHOP, k2, "complete_sale", 1), h2.sig)).toBe(false);
    // "restart": a fresh vault object over the same IndexedDB keeps the identity and the counter
    const Restarted = tillVault.constructor as new () => typeof tillVault;
    const reopened = new Restarted();
    const r = (await reopened.tills.get(till.scope))!;
    expect(r.fingerprint).toBe(till.fingerprint); expect(r.nextCounter).toBe(3); expect(r.signingKey.extractable).toBe(false);
    const req = JSON.parse(await signRequest(till, "recovery_v1_offline_capability:shop-1:" + till.deviceId));
    expect(req.counter).toBe(3); expect(typeof req.key).toBe("string");
    reopened.close();
  });

  it("an operation recorded OFFLINE is signed with its offline marker: the same signature never verifies as an online operation (review 2, H2)", async () => {
    const t = await installSyntheticTrustedTill({ origin: origin() });
    const till = (await currentTill(origin(), ORG, SHOP))!;
    const k = crypto.randomUUID(); const off = { capabilityId: crypto.randomUUID(), deviceSeq: 4 };
    const h = JSON.parse(await signOperation(till, k, "complete_sale", off));
    const e = t.enrollment.enrollmentId;
    expect(await rsaVerifyHex(t.publicN, requestMessage(e, ORG, SHOP, k, "complete_sale", h.counter, `${off.capabilityId}:4`), h.sig)).toBe(true);
    expect(await rsaVerifyHex(t.publicN, requestMessage(e, ORG, SHOP, k, "complete_sale", h.counter, "online"), h.sig)).toBe(false);
  });

  it("an ACTIVE V1 server: a sale is sent ONLY with this till's device signature, and that signature verifies for the sale's key", async () => {
    const t = await installSyntheticTrustedTill({ origin: origin() });
    await refreshRecoveryV1(ORG, { force: true });
    const get = saleStore();
    await get().createSale(sale());
    const sent = fake.callsFor("op_execute").filter((c) => c.args.p_rpc === "complete_sale");
    expect(sent).toHaveLength(1);
    const h = JSON.parse(sent[0].headers![DEVICE_HEADER]);
    expect(h.enrollmentId).toBe(t.enrollment.enrollmentId);
    expect(await rsaVerifyHex(t.publicN, requestMessage(t.enrollment.enrollmentId, ORG, SHOP, String(sent[0].args.p_key), "complete_sale", h.counter), h.sig)).toBe(true);
  });

  it("an ACTIVE V1 server and an UNTRUSTED till (pending enrollment): the sale is refused before anything is sent or saved", async () => {
    const o = await ownerKey(); setOwnerTrustAnchorsForTests([o.fingerprint]);
    await requestEnrollment(origin(), ORG, SHOP);
    await refreshRecoveryV1(ORG, { force: true });
    await expect(saleStore()().createSale(sale())).rejects.toThrow(/Independent device authorization unavailable/);
    expect(fake.callsFor("op_execute")).toHaveLength(0);
    expect(fake.server.sales).toHaveLength(0);
  });
});

function saleStore() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (value: any) => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
  const get = () => state;
  const slice = createSaleSlice(set as never, get as never, {} as never);
  state = { productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }], products: [{ id: "p1", isNonStock: false }],
    getProductPrice: () => 0, getInventoryQty: () => 10, shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: SHOP, productId: "p1", qtyBaseUnits: 10 }], ...slice };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return get;
}
const sale = () => ({ shopId: SHOP, cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 2000,
  cartItems: [{ id: "c1", productId: "p1", productUnitId: "u1", name: "Tea", unitName: "Can", qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "retail" }] });
