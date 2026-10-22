import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDb, type SyncOutboxEntry } from "../lib/localDb";
import { collectQueueExport } from "../lib/queueExport/collect";
import { canonical, digest, sign, syntheticSigningKey } from "./canonical";
import { deviceVault, enrollSyntheticDevice, enrolledDevice } from "./deviceVault";
import { verifyEvidence, verifyEvidencePrefix } from "./evidence";
import { captureTransmission, listDeviceEvidence } from "./journalCapture";
import { configureIndependentTrust, verifyEnrollment } from "./trust";
import { syntheticRecoveryFixture, SYNTHETIC_ORIGIN } from "./testing";
import { getJournalRecord, journalCommitted, journalQueued } from "../stores/data/opJournal";

const key = "019a06c0-0000-7000-8000-000000000001";
const row = (extra: Partial<SyncOutboxEntry> = {}): SyncOutboxEntry => ({
  localId: "test-sale-1", kind: "rpc", name: "complete_sale", args: { p_shop_id: "shop-1", p_idempotency_key: key, p_paid_mmk: 5000, p_items: [{ product_id: "p1", qty: 1 }] },
  idempotencyKey: key, orgId: "org-1", actorId: "user-1", shopId: "shop-1", backendOrigin: SYNTHETIC_ORIGIN,
  createdAt: new Date().toISOString(), status: "pending", attempts: 0, staged: true, ...extra,
});
const snapshot = () => localDb.syncState.toArray();
beforeEach(async () => {
  configureIndependentTrust(null);
  await Promise.all([localDb.syncState.clear(), localDb.syncOutbox.clear(), localDb.provisionalIdMap.clear(), deviceVault.identities.clear()]);
});
afterEach(() => configureIndependentTrust(null));

