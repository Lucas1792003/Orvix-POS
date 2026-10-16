// ----------------------------------------------------------------------
// Pending-queue export: file format, encryption and validation.
//
// Shared by the app (renderer, WebCrypto in Chromium/Electron) and the
// recovery tool (tools/queue-recovery, WebCrypto in Node >= 20). Pure: no
// app imports, no storage, no network. Format and threat model:
// docs/selfhost-migration/phase-f/queue-export.md.
//
// File = JSON envelope. Everything sensitive (payloads, ids, keys) is inside
// `ciphertext` (AES-256-GCM, key from PBKDF2-HMAC-SHA-256 over the
// passphrase typed at export time, 600 000 iterations, random 16-byte salt,
// random 12-byte IV). The clear part holds only the format marker, the KDF /
// cipher parameters and a counts-only summary; all of it is bound to the
// ciphertext as AES-GCM additional data, so editing any clear field (or the
// ciphertext) makes decryption fail exactly like a wrong passphrase.
// ----------------------------------------------------------------------
import { z } from "zod";

export const QUEUE_EXPORT_FORMAT = "shwephala-queue-export";
export const QUEUE_EXPORT_FORMAT_VERSION = 1;
export const QUEUE_EXPORT_FILE_EXTENSION = "spqx";
/** OWASP 2023 guidance for PBKDF2-HMAC-SHA-256. */
export const KDF_ITERATIONS = 600_000;
/** Lower bound accepted on decrypt (a forged envelope cannot weaken the KDF to nothing). */
export const MIN_KDF_ITERATIONS = 100_000;
export const MIN_PASSPHRASE_LENGTH = 10;

export type QueueExportErrorCode =
  | "bad-format"           // not a queue export / malformed JSON / schema violation
  | "unsupported-version"  // newer format than this reader understands
  | "decrypt-failed"       // wrong passphrase, or the file was modified
  | "weak-passphrase"
  | "secret-detected";     // a known secret value would have been written: export aborted

