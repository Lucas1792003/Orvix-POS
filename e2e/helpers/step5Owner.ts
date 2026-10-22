// Step 5 E2E: the SYNTHETIC owner (tools/recovery-v1/owner/owner-sim.mjs, key on the host in a temp dir, never in the
// database container) and the recovery OPERATOR (the role Control uses: orvix_recovery_operator) acting on the DISPOSABLE
// loopback stack. The operator only carries owner-signed documents and performs containment; it never signs anything.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSql } from "./db";
import { PROJECT_ROOT } from "./env";

const SIM = path.join(PROJECT_ROOT, "tools/recovery-v1/owner/owner-sim.mjs");
const dollar = (s: string): string => { let t = "q"; while (s.includes(`$${t}$`)) t += "x"; return `$${t}$${s}$${t}$`; };
export const FIXTURE_OWNER = "SYNTHETIC-TEST-OWNER (local simulation; not an independent production authority)";

/** The last non-empty line of a psql -At result. */
export const sqlOne = (q: string): string => runSql(q).trim().split("\n").filter(Boolean).pop() ?? "";
export const sqlJson = <T = Record<string, unknown>>(q: string): T => JSON.parse(sqlOne(q)) as T;
export const operator = <T = Record<string, unknown>>(call: string): T =>
  JSON.parse(runSql(`SET ROLE orvix_recovery_operator;\nSELECT (${call})::text;\nRESET ROLE;`).trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("[")).pop() ?? "null") as T;

export class SyntheticOwner {
  private n = 0;
  constructor(readonly keydir: string, readonly keyId: string, readonly workdir: string) { mkdirSync(workdir, { recursive: true }); }
  authorize(purpose: string, payload: Record<string, unknown>, opts: { expiresIn?: number; issuedOffset?: number; keyId?: string } = {}): { authorization: string; signature: string } {
    this.n += 1;
    const target = path.join(this.workdir, `target-${this.n}.json`); const pay = path.join(this.workdir, `payload-${this.n}.json`);
    writeFileSync(target, sqlOne("SELECT recovery_v1.authorization_target()::text;"));
    writeFileSync(pay, JSON.stringify(payload));
    const keyId = opts.keyId ?? this.keyId;
    const out = execFileSync("node", [SIM, "authorize", path.join(this.keydir, `${keyId}.private.pem`), keyId, purpose, target, pay,
      "--expires-in", String(opts.expiresIn ?? 3600), "--issued-offset", String(opts.issuedOffset ?? 0)], { encoding: "utf8" });
    return JSON.parse(out) as { authorization: string; signature: string };
  }
  /** a second, NON-enrolled key (an attacker's or a mistaken one) in the same temp dir */
  keygen(keyId: string): void { execFileSync("node", [SIM, "keygen", this.keydir, keyId], { encoding: "utf8" }); }
}

/** Carry an owner-signed document to the verifier through the operator role (what Control does). */
export function submit(a: { authorization: string; signature: string }): Record<string, unknown> {
  return operator(`recovery_v1.operator_submit(${dollar(a.authorization)}, ${dollar(a.signature)}, 'e2e-control-operator')`);
}

export interface DeviceRequest { requestId: string; shopId: string; deviceId: string; keyFingerprint: string; shortCode: string; requestNonce: string; replaces: string | null }
export function pendingRequests(orgId: string): DeviceRequest[] {
  return (operator<{ deviceRequests: DeviceRequest[] }>(`recovery_v1.operator_organization('${orgId}')`).deviceRequests) ?? [];
}

export function approveDevice(owner: SyntheticOwner, orgId: string, r: DeviceRequest, over: Record<string, unknown> = {}, opts: { keyId?: string } = {}) {
  const a = owner.authorize("enroll-device", { scope: orgId, ownerId: FIXTURE_OWNER, device: {
    requestId: r.requestId, orgId, shopId: r.shopId, deviceId: r.deviceId, keyFingerprint: r.keyFingerprint, requestNonce: r.requestNonce,
    notAfter: new Date(Date.now() + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z"), replacesEnrollmentId: r.replaces, ...over } }, opts);
  return submit(a);
}

export interface Report { outcome: string; incidentId: string; recoveryEpoch: number; digest: string; blockers: string[]; hardBlockers: string[]; facts: Record<string, unknown> }
export function reconcile(orgId: string): Report {
  const st = sqlOne(`SELECT state FROM recovery_v1.org_state WHERE org_id = '${orgId}';`);
  if (st !== "RECONCILING") operator(`recovery_v1.operator_transition('${orgId}', 'RECONCILING', 'synthetic recovery review', 'e2e-incident', 'e2e-control-operator')`);
  return operator<Report>(`recovery_v1.operator_reconciliation_report('${orgId}', 'e2e-control-operator')`);
}

export function reopen(owner: SyntheticOwner, orgId: string, rep: Report, decision: "verified" | "limited", uncertainties: string[] = []) {
  return submit(owner.authorize("reopen-organization", { scope: orgId, ownerId: FIXTURE_OWNER, reopen: {
    orgId, incidentId: rep.incidentId, recoveryEpoch: rep.recoveryEpoch, fromState: "RECONCILING", toState: "ACTIVE", reportDigest: rep.digest, decision,
    acceptedBlockers: decision === "limited" ? rep.blockers : [], uncertainties, witnessRequired: false, checkpointHashes: [], backupManifestSha256: null, recoveredAsOf: null } }));
}
