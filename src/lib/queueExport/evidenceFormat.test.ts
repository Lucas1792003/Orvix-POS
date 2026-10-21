// Recovery V1 export contract (correction pass P3): signed device evidence and
// witness receipts travel in format 4. They are never silently dropped: a reader
// that does not know format 4 refuses the file, and a file that carries evidence
// under an older label is refused by this reader.
import { describe, expect, it } from "vitest";
import {
  MIN_KDF_ITERATIONS, QUEUE_EXPORT_FORMAT_VERSION_EVIDENCE, QueueExportError, decryptQueueExport, encryptQueueExport, parseEnvelope,
  requiredFormatVersion, validatePayload, type QueueExportPayload,
} from "./format";
import * as shippedReader from "./__fixtures__/format.4971b55";
import * as rc1Reader from "../../../audit/rc1/fixtures/format.3c00aeb";

const PASS = "correct horse battery staple";
const FAST = { iterations: MIN_KDF_ITERATIONS };

// Synthetic, structurally faithful records (opaque to the export format).
const evidence = {
  envelope: { body: { protocol: "orvix-device-evidence-v1", orgId: "org-1", shopId: "shop-1", deviceId: "dev-1", keyId: "a".repeat(64), operationId: "11111111-1111-4111-8111-111111111111",
    rpc: "complete_sale", evidenceKind: "transmission", payloadHash: "b".repeat(64), observationHash: "c".repeat(64), sequence: 1, previousHash: null,
    createdAt: "2026-10-21T01:00:00.000Z", authorization: { actorId: "user-1", opEpoch: null, backendOrigin: "https://pos.example.test", enrollmentId: "enr-1" } },
    signature: "AAAA".repeat(22).slice(0, 86) + "==", hash: "d".repeat(64) },
  enrollment: { body: { protocol: "orvix-device-enrollment-v1" }, signature: "sig" },
  payload: { p_shop_id: "shop-1", p_idempotency_key: "11111111-1111-4111-8111-111111111111" },
  observation: { state: "sent" }, redacted: false,
};
const receipt = { body: { protocol: "orvix-witness-receipt-v1", witnessId: "local-test-only", keyId: "e".repeat(64),
  checkpoint: { protocol: "orvix-checkpoint-v1", orgId: "org-1", shopId: "shop-1", streamId: "dev-1:x", sequence: 1, digest: "f".repeat(64), previousReceiptHash: null },
  receivedAt: "2026-10-21T01:00:01.000Z" }, signature: "sig", hash: "1".repeat(64) };

const base = (over: Partial<QueueExportPayload> = {}): QueueExportPayload => ({
  format: "shwephala-queue-export", formatVersion: 2, appVersion: "1.0.17-rv1", exportedAt: "2026-10-21T02:00:00.000Z",
  tillId: "till-abc123", backendHost: "pos.example.test",
  session: { userId: "user-1", orgId: "org-1", shopId: "shop-1", role: "ADMIN" },
  entries: [], provisionalIdMap: [], redactedFields: 0, reconciliationLog: [], onlineOperations: [], unreadableOnlineRecords: [],
  journal: [], vanished: [], ...over,
});

