import { canonical, digest, isDigest, isId, isTime, sign, verify } from "./canonical";
import { evidenceStream, verifyEvidencePrefix, type EvidenceRecord } from "./evidence";
import { trustedKey, type IndependentTrustSource } from "./trust";

export interface Checkpoint {
  protocol: "orvix-checkpoint-v1";
  orgId: string;
  shopId: string;
  streamId: string;
  sequence: number;
  digest: string;
  previousReceiptHash: string | null;
}
export interface WitnessReceipt {
  body: { protocol: "orvix-witness-receipt-v1"; witnessId: string; keyId: string; checkpoint: Checkpoint; receivedAt: string };
  signature: string;
  hash: string;
}
export interface WitnessClient { append(checkpoint: Checkpoint): Promise<WitnessReceipt> }

function validCheckpoint(c: Checkpoint): boolean {
  return c.protocol === "orvix-checkpoint-v1" && [c.orgId, c.shopId, c.streamId].every(isId) && Number.isSafeInteger(c.sequence)
    && c.sequence > 0 && isDigest(c.digest) && (c.previousReceiptHash === null || isDigest(c.previousReceiptHash));
}

async function committedDigest(records: readonly EvidenceRecord[]): Promise<string> {
  // Includes all signed events in the prefix and explicitly selects committed
  // observations, which bind the full received reply/lookup and its args.
  // This is what the DEVICE SAW the server claim, not independent proof of commit.
  return digest({ protocol: "orvix-committed-evidence-prefix-v1", events: records.map((r) => r.envelope.hash), committed: records
    .filter((r) => r.envelope.body.evidenceKind === "journal-observation" && (r.observation as { state?: unknown } | null)?.state === "committed")
    .map((r) => r.envelope.hash) });
}

export async function createCheckpoint(records: readonly EvidenceRecord[], source: IndependentTrustSource | null, expected: { orgId: string; shopId: string }, previousReceiptHash: string | null = null): Promise<Checkpoint> {
  const prefix = await verifyEvidencePrefix(records, source, expected);
  if (!prefix.valid || !prefix.streamId) throw new Error("CHECKPOINT_EVIDENCE_UNVERIFIED");
  if (!records.some((r) => r.envelope.body.evidenceKind === "journal-observation" && (r.observation as { state?: unknown } | null)?.state === "committed")) throw new Error("CHECKPOINT_NO_OBSERVED_COMMITTED_EVIDENCE");
  return { protocol: "orvix-checkpoint-v1", orgId: expected.orgId, shopId: expected.shopId, streamId: prefix.streamId, sequence: prefix.sequence, digest: await committedDigest(records), previousReceiptHash };
}

export async function verifyWitnessReceipt(receipt: WitnessReceipt, source: IndependentTrustSource | null, expected: { orgId: string; shopId: string }): Promise<boolean> {
  try {
    const b = receipt.body;
    const c = b.checkpoint;
    if (b.protocol !== "orvix-witness-receipt-v1" || !isId(b.witnessId) || !isTime(b.receivedAt) || !validCheckpoint(c)
      || c.orgId !== expected.orgId || c.shopId !== expected.shopId || await digest({ body: b, signature: receipt.signature }) !== receipt.hash) return false;
    const key = await trustedKey(source, b.keyId, "witness", c.orgId, b.receivedAt);
    return !!key && await verify(b, receipt.signature, key.publicKey);
  } catch { return false; }
}

/** A trusted boundary is supplied by independent custody, never inferred from
 * whichever receipt the recovering server chooses to return. Missing boundary
 * or newer-head availability can never establish latestness. */
