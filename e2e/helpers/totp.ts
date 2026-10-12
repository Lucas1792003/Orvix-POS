// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the QA admin's enrolled
// authenticator factor. The secret stays in process.env for the run.
import { createHmac } from "node:crypto";

function b32decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totpCode(secret: string, t = Math.floor(Date.now() / 1000), step = 30, digits = 6): string {
  const key = b32decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / step)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, "0");
}

/** Seconds left in the current 30 s window. */
export function totpSecondsLeft(step = 30): number {
  return step - (Math.floor(Date.now() / 1000) % step);
}

/** A code that is different from `notThis` (waits for the next window if
 *  needed) — GoTrue may refuse to accept the same code twice in a window. */
export async function freshTotpCode(secret: string, notThis?: string): Promise<string> {
  let code = totpCode(secret);
  if (notThis && code === notThis) {
    await new Promise((r) => setTimeout(r, (totpSecondsLeft() + 1) * 1000));
    code = totpCode(secret);
  }
  return code;
}
