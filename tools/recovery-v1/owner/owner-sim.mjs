#!/usr/bin/env node
// LOCAL SIMULATION of the owner's offline authority (Recovery V1, Step 4). Synthetic test keys only.
//
// The real owner key is generated and kept OFFLINE by the owner (hardware token / air-gapped machine); it never touches the
// server, this repository or any CI. This tool exists so that the protocol can be tested end to end on disposable databases.
// It refuses to write a key anywhere but a fresh directory under the system temp directory.
//
//   owner-sim.mjs keygen <dir> <keyId>                         -> <dir>/<keyId>.private.pem (0600), prints the public key JSON
//   owner-sim.mjs authorize <privatePem> <keyId> <purpose> <target.json> <payload.json> [--expires-in S] [--issued-offset S]
//                                                               -> prints {"authorization": "<exact text>", "signature": "<hex>"}
//   owner-sim.mjs sql-sha256 <file>                             -> sha256 hex of the file's exact bytes
//
// purpose: migration | offline-policy | enroll-owner-key. target.json: the output of recovery_v1.authorization_target().
// The authorization text is signed EXACTLY as printed (RSASSA-PKCS1-v1_5, SHA-256); the server verifies those bytes.
import { createHash, generateKeyPairSync, randomUUID, sign, createPrivateKey, createPublicKey, constants } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [, , cmd, ...args] = process.argv;
const b64urlToHex = (s) => Buffer.from(s, "base64url").toString("hex");
function die(msg) { process.stderr.write(msg + "\n"); process.exit(2); }

if (cmd === "keygen") {
  const [dir, keyId] = args;
  if (!dir || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId ?? "")) die("usage: keygen <dir> <keyId>");
  const abs = resolve(dir);
  const tmpRoots = [realpathSync(tmpdir()), "/private/tmp", "/tmp"];
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  if (!tmpRoots.some((r) => realpathSync(abs).startsWith(r))) die("REFUSED: synthetic owner keys are written only under the system temp directory");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const file = join(abs, `${keyId}.private.pem`);
  writeFileSync(file, pem, { mode: 0o600 }); chmodSync(file, 0o600);
  const jwk = publicKey.export({ format: "jwk" });
  process.stdout.write(JSON.stringify({ keyId, n: b64urlToHex(jwk.n), e: Number(BigInt("0x" + b64urlToHex(jwk.e))) }) + "\n");
} else if (cmd === "authorize") {
  const [pemFile, keyId, purpose, targetFile, payloadFile, ...opts] = args;
  if (!pemFile || !keyId || !purpose || !targetFile || !payloadFile) die("usage: authorize <privatePem> <keyId> <purpose> <target.json> <payload.json> [--expires-in S] [--issued-offset S]");
  const opt = (name, dflt) => { const i = opts.indexOf(name); return i >= 0 ? Number(opts[i + 1]) : dflt; };
  const target = JSON.parse(readFileSync(targetFile, "utf8"));
  const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
  const now = Date.now() + opt("--issued-offset", 0) * 1000;
  const fixed = {
    protocol: "orvix-owner-authorization-v1", purpose, keyId, nonce: randomUUID(),
    target: { database: target.database, systemIdentifier: target.systemIdentifier, recoveryV1InstalledAt: target.recoveryV1InstalledAt },
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + opt("--expires-in", 3600) * 1000).toISOString(),
  };
  // the payload adds its own fields only: it can never replace the protocol, purpose, key, nonce, target or window
  const clash = Object.keys(payload).filter((k) => k in fixed);
  if (clash.length) die(`REFUSED: the payload may not set ${clash.join(", ")}`);
  const doc = { ...fixed, ...payload };
  const text = JSON.stringify(doc);
  const key = createPrivateKey(readFileSync(pemFile));
  const signature = sign("sha256", Buffer.from(text, "utf8"), { key, padding: constants.RSA_PKCS1_PADDING }).toString("hex");
  process.stdout.write(JSON.stringify({ authorization: text, signature }) + "\n");
} else if (cmd === "sql-sha256") {
  process.stdout.write(createHash("sha256").update(readFileSync(args[0])).digest("hex") + "\n");
} else if (cmd === "public-key") {
  const jwk = createPublicKey(createPrivateKey(readFileSync(args[0]))).export({ format: "jwk" });
  process.stdout.write(JSON.stringify({ keyId: args[1], n: b64urlToHex(jwk.n), e: Number(BigInt("0x" + b64urlToHex(jwk.e))) }) + "\n");
} else {
  die("commands: keygen | authorize | sql-sha256 | public-key");
}
