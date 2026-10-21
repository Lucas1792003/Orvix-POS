// node --test tools/recovery-v1/email-archive-adapter.test.mjs
// Synthetic email-archive trees ONLY (the exact layout email-archive.sh writes). Keys exist only in
// memory; nothing is decrypted with OpenPGP, mailed, or restored into a database.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicKeyId } from './backup-archive.mjs';
import { packageEmailArchive, readUnpackedEmailArchive } from './email-archive-adapter.mjs';
import { backupAssessmentInput, verifyBackupArchive } from './restore-verification.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const provenance = generateKeyPairSync('ed25519');
const boundary = { streamId: 'synthetic-stream', sequence: 0, digest: sha('synthetic') };

/** Writes a tree exactly as email-archive.sh lays it out (SHA256SUMS in `sha256sum -b` form). */
function tree({ tamper, extra, omit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orvix-email-adapter-'));
  const files = {
    'db/postgres.dump': Buffer.from('PGDMP synthetic postgres dump bytes'),
    'db/_supabase.dump': Buffer.from('PGDMP synthetic _supabase dump bytes'),
    'db/globals.sql': Buffer.from('-- synthetic roles\n'),
    'db/db-settings.sql': Buffer.from('-- synthetic settings\n'),
    'db/counts.json': Buffer.from('{"synthetic":true}\n'),
    'files/storage.tar.gz': Buffer.from('synthetic storage bytes'),
  };
  if (omit) delete files[omit];
  for (const [p, b] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), b); }
  const sums = Object.keys(files).sort().map((p) => `${sha(files[p])} *${p}`).join('\n') + '\n';
  writeFileSync(join(dir, 'SHA256SUMS'), sums);
  const manifest = { archive_id: 'orvix-2026-W43', created_at: '2026-10-21T04:30:00Z', label: 'orvix', counts: { synthetic: true },
    files: [...Object.keys(files), 'SHA256SUMS'].sort().map((p) => ({ path: p, bytes: (p === 'SHA256SUMS' ? Buffer.from(sums) : files[p]).length,
      sha256: p === 'SHA256SUMS' ? null : sha(files[p]) })) };
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest));
  if (tamper) writeFileSync(join(dir, tamper), 'tampered after SHA256SUMS');
  if (extra) writeFileSync(join(dir, extra), 'not listed');
  return dir;
}
const pack = (dir) => packageEmailArchive({ dir, orgId: 'synthetic-org', shopId: 'synthetic-shop', schemaVersion: '085', evidenceBoundary: boundary,
  decryptionCustody: 'local-test', recipientPublicKey: recipient.publicKey, provenancePrivateKey: provenance.privateKey });
const verify = (envelope) => verifyBackupArchive({ envelope, trustedProvenanceKeys: new Map([[publicKeyId(provenance.publicKey), provenance.publicKey]]),
  recipientPrivateKey: recipient.privateKey, expectedOrgId: 'synthetic-org', expectedShopId: 'synthetic-shop', now: new Date('2026-10-21T05:00:00Z') });
const codes = (r) => r.findings.map((f) => f.code);

