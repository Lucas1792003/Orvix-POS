/** Raw-evidence orchestration. No externally supplied 'verified' flags are accepted.
 * This verifies retained assertions; it does not execute SQL, replay a queue or authorize reopening. */
import { digest, isTime } from '../../src/recovery/canonical';
import { assessRecovery } from '../../src/recovery/assessment';
import { verifyEvidencePrefix, type EvidenceRecord } from '../../src/recovery/evidence';
import { createCheckpoint, verifyWitnessBoundary, type WitnessReceipt } from '../../src/recovery/witness';
import type { IndependentTrustSource } from '../../src/recovery/trust';
import { openBackup, type OpenBackupOptions } from './backup-archive.mjs';
import { backupAssessmentInput, verifyBackupArchive } from './restore-verification.mjs';

interface RestoredOutcomes {
  protocol: 'orvix-restored-operation-outcomes-v1'; orgId: string; shopId: string;
  outcomes: { operationId: string; rpc: string; payloadHash: string; responseHash: string; originalCreatedAt: string }[];
}
export interface OfflineEvidenceManifest {
  protocol: 'orvix-offline-preservation-v1'; orgId: string; shopId: string;
  devices: { deviceId: string; records: EvidenceRecord[] }[];
}
export interface RecoveryVerificationInput {
  backup: OpenBackupOptions & { now?: Date; maxAgeMs?: number; pgRestorePath?: string };
  /** Pins/roster are supplied from a separate custody interface, never from archive metadata. */
  source: IndependentTrustSource | null;
  receipts: readonly WitnessReceipt[];
  trustedBoundary: WitnessReceipt | null;
  offlineManifest?: OfflineEvidenceManifest;
}

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

async function verifyRestoredOutcomes(value: unknown, records: readonly EvidenceRecord[], expected: { orgId: string; shopId: string }) {
  const findings: string[] = [];
  const raw = object(value);
  if (!raw || raw.protocol !== 'orvix-restored-operation-outcomes-v1' || raw.orgId !== expected.orgId || raw.shopId !== expected.shopId || !Array.isArray(raw.outcomes)) {
    return { valid: false, findings: ['RESTORED_COMMITTED_OUTCOMES_MISSING_OR_SCOPE_INVALID'], comparedOperations: 0 };
  }
  const outcomes = raw as unknown as RestoredOutcomes;
  const observed = new Map<string, { rpc: string; payloadHash: string; responseHash: string; originalCreatedAt: string }>();
  for (const record of records) {
    if (record.envelope.body.evidenceKind !== 'journal-observation') continue;
    const observation = object(record.observation);
    if (observation?.state !== 'committed') continue;
    const evidence = object(observation.evidence), body = record.envelope.body;
    if (observation.key !== body.operationId || observation.rpc !== body.rpc || observation.orgId !== expected.orgId || observation.shopId !== expected.shopId
      || !isTime(observation.createdAt) || await digest(observation.args) !== body.payloadHash || !evidence || !Object.hasOwn(evidence, 'response')) {
      findings.push('COMMITTED_DEVICE_OBSERVATION_CONTENT_INCOMPLETE_OR_INCONSISTENT'); continue;
    }
    const entry = { rpc: body.rpc, payloadHash: body.payloadHash, responseHash: await digest(evidence.response), originalCreatedAt: observation.createdAt };
    const previous = observed.get(body.operationId);
    if (previous && await digest(previous) !== await digest(entry)) findings.push('CONTRADICTORY_COMMITTED_DEVICE_RESPONSES');
    observed.set(body.operationId, entry);
  }
  const seen = new Set<string>();
  for (const row of outcomes.outcomes) {
    const expectation = observed.get(row.operationId);
    if (seen.has(row.operationId) || !expectation || row.rpc !== expectation.rpc || row.payloadHash !== expectation.payloadHash
      || row.responseHash !== expectation.responseHash || row.originalCreatedAt !== expectation.originalCreatedAt) findings.push('RESTORED_OUTCOME_DOES_NOT_MATCH_SIGNED_DEVICE_OBSERVATION');
    seen.add(row.operationId);
  }
  for (const id of observed.keys()) if (!seen.has(id)) findings.push('OBSERVED_COMMITTED_OPERATION_MISSING_FROM_RESTORED_OUTCOMES');
  if (!observed.size) findings.push('NO_COMMITTED_DEVICE_RESPONSES_TO_COMPARE');
  return { valid: !findings.length, findings: [...new Set(findings)], comparedOperations: observed.size };
}

