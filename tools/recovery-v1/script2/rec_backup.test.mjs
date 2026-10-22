// node --test tools/recovery-v1/script2/rec_backup.test.mjs
// Script 2 / RECOVERY tester: damaged, forged, truncated, missing-part, re-ordered, stale and untrusted backups against
// backup-archive.mjs, restore-verification.mjs, email-archive-adapter.mjs and deploy/lucashome/backup/email-unpack.py.
// Synthetic keys (memory only) and synthetic bytes only. No network, no mail, no database. Writes a results JSON to
// $REC_EVIDENCE_DIR (default: a fresh /private/tmp/s2r-backup.* directory).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openBackup, publicKeyId, sealBackup } from '../backup-archive.mjs';
import { backupAssessmentInput, deliverToSimulatedRecipient, verifyBackupArchive, verifyWalCoverage, expectedWalFiles } from '../restore-verification.mjs';
import { packageEmailArchive } from '../email-archive-adapter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const EV = process.env.REC_EVIDENCE_DIR ?? mkdtempSync('/private/tmp/s2r-backup.');
mkdirSync(EV, { recursive: true });
const results = [];
const rec = (id, scenario, expected, actual, status) => results.push({ id, scenario, expected, actual, status });
after(() => writeFileSync(join(EV, 'rec-backup-results.json'), JSON.stringify(results, null, 1) + '\n'));

const sha = (b) => createHash('sha256').update(b).digest('hex');
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const provenance = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const otherRecipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const pins = new Map([[publicKeyId(provenance.publicKey), provenance.publicKey]]);
const now = new Date('2026-10-21T05:00:00.000Z');
const boundary = { streamId: 'rec-stream', sequence: 0, digest: sha('rec') };
const meta = (x = {}) => ({ archiveId: 'rec-archive', orgId: 'org-rec', shopId: 'shop-rec', schemaVersion: '086', format: 'logical-pg-custom',
  recoveredAsOf: '2026-10-21T04:00:00.000Z', evidenceBoundary: boundary, provenanceCustody: 'local-test', decryptionCustody: 'local-test', ...x });
const logicalFiles = () => ({ 'postgres.dump': Buffer.from('PGDMP synthetic'), '_supabase.dump': Buffer.from('PGDMP synthetic'),
  'globals.sql': Buffer.from('-- g'), 'db-settings.sql': Buffer.from('-- s'), 'counts.json': Buffer.from('{"sales":3}') });
const seal = (m = meta(), files = logicalFiles(), key = provenance.privateKey, rcpt = recipient.publicKey) =>
  sealBackup({ metadata: m, files, recipientPublicKey: rcpt, provenancePrivateKey: key });
const verify = (envelope, x = {}) => verifyBackupArchive({ envelope, trustedProvenanceKeys: pins, recipientPrivateKey: recipient.privateKey,
  expectedOrgId: 'org-rec', expectedShopId: 'shop-rec', now, ...x });
const codes = (r) => r.findings.map((f) => f.code);
const clone = (o) => JSON.parse(JSON.stringify(o));
// re-sign a modified body with a key (simulates a compromised packager that still holds the pinned provenance key)
import { sign } from 'node:crypto';
import { canonicalJSON } from '../backup-archive.mjs';
const resign = (env, key = provenance.privateKey) => ({ body: env.body, signature: sign(null, Buffer.from(canonicalJSON(env.body)), key).toString('base64') });

