/** Local backup readiness primitives. This module never sends data or restores a database. */
import {
  constants, createCipheriv, createDecipheriv, createHash, createPublicKey,
  publicEncrypt, privateDecrypt, randomBytes, sign, verify,
} from 'node:crypto';

export const BACKUP_PROTOCOL = 'orvix-encrypted-backup-v1';
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function canonicalJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  throw new Error('NON_CANONICAL_VALUE');
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function publicKeyId(key) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  return sha256(publicKey.export({ type: 'spki', format: 'der' }));
}

function requireKey(key, type) {
  if (key.asymmetricKeyType !== type) throw new Error('UNSUPPORTED_KEY_TYPE');
  if (type === 'rsa' && key.asymmetricKeyDetails.modulusLength < 3072) throw new Error('RSA_KEY_TOO_SMALL');
}

export function safeArchivePath(path) {
  return typeof path === 'string' && path.length <= 240 && /^[A-Za-z0-9._/-]+$/.test(path)
    && !path.startsWith('/') && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validateMetadata(metadata) {
  if (!metadata || ['archiveId', 'orgId', 'shopId'].some((key) => typeof metadata[key] !== 'string' || !ID.test(metadata[key]))) throw new Error('INVALID_BACKUP_IDENTITY');
  if (!['085', '086', '087'].includes(metadata.schemaVersion)) throw new Error('UNSUPPORTED_BACKUP_SCHEMA');
  if (!['logical-pg-custom', 'physical-pg-base', 'synthetic-test-fixture'].includes(metadata.format)) throw new Error('UNSUPPORTED_BACKUP_FORMAT');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(metadata.recoveredAsOf)
    || !Number.isFinite(Date.parse(metadata.recoveredAsOf))
    || new Date(metadata.recoveredAsOf).toISOString() !== metadata.recoveredAsOf.replace(/(?<!\.\d{3})Z$/, '.000Z')) throw new Error('INVALID_BACKUP_TIME');
  const boundary = metadata.evidenceBoundary;
  if (!boundary || typeof boundary.streamId !== 'string' || !ID.test(boundary.streamId) || !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 0 || !DIGEST.test(boundary.digest)) throw new Error('INVALID_EVIDENCE_BOUNDARY');
  if (!['infrastructure-source', 'local-test'].includes(metadata.provenanceCustody)) throw new Error('UNKNOWN_PROVENANCE_CUSTODY');
  if (!['independently-held-required', 'local-test'].includes(metadata.decryptionCustody)) throw new Error('UNKNOWN_DECRYPTION_CUSTODY');
  canonicalJSON(metadata);
}

function decode(value, expectedLength) {
  if (typeof value !== 'string') throw new Error('INVALID_BASE64');
  if (value.length > MAX_ARCHIVE_BYTES * 2) throw new Error('ARCHIVE_TOO_LARGE');
  // Script 2 (r18e): linear checks (the former single backtracking regex overflowed the stack on multi-megabyte
  // archives, so every real-size archive failed closed). Strict: length multiple of 4, base64 alphabet only, padding
  // only at the end, and the canonical re-encoding must be identical (no non-zero trailing bits, no alternative forms).
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(value.slice(0, value.length - pad))) throw new Error('INVALID_BASE64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('INVALID_BASE64');
  if (expectedLength !== undefined && decoded.length !== expectedLength) throw new Error('INVALID_CRYPTO_FIELD_LENGTH');
  return decoded;
}

