/** Read-only verification and explicit evidence preservation; no DB/compose/network calls. */
import { chmodSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { canonicalJSON, openBackup, sha256 } from './backup-archive.mjs';

const REQUIRED_LOGICAL = ['postgres.dump', '_supabase.dump', 'globals.sql', 'db-settings.sql', 'counts.json'];
export const PRESERVATION_CATEGORIES = ['later-wal', 'later-dump', 'damaged-data', 'logs', 'offline-evidence'];

function finding(code, severity = 'blocked') { return { code, severity }; }

function outsideDirectory(root, candidate) {
  const path = relative(root, candidate);
  return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
}

export function expectedWalFiles({ timeline, startLsn, endLsnExclusive, segmentBytes }) {
  if (!Number.isInteger(timeline) || timeline < 1 || timeline > 0xffffffff
    || !Number.isInteger(segmentBytes) || segmentBytes < 1024 * 1024 || segmentBytes > 1024 * 1024 * 1024
    || (segmentBytes & (segmentBytes - 1)) !== 0) throw new Error('INVALID_WAL_RANGE');
  const parse = (lsn) => {
    if (typeof lsn !== 'string' || !/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(lsn)) throw new Error('INVALID_WAL_LSN');
    const [high, low] = lsn.split('/');
    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  const start = parse(startLsn), end = parse(endLsnExclusive), segment = BigInt(segmentBytes);
  if (end <= start) throw new Error('INVALID_WAL_RANGE');
  const first = start / segment, last = (end - 1n) / segment;
  if (last - first >= 10000n) throw new Error('WAL_RANGE_TOO_LARGE');
  const perLog = 0x100000000n / segment;
  const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');
  return Array.from({ length: Number(last - first + 1n) }, (_, i) => {
    const n = first + BigInt(i);
    return `${hex(BigInt(timeline))}${hex(n / perLog)}${hex(n % perLog)}`;
  });
}

export function verifyWalCoverage(files, requirement) {
  try {
    // An explicitly chosen single timeline is required. Cross-timeline PITR needs history verification, unsupported here.
    if (requirement.timelineHistory?.length) return { status: 'unsupported', findings: [finding('CROSS_TIMELINE_WAL_UNSUPPORTED')] };
    const required = expectedWalFiles(requirement);
    const missing = [], damaged = [];
    for (const name of required) {
      const bytes = files.get(`wal/${name}`);
      if (!bytes) missing.push(name);
      else if (bytes.length !== requirement.segmentBytes) damaged.push(name);
    }
    return { status: missing.length || damaged.length ? 'incomplete' : 'verified', required, missing, damaged,
      findings: [...(missing.length ? [finding('REQUIRED_WAL_MISSING')] : []), ...(damaged.length ? [finding('WAL_SEGMENT_SIZE_INVALID', 'quarantine')] : [])] };
  } catch { return { status: 'unknown', findings: [finding('WAL_REQUIREMENT_INVALID')] }; }
}

/** pg_restore reads every dump block and writes SQL to /dev/null. It never connects to a DB. */
export function validateLogicalDump(dumpPath, pgRestorePath) {
  if (!isAbsolute(pgRestorePath) || !existsSync(pgRestorePath)) return { status: 'blocked', code: 'PG_RESTORE_UNAVAILABLE' };
  const result = spawnSync(pgRestorePath, ['--file=/dev/null', '--', resolve(dumpPath)], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    env: { PATH: dirname(pgRestorePath), LANG: 'C', LC_ALL: 'C' },
  });
  return result.status === 0 ? { status: 'verified', code: 'DUMP_BLOCKS_READABLE' } : { status: 'damaged', code: 'DUMP_UNREADABLE' };
}

function inspectContents(opened, options) {
  const { files, metadata } = opened, findings = [];
  let coverage = 'unknown';
  const dumpReadability = {};
  if (metadata.format === 'synthetic-test-fixture') {
    findings.push(finding('SYNTHETIC_FIXTURE_NOT_A_DATABASE_BACKUP'));
    if (!files.size) findings.push(finding('BACKUP_EMPTY', 'quarantine'));
  } else if (metadata.format === 'logical-pg-custom') {
    const prefix = files.has('MANIFEST.json') ? 'db/' : '';
    for (const name of REQUIRED_LOGICAL) {
      if (!files.get(`${prefix}${name}`)?.length) { findings.push(finding(`COMPONENT_MISSING:${name}`)); coverage = 'incomplete'; }
    }
    for (const name of ['postgres.dump', '_supabase.dump']) {
      const bytes = files.get(`${prefix}${name}`);
      if (bytes && bytes.subarray(0, 5).toString('ascii') !== 'PGDMP') findings.push(finding(`DUMP_HEADER_INVALID:${name}`, 'quarantine'));
    }
    findings.push(finding('ISOLATED_DATABASE_RESTORE_NOT_PERFORMED'));
    findings.push(finding('LOGICAL_DUMP_HAS_NO_WAL_REPLAY_COVERAGE'));
    // Content hashes prove retention, not source truth, dump completeness or actual restored invariants.
    if (!options.pgRestorePath) findings.push(finding('LOGICAL_DUMP_READ_ALL_REQUIRED'));
    else {
      const scratch = mkdtempSync(join(tmpdir(), 'orvix-dump-readonly-'));
      try {
        for (const database of ['postgres', '_supabase']) {
          const bytes = files.get(`${prefix}${database}.dump`);
          if (!bytes) continue;
          const path = join(scratch, `${database}.dump`);
          writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
          dumpReadability[database] = validateLogicalDump(path, options.pgRestorePath);
          if (dumpReadability[database].status !== 'verified') findings.push(finding(`${dumpReadability[database].code}:${database}`, dumpReadability[database].status === 'damaged' ? 'quarantine' : 'blocked'));
        }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
  } else if (metadata.format === 'physical-pg-base') {
    for (const name of ['backup.json', 'base.tar.gz', 'backup_label']) {
      if (!files.get(name)?.length) findings.push(finding(`COMPONENT_MISSING:${name}`));
    }
    const wal = metadata.wal ? verifyWalCoverage(files, metadata.wal) : { status: 'unknown', findings: [finding('WAL_REQUIREMENT_MISSING')] };
    findings.push(...wal.findings);
    // Existing dr-verify-restore.sh supports only logical/unpacked email layouts. Never call it for a base set.
    findings.push(finding('PHYSICAL_BASE_RESTORE_VERIFIER_UNSUPPORTED'));
    if (wal.status !== 'verified') coverage = 'incomplete';
  }
  return { coverage, findings, dumpReadability };
}

/** Successful cryptographic verification always leaves financial completeness UNKNOWN. */
export function verifyBackupArchive(options) {
  const report = {
    protocol: 'orvix-backup-verification-v1', orgId: options.expectedOrgId, shopId: options.expectedShopId,
    authenticity: 'unverified', integrity: options.envelope ? 'damaged' : 'missing', coverage: 'unknown',
    state: 'QUARANTINED', reopenAuthorized: false, findings: [], availability: 'not-established',
    completeness: 'unknown', restoreExecuted: false,
  };
  if (!options.envelope) { report.findings.push(finding('ARCHIVE_MISSING')); return report; }
  let opened;
  try {
    opened = openBackup(options);
    report.authenticity = 'verified'; report.integrity = 'verified'; report.state = 'RESTRICTED';
    report.orgId = opened.metadata.orgId; report.shopId = opened.metadata.shopId;
    report.archiveDigest = opened.archiveDigest; report.evidenceBoundary = opened.metadata.evidenceBoundary;
    report.recoveredAsOf = opened.metadata.recoveredAsOf; report.format = opened.metadata.format;
    report.provenanceCustody = opened.metadata.provenanceCustody; report.decryptionCustody = opened.metadata.decryptionCustody;
    const contents = inspectContents(opened, options);
    report.coverage = contents.coverage; report.findings.push(...contents.findings);
    report.dumpReadability = contents.dumpReadability;
    const now = options.now ?? new Date();
    const age = now.getTime() - Date.parse(opened.metadata.recoveredAsOf);
    const maximum = options.maxAgeMs ?? 26 * 60 * 60 * 1000;
    if (!Number.isFinite(age) || !Number.isSafeInteger(maximum) || maximum <= 0) report.findings.push(finding('BACKUP_FRESHNESS_POLICY_INVALID'));
    else if (age < -5 * 60 * 1000) report.findings.push(finding('BACKUP_TIME_IN_FUTURE', 'quarantine'));
    else if (age > maximum) report.findings.push(finding('BACKUP_STALE_UNKNOWN_LOST_TAIL'));
    report.signatureVerified = true;
    if (opened.metadata.provenanceCustody === 'infrastructure-source') {
      // The signature authenticates the PACKAGER; the contents came from the infrastructure.
      report.authenticity = 'unverified';
      report.findings.push(finding('CONTENT_PRODUCED_BY_INFRASTRUCTURE_PROVENANCE_UNVERIFIED'));
    }
    if (opened.metadata.provenanceCustody === 'local-test') report.findings.push(finding('PROVENANCE_LOCAL_TEST_LABEL_SYNTHETIC_ONLY'));
    // Tenant fields bind the LABEL, not the contents: a logical dump holds every tenant.
    if (opened.metadata.format !== 'synthetic-test-fixture') report.findings.push(finding('TENANT_LABEL_ONLY_CONTENTS_MAY_INCLUDE_OTHER_TENANTS'));
    report.findings.push(finding('INDEPENDENT_KEY_CUSTODY_NOT_PROVEN'));
    report.findings.push(finding('OFFSITE_SURVIVAL_NOT_PROVEN'));
    report.findings.push(finding('BACKUP_AUTHENTICITY_IS_NOT_FINANCIAL_COMPLETENESS'));
    if (report.findings.some((f) => f.severity === 'quarantine')) { report.state = 'QUARANTINED'; report.coverage = 'incomplete'; }
  } catch (error) {
    report.state = 'QUARANTINED';
    const code = typeof error?.message === 'string' && /^[A-Z0-9_:.-]+$/.test(error.message) ? error.message : 'ARCHIVE_CRYPTOGRAPHIC_VERIFICATION_FAILED';
    report.findings.push(finding(code, 'quarantine'));
  } finally {
    if (opened) for (const bytes of opened.files.values()) bytes.fill(0);
  }
  return report;
}

/** Adapter for src/recovery/assessment.ts; bind scope before passing caller-supplied reports. */
export function backupAssessmentInput(report, { orgId, shopId }) {
  if (report.protocol !== 'orvix-backup-verification-v1' || report.orgId !== orgId || report.shopId !== shopId) return { authenticity: 'unverified', integrity: 'missing', coverage: 'unknown' };
  // Allow-list: only an explicitly non-infrastructure producer label can count as authentic. A
  // missing label, a server-produced archive ('infrastructure-source') or anything unknown is
  // unverified. 'local-test' is a synthetic-fixture label (it carries its own finding).
  const authenticity = report.authenticity === 'verified' && report.provenanceCustody === 'local-test' ? 'verified' : 'unverified';
  return { authenticity, integrity: report.integrity, coverage: report.coverage };
}

function inventoryTree(source, category, prefix = '') {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('EVIDENCE_LINK_OR_SPECIAL_FILE_REFUSED');
  if (stat.isFile()) return [{ source, category, relativePath: prefix || 'evidence.bin', bytes: stat.size }];
  return readdirSync(source).sort().flatMap((name) => inventoryTree(join(source, name), category, prefix ? `${prefix}/${name}` : name));
}

/** Pure read-only plan. It never stops writers, freezes pruning, mutates a source, or authorizes restore. */
export function planEvidencePreservation({ items, incidentDirectory, availableBytes }) {
  if (!isAbsolute(incidentDirectory) || existsSync(incidentDirectory)) throw new Error('FRESH_INCIDENT_DIRECTORY_REQUIRED');
  const seen = new Set();
  const inventory = items.flatMap(({ source, category }) => {
    if (!PRESERVATION_CATEGORIES.includes(category) || seen.has(category)) throw new Error('INVALID_EVIDENCE_CATEGORY');
    seen.add(category);
    const absolute = resolve(source), destination = resolve(incidentDirectory);
    if (!isAbsolute(source) || !outsideDirectory(absolute, destination)) throw new Error('EVIDENCE_DESTINATION_INSIDE_SOURCE');
    return inventoryTree(absolute, category);
  });
  const requiredBytes = inventory.reduce((sum, f) => sum + f.bytes, 0);
  const disk = statfsSync(dirname(incidentDirectory));
  const observedAvailableBytes = disk.bavail * disk.bsize;
  // A caller may tighten the observed capacity for a reservation, never invent more free disk.
  const usableBytes = availableBytes === undefined ? observedAvailableBytes : Math.min(observedAvailableBytes, availableBytes);
  return {
    protocol: 'orvix-evidence-preservation-plan-v1', incidentDirectory, inventory, requiredBytes, observedAvailableBytes,
    missingCategories: PRESERVATION_CATEGORIES.filter((category) => !seen.has(category)),
    spaceVerified: Number.isSafeInteger(usableBytes) && usableBytes >= requiredBytes,
    sourceQuiescenceVerified: false, restoreAuthorized: false,
  };
}

/** Explicit local copies into a fresh incident directory; source evidence is never altered. */
export function preserveEvidence(plan) {
  if (plan.protocol !== 'orvix-evidence-preservation-plan-v1' || !plan.spaceVerified || existsSync(plan.incidentDirectory)) throw new Error('PRESERVATION_PREFLIGHT_REQUIRED');
  mkdirSync(plan.incidentDirectory, { mode: 0o700 });
  const entries = [];
  for (const item of plan.inventory) {
    const root = realpathSync(plan.incidentDirectory);
    const target = join(root, item.category, item.relativePath);
    if (resolve(target) === root || outsideDirectory(root, resolve(target))) throw new Error('INVALID_EVIDENCE_DESTINATION');
    const before = lstatSync(item.source);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('EVIDENCE_SOURCE_CHANGED');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(item.source, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    const source = readFileSync(item.source), copy = readFileSync(target), after = lstatSync(item.source);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256(source) !== sha256(copy)) throw new Error('EVIDENCE_SOURCE_CHANGED_OR_COPY_DAMAGED');
    entries.push({ category: item.category, path: `${item.category}/${item.relativePath}`, bytes: copy.length, sha256: sha256(copy) });
  }
  const manifest = { protocol: 'orvix-preserved-evidence-v1', entries, missingCategories: plan.missingCategories,
    sourceQuiescenceVerified: false, independentAttestation: false, restoreAuthorized: false };
  writeFileSync(join(plan.incidentDirectory, 'PRESERVATION.json'), `${canonicalJSON(manifest)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}

/** Local simulated mailbox: create-new files only; no email/HTTP/network transport exists here. */
export function deliverToSimulatedRecipient({ envelope, recipientDirectory }) {
  if (!isAbsolute(recipientDirectory) || !lstatSync(recipientDirectory).isDirectory() || lstatSync(recipientDirectory).isSymbolicLink()) throw new Error('SIMULATED_RECIPIENT_DIRECTORY_REQUIRED');
  const digest = sha256(canonicalJSON(envelope)), target = join(recipientDirectory, `${digest}.backup.json`);
  const descriptor = openSync(target, 'wx', 0o600);
  try { writeFileSync(descriptor, canonicalJSON(envelope)); } finally { closeSync(descriptor); }
  return { simulated: true, archiveDigest: digest, deliveredToDirectory: true, independentAvailabilityEstablished: false, path: target };
}
