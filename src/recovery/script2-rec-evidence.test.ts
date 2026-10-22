// Script 2 / RECOVERY tester: evidence, witness, assessment and restore-outcome verification under loss, gaps, invalid
// signatures, forks, replays and incorrect checkpoints. Synthetic in-memory keys only; no network, no DB, no IndexedDB.
// npx vitest run src/recovery/script2-rec-evidence.test.ts   (REC_EVIDENCE_DIR=... writes rec-evidence-results.json)
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digest, sign, syntheticSigningKey } from "./canonical";
import { signEvidence, verifyEvidence, verifyEvidencePrefix, type EvidenceBody, type EvidenceRecord } from "./evidence";
import { createCheckpoint, LocalTestWitness, MemoryTestWitnessStore, verifyWitnessBoundary, verifyWitnessReceipt, type Checkpoint } from "./witness";
import { assessRecovery } from "./assessment";
import type { DeviceIdentity } from "./deviceVault";
import type { Enrollment, IndependentTrustSource } from "./trust";
import { publicKeyId, sealBackup, type BackupMetadata } from "../../tools/recovery-v1/backup-archive.mjs";
import { verifyRecovery, type RecoveryVerificationInput } from "../../tools/recovery-v1/verify-recovery";

const results: { id: string; scenario: string; expected: string; actual: string; status: string }[] = [];
const rec = (id: string, scenario: string, expected: string, actual: string, status: "PASS" | "FAIL" | "LIMITATION" | "BLOCKED") => results.push({ id, scenario, expected, actual, status });
afterAll(() => { const d = process.env.REC_EVIDENCE_DIR; if (d) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "rec-evidence-results.json"), JSON.stringify(results, null, 1) + "\n"); } });

