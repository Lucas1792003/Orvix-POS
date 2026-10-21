/** ORVIX canonical JSON v1: UTF-16 sorted object keys, JSON number/string
 * encoding, no Unicode normalization. Reject non-JSON values rather than
 * silently signing a different value. This is a protocol, not PostgreSQL jsonb text. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.some((_, i) => !(i in value)) || Object.keys(value).length !== value.length) throw new Error("NON_JSON_ARRAY");
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (Object.getOwnPropertySymbols(value).length) throw new Error("NON_JSON_SYMBOL");
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("NON_JSON_VALUE");
}

export const bytes = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
export const hex = (value: ArrayBuffer): string => Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
export const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(value);
export const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const digest = async (value: unknown): Promise<string> => hex(await crypto.subtle.digest("SHA-256", bytes(canonical(value))));

export function toBase64(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("INVALID_BASE64");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** P-256 group order. ECDSA accepts both (r, s) and (r, n - s); evidence and receipt hashes
 *  include the signature, so a third party could otherwise re-encode an honest signature and
 *  make one record look like a fork. Signatures are produced and accepted in low-S form only. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N >> 1n;
const toBig = (b: Uint8Array): bigint => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
function toBytes32(v: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
export function isLowS(sig: Uint8Array): boolean { return sig.length === 64 && toBig(sig.subarray(32)) <= P256_HALF_N; }
function toLowS(sig: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (isLowS(sig)) return sig;
  const out = new Uint8Array(64);
  out.set(sig.subarray(0, 32), 0);
  out.set(toBytes32(P256_N - toBig(sig.subarray(32))), 32);
  return out;
}

export async function sign(body: unknown, key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes(canonical(body))));
  return toBase64(toLowS(raw).buffer);
}
export async function verify(body: unknown, signature: string, publicKey: string): Promise<boolean> {
  try {
    const sig = fromBase64(signature);
    if (sig.length !== 64) return false; // WebCrypto P1363 r || s, not ASN.1 DER.
    if (!isLowS(sig)) return false;      // high-S twin of a valid signature: refused (canonical form only)
    if (toBase64(sig.buffer) !== signature) return false; // non-canonical base64 (unused trailing bits) re-encodes the same bytes
    const key = await crypto.subtle.importKey("spki", fromBase64(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, bytes(canonical(body)));
  } catch { return false; }
}

export async function syntheticSigningKey(): Promise<{ privateKey: CryptoKey; publicKey: string; keyId: string }> {
  // Explicitly called by disposable fixtures/enrollment only, never on journal
  // load, missing-key recovery, reinstall or first use of a financial operation.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = toBase64(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey, keyId: await digest(publicKey) };
}
