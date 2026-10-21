import type { BackupEnvelope, OpenBackupOptions } from './backup-archive.mjs';
export interface BackupVerification {
  protocol: 'orvix-backup-verification-v1'; orgId: string; shopId: string;
  authenticity: 'verified' | 'unverified'; integrity: 'verified' | 'damaged' | 'missing'; coverage: 'verified' | 'incomplete' | 'unknown';
  state: 'RESTRICTED' | 'QUARANTINED'; reopenAuthorized: false; findings: { code: string; severity: 'blocked' | 'quarantine' }[];
  availability: 'not-established'; completeness: 'unknown'; restoreExecuted: false; archiveDigest?: string;
  evidenceBoundary?: { streamId: string; sequence: number; digest: string }; recoveredAsOf?: string; format?: string;
}
export function verifyBackupArchive(input: Omit<OpenBackupOptions, 'envelope'> & { envelope?: BackupEnvelope; now?: Date; maxAgeMs?: number; pgRestorePath?: string }): BackupVerification;
export function backupAssessmentInput(report: BackupVerification, expected: { orgId: string; shopId: string }): Pick<BackupVerification, 'authenticity' | 'integrity' | 'coverage'>;
export function validateLogicalDump(path: string, pgRestorePath: string): { status: 'blocked' | 'verified' | 'damaged'; code: string };
export function deliverToSimulatedRecipient(input: { envelope: BackupEnvelope; recipientDirectory: string }): { simulated: true; archiveDigest: string; deliveredToDirectory: true; independentAvailabilityEstablished: false; path: string };
