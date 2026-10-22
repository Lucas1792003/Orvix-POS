/** Local disposable witness double. No network listener, production custody,
 * production keys or external delivery. Run with node --import tsx. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { canonical, syntheticSigningKey } from "../../src/recovery/canonical";
import { LocalTestWitness, verifyWitnessReceipt, type Checkpoint, type TestWitnessStore, type WitnessReceipt } from "../../src/recovery/witness";
import type { IndependentTrustSource } from "../../src/recovery/trust";

export class FileTestWitnessStore implements TestWitnessStore {
  readonly directory: string;
  constructor(directory: string) {
    if (!basename(directory).startsWith("orvix-recovery-v1-witness-")) throw new Error("SYNTHETIC_WITNESS_DIRECTORY_REQUIRED");
    this.directory = directory;
  }
  async transact(scope: string, change: (history: readonly WitnessReceipt[]) => Promise<WitnessReceipt>): Promise<WitnessReceipt> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(scope).digest("hex");
    const file = join(this.directory, `${name}.jsonl`);
    const lockPath = join(this.directory, `${name}.lock`);
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new Error("WITNESS_STORE_BUSY_OR_UNAVAILABLE;RETRY_IDENTICAL_CHECKPOINT"); }
    try {
      let raw = "";
      try { raw = await readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (raw && !raw.endsWith("\n")) throw new Error("WITNESS_STORAGE_DAMAGED;NO_ACKNOWLEDGEMENT");
      const history = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as WitnessReceipt);
      const receipt = await change(history);
      if (!history.some((r) => r.hash === receipt.hash)) {
        await appendFile(file, `${canonical(receipt)}\n`, { mode: 0o600, flag: "a" });
        const fd = await open(file, "r");
        try { await fd.sync(); } finally { await fd.close(); }
        const dir = await open(this.directory, "r");
        try { await dir.sync(); } finally { await dir.close(); }
      }
      return receipt; // only after actual durable append, never a speculative ack.
    } finally { await lock.close(); await unlink(lockPath); }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!["--smoke", "--jsonl"].includes(mode)) throw new Error("Usage: node --import tsx tools/recovery-v1/witness-local.ts --smoke|--jsonl");
  const directory = await mkdtemp(join(tmpdir(), "orvix-recovery-v1-witness-"));
  const key = await syntheticSigningKey();
  const store = new FileTestWitnessStore(directory);
  const witness = new LocalTestWitness({ witnessId: "synthetic-local-witness", ...key, store });
  const trust = { keyId: key.keyId, publicKey: key.publicKey, purpose: "witness" as const, orgId: "synthetic-org",
    notBefore: "2020-01-01T00:00:00.000Z", notAfter: "2099-01-01T00:00:00.000Z", revokedAt: null };
  const source: IndependentTrustSource = { custody: "synthetic-test-only", keys: async () => [trust] };
  if (mode === "--smoke") {
    const checkpoint: Checkpoint = { protocol: "orvix-checkpoint-v1", orgId: trust.orgId, shopId: "synthetic-shop", streamId: "synthetic-device:key", sequence: 1, digest: "a".repeat(64), previousReceiptHash: null };
    const receipt = await witness.append(checkpoint);
    assert.equal(await verifyWitnessReceipt(receipt, source, checkpoint), true);
    assert.deepEqual(await witness.append(checkpoint), receipt);
    await assert.rejects(witness.append({ ...checkpoint, digest: "b".repeat(64) }), /FORK_OR_ROLLBACK/);
    const continued = await witness.append({ ...checkpoint, sequence: 2, digest: "b".repeat(64), previousReceiptHash: receipt.hash });
    assert.equal(await verifyWitnessReceipt(continued, source, checkpoint), true);
    process.stdout.write(`${JSON.stringify({ implementation: witness.implementation, assertionsPassed: 4, durableStorage: directory, publicTrustKey: trust, receipt: continued })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ implementation: witness.implementation, publicTrustKey: trust, durableStorage: directory, credentialLifetime: "this process only" })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      const checkpoint = JSON.parse(line) as Checkpoint;
      if (checkpoint.orgId !== "synthetic-org") throw new Error("SYNTHETIC_ORGANIZATION_ONLY");
      process.stdout.write(`${JSON.stringify({ receipt: await witness.append(checkpoint) })}\n`);
    } catch { process.stdout.write(`${JSON.stringify({ error: "WITNESS_REJECTED;NO_ACKNOWLEDGEMENT" })}\n`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("Local synthetic witness failed; no production changes made.\n"); process.exitCode = 1; });
}
