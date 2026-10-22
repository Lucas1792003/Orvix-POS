/** Disposable synthetic integration smoke; no network, DB or persistent private keys. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { digest, sign, syntheticSigningKey } from '../../src/recovery/canonical';
import { signEvidence, type EvidenceBody, type EvidenceRecord } from '../../src/recovery/evidence';
import { createCheckpoint, LocalTestWitness, MemoryTestWitnessStore } from '../../src/recovery/witness';
import type { DeviceIdentity } from '../../src/recovery/deviceVault';
import type { Enrollment, IndependentTrustSource } from '../../src/recovery/trust';
import { publicKeyId, sealBackup, type BackupEnvelope, type BackupMetadata } from './backup-archive.mjs';
import { deliverToSimulatedRecipient } from './restore-verification.mjs';
import { verifyRecovery, type RecoveryVerificationInput } from './verify-recovery';

const scope = { orgId: 'synthetic-org', shopId: 'synthetic-shop' };
const at = '2026-10-21T10:00:00.000Z';
const owner = await syntheticSigningKey(), device = await syntheticSigningKey(), witnessKey = await syntheticSigningKey();
const source: IndependentTrustSource = {
  custody: 'synthetic-test-only',
  keys: async () => [
    { keyId: owner.keyId, publicKey: owner.publicKey, purpose: 'device-enrollment', orgId: scope.orgId, notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z', revokedAt: null },
    { keyId: witnessKey.keyId, publicKey: witnessKey.publicKey, purpose: 'witness', orgId: scope.orgId, notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z', revokedAt: null },
  ],
};
const enrollmentBody: Enrollment['body'] = {
  protocol: 'orvix-device-enrollment-v1', enrollmentId: 'synthetic-enrollment', ...scope, deviceId: 'synthetic-device',
  keyId: device.keyId, publicKey: device.publicKey, authorityKeyId: owner.keyId,
  notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z', revokedAt: null, replacesEnrollmentId: null,
};
const enrollment: Enrollment = { body: enrollmentBody, signature: await sign(enrollmentBody, owner.privateKey) };
const identity: DeviceIdentity = { scope: 'synthetic-test-only', privateKey: device.privateKey, publicKey: device.publicKey, enrollment, createdAt: at };
const operationId = '11111111-1111-4111-8111-111111111111';
const payload = { p_org_id: scope.orgId, p_shop_id: scope.shopId, p_idempotency_key: operationId, p_quantity: 1 };
const response = { sale_id: 'synthetic-sale', receipt_no: 'SYNTHETIC-001' };
async function makeRecord(sequence: number, previousHash: string | null, state: 'committed' | 'in-doubt', key = operationId): Promise<EvidenceRecord> {
  const observation = { key, rpc: 'create_sale', ...scope, createdAt: at, args: payload, state, evidence: state === 'committed' ? { response } : { source: 'client' } };
  const body: EvidenceBody = {
    protocol: 'orvix-device-evidence-v1', ...scope, deviceId: enrollmentBody.deviceId, keyId: device.keyId,
    operationId: key, rpc: 'create_sale', evidenceKind: 'journal-observation', payloadHash: await digest(payload), observationHash: await digest(observation),
    sequence, previousHash, createdAt: at,
    authorization: { actorId: 'synthetic-actor', opEpoch: null, backendOrigin: 'https://synthetic.invalid', enrollmentId: enrollmentBody.enrollmentId },
  };
  return { envelope: await signEvidence(identity, body), enrollment, payload, observation };
}
const records = [await makeRecord(1, null, 'committed')];
const checkpoint = await createCheckpoint(records, source, scope);
const testWitness = new LocalTestWitness({ witnessId: 'synthetic-witness', keyId: witnessKey.keyId, privateKey: witnessKey.privateKey, store: new MemoryTestWitnessStore(), now: () => at });
const receipt = await testWitness.append(checkpoint);
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 }), provenance = generateKeyPairSync('ed25519');
const metadata: BackupMetadata = {
  archiveId: 'synthetic-integrated-backup', ...scope, schemaVersion: '085', format: 'synthetic-test-fixture', recoveredAsOf: at,
  evidenceBoundary: { streamId: checkpoint.streamId, sequence: checkpoint.sequence, digest: checkpoint.digest },
  provenanceCustody: 'local-test', decryptionCustody: 'local-test',
};
const retained = {
  'recovery/device-evidence.json': Buffer.from(JSON.stringify(records)),
  'recovery/committed-outcomes.json': Buffer.from(JSON.stringify({ protocol: 'orvix-restored-operation-outcomes-v1', ...scope,
    outcomes: [{ operationId, rpc: 'create_sale', payloadHash: await digest(payload), responseHash: await digest(response), originalCreatedAt: at }] })),
};
const seal = (change: Partial<BackupMetadata> = {}, files = retained) => sealBackup({ metadata: { ...metadata, ...change }, files, recipientPublicKey: recipient.publicKey, provenancePrivateKey: provenance.privateKey });
const envelope = seal();
const input: RecoveryVerificationInput = {
  backup: { envelope, recipientPrivateKey: recipient.privateKey, trustedProvenanceKeys: new Map([[publicKeyId(provenance.publicKey), provenance.publicKey]]), expectedOrgId: scope.orgId, expectedShopId: scope.shopId, now: new Date(at) },
  source, receipts: [receipt], trustedBoundary: receipt,
  offlineManifest: { protocol: 'orvix-offline-preservation-v1', ...scope, devices: [{ deviceId: enrollmentBody.deviceId, records }] },
};
let passed = 0;
const check = (name: string, run: () => void) => { run(); passed += 1; process.stdout.write(`PASS ${name}\n`); };
const directory = mkdtempSync(join(tmpdir(), 'orvix-recovery-smoke-'));
try {
  const delivery = deliverToSimulatedRecipient({ envelope, recipientDirectory: directory });
  const received = JSON.parse(readFileSync(delivery.path, 'utf8')) as BackupEnvelope;
  const report = await verifyRecovery({ ...input, backup: { ...input.backup, envelope: received } });
  check('raw signed device evidence + witness receipt + encrypted simulated recipient', () => {
    assert.equal(report.backup.authenticity, 'verified'); assert.equal(report.evidence.valid, true); assert.equal(report.witness.valid, true);
    assert.equal(report.outcomeBinding.comparedOperations, 1); assert.equal(report.outcomeBinding.valid, true);
  });
  check('verification cannot reopen or claim latest/full reconstruction', () => {
    assert.equal(report.state, 'RESTRICTED'); assert.equal(report.reopenAuthorized, false); assert.equal(report.replayAuthorized, false);
    assert.equal(report.witness.latestEstablished, false); assert.equal(report.reconstructedFinancialHistory, false);
    assert.equal(report.independentAuthorityEstablished, false);
  });
  const untrusted = await verifyRecovery({ ...input, source: null });
  check('server-held evidence cannot enroll itself without a pinned trust source', () => { assert.equal(untrusted.state, 'QUARANTINED'); });
  const withheld = await verifyRecovery({ ...input, receipts: [] });
  check('required external receipt withheld fails closed', () => { assert.equal(withheld.state, 'QUARANTINED'); });
  const wrongBoundary = await verifyRecovery({ ...input, backup: { ...input.backup, envelope: seal({ evidenceBoundary: { ...metadata.evidenceBoundary, digest: 'f'.repeat(64) } }) } });
  check('authentic archive with inconsistent committed-evidence boundary fails closed', () => {
    assert.equal(wrongBoundary.state, 'QUARANTINED'); assert.ok(wrongBoundary.findings.includes('BACKUP_BOUNDARY_DOES_NOT_MATCH_RESTORED_SIGNED_EVIDENCE'));
  });
  const changed = structuredClone(records); changed[0].payload = { p_quantity: 99 };
  const tampered = await verifyRecovery({ ...input, backup: { ...input.backup, envelope: seal({}, { ...retained, 'recovery/device-evidence.json': Buffer.from(JSON.stringify(changed)) }) } });
  check('infrastructure backup signer cannot rewrite signed device payloads', () => { assert.equal(tampered.state, 'QUARANTINED'); });
  const changedOutcome = JSON.parse(retained['recovery/committed-outcomes.json'].toString()) as { outcomes: { responseHash: string }[] };
  changedOutcome.outcomes[0].responseHash = 'a'.repeat(64);
  const contradicted = await verifyRecovery({ ...input, backup: { ...input.backup, envelope: seal({}, { ...retained, 'recovery/committed-outcomes.json': Buffer.from(JSON.stringify(changedOutcome)) }) } });
  check('restored outcome assertions must bind exact observed response and original identity', () => { assert.equal(contradicted.state, 'QUARANTINED'); assert.equal(contradicted.outcomeBinding.valid, false); });
  const tailRecord = await makeRecord(2, records[0].envelope.hash, 'in-doubt', '22222222-2222-4222-8222-222222222222');
  const offlineTail = await verifyRecovery({ ...input, offlineManifest: { protocol: 'orvix-offline-preservation-v1', ...scope, devices: [{ deviceId: enrollmentBody.deviceId, records: [...records, tailRecord] }] } });
  check('surviving offline tail is preserved for reconciliation without automatic replay', () => {
    assert.equal(offlineTail.state, 'RESTRICTED'); assert.equal(offlineTail.offline.verifiedStreams, 1);
    assert.deepEqual(offlineTail.offline.uncertainOperationIds, ['22222222-2222-4222-8222-222222222222']); assert.equal(offlineTail.replayAuthorized, false);
  });
  process.stdout.write(`${passed}/${passed} synthetic integration checks passed. Real DB restore/offsite independence not established.\n`);
} finally { rmSync(directory, { recursive: true, force: true }); }
