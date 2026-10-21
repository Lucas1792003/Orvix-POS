/**
 * Adapter: existing weekly email archive (deploy/lucashome/backup/email-archive.sh) -> Recovery V1
 * sealed backup envelope (backup-archive.mjs), verifiable by restore-verification.mjs.
 *
 * Where it runs: on the OWNER'S device (or another independently controlled machine), AFTER
 *   email-unpack.py --out DIR <mails>      (reassembles + checks part/total hashes; never decrypts)
 *   gpg -d DIR/<id>.tar.gpg > <id>.tar     (owner's private key; check gpg's exit status first)
 *   tar -xf <id>.tar -C <tree>             (MANIFEST.json, SHA256SUMS, db/, files/, config/)
 * This module starts from that extracted <tree>. It never decrypts OpenPGP, never reads mail or
 * credentials, never contacts a database or network, and never generates keys: the caller supplies
 * the recipient public key and the provenance private key it already holds.
 *
 * What it proves and what it does not:
 * - It re-checks the archive's OWN integrity data (SHA256SUMS and MANIFEST.json, as written by
 *   email-archive.sh) and refuses links, special files, unlisted files and mismatches.
 * - The V1 provenance signature it adds attests to the PACKAGER (this device), not to whoever
 *   produced the email archive on the server. The archive's producer was the infrastructure.
 * - It establishes nothing about offsite survival, completeness of financial history, or latestness.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeArchivePath, sealBackup, sha256 } from './backup-archive.mjs';

const SUM_LINE = /^([a-f0-9]{64}) [ *](.+)$/;
const REQUIRED = ['db/postgres.dump', 'db/_supabase.dump', 'db/globals.sql', 'db/db-settings.sql', 'db/counts.json'];
const MAX_FILES = 10000;

function finding(code, severity = 'blocked') { return { code, severity }; }

/** Walk without following links; refuse anything that is not a regular file or directory. */
function walk(root, rel = '', out = []) {
  const here = rel ? join(root, rel) : root;
  for (const name of readdirSync(here).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`EMAIL_ARCHIVE_LINK_OR_SPECIAL_FILE_REFUSED:${path}`);
    if (stat.isDirectory()) walk(root, path, out);
    else out.push(path);
    if (out.length > MAX_FILES) throw new Error('EMAIL_ARCHIVE_TOO_MANY_FILES');
  }
  return out;
}

/** Read an extracted email archive tree and verify its own integrity data. Quarantine findings refuse packaging. */
export function readUnpackedEmailArchive(dir) {
  const findings = [];
  const paths = walk(dir);
  for (const p of paths) if (!safeArchivePath(p)) throw new Error(`EMAIL_ARCHIVE_UNSAFE_PATH:${p}`);
  if (!paths.includes('MANIFEST.json')) throw new Error('EMAIL_ARCHIVE_MANIFEST_MISSING');
  if (!paths.includes('SHA256SUMS')) throw new Error('EMAIL_ARCHIVE_SHA256SUMS_MISSING');
  const files = new Map(paths.map((p) => [p, readFileSync(join(dir, p))]));
  let manifest;
  try { manifest = JSON.parse(files.get('MANIFEST.json').toString('utf8')); } catch { throw new Error('EMAIL_ARCHIVE_MANIFEST_UNREADABLE'); }
  if (!manifest || typeof manifest.archive_id !== 'string' || typeof manifest.created_at !== 'string' || !Array.isArray(manifest.files)) throw new Error('EMAIL_ARCHIVE_MANIFEST_INVALID');

  // SHA256SUMS: every file except MANIFEST.json and SHA256SUMS itself, exactly once, matching.
  const sums = new Map();
  for (const line of files.get('SHA256SUMS').toString('utf8').split('\n').filter(Boolean)) {
    const m = SUM_LINE.exec(line);
    if (!m) { findings.push(finding('SHA256SUMS_LINE_INVALID', 'quarantine')); continue; }
    const path = m[2].replace(/^\.\//, '');
    if (sums.has(path)) findings.push(finding(`SHA256SUMS_DUPLICATE:${path}`, 'quarantine'));
    sums.set(path, m[1]);
  }
  for (const p of paths) {
    if (p === 'MANIFEST.json' || p === 'SHA256SUMS') continue;
    if (!sums.has(p)) findings.push(finding(`FILE_NOT_IN_SHA256SUMS:${p}`, 'quarantine'));
    else if (sha256(files.get(p)) !== sums.get(p)) findings.push(finding(`SHA256_MISMATCH:${p}`, 'quarantine'));
  }
  for (const p of sums.keys()) if (!files.has(p)) findings.push(finding(`LISTED_FILE_MISSING:${p}`, 'quarantine'));

  // MANIFEST.json files[]: size and sha256 as recorded by email-archive.sh.
  for (const entry of manifest.files) {
    const p = typeof entry?.path === 'string' ? entry.path.replace(/^\.\//, '') : null;
    if (!p || p === 'MANIFEST.json') continue;
    if (!files.has(p)) { findings.push(finding(`MANIFEST_FILE_MISSING:${p}`, 'quarantine')); continue; }
    if (entry.bytes !== files.get(p).length) findings.push(finding(`MANIFEST_SIZE_MISMATCH:${p}`, 'quarantine'));
    if (entry.sha256 !== null && entry.sha256 !== undefined && entry.sha256 !== sha256(files.get(p))) findings.push(finding(`MANIFEST_SHA256_MISMATCH:${p}`, 'quarantine'));
  }
  for (const r of REQUIRED) if (!files.get(r)?.length) findings.push(finding(`COMPONENT_MISSING:${r}`));
  findings.push(finding('EMAIL_ARCHIVE_PRODUCER_IS_INFRASTRUCTURE'));
  findings.push(finding('OPENPGP_LAYER_VERIFIED_BY_OWNER_GPG_NOT_BY_THIS_ADAPTER'));
  return { manifest, files, findings };
}

function isoMillis(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error('EMAIL_ARCHIVE_CREATED_AT_INVALID');
  return new Date(t).toISOString();
}

/**
 * Package a verified email-archive tree into a V1 envelope. Refuses on any quarantine finding.
 * `recipientPublicKey` / `provenancePrivateKey`: existing caller-held keys (no generation here).
 */
export function packageEmailArchive({ dir, orgId, shopId, schemaVersion, evidenceBoundary, decryptionCustody, recipientPublicKey, provenancePrivateKey }) {
  if (!['independently-held-required', 'local-test'].includes(decryptionCustody)) throw new Error('UNKNOWN_DECRYPTION_CUSTODY');
  const read = readUnpackedEmailArchive(dir);
  const refusing = read.findings.filter((f) => f.severity === 'quarantine');
  if (refusing.length) {
    for (const bytes of read.files.values()) bytes.fill(0);
    return { packaged: false, findings: read.findings };
  }
  const metadata = {
    archiveId: `email-${read.manifest.archive_id}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 160),
    orgId, shopId, schemaVersion, format: 'logical-pg-custom', recoveredAsOf: isoMillis(read.manifest.created_at),
    evidenceBoundary, provenanceCustody: 'infrastructure-source', decryptionCustody,
  };
  const files = Object.fromEntries(read.files);
  const manifestSha256 = sha256(read.files.get('MANIFEST.json'));
  try {
    const envelope = sealBackup({ metadata, files, recipientPublicKey, provenancePrivateKey });
    return { packaged: true, envelope, findings: read.findings, manifestSha256 };
  } finally {
    for (const bytes of read.files.values()) bytes.fill(0);
  }
}