export class QueueExportError extends Error {
  readonly code: QueueExportErrorCode;
  constructor(code: QueueExportErrorCode, message: string) {
    super(message);
    this.name = "QueueExportError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- schema --

const entrySchema = z.object({
  /** Queue position assigned at enqueue (outbox `seq`); null only for pre-seq rows. */
  seq: z.number().int().nullable(),
  /** The outbox row's own id (`localId`). */
  opId: z.string().min(1),
  idempotencyKey: z.string().nullable(),
  kind: z.enum(["rpc", "table_write"]),
  /** RPC name, or "<table>.<op>" for a table write. */
  opType: z.string().min(1),
  table: z.string().nullable(),
  tableOp: z.enum(["insert", "update", "delete"]).nullable(),
  rowId: z.string().nullable(),
  /** RPC arguments (incl. p_idempotency_key) or the table-write row, exactly as queued. */
  payload: z.record(z.unknown()).nullable(),
  refs: z.array(z.object({ field: z.string(), provisionalId: z.string() })),
  provisional: z.array(z.object({ table: z.string(), ids: z.array(z.string()) })),
  shopId: z.string().nullable(),
  /** When the entry was queued. */
  createdAt: z.string(),
  /** The operation's own (ring-up) time, `p_created_at`, when it has one. */
  ringUpAt: z.string().nullable(),
  /** "quarantined" (1.0.16): queued for another backend than the till's
   *  current one (or by a build that did not record it); never sent by the
   *  till. Replayed only on an explicit owner decision (tools/queue-recovery
   *  --include-quarantined). */
  status: z.enum(["pending", "syncing", "failed", "conflict", "quarantined"]),
  attempts: z.number().int().min(0),
  lastErrorClass: z.enum(["transient", "permanent"]).nullable(),
  lastError: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  /** Origin of the backend the entry was queued for (1.0.16+); null = not
   *  recorded (v1.0.15 and earlier: hosted). Absent in older exports. */
  backendOrigin: z.string().nullable().default(null),
  /** Why the till quarantined it, when it did. */
  quarantineReason: z.string().nullable().default(null),
});

export type QueueExportEntry = z.infer<typeof entrySchema>;

const payloadSchema = z.object({
  format: z.literal(QUEUE_EXPORT_FORMAT),
  formatVersion: z.literal(QUEUE_EXPORT_FORMAT_VERSION),
  appVersion: z.string(),
  exportedAt: z.string(),
  tillId: z.string(),
  /** Host (and port) the till is built for — never a key. */
  backendHost: z.string(),
  session: z.object({
    userId: z.string().nullable(),
    orgId: z.string().nullable(),
    shopId: z.string().nullable(),
    role: z.string().nullable(),
  }),
  entries: z.array(entrySchema),
  /** provisional id -> server id for parents that already synced (resolves `refs`). */
  provisionalIdMap: z.array(z.object({ provisionalId: z.string(), realId: z.string(), createdAt: z.string() })),
  /** Number of values the serializer blanked because their key looked like a credential. */
  redactedFields: z.number().int().min(0),
});

export type QueueExportPayload = z.infer<typeof payloadSchema>;

const summarySchema = z.object({
  total: z.number().int().min(0),
  byStatus: z.record(z.number().int().min(0)),
  byOpType: z.record(z.number().int().min(0)),
});

export type QueueExportSummary = z.infer<typeof summarySchema>;

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const envelopeSchema = z.object({
  format: z.literal(QUEUE_EXPORT_FORMAT),
  formatVersion: z.number().int(),
  encrypted: z.literal(true),
  header: z.object({
    appVersion: z.string(),
    exportedAt: z.string(),
    tillId: z.string(),
    summary: summarySchema,
  }),
  kdf: z.object({
    name: z.literal("PBKDF2"),
    hash: z.literal("SHA-256"),
    iterations: z.number().int(),
    salt: b64,
  }),
  cipher: z.object({
    name: z.literal("AES-GCM"),
    keyBits: z.literal(256),
    tagBits: z.literal(128),
    iv: b64,
  }),
  ciphertext: b64,
});

export type QueueExportEnvelope = z.infer<typeof envelopeSchema>;

// --------------------------------------------------------------- helpers --

export function summarize(entries: readonly Pick<QueueExportEntry, "status" | "opType">[]): QueueExportSummary {
  const byStatus: Record<string, number> = {};
  const byOpType: Record<string, number> = {};
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    byOpType[e.opType] = (byOpType[e.opType] ?? 0) + 1;
  }
  return { total: entries.length, byStatus, byOpType };
}

/** JSON with object keys sorted at every level — the AES-GCM additional data. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  return c.subtle;
};

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function additionalData(env: Omit<QueueExportEnvelope, "ciphertext">): Uint8Array<ArrayBuffer> {
  const { format, formatVersion, encrypted, header, kdf, cipher } = env;
  return new TextEncoder().encode(canonicalJson({ format, formatVersion, encrypted, header, kdf, cipher }));
}

export function checkPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new QueueExportError("weak-passphrase", `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
}

// ------------------------------------------------------- secret hygiene --

/** Keys whose values are never written to an export, wherever they appear
 *  inside a payload. The serializer copies only known outbox fields; this is
 *  the second line of defence for free-form `args` / `row` objects. */
export const SECRET_KEY_PATTERN =
  /(access|refresh|provider|id)_?token|password|passwd|passphrase|secret|^totp$|totp_?(secret|code|uri|factor)|otp_?code|api_?key|apikey|anon_?key|service_?role|jwt|authorization|bearer|cookie|^session$|session_?(obj|data|token)/i;

/** Placeholder written instead of a redacted value. An entry whose payload
 *  contains it is never replayed by the recovery tool (its payload is no
 *  longer the one the till would send). */
export const REDACTED = "[REDACTED]";

/** Deep copy of `value` with every credential-looking key's value replaced. */
export function redactSecrets<T>(value: T, counter: { n: number } = { n: 0 }): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, counter)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        counter.n++;
        out[k] = REDACTED;
      } else {
        out[k] = redactSecrets(v, counter);
      }
    }
    return out as T;
  }
  return value;
}

/** Throws `secret-detected` if any known secret value (session tokens, the
 *  anon key …) occurs anywhere in `serialized`. Values shorter than 12
 *  characters are ignored (they cannot be credentials and would only cause
 *  false positives). */
export function assertNoSecretValues(serialized: string, secretValues: readonly (string | null | undefined)[]): void {
  for (const s of secretValues) {
    if (typeof s !== "string" || s.length < 12) continue;
    if (serialized.includes(s)) {
      throw new QueueExportError(
        "secret-detected",
        "A credential value was found in the export data; the export was aborted and nothing was written.",
      );
    }
  }
}

// ------------------------------------------------------ encrypt/decrypt --

export function validatePayload(value: unknown): QueueExportPayload {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new QueueExportError("bad-format", `Export contents are invalid at ${first?.path.join(".") || "(root)"}: ${first?.message ?? "schema"}`);
  }
  return parsed.data;
}

