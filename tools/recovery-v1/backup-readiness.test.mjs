import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON, openBackup, publicKeyId, sealBackup, sha256 } from './backup-archive.mjs';
import {
  backupAssessmentInput, deliverToSimulatedRecipient, expectedWalFiles, planEvidencePreservation,
  preserveEvidence, validateLogicalDump, verifyBackupArchive, verifyWalCoverage,
} from './restore-verification.mjs';

const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const source = generateKeyPairSync('ed25519');
const metadata = {
  archiveId: 'synthetic-archive-1', orgId: 'org-test', shopId: 'shop-test', schemaVersion: '085',
  format: 'synthetic-test-fixture', recoveredAsOf: '2026-10-21T10:00:00.000Z',
  evidenceBoundary: { streamId: 'financial-events', sequence: 3, digest: 'a'.repeat(64) },
  provenanceCustody: 'local-test', decryptionCustody: 'local-test',
};
const files = { 'fixture.txt': Buffer.from('Synthetic recovery fixture. No business data or credentials.') };
const seal = (changes = {}, content = files) => sealBackup({ metadata: { ...metadata, ...changes }, files: content, recipientPublicKey: recipient.publicKey, provenancePrivateKey: source.privateKey });
const options = (envelope) => ({ envelope, trustedProvenanceKeys: new Map([[publicKeyId(source.publicKey), source.publicKey]]),
  recipientPrivateKey: recipient.privateKey, expectedOrgId: metadata.orgId, expectedShopId: metadata.shopId,
  now: new Date('2026-10-21T10:01:00.000Z') });
const resign = (envelope) => ({ ...envelope, signature: sign(null, Buffer.from(canonicalJSON(envelope.body)), source.privateKey).toString('base64') });
const withDirectory = (run) => {
  const directory = mkdtempSync(join(tmpdir(), 'orvix-backup-unit-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('authenticated encryption round-trips exact synthetic bytes; every sealing uses a new key and nonce', () => {
  const first = seal(), second = seal(), opened = openBackup(options(first));
  assert.deepEqual(opened.files.get('fixture.txt'), files['fixture.txt']);
  assert.equal(opened.archiveDigest, sha256(canonicalJSON(first)));
  assert.notEqual(first.body.nonce, second.body.nonce);
  assert.notEqual(first.body.ciphertext, second.body.ciphertext);
  assert.notEqual(first.body.wrappedKey, second.body.wrappedKey);
});

test('provenance must use an independently supplied pinned public key', () => {
  const envelope = seal();
  assert.throws(() => openBackup({ ...options(envelope), trustedProvenanceKeys: new Map() }), /PROVENANCE_KEY_NOT_PINNED/);
  const attacker = generateKeyPairSync('ed25519');
  assert.throws(() => openBackup({ ...options(envelope), trustedProvenanceKeys: new Map([[envelope.body.provenanceKeyId, attacker.publicKey]]) }), /PROVENANCE_KEY_NOT_PINNED/);
});

test('signature binds tenant, operation boundary, inventory and ciphertext', () => {
  for (const mutate of [
    (body) => { body.metadata.orgId = 'attacker-org'; },
    (body) => { body.metadata.evidenceBoundary.sequence += 1; },
    (body) => { body.inventory[0].sha256 = 'b'.repeat(64); },
    (body) => { body.ciphertext = Buffer.from('damaged').toString('base64'); },
  ]) {
    const envelope = structuredClone(seal()); mutate(envelope.body);
    assert.throws(() => openBackup(options(envelope)), /PROVENANCE_SIGNATURE_INVALID/);
  }
});

test('signature cannot substitute AEAD integrity even when the source re-signs damaged ciphertext', () => {
  const envelope = seal(), bytes = Buffer.from(envelope.body.ciphertext, 'base64');
  bytes[0] ^= 1; envelope.body.ciphertext = bytes.toString('base64');
  assert.throws(() => openBackup(options(resign(envelope))));
});

test('tenant and recipient replay fail closed', () => {
  const envelope = seal();
  assert.throws(() => openBackup({ ...options(envelope), expectedOrgId: 'other-org' }), /BACKUP_TENANT_MISMATCH/);
  assert.throws(() => openBackup({ ...options(envelope), expectedShopId: '' }), /BACKUP_TENANT_MISMATCH/);
  const wrongRecipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
  assert.throws(() => openBackup({ ...options(envelope), recipientPrivateKey: wrongRecipient.privateKey }), /RECIPIENT_KEY_MISMATCH/);
});

test('unsafe archive paths, weak recipient keys, unknown schemas and noncanonical values are refused', () => {
  for (const path of ['../escape', '/absolute', 'dir//file', 'dir/./file', 'dir/../file', 'dir/file\n']) assert.throws(() => seal({}, { [path]: Buffer.from('x') }), /INVALID_BACKUP_PATHS/);
  assert.throws(() => seal({ schemaVersion: '088' }), /UNSUPPORTED_BACKUP_SCHEMA/);
  assert.throws(() => seal({ evidenceBoundary: { ...metadata.evidenceBoundary, sequence: 0.5 } }), /INVALID_EVIDENCE_BOUNDARY/);
  assert.throws(() => canonicalJSON({ a: undefined }), /NON_CANONICAL_VALUE/);
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => sealBackup({ metadata, files, recipientPublicKey: weak.publicKey, provenancePrivateKey: source.privateKey }), /RSA_KEY_TOO_SMALL/);
});

