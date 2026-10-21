#!/usr/bin/env node
/** Synthetic fixtures ONLY. Keys exist only in memory; this tool cannot send email or contact a DB. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { openBackup, publicKeyId, sealBackup, sha256 } from './backup-archive.mjs';
import { deliverToSimulatedRecipient, validateLogicalDump } from './restore-verification.mjs';

const [inputDump, outputDump, recipientDirectory, pgRestorePath] = process.argv.slice(2);
if (!inputDump || !outputDump || !recipientDirectory || !pgRestorePath || ![inputDump, outputDump, recipientDirectory, pgRestorePath].every(isAbsolute)) {
  throw new Error('Usage: node backup-fixture-roundtrip.mjs ABS_SYNTHETIC_DUMP ABS_NEW_OUTPUT ABS_NEW_SIMULATED_MAILBOX ABS_PG_RESTORE');
}
const sourceStat = lstatSync(inputDump);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('SYNTHETIC_INPUT_REGULAR_FILE_REQUIRED');
const bytes = readFileSync(inputDump);
assert.equal(validateLogicalDump(inputDump, pgRestorePath).status, 'verified');
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const provenance = generateKeyPairSync('ed25519');
const metadata = {
  archiveId: 'synthetic-isolated-pg-fixture', orgId: 'synthetic-org', shopId: 'synthetic-shop', schemaVersion: '085',
  format: 'synthetic-test-fixture', recoveredAsOf: new Date().toISOString(),
  evidenceBoundary: { streamId: 'synthetic-not-financial', sequence: 0, digest: sha256('synthetic-no-financial-boundary') },
  provenanceCustody: 'local-test', decryptionCustody: 'local-test',
};
const envelope = sealBackup({ metadata, files: { 'fixture.dump': bytes }, recipientPublicKey: recipient.publicKey, provenancePrivateKey: provenance.privateKey });
mkdirSync(recipientDirectory, { mode: 0o700 });
const delivery = deliverToSimulatedRecipient({ envelope, recipientDirectory });
const received = JSON.parse(readFileSync(delivery.path, 'utf8'));
const opened = openBackup({ envelope: received, trustedProvenanceKeys: new Map([[publicKeyId(provenance.publicKey), provenance.publicKey]]), recipientPrivateKey: recipient.privateKey,
  expectedOrgId: metadata.orgId, expectedShopId: metadata.shopId });
const restored = opened.files.get('fixture.dump');
assert.deepEqual(restored, bytes);
writeFileSync(outputDump, restored, { flag: 'wx', mode: 0o600 });
assert.equal(validateLogicalDump(outputDump, pgRestorePath).status, 'verified');
const report = { protocol: 'orvix-synthetic-encrypted-dump-smoke-v1', encryptedRoundTrip: true, pgRestoreReadAll: true,
  byteEquality: true, inputBytes: bytes.length, inputSha256: sha256(bytes), outputSha256: sha256(restored), simulatedRecipient: true,
  databaseRestoreExecutedByThisTool: false, fullSupabaseRestoreVerified: false, independentAvailabilityEstablished: false, productionKeysCreated: false };
writeFileSync(join(recipientDirectory, 'SYNTHETIC-ROUNDTRIP.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report)}\n`);
bytes.fill(0); restored.fill(0);