test('r10 corrupted ciphertext: unsigned corruption, and corruption re-signed by the pinned packager key', () => {
  const env = seal(); const c = clone(env);
  const i = Math.floor(c.body.ciphertext.length / 2); c.body.ciphertext = c.body.ciphertext.slice(0, i) + (c.body.ciphertext[i] === 'A' ? 'B' : 'A') + c.body.ciphertext.slice(i + 1);
  const r1 = verify(c); const r2 = verify(resign(c));
  const ok = r1.state === 'QUARANTINED' && codes(r1).includes('PROVENANCE_SIGNATURE_INVALID') && r2.state === 'QUARANTINED' && r2.integrity !== 'verified';
  rec('r10', 'corrupted ciphertext (plain, and re-signed by the pinned key)', 'QUARANTINED both; GCM tag stops the re-signed one',
    `plain=${r1.state}/${codes(r1)} resigned=${r2.state}/${codes(r2)}`, ok ? 'PASS' : 'FAIL');
  assert.ok(ok);
});

test('r11 wrong decryption key and wrong recipient', () => {
  const r = verifyBackupArchive({ envelope: seal(), trustedProvenanceKeys: pins, recipientPrivateKey: otherRecipient.privateKey, expectedOrgId: 'org-rec', expectedShopId: 'shop-rec', now });
  const c = clone(seal()); c.body.wrappedKey = seal(meta(), logicalFiles(), provenance.privateKey, otherRecipient.publicKey).body.wrappedKey;
  const r2 = verify(resign(c));
  const ok = r.state === 'QUARANTINED' && codes(r).includes('RECIPIENT_KEY_MISMATCH') && r2.state === 'QUARANTINED';
  rec('r11', 'wrong recipient private key / data key wrapped for another recipient', 'QUARANTINED, no plaintext', `wrong_key=${codes(r)} swapped_wrap=${codes(r2)}`, ok ? 'PASS' : 'FAIL');
  assert.ok(ok);
});

test('r12 untrusted provenance: unpinned signer, pinned id with foreign signature, server-produced content', () => {
  const forged = seal(meta(), logicalFiles(), attacker.privateKey);
  const r1 = verify(forged);
  const claim = clone(seal()); const r2 = verify({ body: claim.body, signature: resign(claim, attacker.privateKey).signature });
  const infra = verify(seal(meta({ provenanceCustody: 'infrastructure-source' })));
  const ok = codes(r1).includes('PROVENANCE_KEY_NOT_PINNED') && codes(r2).includes('PROVENANCE_SIGNATURE_INVALID')
    && infra.authenticity === 'unverified' && codes(infra).includes('CONTENT_PRODUCED_BY_INFRASTRUCTURE_PROVENANCE_UNVERIFIED')
    && backupAssessmentInput(infra, { orgId: 'org-rec', shopId: 'shop-rec' }).authenticity === 'unverified';
  rec('r12', 'backup from a compromised server: unpinned key, forged signature under a pinned key id, infrastructure-produced archive',
    'refused / authenticity unverified', `unpinned=${codes(r1)[0]} forged=${codes(r2)[0]} infra.authenticity=${infra.authenticity}`, ok ? 'PASS' : 'FAIL');
  assert.ok(ok);
});

test('r12b compromised holder of a pinned provenance key self-labels a server dump as local-test', () => {
  const r = verify(seal(meta({ provenanceCustody: 'local-test' })));
  const a = backupAssessmentInput(r, { orgId: 'org-rec', shopId: 'shop-rec' });
  rec('r12b', 'pinned-key holder labels a logical (production-format) archive provenanceCustody=local-test',
    'a self-asserted label never upgrades authenticity for a production format', `assessment.authenticity=${a.authenticity} findings has PROVENANCE_LOCAL_TEST_LABEL_SYNTHETIC_ONLY=${codes(r).includes('PROVENANCE_LOCAL_TEST_LABEL_SYNTHETIC_ONLY')}`,
    a.authenticity === 'verified' ? 'LIMITATION' : 'PASS');
});

