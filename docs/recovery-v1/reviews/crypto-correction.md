# Review: cryptographic trust and backup/recovery (correction pass)

Date: 2026-10-21. This supplements [crypto.md](crypto.md), which covers the implementing session's own review. Three independent rounds were run. Final verdict: **GO**. No CRITICAL or HIGH finding is open.

## Round 1: GO with conditions (no CRITICAL/HIGH)
- **M1.** A server-produced email archive repackaged by the adapter was reported as `authenticity: verified`.
- **M2.** The organization/shop "tenant binding" is only a label: a logical dump holds every tenant.
- **M3.** ECDSA high-S twins verified, and evidence and receipt hashes include the signature, so a third party could fabricate a "fork".
- **M4.** A signature that should exist but could not be produced left no trace.
- **LOW.** Adapter strictness and size limits, "could not check" reported as "damaged", WAL coverage from producer metadata, export gaps, test trust sources accepted on the write path, odd arguments stalling an operation, no `navigator.storage.persist()`.

**Fixes:**
- Provenance is now an allow-list, with findings for infrastructure-produced contents and for tenant labels.
- Signatures are low-S only.
- A `deviceEvidenceGap` marker records missing signatures.
- Adapter limits and the 128 MiB cap (below the email tier's 180 MiB) are documented.

## Round 2: NO-GO for crypto, GO for client and backup
- **HIGH.** Non-canonical base64 still let a signature be re-encoded with a different hash, so a fake "fork" was still possible.
- **MEDIUM.** A missing or `local-test` provenance label could count as authentic, and the raw report was inconsistent.
- **MEDIUM.** Damaged own-organization evidence was exported unredacted.
- **LOW.** A crafted record could pass the text-match scope check; module-level gap state; a detection race; a misleading storage-failure message.

**Fixes:**
- `verify()` refuses non-canonical base64.
- `backupAssessmentInput` is an allow-list, and the raw report's `authenticity` is consistent, with `signatureVerified` reported separately.
- Damaged evidence is scoped by parsed organization fields and redacted.
- The gap is returned per capture.

## Round 3 (combined final verification): CLOSED
- **Signatures.** 40 signatures probed. High-S twins and all 15 non-canonical base64 variants are refused; `sign()` never produced high-S; the n/2 boundary is correct.
- **Provenance.** Only `local-test` counts as authentic; missing, unknown, wrong-case, null and `infrastructure-source` labels are all unverified, and the report and assessment agree.
- **Export.** Escaped, numeric, conflicting, null and `__proto__` organization fields are all handled without a leak.
- **Remaining LOW, documented:**
  - `local-test` is accepted on any backup format.
  - `backupAssessmentInput` trusts the report object it is given.
  - Neither can reopen anything, because the assessment never returns ACTIVE.

## Guarantee answers (from the round 1 reviewer, unchanged by later rounds)
These answers assume trust pins from custody the server does not control, and client code that is not served altered.

| Question | Answer |
|---|---|
| Can a compromised server forge device evidence? | No. It can withhold evidence. |
| Can it enroll an attacker device? | No: enrollment needs the pinned root key's signature and a fresh ACTIVE status. |
| Can it hide later checkpoints? | Yes; only an independently supplied boundary limits this. |
| Can incomplete replay be detected? | Only up to that boundary, for the supplied streams (no device roster). |
| Can every lost transaction be reconstructed? | No. |
| Does offsite data survive host loss? | Not established. |
| Who controls the trust keys? | Nobody yet: no production custody exists. |