describe("format 4: signed device evidence and witness receipts", () => {
  it("round-trips byte-identically and is labelled format 4 in the authenticated envelope", async () => {
    const p = base({ formatVersion: 4, deviceEvidence: [evidence], witnessReceipts: [receipt] });
    const env = await encryptQueueExport(p, PASS, FAST);
    expect(env.formatVersion).toBe(QUEUE_EXPORT_FORMAT_VERSION_EVIDENCE);
    const back = await decryptQueueExport(JSON.stringify(env), PASS);
    expect(back).toEqual(p);
    expect(JSON.stringify(back.deviceEvidence)).toBe(JSON.stringify([evidence]));   // original signed record, unchanged
    expect(JSON.stringify(back.witnessReceipts)).toBe(JSON.stringify([receipt]));
  });
  it("evidence under an older label is refused, never dropped", () => {
    for (const v of [1, 2, 3] as const) {
      expect(() => validatePayload(base({ formatVersion: v, deviceEvidence: [evidence], witnessReceipts: [] }))).toThrow(/require format 4/);
      expect(() => validatePayload(base({ formatVersion: v, witnessReceipts: [receipt] }))).toThrow(/require format 4/);
    }
  });
  it("encryption upgrades the envelope label to 4 even if the payload under-labels it (validation refuses first)", async () => {
    await expect(encryptQueueExport(base({ formatVersion: 2, deviceEvidence: [evidence] }), PASS, FAST)).rejects.toThrow(/require format 4/);
  });
  it("a format-4 file must carry both arrays explicitly", () => {
    expect(() => validatePayload(base({ formatVersion: 4, deviceEvidence: [evidence] }))).toThrow(/explicitly/);
    expect(() => validatePayload(base({ formatVersion: 4 }))).toThrow(/explicitly/);
    expect(validatePayload(base({ formatVersion: 4, deviceEvidence: [], witnessReceipts: [] })).formatVersion).toBe(4);
  });
  it("an envelope labelled below what its contents need is refused on decrypt", async () => {
    const env = await encryptQueueExport(base({ formatVersion: 4, deviceEvidence: [evidence], witnessReceipts: [] }), PASS, FAST);
    // The label is AES-GCM additional data: relabelling breaks authentication, so the file is refused either way.
    await expect(decryptQueueExport(JSON.stringify({ ...env, formatVersion: 3 }), PASS)).rejects.toBeInstanceOf(QueueExportError);
  });
  it("requiredFormatVersion: evidence > unreadable records > anything else", () => {
    expect(requiredFormatVersion({})).toBe(1);
    expect(requiredFormatVersion({ unreadableOnlineRecords: [{}] })).toBe(3);
    expect(requiredFormatVersion({ unreadableOnlineRecords: [{}], witnessReceipts: [receipt] })).toBe(4);
  });
});

describe("older readers refuse a format-4 file instead of silently dropping its evidence", () => {
  it("the format-3 reader shipped at 4971b55", async () => {
    const env = await encryptQueueExport(base({ formatVersion: 4, deviceEvidence: [evidence], witnessReceipts: [receipt] }), PASS, FAST);
    let code: string | null = null;
    try { shippedReader.parseEnvelope(JSON.stringify(env)); } catch (e) { code = (e as { code?: string }).code ?? "thrown"; }
    expect(code).toBe("unsupported-version");
  });
  it("the frozen RC1 (format-1) reader", async () => {
    const env = await encryptQueueExport(base({ formatVersion: 4, deviceEvidence: [evidence], witnessReceipts: [] }), PASS, FAST);
    expect(() => rc1Reader.parseEnvelope(JSON.stringify(env))).toThrow();
  });
});

describe("existing legacy files still read (no evidence fields invented)", () => {
  for (const v of [1, 2] as const) {
    it(`format ${v}`, async () => {
      const p = base({ formatVersion: v });
      const back = await decryptQueueExport(JSON.stringify(await encryptQueueExport(p, PASS, FAST)), PASS);
      expect(back).toEqual(p);
      expect("deviceEvidence" in back).toBe(false);
      expect(parseEnvelope(JSON.stringify(await encryptQueueExport(p, PASS, FAST))).formatVersion).toBe(2); // as before V1
    });
  }
  it("format 3 (unreadable records) is unchanged", async () => {
    const p = base({ formatVersion: 3, unreadableOnlineRecords: [{ key: "online-op:x", raw: "{", reason: "unparseable",
      claimed: { name: null, scope: null, orgId: "org-1", userId: null, backendOrigin: null, version: null } }] });
    const env = await encryptQueueExport(p, PASS, FAST);
    expect(env.formatVersion).toBe(3);
    expect(await decryptQueueExport(JSON.stringify(env), PASS)).toEqual(p);
  });
});
