#!/usr/bin/env node
// LOCAL SIMULATION of Orvix tills' device keys (Recovery V1, Step 5). Synthetic test keys only, kept in memory.
//
// It produces exactly what a real till produces (src/recovery/deviceTrust.ts): an RSA-2048 key (RSASSA-PKCS1-v1_5,
// SHA-256), a self-signed enrollment REQUEST (proof of possession) and the per-operation request signature
//   orvix-device-request-v1\n<enrollmentId>\n<orgId>\n<shopId>\n<key>\n<rpc>\n<counter>
// that PostgreSQL verifies (recovery_v1.device_check). A real till's key is non-extractable and never leaves it; this
// simulator also hands out the CRT parts of a key ONLY when asked for an in-database FIXTURE device (fixtureKey).
//
//   device-sim.mjs serve            JSON lines on stdin/stdout: {"id":n,"cmd":...} -> {"id":n,"ok":true,...}
//     keygen  {handle}                                      -> {n, e, fingerprint}
//     request {handle, orgId, shopId, deviceId, requestId?, requestNonce?, requestedAt?, replacesEnrollmentId?, evidencePublicKey?}
//                                                           -> {request, signature, requestId, requestNonce}
//     header  {handle, enrollmentId, orgId, shopId, key, rpc, counter, includeKey?}  -> {header}
//     sign    {handle, text}                                -> {signature}
//     fixtureKey {handle}                                   -> {n, p, q, dp, dq, qi, bytes}   (decimal strings)
import { createHash, generateKeyPairSync, randomUUID, sign, constants } from "node:crypto";
import { createInterface } from "node:readline";

const keys = new Map();
const hexOf = (b64url) => Buffer.from(b64url, "base64url").toString("hex");
const canonicalHex = (b64url) => hexOf(b64url).replace(/^0+/, "") || "0";
const decOf = (b64url) => BigInt("0x" + hexOf(b64url)).toString(10);
export const fingerprintOf = (nHex) => createHash("sha256").update(`${nHex.toLowerCase().replace(/^0+/, "")}:65537`, "utf8").digest("hex");
const rsaSign = (k, text) => sign("sha256", Buffer.from(text, "utf8"), { key: k.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("hex");
// marker: '<capabilityId>:<deviceSeq>' for an operation recorded offline, else 'online' (recovery_v1.offline_marker)
export const requestMessage = ({ enrollmentId, orgId, shopId, key, rpc, counter, marker }) =>
  `orvix-device-request-v1\n${enrollmentId}\n${orgId}\n${shopId}\n${key}\n${rpc}\n${counter}\n${marker ?? "online"}`;

function handle(msg) {
  const k = keys.get(msg.handle);
  switch (msg.cmd) {
    case "keygen": {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
      const jwk = pair.privateKey.export({ format: "jwk" });
      const n = canonicalHex(jwk.n);
      keys.set(msg.handle, { privateKey: pair.privateKey, jwk, n });
      return { n, e: 65537, fingerprint: fingerprintOf(n) };
    }
    case "request": {
      if (!k) throw new Error("unknown handle");
      const doc = {
        protocol: "orvix-device-enrollment-request-v1", requestId: msg.requestId ?? randomUUID(), orgId: msg.orgId, shopId: msg.shopId, deviceId: msg.deviceId,
        publicKey: { n: k.n, e: 65537 }, keyFingerprint: msg.keyFingerprint ?? fingerprintOf(k.n), evidencePublicKey: msg.evidencePublicKey ?? null,
        requestNonce: msg.requestNonce ?? randomUUID(), requestedAt: msg.requestedAt ?? new Date().toISOString(), replacesEnrollmentId: msg.replacesEnrollmentId ?? null,
      };
      const request = JSON.stringify(doc);
      return { request, signature: rsaSign(keys.get(msg.signWith ?? msg.handle), request), requestId: doc.requestId, requestNonce: doc.requestNonce };
    }
    case "header": {
      if (!k) throw new Error("unknown handle");
      const sig = rsaSign(k, requestMessage(msg));
      const h = { v: 1, enrollmentId: msg.enrollmentId, counter: msg.counter, sig };
      if (msg.includeKey) h.key = msg.key;
      return { header: JSON.stringify(h) };
    }
    case "sign": {
      if (!k) throw new Error("unknown handle");
      return { signature: rsaSign(k, msg.text) };
    }
    case "fixtureKey": {
      if (!k) throw new Error("unknown handle");
      const j = k.jwk;
      return { n: decOf(j.n), p: decOf(j.p), q: decOf(j.q), dp: decOf(j.dp), dq: decOf(j.dq), qi: decOf(j.qi), bytes: Buffer.from(j.n, "base64url").length };
    }
    default: throw new Error("unknown cmd");
  }
}

if (process.argv[2] === "serve") {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n"); return; }
    try { process.stdout.write(JSON.stringify({ id: msg.id, ok: true, ...handle(msg) }) + "\n"); }
    catch (e) { process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: String(e?.message ?? e) }) + "\n"); }
  });
} else if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  process.stderr.write("usage: device-sim.mjs serve\n"); process.exit(2);
}