test('r13 truncated / empty / malformed archives', () => {
  const env = seal();
  const t1 = clone(env); t1.body.ciphertext = t1.body.ciphertext.slice(0, Math.floor(t1.body.ciphertext.length / 3) * 2);
  const t2 = clone(env); delete t2.signature;
  const text = JSON.stringify(env); let parsed = null, parseError = null;
  try { parsed = JSON.parse(text.slice(0, Math.floor(text.length * 0.7))); } catch (e) { parseError = e.name; }
  const r1 = verify(resign(t1)), r2 = verify(t2), r3 = verify(null), r4 = verify({});
  const ok = r1.state === 'QUARANTINED' && r2.state === 'QUARANTINED' && r3.state === 'QUARANTINED' && codes(r3).includes('ARCHIVE_MISSING') && r4.state === 'QUARANTINED' && parsed === null;
  rec('r13', 'truncated ciphertext (re-signed), missing signature, truncated file, missing archive', 'all QUARANTINED, nothing restored',
    `trunc=${codes(r1)} nosig=${codes(r2)} file_parse=${parseError} missing=${codes(r3)} empty=${codes(r4)}`, ok ? 'PASS' : 'FAIL');
  assert.ok(ok);
});

test('r14 missing archive components (logical layout)', () => {
  const f = logicalFiles(); delete f['_supabase.dump']; delete f['counts.json'];
  const r = verify(seal(meta(), f));
  const ok = codes(r).includes('COMPONENT_MISSING:_supabase.dump') && codes(r).includes('COMPONENT_MISSING:counts.json') && r.coverage === 'incomplete' && r.state !== 'ACTIVE';
  rec('r14', 'archive without _supabase.dump and counts.json', 'COMPONENT_MISSING findings, coverage incomplete, never ACTIVE', `${r.state} ${r.coverage} ${codes(r).filter((c) => c.startsWith('COMPONENT'))}`, ok ? 'PASS' : 'FAIL');
  assert.ok(ok);
});

test('r14b counts.json is required but never compared with the restored/dumped contents', () => {
  const f = logicalFiles(); f['counts.json'] = Buffer.from('{"sales":999999,"sale_items":"garbage"}');
  const r = verify(seal(meta(), f));
  rec('r14b', 'counts.json that contradicts the dump', 'mismatch finding', `findings=${codes(r).filter((c) => /COUNT/.test(c))} state=${r.state}`,
    codes(r).some((c) => /COUNT/.test(c)) ? 'PASS' : 'LIMITATION');
});

