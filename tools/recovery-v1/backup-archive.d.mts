import type { KeyObject } from 'node:crypto';
export interface BackupMetadata {
  archiveId: string; orgId: string; shopId: string; schemaVersion: '085' | '086' | '087';
  format: 'logical-pg-custom' | 'physical-pg-base' | 'synthetic-test-fixture'; recoveredAsOf: string;
  evidenceBoundary: { streamId: string; sequence: number; digest: string };
  provenanceCustody: 'infrastructure-source' | 'local-test'; decryptionCustody: 'independently-held-required' | 'local-test';
  wal?: { timeline: number; startLsn: string; endLsnExclusive: string; segmentBytes: number; timelineHistory?: string[] };
}
export interface BackupEnvelope {
  body: {
    protocol: string; algorithm: string; metadata: BackupMetadata; recipientKeyId: string; provenanceKeyId: string;
    inventory: { path: string; bytes: number; sha256: string }[]; nonce: string; tag: string; wrappedKey: string; ciphertext: string;
  }; signature: string;
}
export interface OpenBackupOptions {
  envelope: BackupEnvelope; trustedProvenanceKeys: ReadonlyMap<string, KeyObject>; recipientPrivateKey: KeyObject;
  expectedOrgId: string; expectedShopId: string;
}
export const BACKUP_PROTOCOL: string;
export const MAX_ARCHIVE_BYTES: number;
export function canonicalJSON(value: unknown): string;
export function sha256(bytes: string | Uint8Array): string;
export function publicKeyId(key: KeyObject): string;
export function safeArchivePath(path: string): boolean;
export function sealBackup(input: { metadata: BackupMetadata; files: Record<string, Uint8Array>; recipientPublicKey: KeyObject; provenancePrivateKey: KeyObject }): BackupEnvelope;
export function openBackup(input: OpenBackupOptions): {
  metadata: BackupMetadata; files: Map<string, Buffer>; archiveDigest: string; provenanceKeyId: string; recipientKeyId: string;
};
