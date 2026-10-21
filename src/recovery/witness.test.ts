import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDb } from "../lib/localDb";
import { journalCommitted, journalQueued } from "../stores/data/opJournal";
import { deviceVault } from "./deviceVault";
import { listDeviceEvidence } from "./journalCapture";
import { configureIndependentTrust } from "./trust";
import { syntheticRecoveryFixture, SYNTHETIC_ORIGIN } from "./testing";
import { createCheckpoint, submitCheckpoint, verifyWitnessBoundary, verifyWitnessReceipt } from "./witness";
import { checkpointDeviceEvidence } from "./sync";

beforeEach(async () => { configureIndependentTrust(null); await Promise.all([localDb.syncState.clear(), deviceVault.identities.clear()]); });
afterEach(() => configureIndependentTrust(null));
const operation = { localId: "sale-1", kind: "rpc" as const, name: "complete_sale", args: { p_shop_id: "shop-1", p_idempotency_key: "019a06c0-0000-7000-8000-000000000001", p_paid_mmk: 100 },
  idempotencyKey: "019a06c0-0000-7000-8000-000000000001", orgId: "org-1", shopId: "shop-1", actorId: "user-1", backendOrigin: SYNTHETIC_ORIGIN,
  createdAt: new Date().toISOString(), status: "pending" as const, attempts: 0 };

async function fixture() {
  const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
  await journalQueued(operation);
  await journalCommitted(operation, { source: "reply", response: { sale: { id: "sale-real", total_mmk: 100 } } });
  const records = await listDeviceEvidence("org-1");
  const checkpoint = await createCheckpoint(records, f.source, f);
  return { ...f, records, checkpoint };
}

describe("independently verifiable checkpoint protocol (local witness is synthetic)", () => {
  it("binds actual committed observations and independently pinned witness receipt", async () => {
    const f = await fixture();
    const receipt = await submitCheckpoint(f.witness, f.checkpoint, f.source);
    expect(f.witness.implementation).toBe("LOCAL_TEST_DOUBLE_NOT_INDEPENDENT");
    expect(await verifyWitnessReceipt(receipt, f.source, f)).toBe(true);
    expect(await verifyWitnessReceipt(receipt, null, f)).toBe(false);
    expect(await verifyWitnessBoundary({ receipts: [receipt], source: f.source, expected: f, trustedBoundary: receipt, records: f.records }))
      .toMatchObject({ valid: true, latestEstablished: false });
  });
  it("does not checkpoint pending intents as committed operations", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source); await journalQueued(operation);
    await expect(createCheckpoint(await listDeviceEvidence("org-1"), f.source, f)).rejects.toThrow("CHECKPOINT_NO_OBSERVED_COMMITTED_EVIDENCE");
  });
  it("returns the same actual acknowledgement on concurrent exact retries and rejects forks/rollback", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.witness.append(f.checkpoint), f.witness.append(f.checkpoint)]);
    expect(a).toEqual(b);
    await expect(f.witness.append({ ...f.checkpoint, digest: "a".repeat(64) })).rejects.toThrow("WITNESS_FORK_OR_ROLLBACK");
    await expect(f.witness.append({ ...f.checkpoint, sequence: 1, previousReceiptHash: a.hash })).rejects.toThrow("WITNESS_FORK_OR_ROLLBACK");
  });
  it("detects recovered rollback below trusted boundary, modified replies and withheld checkpoint", async () => {
    const f = await fixture(); const receipt = await f.witness.append(f.checkpoint);
    const rollback = await verifyWitnessBoundary({ receipts: [receipt], source: f.source, expected: f, trustedBoundary: receipt, records: f.records.slice(0, 1) });
    expect(rollback.valid).toBe(false); expect(rollback.findings).toContain("ROLLBACK_BELOW_TRUSTED_BOUNDARY");
    const changed = structuredClone(f.records); changed[1].observation = { state: "committed", evidence: { response: { sale: { total_mmk: 999 } } } };
    expect((await verifyWitnessBoundary({ receipts: [receipt], source: f.source, expected: f, trustedBoundary: receipt, records: changed })).valid).toBe(false);
    expect((await verifyWitnessBoundary({ receipts: [], source: f.source, expected: f, trustedBoundary: receipt, records: f.records })).findings).toContain("TRUSTED_BOUNDARY_WITHHELD");
  });
  it("fails closed when required boundary/receipt unavailable or witness cannot sign", async () => {
    const f = await fixture();
    const receipt = await f.witness.append(f.checkpoint);
    expect((await verifyWitnessBoundary({ receipts: [receipt], source: f.source, expected: f, trustedBoundary: null, records: f.records })).valid).toBe(false);
    await expect(submitCheckpoint(null, f.checkpoint, f.source)).rejects.toThrow("CHECKPOINT_NOT_ACKNOWLEDGED");
    const tampered = structuredClone(receipt); tampered.body.checkpoint.orgId = "org-2";
    await expect(submitCheckpoint({ append: async () => tampered }, f.checkpoint, f.source)).rejects.toThrow("WITNESS_RECEIPT_UNVERIFIABLE");
  });
  it("verifies independent receipt rotation without trusting server key substitution", async () => {
    const f = await fixture(); const receipt = await f.witness.append(f.checkpoint);
    f.keys[1].revokedAt = "2020-01-01T00:00:00.000Z";
    expect(await verifyWitnessReceipt(receipt, f.source, f)).toBe(false);
  });
  it("integrates journal prefix, local witness and immutable durable receipt without deleting evidence", async () => {
    const f = await fixture();
    const receipt = await checkpointDeviceEvidence({ orgId: "org-1", shopId: "shop-1", streamId: f.checkpoint.streamId, previous: null, client: f.witness });
    expect(await verifyWitnessReceipt(receipt, f.source, f)).toBe(true);
    const again = await checkpointDeviceEvidence({ orgId: "org-1", shopId: "shop-1", streamId: f.checkpoint.streamId, previous: null, client: f.witness });
    expect(again).toEqual(receipt);
    expect(await localDb.syncState.where("key").startsWith("rv1:witness:").count()).toBe(1);
    expect(await listDeviceEvidence("org-1")).toEqual(f.records);
  });
});