test('r15 email archive parts: missing, re-ordered, truncated, extra, corrupted, consistently forged, newest withheld', () => {
  const dir = mkdtempSync('/private/tmp/s2r-email.');
  const unpack = join(ROOT, 'deploy/lucashome/backup/email-unpack.py');
  const mk = (id, payload, partBytes = 100) => {
    const d = join(dir, id + '-' + randomBytes(3).toString('hex')); mkdirSync(d);
    const parts = []; for (let i = 0; i * partBytes < payload.length; i++) parts.push(payload.subarray(i * partBytes, (i + 1) * partBytes));
    const index = { archive_id: id, part_count: parts.length, total_bytes: payload.length, total_sha256: sha(payload),
      parts: parts.map((p, i) => ({ n: i + 1, file: `${id}.tar.gpg.${String(i + 1).padStart(3, '0')}`, bytes: p.length, sha256: sha(p) })) };
    parts.forEach((p, i) => writeFileSync(join(d, index.parts[i].file), p));
    writeFileSync(join(d, `${id}.index.json`), JSON.stringify(index));
    return { d, index, parts };
  };
  const runU = (...args) => { const p = spawnSync('python3', ['-I', unpack, ...args], { encoding: 'utf8' }); return { rc: p.status, out: (p.stdout + p.stderr).trim().split('\n').slice(-2).join(' | ') }; };
  const payload = randomBytes(450);
  const good = mk('orvix-2026-W43', payload); const rGood = runU(good.d);
  const miss = mk('orvix-2026-W43', payload); rmSync(join(miss.d, miss.index.parts[2].file)); const rMiss = runU(miss.d);
  const reo = mk('orvix-2026-W43', payload); writeFileSync(join(reo.d, reo.index.parts[0].file), reo.parts[1]); writeFileSync(join(reo.d, reo.index.parts[1].file), reo.parts[0]); const rReo = runU(reo.d);
  const tr = mk('orvix-2026-W43', payload); writeFileSync(join(tr.d, tr.index.parts[4].file), tr.parts[4].subarray(0, 10)); const rTr = runU(tr.d);
  const ex = mk('orvix-2026-W43', payload); writeFileSync(join(ex.d, 'orvix-2026-W43.tar.gpg.009'), Buffer.from('extra')); const rEx = runU(ex.d);
  const co = mk('orvix-2026-W43', payload); const bad = Buffer.from(co.parts[1]); bad[5] ^= 1; writeFileSync(join(co.d, co.index.parts[1].file), bad); const rCo = runU(co.d);
  const forged = mk('orvix-2026-W43', randomBytes(300)); const rForged = runU(forged.d);
  const w42 = mk('orvix-2026-W42', randomBytes(200)); const rWithheld = runU(w42.d);
  const detected = [rMiss, rReo, rTr, rEx, rCo].every((r) => r.rc === 1);
  rec('r15', 'email parts missing / re-ordered / truncated / extra / corrupted', 'email-unpack exits 1 for each',
    `good=${rGood.rc} missing=${rMiss.rc} reordered=${rReo.rc} truncated=${rTr.rc} extra=${rEx.rc} corrupted=${rCo.rc}`, detected && rGood.rc === 0 ? 'PASS' : 'FAIL');
  rec('r15b', 'consistently forged parts + index (anyone may encrypt to the owner PUBLIC key; index is unsigned)', 'provenance unverifiable at unpack',
    `forged archive accepted rc=${rForged.rc}; producer authenticity is only labelled (EMAIL_ARCHIVE_PRODUCER_IS_INFRASTRUCTURE)`, 'LIMITATION');
  rec('r15c', 'newest week withheld from the mailbox', 'latestness not established', `older W42 accepted rc=${rWithheld.rc}: "${rWithheld.out.slice(0, 80)}" (no newer-archive check)`, 'LIMITATION');
  rmSync(dir, { recursive: true, force: true });
  assert.ok(detected && rGood.rc === 0);
});

test('r16 email-archive adapter refuses a tampered tree and labels server provenance', () => {
  const dir = mkdtempSync('/private/tmp/s2r-tree.');
  const files = { 'db/postgres.dump': Buffer.from('PGDMP p'), 'db/_supabase.dump': Buffer.from('PGDMP s'), 'db/globals.sql': Buffer.from('-- g'),
    'db/db-settings.sql': Buffer.from('-- s'), 'db/counts.json': Buffer.from('{}') };
  for (const [p, b] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), b); }
  writeFileSync(join(dir, 'SHA256SUMS'), Object.keys(files).sort().map((p) => `${sha(files[p])} *${p}`).join('\n') + '\n');
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({ archive_id: 'orvix-2026-W43', created_at: '2026-10-21T04:00:00Z', files: Object.keys(files).map((p) => ({ path: p, bytes: files[p].length, sha256: sha(files[p]) })) }));
  writeFileSync(join(dir, 'db/postgres.dump'), 'PGDMP tampered');
  const r = packageEmailArchive({ dir, orgId: 'org-rec', shopId: 'shop-rec', schemaVersion: '086', evidenceBoundary: boundary, decryptionCustody: 'local-test',
    recipientPublicKey: recipient.publicKey, provenancePrivateKey: provenance.privateKey });
  const ok = r.packaged === false && r.findings.some((f) => f.code === 'SHA256_MISMATCH:db/postgres.dump');
  rec('r16', 'extracted email archive tree modified after SHA256SUMS', 'packaging refused', `packaged=${r.packaged} ${r.findings.filter((f) => f.severity === 'quarantine').map((f) => f.code)}`, ok ? 'PASS' : 'FAIL');
  rmSync(dir, { recursive: true, force: true });
  assert.ok(ok);
});

