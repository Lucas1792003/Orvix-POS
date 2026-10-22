import { canonical, digest, isDigest, isId, isTime, sign, verify } from "./canonical";
import { verifyEnrollment, type Enrollment, type IndependentTrustSource } from "./trust";
import type { DeviceIdentity } from "./deviceVault";

export interface EvidenceBody {
  protocol: "orvix-device-evidence-v1";
  orgId: string;
  shopId: string;
  deviceId: string;
  keyId: string;
  operationId: string;
  rpc: string;
  evidenceKind: "journal-observation" | "transmission";
  payloadHash: string;
  observationHash: string;
  sequence: number;
  previousHash: string | null;
  createdAt: string;
  authorization: { actorId: string | null; opEpoch: string | null; backendOrigin: string; enrollmentId: string };
}
export interface SignedEvidence { body: EvidenceBody; signature: string; hash: string }
export interface EvidenceRecord {
  envelope: SignedEvidence;
  enrollment: Enrollment;
  /** Original operation / observation, preserved even after later journal
   * changes. They may contain cost data: export only for its organization owner. */
  payload: unknown;
  observation: unknown;
}
export const evidenceStream = (b: Pick<EvidenceBody, "deviceId" | "keyId">): string => `${b.deviceId}:${b.keyId}`;

export async function signEvidence(identity: DeviceIdentity, body: EvidenceBody): Promise<SignedEvidence> {
  const e = identity.enrollment.body;
  if (body.orgId !== e.orgId || body.shopId !== e.shopId || body.deviceId !== e.deviceId || body.keyId !== e.keyId
    || body.authorization.enrollmentId !== e.enrollmentId) throw new Error("EVIDENCE_ENROLLMENT_MISMATCH");
  const signature = await sign(body, identity.privateKey);
  return { body, signature, hash: await digest({ body, signature }) };
}

export async function verifyEvidence(record: EvidenceRecord, source: IndependentTrustSource | null, expected: { orgId: string; shopId: string; deviceId?: string }): Promise<boolean> {
  try {
    const { envelope: e, enrollment } = record;
    const b = e.body;
    const a = b.authorization;
    if (b.protocol !== "orvix-device-evidence-v1" || b.orgId !== expected.orgId || b.shopId !== expected.shopId
      || (expected.deviceId && b.deviceId !== expected.deviceId) || ![b.orgId, b.shopId, b.deviceId, b.operationId, b.rpc, a.enrollmentId].every(isId)
      || !["journal-observation", "transmission"].includes(b.evidenceKind) || !Number.isSafeInteger(b.sequence) || b.sequence < 1
      || !isTime(b.createdAt) || !isDigest(b.payloadHash) || !isDigest(b.observationHash) || (b.previousHash !== null && !isDigest(b.previousHash))
      || (b.sequence === 1 ? b.previousHash !== null : b.previousHash === null)
      || (a.actorId !== null && !isId(a.actorId)) || typeof a.backendOrigin !== "string" || !a.backendOrigin
      || (a.opEpoch !== null && typeof a.opEpoch !== "string")) return false;
    const t = enrollment.body;
    if (!await verifyEnrollment(enrollment, source, b.createdAt) || t.orgId !== b.orgId || t.shopId !== b.shopId || t.deviceId !== b.deviceId
      || t.keyId !== b.keyId || t.enrollmentId !== a.enrollmentId || await digest(record.payload) !== b.payloadHash
      || await digest(record.observation) !== b.observationHash || await digest({ body: b, signature: e.signature }) !== e.hash) return false;
    return await verify(b, e.signature, t.publicKey);
  } catch { return false; }
}

/** Verify one device/key stream, requiring a complete prefix from genesis.
 * Even a valid prefix does not prove there were no omitted operations or tail. */
export async function verifyEvidencePrefix(records: readonly EvidenceRecord[], source: IndependentTrustSource | null, expected: { orgId: string; shopId: string; deviceId?: string }): Promise<{
  valid: boolean; complete: false; prefixVerified: boolean; sequence: number; digest: string | null; streamId: string | null; findings: string[];
}> {
  const findings: string[] = [];
  let previousHash: string | null = null;
  let streamId: string | null = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const currentStream = evidenceStream(r.envelope.body);
    streamId ??= currentStream;
    if (currentStream !== streamId || r.envelope.body.sequence !== i + 1 || r.envelope.body.previousHash !== previousHash
      || !await verifyEvidence(r, source, expected)) { findings.push(`INVALID_EVIDENCE_AT_${i + 1}`); break; }
    previousHash = r.envelope.hash;
  }
  if (!records.length) findings.push("NO_DEVICE_EVIDENCE");
  const valid = findings.length === 0;
  return { valid, complete: false, prefixVerified: valid, sequence: valid ? records.length : 0, digest: valid ? previousHash : null, streamId,
    findings: [...findings, "AUTHENTIC_PREFIX_DOES_NOT_PROVE_NO_OMISSIONS_OR_LATEST_TAIL"] };
}

export const evidenceIdentity = (record: EvidenceRecord): string => canonical([record.envelope.body.orgId, record.envelope.body.shopId, evidenceStream(record.envelope.body), record.envelope.body.sequence]);