const scope = { orgId: "org-rec", shopId: "shop-rec" };
const at = "2026-10-21T10:00:00.000Z";
const window = { notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", revokedAt: null };

async function world() {
  const owner = await syntheticSigningKey(), device = await syntheticSigningKey(), witnessKey = await syntheticSigningKey(), rogue = await syntheticSigningKey();
  const source: IndependentTrustSource = { custody: "synthetic-test-only", keys: async () => [
    { keyId: owner.keyId, publicKey: owner.publicKey, purpose: "device-enrollment", orgId: scope.orgId, ...window },
    { keyId: witnessKey.keyId, publicKey: witnessKey.publicKey, purpose: "witness", orgId: scope.orgId, ...window }] };
  const eb: Enrollment["body"] = { protocol: "orvix-device-enrollment-v1", enrollmentId: "rec-enrollment", ...scope, deviceId: "rec-device", keyId: device.keyId,
    publicKey: device.publicKey, authorityKeyId: owner.keyId, ...window, replacesEnrollmentId: null };
  const enrollment: Enrollment = { body: eb, signature: await sign(eb, owner.privateKey) };
  const identity: DeviceIdentity = { scope: "synthetic-test-only", privateKey: device.privateKey, publicKey: device.publicKey, enrollment, createdAt: at } as DeviceIdentity;
  const records: EvidenceRecord[] = [];
  const add = async (key: string, state: "committed" | "in-doubt", response: unknown = { sale: { id: `sale-${key.slice(0, 4)}` } }) => {
    const payload = { p_shop_id: scope.shopId, p_idempotency_key: key, p_paid_mmk: 1000 };
    const observation = { key, rpc: "complete_sale", ...scope, createdAt: at, args: payload, state, evidence: state === "committed" ? { response } : { source: "client" } };
    const body: EvidenceBody = { protocol: "orvix-device-evidence-v1", ...scope, deviceId: eb.deviceId, keyId: device.keyId, operationId: key, rpc: "complete_sale",
      evidenceKind: "journal-observation", payloadHash: await digest(payload), observationHash: await digest(observation), sequence: records.length + 1,
      previousHash: records.at(-1)?.envelope.hash ?? null, createdAt: at,
      authorization: { actorId: "u-cash", opEpoch: null, backendOrigin: "https://synthetic.invalid", enrollmentId: eb.enrollmentId } };
    records.push({ envelope: await signEvidence(identity, body), enrollment, payload, observation });
  };
  await add("11111111-1111-4111-8111-111111111111", "committed");
  await add("22222222-2222-4222-8222-222222222222", "committed");
  await add("33333333-3333-4333-8333-333333333333", "committed");
  const store = new MemoryTestWitnessStore();
  const witness = new LocalTestWitness({ witnessId: "rec-witness", keyId: witnessKey.keyId, privateKey: witnessKey.privateKey, store, now: () => at });
  return { owner, device, witnessKey, rogue, source, enrollment, identity, records, witness, store };
}

describe("Script 2 recovery evidence adversarial tests", () => {
  it("r80 missing transaction journal (no device evidence at all)", async () => {
    const w = await world();
    const p = await verifyEvidencePrefix([], w.source, scope);
    const a = assessRecovery({ ...scope, backup: { authenticity: "verified", integrity: "verified", coverage: "verified" }, evidence: p, witness: { valid: true, latestEstablished: false, findings: [] } });
    rec("r80", "journal missing (no device evidence)", "invalid, NO_DEVICE_EVIDENCE, QUARANTINED", `${p.valid} ${p.findings} -> ${a.state}`, !p.valid && p.findings.includes("NO_DEVICE_EVIDENCE") && a.state === "QUARANTINED" ? "PASS" : "FAIL");
    expect(a.state).toBe("QUARANTINED");
  });
  it("r81 evidence chain gap (record 2 lost)", async () => {
    const w = await world();
    const p = await verifyEvidencePrefix([w.records[0], w.records[2]], w.source, scope);
    rec("r81", "middle evidence record lost", "INVALID_EVIDENCE_AT_2", p.findings.join(","), p.findings.includes("INVALID_EVIDENCE_AT_2") ? "PASS" : "FAIL");
    expect(p.valid).toBe(false);
  });
  it("r82 evidence tail lost: undetectable alone, detected against a trusted boundary", async () => {
    const w = await world();
    const cp = await createCheckpoint(w.records, w.source, scope); const receipt = await w.witness.append(cp);
    const alone = await verifyEvidencePrefix(w.records.slice(0, 2), w.source, scope);
    const vs = await verifyWitnessBoundary({ receipts: [receipt], source: w.source, expected: scope, trustedBoundary: receipt, records: w.records.slice(0, 2) });
    rec("r82", "last evidence record lost", "prefix alone cannot tell; trusted boundary -> ROLLBACK_BELOW_TRUSTED_BOUNDARY",
      `prefix.valid=${alone.valid} boundary.findings=${vs.findings.filter((f) => !f.startsWith("AUTHENTIC"))}`, alone.valid && vs.findings.includes("ROLLBACK_BELOW_TRUSTED_BOUNDARY") ? "PASS" : "FAIL");
    expect(vs.valid).toBe(false);
  });
  it("r83 invalid device signatures (tampered, and signed by an unenrolled key)", async () => {
    const w = await world();
    const t = structuredClone(w.records); const s = t[1].envelope.signature; t[1].envelope.signature = (s[0] === "A" ? "B" : "A") + s.slice(1);
    const u = structuredClone(w.records); u[1].envelope.signature = await sign(u[1].envelope.body, w.rogue.privateKey);
    u[1].envelope.hash = await digest({ body: u[1].envelope.body, signature: u[1].envelope.signature });
    const a = await verifyEvidence(t[1], w.source, scope), b = await verifyEvidence(u[1], w.source, scope);
    rec("r83", "tampered signature; signature by a key that is not the enrolled device key", "both rejected", `tampered=${a} rogue=${b}`, !a && !b ? "PASS" : "FAIL");
    expect(a || b).toBe(false);
  });
  it("r84 forked witness chain (equivocating witness signs two digests for one sequence)", async () => {
    const w = await world();
    const cp = await createCheckpoint(w.records, w.source, scope);
    const r1 = await w.witness.append(cp);
    const twin = new LocalTestWitness({ witnessId: "rec-witness", keyId: w.witnessKey.keyId, privateKey: w.witnessKey.privateKey, store: new MemoryTestWitnessStore(), now: () => at });
    const r2 = await twin.append({ ...cp, digest: "a".repeat(64) });
    const v = await verifyWitnessBoundary({ receipts: [r1, r2], source: w.source, expected: scope, trustedBoundary: r1, records: w.records });
    rec("r84", "two validly signed receipts for the same stream/sequence with different digests", "WITNESS_FORK", v.findings.filter((f) => !f.startsWith("AUTHENTIC")).join(","), v.findings.includes("WITNESS_FORK") ? "PASS" : "FAIL");
    expect(v.findings).toContain("WITNESS_FORK");
  });
  it("r85 replayed witness receipts (duplicate, cross-organization, stale presented as boundary)", async () => {
    const w = await world();
    const cp2 = await createCheckpoint(w.records.slice(0, 2), w.source, scope); const r2 = await w.witness.append(cp2);
    const cp3 = { ...(await createCheckpoint(w.records, w.source, scope)), previousReceiptHash: r2.hash }; const r3 = await w.witness.append(cp3);
    const dup = await verifyWitnessBoundary({ receipts: [r2, r3, r3], source: w.source, expected: scope, trustedBoundary: r3, records: w.records });
    const cross = await verifyWitnessReceipt(r3, w.source, { orgId: "org-other", shopId: scope.shopId });
    const stale = await verifyWitnessBoundary({ receipts: [r2], source: w.source, expected: scope, trustedBoundary: r2, records: w.records.slice(0, 2) });
    rec("r85", "receipt replayed twice in the chain; replayed into another org", "chain finding; cross-org rejected",
      `dup=${dup.findings.filter((f) => !f.startsWith("AUTHENTIC"))} cross_org_valid=${cross}`, !dup.valid && !cross ? "PASS" : "FAIL");
    rec("r85b", "older authentic receipt replayed as the boundary while a newer one exists (newer withheld, evidence truncated to match)", "latest never established",
      `valid=${stale.valid} latestEstablished=${stale.latestEstablished}`, stale.valid && !stale.latestEstablished ? "LIMITATION" : "FAIL");
    expect(dup.valid).toBe(false); expect(cross).toBe(false); expect(stale.latestEstablished).toBe(false);
  });
  it("r86 incorrect recovery checkpoint (digest that matches no recovered prefix) is witnessed but detected", async () => {
    const w = await world();
    const bad: Checkpoint = { protocol: "orvix-checkpoint-v1", ...scope, streamId: `${w.records[0].envelope.body.deviceId}:${w.records[0].envelope.body.keyId}`, sequence: 3, digest: "b".repeat(64), previousReceiptHash: null };
    const r = await w.witness.append(bad);
    const v = await verifyWitnessBoundary({ receipts: [r], source: w.source, expected: scope, trustedBoundary: r, records: w.records });
    rec("r86", "witness accepts any checkpoint content; verifier compares with recovered evidence", "WITNESS_DIGEST_OR_RECOVERED_PREFIX_MISMATCH",
      `witness_signed=${await verifyWitnessReceipt(r, w.source, scope)} findings=${v.findings.filter((f) => !f.startsWith("AUTHENTIC"))}`,
      v.findings.includes("WITNESS_DIGEST_OR_RECOVERED_PREFIX_MISMATCH") ? "PASS" : "FAIL");
    expect(v.valid).toBe(false);
  });
  it("r87 the local witness is a test double; nothing establishes independent trust or reopens", async () => {
    const w = await world();
    const cp = await createCheckpoint(w.records, w.source, scope); const r = await w.witness.append(cp);
    const v = await verifyWitnessBoundary({ receipts: [r], source: w.source, expected: scope, trustedBoundary: r, records: w.records });
    const p = await verifyEvidencePrefix(w.records, w.source, scope);
    const a = assessRecovery({ ...scope, backup: { authenticity: "verified", integrity: "verified", coverage: "verified" }, evidence: { ...p, complete: true }, witness: v });
    rec("r87", "all-green synthetic inputs with the LOCAL witness double", "implementation LOCAL_TEST_DOUBLE_NOT_INDEPENDENT; latestEstablished false; RESTRICTED; reopenAuthorized false",
      `impl=${w.witness.implementation} latest=${v.latestEstablished} state=${a.state} reopen=${a.reopenAuthorized} findings=${a.findings.filter((f) => /LATEST|OWNER/.test(f))}`,
      w.witness.implementation === "LOCAL_TEST_DOUBLE_NOT_INDEPENDENT" && !v.latestEstablished && a.state === "RESTRICTED" && a.reopenAuthorized === false ? "PASS" : "FAIL");
    rec("r87b", "independent witness / owner custody", "an independently operated witness and owner key custody", "none exists (infrastructure-blocked); every trust key in this run is synthetic in-memory", "BLOCKED");
    expect(a.reopenAuthorized).toBe(false); expect(a.state).toBe("RESTRICTED");
  });
  it("r88 raw verifiers do not distinguish synthetic custody from independent custody", async () => {
    const w = await world();
    const ok = await verifyEvidence(w.records[0], w.source, scope);
    rec("r88", "trust source labelled custody=synthetic-test-only fed to verifyEvidence / verifyWitnessReceipt", "custody label enforced or reported",
      `verifyEvidence=${ok} (custody never read by evidence/witness/trust; only verifyRecovery adds SYNTHETIC_TRUST_KEYS_ESTABLISH_NO_INDEPENDENT_PRODUCTION_CUSTODY)`, ok ? "LIMITATION" : "PASS");
    expect(ok).toBe(true);
  });
  it("r89 duplicate execution after restore is detected from signed device observations, never repaired", async () => {
    const w = await world();
    const cp = await createCheckpoint(w.records, w.source, scope); const receipt = await w.witness.append(cp);
    const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 }), provenance = generateKeyPairSync("ed25519");
    const outcome = async (r: EvidenceRecord, response?: unknown) => {
      const o = r.observation as { key: string; createdAt: string; evidence: { response: unknown } };
      return { operationId: o.key, rpc: "complete_sale", payloadHash: r.envelope.body.payloadHash, responseHash: await digest(response ?? o.evidence.response), originalCreatedAt: o.createdAt };
    };
    const metadata: BackupMetadata = { archiveId: "rec-restore", ...scope, schemaVersion: "086", format: "synthetic-test-fixture", recoveredAsOf: at,
      evidenceBoundary: { streamId: cp.streamId, sequence: cp.sequence, digest: cp.digest }, provenanceCustody: "local-test", decryptionCustody: "local-test" };
    const run = async (outcomes: unknown[]) => {
      const files = { "recovery/device-evidence.json": Buffer.from(JSON.stringify(w.records)),
        "recovery/committed-outcomes.json": Buffer.from(JSON.stringify({ protocol: "orvix-restored-operation-outcomes-v1", ...scope, outcomes })) };
      const envelope = sealBackup({ metadata, files, recipientPublicKey: recipient.publicKey, provenancePrivateKey: provenance.privateKey });
      const input: RecoveryVerificationInput = { backup: { envelope, recipientPrivateKey: recipient.privateKey, trustedProvenanceKeys: new Map([[publicKeyId(provenance.publicKey), provenance.publicKey]]),
        expectedOrgId: scope.orgId, expectedShopId: scope.shopId, now: new Date(at) }, source: w.source, receipts: [receipt], trustedBoundary: receipt };
      return verifyRecovery(input);
    };
    const all = await run([await outcome(w.records[0]), await outcome(w.records[1]), await outcome(w.records[2])]);
    const lost = await run([await outcome(w.records[0]), await outcome(w.records[1])]);
    const reexec = await run([await outcome(w.records[0]), await outcome(w.records[1]), await outcome(w.records[2], { sale: { id: "sale-re-executed" } })]);
    rec("r89", "restored outcomes missing a committed sale (restore lost it) / holding a re-executed sale under the same key",
      "OBSERVED_COMMITTED_OPERATION_MISSING_FROM_RESTORED_OUTCOMES / RESTORED_OUTCOME_DOES_NOT_MATCH_SIGNED_DEVICE_OBSERVATION; QUARANTINED; nothing replayed",
      `control=${all.state}/${all.outcomeBinding.valid} lost=${lost.state}/${lost.outcomeBinding.findings} reexecuted=${reexec.state}/${reexec.outcomeBinding.findings} replayAuthorized=${reexec.replayAuthorized} reconstructed=${reexec.reconstructedFinancialHistory}`,
      all.outcomeBinding.valid && lost.state === "QUARANTINED" && lost.outcomeBinding.findings.includes("OBSERVED_COMMITTED_OPERATION_MISSING_FROM_RESTORED_OUTCOMES")
        && reexec.state === "QUARANTINED" && reexec.outcomeBinding.findings.includes("RESTORED_OUTCOME_DOES_NOT_MATCH_SIGNED_DEVICE_OBSERVATION") && !reexec.replayAuthorized ? "PASS" : "FAIL");
    rec("r89b", "the restored-outcomes manifest itself", "produced and attested independently of the restored server", "it is caller/server-supplied JSON inside the archive (RESTORED_OUTCOME_MANIFEST_IS_NOT_FULL_FINANCIAL_LEDGER_VERIFICATION); only devices that kept evidence are covered (no device roster)", "LIMITATION");
    expect(lost.state).toBe("QUARANTINED"); expect(reexec.state).toBe("QUARANTINED");
  });
});