test('r17 replayed old (but authentic) archive presented as the latest', () => {
  const fresh = verify(seal(meta({ recoveredAsOf: '2026-10-20T06:00:00.000Z' })));
  const stale = verify(seal(meta({ recoveredAsOf: '2026-10-10T06:00:00.000Z' })));
  rec('r17', 'authentic archive 23 h old replayed instead of a newer one; 11 days old', 'latestness never established; stale finding past 26 h',
    `23h: findings_has_stale=${codes(fresh).includes('BACKUP_STALE_UNKNOWN_LOST_TAIL')} state=${fresh.state}; 11d: stale=${codes(stale).includes('BACKUP_STALE_UNKNOWN_LOST_TAIL')}`,
    codes(stale).includes('BACKUP_STALE_UNKNOWN_LOST_TAIL') ? 'LIMITATION' : 'FAIL');
  assert.ok(codes(stale).includes('BACKUP_STALE_UNKNOWN_LOST_TAIL'));
});

test('r18 physical base backup + WAL: missing middle segment, zero-filled segment of the right size, wrong size', () => {
  const seg = 16 * 1024 * 1024;
  const wal = { timeline: 1, startLsn: '0/2000028', endLsnExclusive: '0/6000000', segmentBytes: seg };
  const names = expectedWalFiles(wal);
  const real = (n) => { const b = Buffer.alloc(seg); b.writeUInt16LE(0xD113, 0); b.write(n, 64); return b; };   // stand-in (only names/sizes are checked)
  const all = new Map(names.map((n) => [`wal/${n}`, real(n)]));
  const missing = new Map(all); missing.delete(`wal/${names[1]}`);
  const zeroed = new Map(all); zeroed.set(`wal/${names[1]}`, Buffer.alloc(seg));
  const short = new Map(all); short.set(`wal/${names[1]}`, Buffer.alloc(1024));
  const m = verifyWalCoverage(missing, wal), z = verifyWalCoverage(zeroed, wal), s = verifyWalCoverage(short, wal);
  rec('r18a', 'WAL coverage with the middle segment deleted', 'REQUIRED_WAL_MISSING', `${m.status} ${m.missing}`, m.status === 'incomplete' && m.findings.some((f) => f.code === 'REQUIRED_WAL_MISSING') ? 'PASS' : 'FAIL');
  rec('r18b', 'WAL coverage with a zero-filled (or any garbage) segment of exactly 16 MiB', 'segment content validated (pg_waldump / page magic)', `status=${z.status} (names and sizes only)`,
    z.status === 'verified' ? 'FAIL' : 'PASS');
  rec('r18c', 'WAL segment of the wrong size', 'WAL_SEGMENT_SIZE_INVALID quarantine', `${s.status} ${s.findings.map((f) => f.code)}`, s.findings.some((f) => f.code === 'WAL_SEGMENT_SIZE_INVALID') ? 'PASS' : 'FAIL');
  // a small (1 MiB-segment) physical set, so that the archive itself stays openable (see r18e)
  const wal1 = { timeline: 1, startLsn: '0/100028', endLsnExclusive: '0/300000', segmentBytes: 1024 * 1024 };
  const n1 = expectedWalFiles(wal1);
  const zfiles = Object.fromEntries(n1.map((n, i) => [`wal/${n}`, i === 1 ? Buffer.alloc(wal1.segmentBytes) : (() => { const b = Buffer.alloc(wal1.segmentBytes); b.writeUInt16LE(0xD113, 0); return b; })()]));
  const phys = verify(seal(meta({ format: 'physical-pg-base', wal: wal1 }), { 'backup.json': Buffer.from('{}'), 'base.tar.gz': Buffer.from('x'), backup_label: Buffer.from('START WAL LOCATION: 0/100028'), ...zfiles }));
  rec('r18d', 'physical archive whose middle WAL segment is zero-filled', 'never verified for PITR; WAL content problem reported',
    `state=${phys.state} coverage=${phys.coverage} findings=${codes(phys).filter((c) => /WAL|PHYSICAL/.test(c))} (no WAL-content finding; only the generic PHYSICAL_BASE_RESTORE_VERIFIER_UNSUPPORTED keeps it from 'verified')`,
    phys.coverage !== 'verified' && codes(phys).includes('PHYSICAL_BASE_RESTORE_VERIFIER_UNSUPPORTED') ? (codes(phys).some((c) => /WAL/.test(c)) ? 'PASS' : 'LIMITATION') : 'FAIL');
  assert.equal(m.status, 'incomplete');
  assert.notEqual(z.status, 'verified', 'DEFECT r18b: WAL coverage accepts a zero-filled segment of the right size');
});

