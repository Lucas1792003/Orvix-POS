// Correction pass, review round 2: canonical (low-S) signatures, visible signing gaps,
// damaged evidence never silently dropped from an owner export.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { localDb } from "../lib/localDb";
import { collectQueueExportSnapshot } from "../lib/queueExport/collect";
import { bytes, canonical, fromBase64, isLowS, sign, syntheticSigningKey, toBase64, verify } from "./canonical";
import { deviceVault } from "./deviceVault";
import { captureJournal, DEVICE_EVIDENCE_PREFIX, WITNESS_RECEIPT_PREFIX } from "./journalCapture";
import { configureIndependentTrust } from "./trust";
import { syntheticRecoveryFixture } from "./testing";
import type { JournalRecord } from "../stores/data/opJournal";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const big = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const bytes32 = (v: bigint) => { const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };

beforeEach(async () => {
  await Promise.all(localDb.tables.map((t) => t.clear())); await deviceVault.identities.clear(); configureIndependentTrust(null);
});

describe("ECDSA signatures are canonical (low-S): no third party can re-encode one into a 'fork'", () => {
  it("every produced signature is low-S and verifies; its high-S twin is refused", async () => {
    const k = await syntheticSigningKey();
    for (let i = 0; i < 40; i++) {
      const body = { n: i, protocol: "orvix-test" };
      const sig = await sign(body, k.privateKey);
      const raw = fromBase64(sig);
      expect(isLowS(raw)).toBe(true);
      expect(await verify(body, sig, k.publicKey)).toBe(true);
      const twin = new Uint8Array(64); twin.set(raw.subarray(0, 32), 0); twin.set(bytes32(N - big(raw.subarray(32))), 32);
      // WebCrypto itself accepts the twin; this protocol must not.
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" },
        await crypto.subtle.importKey("spki", fromBase64(k.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
        twin, bytes(canonical(body)))).toBe(true);
      expect(await verify(body, toBase64(twin.buffer), k.publicKey)).toBe(false);
      // non-canonical base64: flip the unused low bits of the last data character (same bytes, new string)
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const lastIdx = sig.length - 3;                                   // "...X==": X carries 4 unused bits
      const alt = sig.slice(0, lastIdx) + alphabet[alphabet.indexOf(sig[lastIdx]) ^ 1] + sig.slice(lastIdx + 1);
      expect(Array.from(fromBase64(alt))).toEqual(Array.from(raw));    // decodes to the very same signature bytes
      expect(await verify(body, alt, k.publicKey)).toBe(false);         // but only the canonical encoding verifies
    }
  });
});

const journalRecord = (over: Partial<JournalRecord> = {}): JournalRecord => ({
  key: "11111111-1111-4111-8111-111111111111", rpc: "complete_sale", source: "outbox", state: "sent", orgId: "org-1", shopId: "shop-1",
  actorId: "user-1", backendOrigin: "http://127.0.0.1:54321", createdAt: "2026-10-21T00:00:00.000Z", sends: 1, events: [], args: { p_shop_id: "shop-1" },
  ...over,
}) as unknown as JournalRecord;

describe("a signature that should exist but could not be produced is a VISIBLE gap", () => {
  it("trust configured, device authorization unavailable for this backend: the record is marked, not silently unsigned", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    const r = journalRecord({ backendOrigin: "http://127.0.0.1:59999" } as Partial<JournalRecord>);   // no enrolled identity for this origin
    await captureJournal(r);
    expect(r.deviceEvidenceHash).toBeUndefined();
    expect(r.deviceEvidenceGap).toBe("device-authorization-unavailable");
  });
  it("trust configured and the device enrolled: signed, no gap", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    const r = journalRecord();
    await captureJournal(r);
    expect(r.deviceEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.deviceEvidenceGap).toBeUndefined();
  });
  it("no trust source (legacy/production today): no signature expected, so no gap marker", async () => {
    const r = journalRecord();
    await captureJournal(r);
    expect(r.deviceEvidenceHash).toBeUndefined();
    expect(r.deviceEvidenceGap).toBeUndefined();
  });
});