export async function verifyRecovery(input: RecoveryVerificationInput) {
  const expected = { orgId: input.backup.expectedOrgId, shopId: input.backup.expectedShopId };
  const backup = verifyBackupArchive(input.backup);
  const integrationFindings = [
    'RETAINED_DEVICE_RESPONSE_IS_NOT_INDEPENDENT_DATABASE_COMMIT_OBSERVATION',
    'RESTORED_OUTCOME_MANIFEST_IS_NOT_FULL_FINANCIAL_LEDGER_VERIFICATION',
    'INDEPENDENT_DEVICE_ROSTER_UNAVAILABLE;OMITTED_OR_LOST_DEVICES_CANNOT_BE_EXCLUDED',
  ];
  let records: EvidenceRecord[] = [];
  let outcomes: unknown = null;
  const stableSource: IndependentTrustSource | null = input.source ? { custody: input.source.custody, keys: async () => pins } : null;
  let pins: Awaited<ReturnType<IndependentTrustSource['keys']>> = [];
  try {
    pins = input.source ? structuredClone(await input.source.keys()) : [];
    const opened = openBackup(input.backup);
    try {
      const evidenceBytes = opened.files.get('recovery/device-evidence.json');
      const outcomeBytes = opened.files.get('recovery/committed-outcomes.json');
      if (evidenceBytes) {
        const parsed: unknown = JSON.parse(evidenceBytes.toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length > 10000) throw new Error('ARCHIVE_DEVICE_EVIDENCE_INVALID');
        records = parsed as EvidenceRecord[];
      } else integrationFindings.push('ARCHIVE_DEVICE_EVIDENCE_MISSING');
      outcomes = outcomeBytes ? JSON.parse(outcomeBytes.toString('utf8')) as unknown : null;
    } finally { for (const bytes of opened.files.values()) bytes.fill(0); }
  } catch {
    integrationFindings.push('RAW_ARCHIVE_OR_PINNED_EVIDENCE_UNREADABLE');
  }
  let evidence: Awaited<ReturnType<typeof verifyEvidencePrefix>>;
  let witness: Awaited<ReturnType<typeof verifyWitnessBoundary>>;
  let outcomeBinding = { valid: false, comparedOperations: 0, findings: ['RESTORED_OUTCOMES_UNVERIFIED'] };
  try {
    evidence = await verifyEvidencePrefix(records, stableSource, expected);
    witness = await verifyWitnessBoundary({ records, receipts: input.receipts, source: stableSource, expected, trustedBoundary: input.trustedBoundary });
    outcomeBinding = await verifyRestoredOutcomes(outcomes, records, expected);
    if (evidence.valid) {
      const checkpoint = await createCheckpoint(records, stableSource, expected);
      const boundary = backup.evidenceBoundary;
      if (!boundary || boundary.streamId !== checkpoint.streamId || boundary.sequence !== checkpoint.sequence || boundary.digest !== checkpoint.digest) {
        evidence.valid = false; integrationFindings.push('BACKUP_BOUNDARY_DOES_NOT_MATCH_RESTORED_SIGNED_EVIDENCE');
      }
    }
  } catch {
    evidence = { valid: false, complete: false, prefixVerified: false, sequence: 0, digest: null, streamId: null, findings: ['RAW_DEVICE_EVIDENCE_UNVERIFIABLE'] };
    witness = { valid: false, latestEstablished: false, findings: ['RAW_WITNESS_EVIDENCE_UNVERIFIABLE'] };
  }
  const offline = { supplied: !!input.offlineManifest, verifiedStreams: 0, uncertainOperationIds: [] as string[], findings: [] as string[], valid: true };
  if (!input.offlineManifest) offline.findings.push('SURVIVING_OFFLINE_EVIDENCE_NOT_SUPPLIED');
  else {
    try {
      const manifest = input.offlineManifest;
      if (manifest.protocol !== 'orvix-offline-preservation-v1' || manifest.orgId !== expected.orgId || manifest.shopId !== expected.shopId
        || !Array.isArray(manifest.devices) || manifest.devices.length > 10000) throw new Error('OFFLINE_MANIFEST_SCOPE_INVALID');
      const devices = new Set<string>();
      for (const device of manifest.devices) {
        if (devices.has(device.deviceId) || !Array.isArray(device.records)) throw new Error('OFFLINE_DEVICE_DUPLICATE_OR_RECORDS_INVALID');
        devices.add(device.deviceId);
        const result = await verifyEvidencePrefix(device.records, stableSource, { ...expected, deviceId: device.deviceId });
        if (!result.valid) throw new Error('OFFLINE_DEVICE_EVIDENCE_UNVERIFIABLE');
        offline.verifiedStreams += 1;
        for (const record of device.records) {
          const sameStream = result.streamId === evidence.streamId;
          const retained = sameStream ? records[record.envelope.body.sequence - 1] : undefined;
          if (retained && retained.envelope.hash !== record.envelope.hash) throw new Error('OFFLINE_AND_RESTORED_EVIDENCE_FORK');
          if (!retained) offline.uncertainOperationIds.push(record.envelope.body.operationId);
        }
      }
      if (offline.uncertainOperationIds.length) offline.findings.push('SURVIVING_OFFLINE_TAIL_REQUIRES_RECONCILIATION;NO_REPLAY_OR_REENTRY_AUTHORIZED');
    } catch { offline.valid = false; offline.findings.push('OFFLINE_MANIFEST_UNVERIFIABLE_OR_FORKED'); }
  }
  if (input.source?.custody === 'synthetic-test-only') integrationFindings.push('SYNTHETIC_TRUST_KEYS_ESTABLISH_NO_INDEPENDENT_PRODUCTION_CUSTODY');
  if (backup.state === 'QUARANTINED' || !outcomeBinding.valid || !offline.valid) evidence.valid = false;
  const assessment = assessRecovery({ ...expected, backup: backupAssessmentInput(backup, expected), evidence, witness });
  return {
    ...assessment, findings: [...new Set([...assessment.findings, ...backup.findings.map((item) => item.code), ...outcomeBinding.findings, ...integrationFindings, ...offline.findings])],
    backup, evidence, witness, outcomeBinding, offline: { ...offline, uncertainOperationIds: [...new Set(offline.uncertainOperationIds)] },
    reconstructedFinancialHistory: false, restoreExecuted: false, replayAuthorized: false, independentAuthorityEstablished: false,
  };
}