test('missing/damaged archives produce explicit quarantined reports without throwing or leaking payloads', () => {
  const missing = verifyBackupArchive(options(undefined));
  assert.equal(missing.integrity, 'missing'); assert.equal(missing.state, 'QUARANTINED');
  const damaged = seal(); damaged.signature = 'bad';
  const report = verifyBackupArchive(options(damaged));
  assert.equal(report.integrity, 'damaged'); assert.equal(report.authenticity, 'unverified');
  assert.equal(report.reopenAuthorized, false); assert.equal(report.state, 'QUARANTINED');
  assert.ok(!JSON.stringify(report).includes(files['fixture.txt'].toString()));
});

test('cryptographic success preserves uncertainty, restriction and unproven custody/availability', () => {
  const report = verifyBackupArchive(options(seal()));
  assert.equal(report.authenticity, 'verified'); assert.equal(report.integrity, 'verified');
  assert.equal(report.coverage, 'unknown'); assert.equal(report.completeness, 'unknown');
  assert.equal(report.state, 'RESTRICTED'); assert.equal(report.reopenAuthorized, false);
  assert.equal(report.availability, 'not-established'); assert.equal(report.restoreExecuted, false);
  assert.ok(report.findings.some((f) => f.code === 'INDEPENDENT_KEY_CUSTODY_NOT_PROVEN'));
  assert.deepEqual(backupAssessmentInput(report, { orgId: 'other', shopId: 'shop-test' }), { authenticity: 'unverified', integrity: 'missing', coverage: 'unknown' });
  assert.deepEqual(backupAssessmentInput(report, { orgId: metadata.orgId, shopId: metadata.shopId }), { authenticity: 'verified', integrity: 'verified', coverage: 'unknown' });
});

test('inspection errors quarantine an authenticated archive while retaining its byte-verification result', () => {
  const report = verifyBackupArchive({ ...options(seal()), now: 'invalid-policy-time' });
  assert.equal(report.authenticity, 'verified'); assert.equal(report.integrity, 'verified');
  assert.equal(report.state, 'QUARANTINED'); assert.equal(report.reopenAuthorized, false);
  assert.ok(report.findings.some((f) => f.severity === 'quarantine'));
});

test('logical and existing unpacked email layouts are recognized, never mistaken for verified database restoration', () => {
  const content = Object.fromEntries(['postgres.dump', '_supabase.dump', 'globals.sql', 'db-settings.sql', 'counts.json'].map((name) => [`db/${name}`, Buffer.from(name.endsWith('.dump') ? 'PGDMPsynthetic-invalid-dump' : '{}')]));
  content['MANIFEST.json'] = Buffer.from('{}');
  const report = verifyBackupArchive(options(seal({ format: 'logical-pg-custom' }, content)));
  assert.equal(report.integrity, 'verified'); assert.equal(report.coverage, 'unknown');
  assert.ok(report.findings.some((f) => f.code === 'ISOLATED_DATABASE_RESTORE_NOT_PERFORMED'));
  assert.ok(report.findings.some((f) => f.code === 'LOGICAL_DUMP_READ_ALL_REQUIRED'));
  assert.ok(!report.findings.some((f) => f.code.startsWith('COMPONENT_MISSING:')));
});