export async function verifyWitnessBoundary(input: {
  receipts: readonly WitnessReceipt[];
  source: IndependentTrustSource | null;
  expected: { orgId: string; shopId: string };
  trustedBoundary: WitnessReceipt | null;
  records: readonly EvidenceRecord[];
}): Promise<{ valid: boolean; latestEstablished: false; findings: string[] }> {
  const findings: string[] = [];
  const { expected, source, trustedBoundary, records } = input;
  if (!trustedBoundary || !await verifyWitnessReceipt(trustedBoundary, source, expected)) findings.push("INDEPENDENT_TRUSTED_BOUNDARY_MISSING_OR_INVALID");
  const prefix = await verifyEvidencePrefix(records, source, expected);
  if (!prefix.valid) findings.push("DEVICE_PREFIX_INVALID_OR_MISSING");
  const seen = new Map<string, string>();
  let previous: WitnessReceipt | null = null;
  for (const receipt of input.receipts) {
    if (!await verifyWitnessReceipt(receipt, source, expected)) { findings.push("WITNESS_SIGNATURE_INVALID"); continue; }
    const c = receipt.body.checkpoint;
    const identity = `${c.streamId}:${c.sequence}`;
    if (seen.has(identity) && seen.get(identity) !== receipt.hash) findings.push("WITNESS_FORK");
    seen.set(identity, receipt.hash);
    if (c.streamId !== prefix.streamId) findings.push("WITNESS_STREAM_MISMATCH");
    if (previous) {
      const p = previous.body.checkpoint;
      if (c.sequence < p.sequence || c.previousReceiptHash !== previous.hash) findings.push("WITNESS_CHAIN_FORK_OR_ROLLBACK");
    } else if (c.previousReceiptHash !== null) findings.push("WITNESS_CHAIN_PREFIX_MISSING");
    if (c.sequence > records.length || await committedDigest(records.slice(0, c.sequence)) !== c.digest) findings.push("WITNESS_DIGEST_OR_RECOVERED_PREFIX_MISMATCH");
    previous = receipt;
  }
  if (!previous) findings.push("WITNESS_RECEIPT_MISSING");
  if (trustedBoundary) {
    const b = trustedBoundary.body.checkpoint;
    if (b.streamId !== prefix.streamId || records.length < b.sequence) findings.push("ROLLBACK_BELOW_TRUSTED_BOUNDARY");
    if (!input.receipts.some((r) => r.hash === trustedBoundary.hash)) findings.push("TRUSTED_BOUNDARY_WITHHELD");
  }
  return { valid: findings.length === 0, latestEstablished: false, findings: [...new Set([...findings, "AUTHENTIC_RECEIPT_IS_NOT_PROOF_OF_LATEST_HEAD;NEWER_CHECKPOINTS_CAN_BE_WITHHELD"])] };
}

export interface TestWitnessStore {
  /** Atomic compare-and-append for one stream. Must serialize concurrent
   * writers and return its actual stored receipt; never acknowledge in advance. */
  transact(scope: string, change: (history: readonly WitnessReceipt[]) => Promise<WitnessReceipt>): Promise<WitnessReceipt>;
}

/** Disposable implementation/test double. The same process can control all
 * keys; it establishes NO independent production custody. */
export class LocalTestWitness implements WitnessClient {
  readonly implementation = "LOCAL_TEST_DOUBLE_NOT_INDEPENDENT";
  private readonly options: { witnessId: string; keyId: string; privateKey: CryptoKey; store: TestWitnessStore; now?: () => string };
  constructor(options: { witnessId: string; keyId: string; privateKey: CryptoKey; store: TestWitnessStore; now?: () => string }) { this.options = options; }
  async append(checkpoint: Checkpoint): Promise<WitnessReceipt> {
    if (!validCheckpoint(checkpoint)) throw new Error("INVALID_CHECKPOINT");
    const scope = canonical([checkpoint.orgId, checkpoint.shopId, checkpoint.streamId]);
    return this.options.store.transact(scope, async (history) => {
      const latest = history.at(-1);
      if (latest && canonical(latest.body.checkpoint) === canonical(checkpoint)) return latest;
      if (latest ? checkpoint.sequence <= latest.body.checkpoint.sequence || checkpoint.previousReceiptHash !== latest.hash : checkpoint.previousReceiptHash !== null) throw new Error("WITNESS_FORK_OR_ROLLBACK");
      const body: WitnessReceipt["body"] = {
        protocol: "orvix-witness-receipt-v1", witnessId: this.options.witnessId, keyId: this.options.keyId, checkpoint,
        receivedAt: this.options.now?.() ?? new Date().toISOString(),
      };
      const signature = await sign(body, this.options.privateKey);
      return { body, signature, hash: await digest({ body, signature }) };
    });
  }
}

/** Per-process serialized disposable store, useful for offline smoke tests.
 * The file-backed CLI uses an exclusive lock and fsync instead. */
export class MemoryTestWitnessStore implements TestWitnessStore {
  readonly histories = new Map<string, WitnessReceipt[]>();
  private turn: Promise<unknown> = Promise.resolve();
  transact(scope: string, change: (history: readonly WitnessReceipt[]) => Promise<WitnessReceipt>): Promise<WitnessReceipt> {
    const result = this.turn.then(async () => {
      const history = this.histories.get(scope) ?? [];
      const next = await change(history);
      if (!history.some((r) => r.hash === next.hash)) this.histories.set(scope, [...history, next]);
      return next;
    });
    this.turn = result.catch(() => undefined);
    return result;
  }
}

export async function submitCheckpoint(client: WitnessClient | null, checkpoint: Checkpoint, source: IndependentTrustSource | null): Promise<WitnessReceipt> {
  if (!client) throw new Error("WITNESS_UNAVAILABLE;CHECKPOINT_NOT_ACKNOWLEDGED");
  const receipt = await client.append(checkpoint);
  if (canonical(receipt.body.checkpoint) !== canonical(checkpoint) || !await verifyWitnessReceipt(receipt, source, checkpoint)) throw new Error("WITNESS_RECEIPT_UNVERIFIABLE");
  return receipt;
}

export { evidenceStream };
