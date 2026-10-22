export interface RecoveryAssessmentInput {
  orgId: string;
  shopId: string;
  backup: { authenticity: "verified" | "unverified"; integrity: "verified" | "damaged" | "missing"; coverage: "verified" | "incomplete" | "unknown" };
  evidence: { valid: boolean; complete: boolean; findings: string[] };
  witness: { valid: boolean; latestEstablished: boolean; findings: string[] };
}

/** Internal aggregation only. External tools must call raw crypto verifiers,
 * never trust user-provided booleans as verified reports. There is no release
 * authority here and even all green inputs cannot automatically reopen. */
export function assessRecovery(input: RecoveryAssessmentInput): {
  protocol: "orvix-recovery-assessment-v1"; orgId: string; shopId: string;
  state: "RESTRICTED" | "QUARANTINED"; reopenAuthorized: false; findings: string[];
} {
  const findings = [...input.evidence.findings, ...input.witness.findings];
  if (input.backup.authenticity !== "verified") findings.push("BACKUP_PROVENANCE_UNVERIFIED");
  if (input.backup.integrity !== "verified") findings.push(`BACKUP_${input.backup.integrity.toUpperCase()}`);
  if (input.backup.coverage !== "verified") findings.push("BACKUP_COMPLETENESS_NOT_ESTABLISHED");
  if (!input.evidence.complete) findings.push("FINANCIAL_HISTORY_COMPLETENESS_NOT_ESTABLISHED");
  if (!input.witness.latestEstablished) findings.push("LATEST_LEGITIMATE_CHECKPOINT_NOT_ESTABLISHED");
  findings.push("INDEPENDENT_OWNER_RELEASE_NOT_IMPLEMENTED;NO_AUTOMATIC_REOPEN");
  return {
    protocol: "orvix-recovery-assessment-v1", orgId: input.orgId, shopId: input.shopId,
    state: !input.evidence.valid || !input.witness.valid || input.backup.integrity !== "verified" || input.backup.authenticity !== "verified" ? "QUARANTINED" : "RESTRICTED",
    reopenAuthorized: false, findings: [...new Set(findings)],
  };
}