test('an intact email-archive tree packages and verifies; financial completeness stays unknown', () => {
  const dir = tree();
  try {
    const r = pack(dir);
    assert.equal(r.packaged, true);
    const report = verify(r.envelope);
    assert.equal(report.signatureVerified, true);       // the packager's signature is valid ...
    assert.equal(report.authenticity, 'unverified');    // ... but the contents were produced by the server
    assert.equal(report.integrity, 'verified');
    assert.equal(report.completeness, 'unknown');
    assert.equal(report.reopenAuthorized, false);
    assert.notEqual(report.state, 'ACTIVE');
    assert.equal(report.provenanceCustody, 'infrastructure-source');            // the producer was the server
    assert.ok(codes(report).includes('OFFSITE_SURVIVAL_NOT_PROVEN'));
    assert.ok(codes(report).includes('ISOLATED_DATABASE_RESTORE_NOT_PERFORMED'));
    assert.ok(r.findings.some((f) => f.code === 'EMAIL_ARCHIVE_PRODUCER_IS_INFRASTRUCTURE'));
    // the packager's valid signature does not make server-produced contents authentic for the assessment
    assert.ok(codes(report).includes('CONTENT_PRODUCED_BY_INFRASTRUCTURE_PROVENANCE_UNVERIFIED'));
    assert.ok(codes(report).includes('TENANT_LABEL_ONLY_CONTENTS_MAY_INCLUDE_OTHER_TENANTS'));
    assert.equal(backupAssessmentInput(report, { orgId: 'synthetic-org', shopId: 'synthetic-shop' }).authenticity, 'unverified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file changed after SHA256SUMS is refused (no envelope)', () => {
  const dir = tree({ tamper: 'db/postgres.dump' });
  try {
    const r = pack(dir);
    assert.equal(r.packaged, false);
    assert.ok(r.findings.some((f) => f.code === 'SHA256_MISMATCH:db/postgres.dump'));
    assert.equal(r.envelope, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unlisted file is refused', () => {
  const dir = tree({ extra: 'db/smuggled.sql' });
  try { assert.ok(pack(dir).findings.some((f) => f.code === 'FILE_NOT_IN_SHA256SUMS:db/smuggled.sql')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing required component is reported (and not reported as complete)', () => {
  const dir = tree({ omit: 'db/_supabase.dump' });
  try {
    const read = readUnpackedEmailArchive(dir);
    assert.ok(read.findings.some((f) => f.code === 'COMPONENT_MISSING:db/_supabase.dump'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a symbolic link inside the tree is refused outright', () => {
  const dir = tree();
  try {
    symlinkSync('/etc/hosts', join(dir, 'db', 'link.sql'));
    assert.throws(() => readUnpackedEmailArchive(dir), /LINK_OR_SPECIAL_FILE_REFUSED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing manifest or checksum list is refused', () => {
  const a = tree(); const b = tree();
  try {
    rmSync(join(a, 'MANIFEST.json')); rmSync(join(b, 'SHA256SUMS'));
    assert.throws(() => readUnpackedEmailArchive(a), /MANIFEST_MISSING/);
    assert.throws(() => readUnpackedEmailArchive(b), /SHA256SUMS_MISSING/);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('the wrong provenance key or another tenant cannot open the packaged envelope', () => {
  const dir = tree();
  try {
    const { envelope } = pack(dir);
    const other = generateKeyPairSync('ed25519');
    const wrongKey = verifyBackupArchive({ envelope, trustedProvenanceKeys: new Map([[publicKeyId(other.publicKey), other.publicKey]]),
      recipientPrivateKey: recipient.privateKey, expectedOrgId: 'synthetic-org', expectedShopId: 'synthetic-shop' });
    assert.equal(wrongKey.state, 'QUARANTINED');
    const otherTenant = verifyBackupArchive({ envelope, trustedProvenanceKeys: new Map([[publicKeyId(provenance.publicKey), provenance.publicKey]]),
      recipientPrivateKey: recipient.privateKey, expectedOrgId: 'another-org', expectedShopId: 'synthetic-shop' });
    assert.equal(otherTenant.state, 'QUARANTINED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backupAssessmentInput is an allow-list: a missing or unknown provenance label is never authentic', () => {
  const base = { protocol: 'orvix-backup-verification-v1', orgId: 'o', shopId: 's', authenticity: 'verified', integrity: 'verified', coverage: 'unknown' };
  assert.equal(backupAssessmentInput({ ...base }, { orgId: 'o', shopId: 's' }).authenticity, 'unverified');
  assert.equal(backupAssessmentInput({ ...base, provenanceCustody: 'something-else' }, { orgId: 'o', shopId: 's' }).authenticity, 'unverified');
  assert.equal(backupAssessmentInput({ ...base, provenanceCustody: 'infrastructure-source' }, { orgId: 'o', shopId: 's' }).authenticity, 'unverified');
  assert.equal(backupAssessmentInput({ ...base, provenanceCustody: 'local-test' }, { orgId: 'o', shopId: 's' }).authenticity, 'verified');
});