/** Caller supplies existing keys; no production key generation or enrollment is provided. */
export function sealBackup({ metadata, files, recipientPublicKey, provenancePrivateKey }) {
  validateMetadata(metadata);
  requireKey(recipientPublicKey, 'rsa');
  requireKey(provenancePrivateKey, 'ed25519');
  const names = Object.keys(files).sort();
  if (!names.length || names.length > 10000 || names.some((name) => !safeArchivePath(name))) throw new Error('INVALID_BACKUP_PATHS');
  let size = 0;
  const payload = names.map((path) => {
    if (!Buffer.isBuffer(files[path]) && !(files[path] instanceof Uint8Array)) throw new Error('BACKUP_BYTES_REQUIRED');
    const bytes = Buffer.from(files[path]);
    size += bytes.length;
    if (size > MAX_ARCHIVE_BYTES / 2) throw new Error('ARCHIVE_TOO_LARGE');
    return { path, content: bytes.toString('base64') };
  });
  const inventory = payload.map(({ path }) => ({ path, bytes: files[path].length, sha256: sha256(files[path]) }));
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  const header = {
    protocol: BACKUP_PROTOCOL, algorithm: 'AES-256-GCM+RSA-OAEP-SHA256+Ed25519', metadata,
    recipientKeyId: publicKeyId(recipientPublicKey), provenanceKeyId: publicKeyId(provenancePrivateKey), inventory,
  };
  try {
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    cipher.setAAD(Buffer.from(canonicalJSON(header)));
    const plaintext = Buffer.from(canonicalJSON(payload));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const body = {
      ...header, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      wrappedKey: publicEncrypt({ key: recipientPublicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, dataKey).toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    return { body, signature: sign(null, Buffer.from(canonicalJSON(body)), provenancePrivateKey).toString('base64') };
  } finally { dataKey.fill(0); }
}

/** Trust anchors are caller-pinned public keys, never keys taken from the archive/server. */
export function openBackup({ envelope, trustedProvenanceKeys, recipientPrivateKey, expectedOrgId, expectedShopId }) {
  const body = envelope?.body;
  if (!body || body.protocol !== BACKUP_PROTOCOL || body.algorithm !== 'AES-256-GCM+RSA-OAEP-SHA256+Ed25519') throw new Error('UNSUPPORTED_ENVELOPE');
  if (typeof body.ciphertext !== 'string' || body.ciphertext.length > MAX_ARCHIVE_BYTES * 2 || !Array.isArray(body.inventory) || body.inventory.length > 10000) throw new Error('ARCHIVE_TOO_LARGE_OR_INVENTORY_INVALID');
  const publicKey = trustedProvenanceKeys.get(body.provenanceKeyId);
  if (!publicKey || publicKeyId(publicKey) !== body.provenanceKeyId) throw new Error('PROVENANCE_KEY_NOT_PINNED');
  requireKey(publicKey, 'ed25519');
  if (!verify(null, Buffer.from(canonicalJSON(body)), publicKey, decode(envelope.signature, 64))) throw new Error('PROVENANCE_SIGNATURE_INVALID');
  validateMetadata(body.metadata);
  if (!expectedOrgId || !expectedShopId || body.metadata.orgId !== expectedOrgId || body.metadata.shopId !== expectedShopId) throw new Error('BACKUP_TENANT_MISMATCH');
  requireKey(recipientPrivateKey, 'rsa');
  if (publicKeyId(recipientPrivateKey) !== body.recipientKeyId) throw new Error('RECIPIENT_KEY_MISMATCH');
  const { nonce, tag, wrappedKey, ciphertext, ...header } = body;
  const dataKey = privateDecrypt({ key: recipientPrivateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, decode(wrappedKey));
  if (dataKey.length !== 32) throw new Error('INVALID_DATA_KEY');
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, decode(nonce, 12));
    decipher.setAAD(Buffer.from(canonicalJSON(header)));
    decipher.setAuthTag(decode(tag, 16));
    // Do not release unauthenticated bytes before final() succeeds.
    plaintext = Buffer.concat([decipher.update(decode(ciphertext)), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (!Array.isArray(payload) || !Array.isArray(body.inventory) || payload.length !== body.inventory.length || payload.length > 10000) throw new Error('INVENTORY_MISMATCH');
    const files = new Map();
    for (let i = 0; i < payload.length; i += 1) {
      const entry = payload[i], item = body.inventory[i];
      if (!safeArchivePath(entry.path) || files.has(entry.path) || item.path !== entry.path) throw new Error('INVALID_BACKUP_PATHS');
      const bytes = decode(entry.content);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error('CONTENT_HASH_MISMATCH');
      files.set(entry.path, bytes);
    }
    return { metadata: body.metadata, files, archiveDigest: sha256(canonicalJSON(envelope)), provenanceKeyId: body.provenanceKeyId, recipientKeyId: body.recipientKeyId };
  } finally { dataKey.fill(0); plaintext?.fill(0); }
}