export interface EncryptOptions {
  iterations?: number;
  /** Test hooks only. */
  salt?: Uint8Array<ArrayBuffer>;
  iv?: Uint8Array<ArrayBuffer>;
}

export async function encryptQueueExport(
  payload: QueueExportPayload,
  passphrase: string,
  options: EncryptOptions = {},
): Promise<QueueExportEnvelope> {
  checkPassphrase(passphrase);
  const valid = validatePayload(payload);
  const iterations = options.iterations ?? KDF_ITERATIONS;
  const salt = options.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = options.iv ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
  const head: Omit<QueueExportEnvelope, "ciphertext"> = {
    format: QUEUE_EXPORT_FORMAT,
    formatVersion: QUEUE_EXPORT_FORMAT_VERSION,
    encrypted: true,
    header: {
      appVersion: valid.appVersion,
      exportedAt: valid.exportedAt,
      tillId: valid.tillId,
      summary: summarize(valid.entries),
    },
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", keyBits: 256, tagBits: 128, iv: toBase64(iv) },
  };
  const key = await deriveKey(passphrase, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(valid));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, tagLength: 128, additionalData: additionalData(head) }, key, plaintext);
  return { ...head, ciphertext: toBase64(new Uint8Array(ct)) };
}

/** Parse + schema-check the envelope (no passphrase needed). */
export function parseEnvelope(input: string | unknown): QueueExportEnvelope {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new QueueExportError("bad-format", "Not a queue export file (not JSON).");
    }
  }
  const v = value as { format?: unknown; formatVersion?: unknown } | null;
  if (!v || typeof v !== "object" || v.format !== QUEUE_EXPORT_FORMAT) {
    throw new QueueExportError("bad-format", "Not a Shwe Pha La queue export file.");
  }
  if (typeof v.formatVersion === "number" && v.formatVersion > QUEUE_EXPORT_FORMAT_VERSION) {
    throw new QueueExportError("unsupported-version", `Export format ${v.formatVersion} is newer than this tool supports (${QUEUE_EXPORT_FORMAT_VERSION}).`);
  }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new QueueExportError("bad-format", `Export envelope is invalid at ${first?.path.join(".") || "(root)"}: ${first?.message ?? "schema"}`);
  }
  if (parsed.data.formatVersion !== QUEUE_EXPORT_FORMAT_VERSION) {
    throw new QueueExportError("unsupported-version", `Unsupported export format version ${parsed.data.formatVersion}.`);
  }
  if (parsed.data.kdf.iterations < MIN_KDF_ITERATIONS) {
    throw new QueueExportError("bad-format", `KDF iteration count ${parsed.data.kdf.iterations} is below the minimum ${MIN_KDF_ITERATIONS}.`);
  }
  return parsed.data;
}

export async function decryptQueueExport(input: string | unknown, passphrase: string): Promise<QueueExportPayload> {
  const env = parseEnvelope(input);
  const { ciphertext, ...head } = env;
  let plain: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, fromBase64(env.kdf.salt), env.kdf.iterations);
    plain = await subtle().decrypt(
      { name: "AES-GCM", iv: fromBase64(env.cipher.iv), tagLength: 128, additionalData: additionalData(head) },
      key,
      fromBase64(ciphertext),
    );
  } catch {
    throw new QueueExportError("decrypt-failed", "Wrong passphrase, or the file has been modified.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new QueueExportError("bad-format", "Decrypted contents are not JSON.");
  }
  const payload = validatePayload(value);
  // The clear summary is authenticated, but check it describes this payload.
  if (canonicalJson(summarize(payload.entries)) !== canonicalJson(env.header.summary)) {
    throw new QueueExportError("bad-format", "The file's summary does not match its contents.");
  }
  return payload;
}

/** Queue order: seq ascending (null seq first, by createdAt then opId) — the
 *  order the till's own drain replays in (stores/data/outbox.ts byQueueOrder). */
export function inQueueOrder<T extends Pick<QueueExportEntry, "seq" | "createdAt" | "opId">>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.seq != null && b.seq != null) return a.seq - b.seq;
    if (a.seq == null && b.seq == null) {
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.opId.localeCompare(b.opId);
    }
    return a.seq == null ? -1 : 1;
  });
}

export function defaultExportFileName(tillId: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const till = tillId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "till";
  return `pending-queue-${till}-${stamp}.${QUEUE_EXPORT_FILE_EXTENSION}`;
}
