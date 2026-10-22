import Dexie from "dexie";
import { localDb } from "../lib/localDb";
import type { JournalRecord } from "../stores/data/opJournal";
import { digest } from "./canonical";
import { enrolledDevice } from "./deviceVault";
import { evidenceStream, signEvidence, type EvidenceRecord } from "./evidence";
import { independentTrustSource, TrustUnavailable } from "./trust";
import { currentTill, tillEvidenceIdentity } from "./deviceTrust";

export const DEVICE_EVIDENCE_PREFIX = "rv1:evidence:";
export const WITNESS_RECEIPT_PREFIX = "rv1:witness:";
const headKey = (scope: string) => `rv1:head:${scope}`;
/** Local evidence contradicts itself (a changed transmission under the same
 *  operation identity, an unreadable chain head). Never retried automatically:
 *  a person decides, and the originals are preserved. */
export class EvidenceIntegrityError extends TrustUnavailable {
  constructor(message: string) { super(message); this.name = "EvidenceIntegrityError"; }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface CaptureInput {
  orgId: string | null; shopId: string | null; backendOrigin: string | null; actorId: string | null;
  key: string; rpc: string; args: Record<string, unknown> | null; opEpoch?: string | null;
  createdAt: string;
}

/** `gap`: why a signature that was expected (trust source configured) was not produced. Returned
 *  per call (no shared state), so concurrent captures can never swap or erase each other's gap. */
interface Captured { hash: string | null; gap: string | null }
async function capture(input: CaptureInput, observation: unknown, kind: "journal-observation" | "transmission", required: boolean): Promise<Captured> {
  // Step 5: an owner-approved till (deviceTrust.ts) signs its evidence with its bound ECDSA evidence key when no Step 4
  // independent trust source is injected
  // (the vault read is started INSIDE waitFor, as below: the caller's IndexedDB transaction must stay alive)
  const stepFive = !independentTrustSource() && Boolean(input.orgId && input.shopId && input.backendOrigin)
    && Boolean(await Dexie.waitFor(Promise.resolve().then(() => currentTill(input.backendOrigin!, input.orgId!, input.shopId!)).catch(() => null)));
  if (!independentTrustSource() && !stepFive) {
    if (required) throw new TrustUnavailable();
    return { hash: null, gap: null }; // Existing legacy data is retained, never retroactively called signed.
  }
  if (!input.orgId || !input.shopId || !input.backendOrigin || !uuid.test(input.key)) {
    if (required) throw new TrustUnavailable("Operation lacks an unambiguous organization, shop, backend or UUID identity.");
    return { hash: null, gap: "identity-incomplete" };
  }
  // Resolve inside waitFor even on an unavailable key. This keeps the caller's
  // IDB transaction active while still retaining critical outcome observations.
  const identity = await Dexie.waitFor(Promise.resolve().then(() => stepFive
    ? tillEvidenceIdentity(input.backendOrigin!, input.orgId!, input.shopId!)
    : enrolledDevice(input.backendOrigin!, input.orgId!, input.shopId!)).catch(() => null));
  if (!identity) {
    if (required) throw new TrustUnavailable("The enrolled signing identity is unavailable; it will not be regenerated.");
    return { hash: null, gap: "device-authorization-unavailable" };
  }
  const payload = input.args ?? null;
  const [payloadHash, observationHash] = await Dexie.waitFor(Promise.all([digest(payload), digest(observation)]));
  const b = identity.enrollment.body;
  const streamId = evidenceStream({ deviceId: b.deviceId, keyId: b.keyId });
  const scope = JSON.stringify([input.backendOrigin, input.orgId, input.shopId, streamId]);
  const stableId = await Dexie.waitFor(digest([scope, input.key, kind, kind === "transmission" ? "single-transmission-binding" : observationHash]));
  const key = DEVICE_EVIDENCE_PREFIX + stableId;
  const existing = await localDb.syncState.get(key);
  if (existing) {
    const old = JSON.parse(existing.value ?? "null") as EvidenceRecord;
    if (old.envelope.body.payloadHash !== payloadHash || old.envelope.body.observationHash !== observationHash) throw new EvidenceIntegrityError("An operation's signed transmission changed. The original evidence and key are retained; no new request was sent.");
    return { hash: old.envelope.hash, gap: null };
  }
  const head = await localDb.syncState.get(headKey(scope));
  const previous = head ? JSON.parse(head.value ?? "null") as { sequence: number; hash: string } : null;
  if (head && (!previous || !Number.isSafeInteger(previous.sequence) || previous.sequence < 1 || !/^[a-f0-9]{64}$/.test(previous.hash))) throw new EvidenceIntegrityError("Evidence chain head is unreadable. It will not be reset.");
  const envelope = await Dexie.waitFor(signEvidence(identity, {
    protocol: "orvix-device-evidence-v1", orgId: input.orgId, shopId: input.shopId, deviceId: b.deviceId, keyId: b.keyId,
    operationId: input.key, rpc: input.rpc, evidenceKind: kind, payloadHash, observationHash,
    sequence: (previous?.sequence ?? 0) + 1, previousHash: previous?.hash ?? null, createdAt: new Date().toISOString(),
    authorization: { actorId: input.actorId, opEpoch: input.opEpoch ?? null, backendOrigin: input.backendOrigin, enrollmentId: b.enrollmentId },
  }));
  const record: EvidenceRecord = { envelope, enrollment: identity.enrollment, payload, observation };
  // add(), never put(): original snapshots are not changed with the journal.
  await localDb.syncState.add({ key, value: JSON.stringify(record), updatedAt: envelope.body.createdAt });
  await localDb.syncState.put({ key: headKey(scope), value: JSON.stringify({ sequence: envelope.body.sequence, hash: envelope.hash }), updatedAt: envelope.body.createdAt });
  return { hash: envelope.hash, gap: null };
}

/** Called inside the SAME IndexedDB transaction as the operation and journal.
 * waitFor is limited to WebCrypto / separate vault reads; all chain reads and
 * writes remain in the caller's live transaction. */
export async function captureJournal(record: JournalRecord): Promise<void> {
  const { deviceEvidenceHash: _old, deviceEvidenceGap: _gap, fingerprint: _fingerprint, ...snapshot } = record;
  void _old; void _gap; void _fingerprint; // derived free text can bypass field-based secret redaction
  const value = JSON.parse(JSON.stringify(snapshot)) as unknown;
  const { hash, gap } = await capture(record, value, "journal-observation", false);
  // Each observation states its own signing outcome: a new signature clears an older gap; a new
  // gap keeps the earlier signed hash (that observation WAS signed) and marks this one's gap.
  if (hash) { record.deviceEvidenceHash = hash; delete record.deviceEvidenceGap; }
  else if (gap) record.deviceEvidenceGap = gap;
}

/** Exact wire payload binding after provisional references have resolved.
 * Never replace the financial key, actor, creation timestamp or epoch. */
export async function captureTransmission(input: CaptureInput): Promise<void> {
  await localDb.transaction("rw", localDb.syncState, async () => {
    await capture(input, { rpc: input.rpc, key: input.key, actorId: input.actorId, opEpoch: input.opEpoch ?? null }, "transmission", true);
  });
}

export async function listDeviceEvidence(orgId: string, shopId?: string): Promise<EvidenceRecord[]> {
  const rows = await localDb.syncState.where("key").startsWith(DEVICE_EVIDENCE_PREFIX).toArray();
  const result: EvidenceRecord[] = [];
  for (const row of rows) {
    // Unreadable originals are left on disk; the caller must not call this a
    // completeness check. Owner export keeps damaged and malformed records with their raw bytes, flagged unreadable.
    try {
      const r = JSON.parse(row.value ?? "null") as EvidenceRecord;
      if (r.envelope.body.orgId === orgId && (!shopId || r.envelope.body.shopId === shopId)) result.push(r);
    } catch { throw new TrustUnavailable("Device evidence is unreadable. Preserve the profile before recovery."); }
  }
  return result.sort((a, b) => evidenceStream(a.envelope.body).localeCompare(evidenceStream(b.envelope.body)) || a.envelope.body.sequence - b.envelope.body.sequence);
}