test('incomplete or invalid logical content is explicitly rejected from completeness', () => {
  const report = verifyBackupArchive(options(seal({ format: 'logical-pg-custom' }, { 'postgres.dump': Buffer.from('not-a-dump') })));
  assert.equal(report.coverage, 'incomplete'); assert.equal(report.state, 'QUARANTINED');
  assert.ok(report.findings.some((f) => f.code === 'DUMP_HEADER_INVALID:postgres.dump'));
  assert.ok(report.findings.some((f) => f.code === 'COMPONENT_MISSING:_supabase.dump'));
});

test('WAL enumeration includes required segments with exclusive end and correct segment/log rollover', () => {
  assert.deepEqual(expectedWalFiles({ timeline: 3, startLsn: '0/FFF00000', endLsnExclusive: '1/100000', segmentBytes: 1024 * 1024 }), ['000000030000000000000FFF', '000000030000000100000000']);
  assert.deepEqual(expectedWalFiles({ timeline: 1, startLsn: '0/0', endLsnExclusive: '0/1000000', segmentBytes: 16 * 1024 * 1024 }), ['000000010000000000000000']);
  assert.throws(() => expectedWalFiles({ timeline: 0, startLsn: '0/0', endLsnExclusive: '0/10', segmentBytes: 1024 * 1024 }), /INVALID_WAL_RANGE/);
});

test('WAL coverage distinguishes absent, short, complete and unsupported cross-timeline chains', () => {
  const requirement = { timeline: 1, startLsn: '0/0', endLsnExclusive: '0/200000', segmentBytes: 1024 * 1024 };
  const names = expectedWalFiles(requirement), content = new Map([[`wal/${names[0]}`, Buffer.alloc(requirement.segmentBytes)]]);
  assert.equal(verifyWalCoverage(content, requirement).status, 'incomplete');
  content.set(`wal/${names[1]}`, Buffer.alloc(1));
  assert.deepEqual(verifyWalCoverage(content, requirement).damaged, [names[1]]);
  content.set(`wal/${names[1]}`, Buffer.alloc(requirement.segmentBytes));
  assert.equal(verifyWalCoverage(content, requirement).status, 'verified');
  assert.equal(verifyWalCoverage(content, { ...requirement, timelineHistory: ['00000002.history'] }).status, 'unsupported');
});

test('physical backup and WAL structural checks never claim existing logical verifier supports base/PITR', () => {
  const report = verifyBackupArchive(options(seal({ format: 'physical-pg-base', wal: { timeline: 1, startLsn: '0/0', endLsnExclusive: '0/100000', segmentBytes: 1024 * 1024 } }, { 'backup.json': Buffer.from('{}'), 'backup_label': Buffer.from('synthetic'), 'base.tar.gz': Buffer.from('synthetic') })));
  assert.ok(report.findings.some((f) => f.code === 'PHYSICAL_BASE_RESTORE_VERIFIER_UNSUPPORTED'));
  assert.ok(report.findings.some((f) => f.code === 'REQUIRED_WAL_MISSING'));
  assert.equal(report.coverage, 'incomplete'); assert.equal(report.restoreExecuted, false);
});

test('stale and future restore points are findings and never accept-stale reopen overrides', () => {
  const stale = verifyBackupArchive(options(seal({ recoveredAsOf: '2026-10-01T10:00:00.000Z' })));
  assert.ok(stale.findings.some((f) => f.code === 'BACKUP_STALE_UNKNOWN_LOST_TAIL'));
  const future = verifyBackupArchive(options(seal({ recoveredAsOf: '2026-11-01T10:00:00.000Z' })));
  assert.equal(future.state, 'QUARANTINED'); assert.equal(future.reopenAuthorized, false);
});

test('read-only dump validation blocks unavailable binaries and rejects corrupt PGDMP data', () => withDirectory((directory) => {
  const path = join(directory, 'synthetic.dump'); writeFileSync(path, 'PGDMPsynthetic-invalid-dump');
  assert.equal(validateLogicalDump(path, '/missing/pg_restore').status, 'blocked');
  // Installed executable is local tooling; no DB/server/network arguments are accepted.
  if (existsSync('/opt/homebrew/bin/pg_restore')) assert.equal(validateLogicalDump(path, '/opt/homebrew/bin/pg_restore').status, 'damaged');
}));