describe("device evidence cryptography and enrollment", () => {
  it("canonical serialization is deterministic and rejects silent JSON transformations", () => {
    expect(canonical({ b: 1, a: [null, 2.5, "က"] })).toBe(canonical({ a: [null, 2.5, "က"], b: 1 }));
    const sparse = new Array(2); sparse[1] = 1;
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), { a: undefined }, sparse]) expect(() => canonical(value)).toThrow();
  });
  it("generates a nonexportable private key retained by structured IndexedDB storage", async () => {
    const f = await syntheticRecoveryFixture();
    configureIndependentTrust(f.source);
    const stored = await enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1");
    expect(stored.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", stored.privateKey)).rejects.toThrow();
    expect(await verifyEnrollment(stored.enrollment, f.source, new Date().toISOString())).toBe(true);
  });
  it("refuses infrastructure presented keys, foreign enrollment and silent replacement", async () => {
    const f = await syntheticRecoveryFixture();
    expect(await verifyEnrollment(f.identity.enrollment, null, new Date().toISOString())).toBe(false);
    const altered = structuredClone(f.identity.enrollment);
    altered.body.orgId = "org-2";
    expect(await verifyEnrollment(altered, f.source, new Date().toISOString())).toBe(false);
    await expect(enrollSyntheticDevice({ origin: SYNTHETIC_ORIGIN, orgId: "org-1", shopId: "shop-1", deviceId: "attacker", source: f.source,
      authorize: async () => f.identity.enrollment })).rejects.toThrow(/already exists/);
  });
  it("does not generate any signing identity on first use or after loss", async () => {
    await journalQueued(row());
    expect(await deviceVault.identities.count()).toBe(0);
    expect(await listDeviceEvidence("org-1")).toEqual([]);
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await deviceVault.identities.clear(); // synthetic lost-device event only
    await expect(enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1")).rejects.toThrow(/will not be regenerated/);
    expect(await deviceVault.identities.count()).toBe(0);
    expect(await getJournalRecord(key)).not.toBeNull();
  });
  it("rejects expired/revoked authority for current authorization without deleting old evidence", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await journalQueued(row());
    const original = await listDeviceEvidence("org-1");
    f.keys[0].revokedAt = "2020-01-01T00:00:00.000Z";
    await expect(enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1")).rejects.toThrow(/revoked/);
    expect(await listDeviceEvidence("org-1")).toEqual(original);
  });
  it("requires fresh independently signed per-device lifecycle status; old enrollment never reinstates a lost key", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await journalQueued(row()); const original = await listDeviceEvidence("org-1");
    f.deviceStates.set(f.identity.enrollment.body.enrollmentId, "REVOKED");
    await expect(enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1")).rejects.toThrow(/revoked/);
    f.deviceStates.set(f.identity.enrollment.body.enrollmentId, "LOST");
    await expect(enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1")).rejects.toThrow(/lost/);
    configureIndependentTrust({ custody: f.source.custody, keys: f.source.keys });
    await expect(enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1")).rejects.toThrow(/current device authorization is unavailable/);
    expect(await listDeviceEvidence("org-1")).toEqual(original);
  });
  it("rejects delayed expired ACTIVE status and a valid status replayed under a fresh challenge", async () => {
    const f = await syntheticRecoveryFixture();
    let time = Date.parse("2026-10-21T12:00:00.000Z");
    const realStatus = f.source.deviceStatus!;
    configureIndependentTrust({ ...f.source, deviceStatus: async (request) => {
      const response = await realStatus(request); time += 121_000; return response;
    } });
    await expect(enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1", () => new Date(time).toISOString())).rejects.toThrow(/stale/);
    const replay = await realStatus({ enrollment: f.identity.enrollment, challenge: "old-challenge", now: new Date().toISOString() });
    configureIndependentTrust({ ...f.source, deviceStatus: async () => replay });
    await expect(enrolledDevice(SYNTHETIC_ORIGIN, "org-1", "shop-1")).rejects.toThrow(/unverified/);
  });
  it("detects payload, operation, sequence, authorization and signature substitution and tenant/device replay", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await journalQueued(row());
    const [original] = await listDeviceEvidence("org-1");
    expect(await verifyEvidence(original, f.source, f)).toBe(true);
    expect(await verifyEvidence(original, f.source, { orgId: "org-2", shopId: "shop-1" })).toBe(false);
    expect(await verifyEvidence(original, f.source, { orgId: "org-1", shopId: "shop-2" })).toBe(false);
    expect(await verifyEvidence(original, f.source, { orgId: "org-1", shopId: "shop-1", deviceId: "other-device" })).toBe(false);
    const changes = [
      (r: typeof original) => { r.payload = { tampered: true }; },
      (r: typeof original) => { r.envelope.body.operationId = "other-operation"; },
      (r: typeof original) => { r.envelope.body.sequence = 99; },
      (r: typeof original) => { r.envelope.body.authorization.actorId = "attacker"; },
      (r: typeof original) => { r.envelope.signature = btoa("x".repeat(64)); },
    ];
    for (const change of changes) {
      const forged = structuredClone(original); change(forged);
      forged.envelope.hash = await digest({ body: forged.envelope.body, signature: forged.envelope.signature });
      expect(await verifyEvidence(forged, f.source, f)).toBe(false);
    }
    const attacker = await syntheticSigningKey();
    const forged = structuredClone(original);
    forged.enrollment.body.publicKey = attacker.publicKey; forged.enrollment.body.keyId = attacker.keyId;
    forged.enrollment.signature = await sign(forged.enrollment.body, attacker.privateKey);
    expect(await verifyEvidence(forged, f.source, f)).toBe(false);
  });
});

describe("actual journal/write-ahead integration", () => {
  it("keeps signed queued and committed observations immutable while the journal advances", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    const operation = row();
    await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
      await localDb.syncOutbox.add(operation); await journalQueued(operation);
    });
    const [queued] = await listDeviceEvidence("org-1");
    await journalCommitted(operation, { source: "reply", response: { sale: { id: "sale-real", receipt_no: "S-1001" } }, recordedOnServer: true });
    const records = await listDeviceEvidence("org-1");
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(queued);
    expect(records[1].observation).toMatchObject({ state: "committed" });
    expect(await verifyEvidencePrefix(records, f.source, f)).toMatchObject({ valid: true, prefixVerified: true, complete: false, sequence: 2 });
    expect(await getJournalRecord(key)).toMatchObject({ state: "committed", deviceEvidenceHash: records[1].envelope.hash });
  });
  it("serializes concurrent journal writers in real Dexie transactions with one immutable sequence", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await Promise.all(Array.from({ length: 5 }, (_, n) => {
      const id = `019a06c0-0000-7000-8000-${String(n + 1).padStart(12, "0")}`;
      return journalQueued(row({ idempotencyKey: id, localId: `row-${n}`, args: { p_shop_id: "shop-1", p_idempotency_key: id, p_paid_mmk: n } }));
    }));
    const records = await listDeviceEvidence("org-1");
    expect(records.map((r) => r.envelope.body.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(await verifyEvidencePrefix(records, f.source, f)).toMatchObject({ valid: true, sequence: 5 });
  });
  it("rolls back the journal, outbox and signed evidence together after persistence failure", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await expect(localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
      const operation = row(); await localDb.syncOutbox.add(operation); await journalQueued(operation); throw new Error("synthetic disk failure");
    })).rejects.toThrow("synthetic disk failure");
    expect(await snapshot()).toEqual([]); expect(await localDb.syncOutbox.count()).toBe(0);
  });
  it("signs exact resolved transmission once per stable operation key; changed resend fails closed", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    const input = row();
    await captureTransmission({ ...input, key, rpc: input.name, args: input.args ?? null, orgId: "org-1", actorId: "user-1", backendOrigin: SYNTHETIC_ORIGIN });
    const first = await snapshot();
    await captureTransmission({ ...input, key, rpc: input.name, args: input.args ?? null, orgId: "org-1", actorId: "user-1", backendOrigin: SYNTHETIC_ORIGIN });
    expect(await snapshot()).toEqual(first);
    await expect(captureTransmission({ ...input, key, rpc: input.name, args: { ...input.args, p_paid_mmk: 8000 }, orgId: "org-1", actorId: "user-1", backendOrigin: SYNTHETIC_ORIGIN })).rejects.toThrow(/transmission changed/);
    expect(await snapshot()).toEqual(first);
  });
  it("preserves observed replies when signing identity is lost and never calls them signed", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await journalQueued(row()); const originals = await listDeviceEvidence("org-1");
    await deviceVault.identities.clear();
    await journalCommitted(row(), { source: "reply", response: { sale: { id: "only-surviving-reply" } } });
    expect(await getJournalRecord(key)).toMatchObject({ state: "committed", evidence: { response: { sale: { id: "only-surviving-reply" } } } });
    expect(await listDeviceEvidence("org-1")).toEqual(originals);
  });
  it("exports immutable signed evidence only to its owner, preserving public authorization context", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source); await journalQueued(row());
    const ctx = { appVersion: "synthetic", tillId: "till-test", backendHost: "127.0.0.1:54321", session: { userId: "owner", orgId: "org-1", shopId: "shop-1", role: "ADMIN" } };
    const exported = await collectQueueExport(localDb, ctx);
    expect(exported.deviceEvidence).toHaveLength(1);
    expect(await verifyEvidence(exported.deviceEvidence[0] as Awaited<ReturnType<typeof listDeviceEvidence>>[number], f.source, f)).toBe(true);
    expect((await collectQueueExport(localDb, { ...ctx, session: { ...ctx.session, role: "CASHIER" } })).deviceEvidence).toEqual([]);
    expect((await collectQueueExport(localDb, { ...ctx, session: { ...ctx.session, orgId: "org-2" } })).deviceEvidence).toEqual([]);
  });
});