test('r18e an authentic archive of realistic size (6 MB) cannot be opened', () => {
  const big = logicalFiles(); big['postgres.dump'] = Buffer.concat([Buffer.from('PGDMP'), randomBytes(6 * 1024 * 1024)]);
  const r = verify(seal(meta(), big));
  let direct = null; try { openBackup({ envelope: seal(meta(), big), trustedProvenanceKeys: pins, recipientPrivateKey: recipient.privateKey, expectedOrgId: 'org-rec', expectedShopId: 'shop-rec' }); direct = 'opened'; } catch (e) { direct = e.message; }
  rec('r18e', 'authentic, untampered 6 MB logical archive (well under MAX_ARCHIVE_BYTES = 256 MiB)', 'opens and verifies',
    `state=${r.state} findings=${codes(r)} openBackup error="${direct}" (base64 validation regex in decode() overflows the stack above ~4-8 M chars)`, r.integrity === 'verified' ? 'PASS' : 'FAIL');
  assert.equal(r.integrity, 'verified', 'DEFECT r18e: authentic archives above a few MB cannot be opened');
});

test('r19 decryption never releases unauthenticated bytes; tenant label mismatch refused', () => {
  const env = seal();
  let threw = null; try { openBackup({ envelope: env, trustedProvenanceKeys: pins, recipientPrivateKey: recipient.privateKey, expectedOrgId: 'org-other', expectedShopId: 'shop-rec' }); } catch (e) { threw = e.message; }
  rec('r19', 'archive opened for another organization', 'BACKUP_TENANT_MISMATCH', String(threw), threw === 'BACKUP_TENANT_MISMATCH' ? 'PASS' : 'FAIL');
  assert.equal(threw, 'BACKUP_TENANT_MISMATCH');
});

test('r20 simulated mailbox only: no transport, availability never established', () => {
  const box = mkdtempSync('/private/tmp/s2r-mailbox.');
  const env = seal(); const d = deliverToSimulatedRecipient({ envelope: env, recipientDirectory: box });
  let again = null; try { deliverToSimulatedRecipient({ envelope: env, recipientDirectory: box }); } catch (e) { again = e.code; }
  const src = ['restore-verification.mjs', 'email-archive-adapter.mjs', 'backup-archive.mjs'].map((f) => readFileSync(join(HERE, '..', f), 'utf8')).join('\n');
  const transports = (src.match(/from ['"](node:)?(net|http|https|tls|dgram|child_process)['"]|nodemailer|smtp/gi) ?? []);
  const ok = d.simulated === true && d.independentAvailabilityEstablished === false && again === 'EEXIST';
  rec('r20', 'email adapter / delivery', 'simulated mailbox only; real offsite delivery unverified', `simulated=${d.simulated} availability=${d.independentAvailabilityEstablished} redeliver=${again} imports=${transports.join(',') || 'none'} (child_process only runs pg_restore)`,
    ok ? 'PASS' : 'FAIL');
  rmSync(box, { recursive: true, force: true });
  assert.ok(ok);
});