describe("owner export never silently drops damaged evidence, and never leaks another organization's", () => {
  it("own malformed -> redacted contents; unparseable or crafted -> size and fingerprint only; another org's -> omitted", async () => {
    await localDb.syncState.bulkPut([
      { key: `${DEVICE_EVIDENCE_PREFIX}own-malformed`, value: JSON.stringify({ envelope: { note: "no body" }, orgId: "org-1", password: "hunter2" }), updatedAt: "x" },
      { key: `${DEVICE_EVIDENCE_PREFIX}garbage`, value: "{not json", updatedAt: "x" },
      { key: `${DEVICE_EVIDENCE_PREFIX}other-org`, value: JSON.stringify({ envelope: { body: { orgId: "org-2" } } }), updatedAt: "x" },
      // crafted: escaped key so a text match would see only "org-1"; the parsed orgId is org-2's
      { key: `${DEVICE_EVIDENCE_PREFIX}crafted`, value: '{"org\\u0049d":"org-2","note":"org-1","secret":"s3cret-of-org-2"}', updatedAt: "x" },
      { key: `${WITNESS_RECEIPT_PREFIX}garbage`, value: "]]", updatedAt: "x" },
    ]);
    const { payload } = await collectQueueExportSnapshot(localDb, {
      appVersion: "1.0.17-rv1", tillId: "till-1", backendHost: "pos.example.test",
      session: { userId: "user-1", orgId: "org-1", shopId: null, role: "ADMIN" },
    });
    expect(payload.formatVersion).toBe(4);
    const ev = payload.deviceEvidence as Record<string, unknown>[];
    const byKey = (k: string) => ev.find((e) => e.key === `${DEVICE_EVIDENCE_PREFIX}${k}`)!;
    expect(ev).toHaveLength(3);                                          // own-malformed, garbage, crafted (other-org omitted)
    expect(byKey("own-malformed")).toMatchObject({ unreadable: true, reason: "malformed", redacted: true });
    expect(JSON.stringify(byKey("own-malformed"))).not.toContain("hunter2");
    expect(byKey("garbage")).toMatchObject({ unreadable: true, reason: "unparseable", scope: "unknown-organization", rawLength: 9 });
    expect(byKey("garbage").raw).toBeUndefined();
    expect(byKey("crafted")).toMatchObject({ unreadable: true, scope: "unknown-organization" });
    const text = JSON.stringify(payload);
    expect(text).not.toContain("s3cret-of-org-2");
    expect(text).not.toContain("org-2");
    expect((payload.witnessReceipts as Record<string, unknown>[])[0]).toMatchObject({ unreadable: true, scope: "unknown-organization" });
  });
  it("conflicting organization fields: only exported when EVERY field is the exporting organization", async () => {
    await localDb.syncState.bulkPut([
      { key: `${DEVICE_EVIDENCE_PREFIX}conflict`, value: JSON.stringify({ orgId: "org-1", envelope: { body: { orgId: "org-2" } }, secret: "s3cret-conflict" }), updatedAt: "x" },
      { key: `${DEVICE_EVIDENCE_PREFIX}nullnested`, value: JSON.stringify({ orgId: "org-1", envelope: { body: { orgId: null } }, secret: "s3cret-null" }), updatedAt: "x" },
    ]);
    const { payload } = await collectQueueExportSnapshot(localDb, {
      appVersion: "1.0.17-rv1", tillId: "till-1", backendHost: "pos.example.test",
      session: { userId: "user-1", orgId: "org-1", shopId: null, role: "ADMIN" },
    });
    const text = JSON.stringify(payload);
    expect(text).not.toContain("s3cret-conflict");
    expect(text).not.toContain("s3cret-null");
    expect((payload.deviceEvidence as Record<string, unknown>[]).every((e) => e.scope === "unknown-organization")).toBe(true);
  });
  it("damaged JOURNAL rows without a usable organization are exported as markers, never dropped", async () => {
    const { JOURNAL_PREFIX } = await import("../stores/data/opJournal");
    await localDb.syncState.bulkPut([
      { key: `${JOURNAL_PREFIX}no-org`, value: JSON.stringify({ rpc: "complete_sale" }), updatedAt: "x" },
      { key: `${JOURNAL_PREFIX}numeric-org`, value: JSON.stringify({ orgId: 5, rpc: "complete_sale" }), updatedAt: "x" },
      { key: `${JOURNAL_PREFIX}garbage`, value: "{{", updatedAt: "x" },
      { key: `${JOURNAL_PREFIX}other-org`, value: JSON.stringify({ orgId: "org-2", rpc: "x", secret: "s3cret-journal-org2" }), updatedAt: "x" },
    ]);
    const { payload } = await collectQueueExportSnapshot(localDb, {
      appVersion: "1.0.17-rv1", tillId: "till-1", backendHost: "pos.example.test",
      session: { userId: "user-1", orgId: "org-1", shopId: null, role: "ADMIN" },
    });
    const keys = payload.journal.map((j) => (j as { key: string }).key);
    for (const k of ["no-org", "numeric-org", "garbage"]) expect(keys).toContain(`${JOURNAL_PREFIX}${k}`);
    for (const j of payload.journal.filter((x) => ["no-org", "numeric-org", "garbage"].some((k) => (x as { key: string }).key.endsWith(k)))) {
      expect(j).toMatchObject({ state: "unreadable", orgId: null });
      expect(typeof (j as { rawFingerprint?: unknown }).rawFingerprint).toBe("string");
    }
    expect(JSON.stringify(payload)).not.toContain("s3cret-journal-org2");
  });
  it("a staff (non-owner) export carries no evidence at all", async () => {
    await localDb.syncState.put({ key: `${DEVICE_EVIDENCE_PREFIX}x`, value: "{not json", updatedAt: "x" });
    const { payload } = await collectQueueExportSnapshot(localDb, {
      appVersion: "1.0.17-rv1", tillId: "till-1", backendHost: "pos.example.test",
      session: { userId: "user-2", orgId: "org-1", shopId: "shop-1", role: "CASHIER" },
    });
    expect(payload.deviceEvidence ?? []).toEqual([]);
    expect(payload.formatVersion).not.toBe(4);
  });
});