test('preservation preflight is read-only and copies later WAL, dumps, damaged data, logs and offline evidence separately', () => withDirectory((directory) => {
  const categories = ['later-wal', 'later-dump', 'damaged-data', 'logs', 'offline-evidence'];
  const items = categories.map((category) => {
    const source = join(directory, `source-${category}`); mkdirSync(source);
    writeFileSync(join(source, 'original.bin'), `synthetic ${category}`);
    return { source, category };
  });
  const incidentDirectory = join(directory, 'incident');
  const plan = planEvidencePreservation({ items, incidentDirectory, availableBytes: 10000 });
  assert.equal(existsSync(incidentDirectory), false); assert.equal(plan.restoreAuthorized, false);
  assert.deepEqual(plan.missingCategories, []);
  const manifest = preserveEvidence(plan);
  assert.equal(manifest.entries.length, 5); assert.equal(manifest.independentAttestation, false);
  for (const entry of manifest.entries) assert.equal(sha256(readFileSync(join(incidentDirectory, entry.path))), entry.sha256);
  assert.equal(readFileSync(join(items[0].source, 'original.bin'), 'utf8'), 'synthetic later-wal');
  assert.throws(() => preserveEvidence(plan), /PRESERVATION_PREFLIGHT_REQUIRED/);
  assert.equal(JSON.parse(readFileSync(join(incidentDirectory, 'PRESERVATION.json'), 'utf8')).restoreAuthorized, false);
}));

test('preservation refuses symlinks, nested destinations, reused categories and insufficient space', () => withDirectory((directory) => {
  const source = join(directory, 'original'); writeFileSync(source, 'synthetic');
  const link = join(directory, 'link'); symlinkSync(source, link);
  assert.throws(() => planEvidencePreservation({ items: [{ source: link, category: 'logs' }], incidentDirectory: join(directory, 'incident'), availableBytes: 1000 }), /LINK_OR_SPECIAL/);
  assert.throws(() => planEvidencePreservation({ items: [{ source: directory, category: 'logs' }], incidentDirectory: join(directory, 'nested'), availableBytes: 1000 }), /DESTINATION_INSIDE_SOURCE/);
  assert.throws(() => planEvidencePreservation({ items: [{ source, category: 'logs' }, { source, category: 'logs' }], incidentDirectory: join(directory, 'incident'), availableBytes: 1000 }), /INVALID_EVIDENCE_CATEGORY/);
  const plan = planEvidencePreservation({ items: [{ source, category: 'logs' }], incidentDirectory: join(directory, 'incident'), availableBytes: 1 });
  assert.throws(() => preserveEvidence(plan), /PRESERVATION_PREFLIGHT_REQUIRED/);
  assert.equal(existsSync(plan.incidentDirectory), false);
  assert.ok(plan.missingCategories.includes('damaged-data'));
}));

test('preservation treats dot-prefixed names as path components when checking source containment', () => withDirectory((directory) => {
  const source = join(directory, 'original'); mkdirSync(source);
  writeFileSync(join(source, '..notes'), 'synthetic original evidence');
  const nestedDestination = join(source, '..incident');
  assert.throws(() => planEvidencePreservation({ items: [{ source, category: 'logs' }], incidentDirectory: nestedDestination, availableBytes: 1000 }), /DESTINATION_INSIDE_SOURCE/);
  assert.equal(existsSync(nestedDestination), false);
  const incidentDirectory = join(directory, '..incident');
  const plan = planEvidencePreservation({ items: [{ source, category: 'logs' }], incidentDirectory, availableBytes: 1000 });
  const manifest = preserveEvidence(plan);
  assert.equal(manifest.entries[0].path, 'logs/..notes');
  assert.equal(readFileSync(join(incidentDirectory, 'logs', '..notes'), 'utf8'), 'synthetic original evidence');
  assert.equal(readFileSync(join(source, '..notes'), 'utf8'), 'synthetic original evidence');
}));

test('simulated recipient retains ciphertext only and cannot establish independent offsite survival', () => withDirectory((directory) => {
  const envelope = seal(), receipt = deliverToSimulatedRecipient({ envelope, recipientDirectory: directory });
  assert.equal(receipt.simulated, true); assert.equal(receipt.independentAvailabilityEstablished, false);
  const received = JSON.parse(readFileSync(receipt.path, 'utf8'));
  assert.deepEqual(openBackup(options(received)).files.get('fixture.txt'), files['fixture.txt']);
  assert.ok(!readFileSync(receipt.path, 'utf8').includes(files['fixture.txt'].toString()));
  assert.throws(() => deliverToSimulatedRecipient({ envelope, recipientDirectory: directory }), /EEXIST/);
}));
