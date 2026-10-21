# Review: offline clients and legacy compatibility (correction pass)

Date: 2026-10-21. One independent review, plus the client portion of the round-2 crypto/client re-review. Final verdict: **GO**. No CRITICAL or HIGH findings.

## What the reviewer ran
- `src/recovery/offlineCompat.test.ts`: 10/10 on the corrected tree. On a scratch copy of the pre-correction code (snapshot checksums verified), 4 failed: the three 085 failure cases (network down, timeout, 500) and the "not persisted" case. All four failed with "Recovery authorization could not be established", thrown before the sale was saved.
- `npx vitest run audit/rc1 tools/queue-recovery src/lib/queueExport`: 88/88.
- Full suite: 151 files and 1882 tests passed, 0 failed.
- Pristine 4971b55 PT503 tests: 5/5.

## Confirmed behaviour
- **085/086/087 without V1:**
  - A failed status request no longer blocks offline selling: the sale is saved and queued with its key.
  - With `navigator.onLine` false, no request is made.
  - Drain, retry, set-aside and reconcile behave as at 4971b55.
- **Detection:**
  - Detection is durable per backend origin and organization.
  - After detection, every failure, a missing function, a malformed reply, being offline or an unknown organization blocks.
  - The 30 s in-memory window is consulted only before detection.
- **Old clients against V1 guards:** the server refuses with PT503 `ORG_SUSPENDED`. 1.0.16 holds queued entries as retryable `suspended`. 1.0.15 marks them `conflict`, kept until someone retries them manually.
- **Export format 4:** older readers refuse a format-4 file, and formats 1–3 still read.
- **Local storage:** IndexedDB has no schema bump and no key renames. Additions are a separate `orvix-recovery-device-v1` database and `rv1:*` keys. No forced-update path exists.
- **m086 compatibility:** no exports were removed or renamed, and the legacy parts are unaffected.

## Findings and disposition
| Severity | Finding | Disposition |
|---|---|---|
| MEDIUM | Detection is one-way with no client reset: removing V1 or restoring a pre-V1 backup leaves tills refusing financial writes. | Documented in the device-witness doc. It is also part of the unresolved offline-first production blocker (see IMPLEMENTATION-REPORT.md). |
| MEDIUM | 1.0.15 turns PT503 into a manual-retry conflict; nothing was tested over real HTTP/PostgREST. | Documented: 1.0.15 must be upgraded or isolated before V1. |
| LOW | A status request that hangs (rather than fails) can delay a sale by up to 8 s, at most once per 30 s. | Documented. |
| LOW | The doc overstated what is non-retryable. | Corrected. |
| LOW | A doc path was relative to the wrong directory. | Corrected. |
| LOW | A corrupt `rv1` marker blocks selling even on a legacy server. | Fail-closed by design. |
| LOW | The queue-recovery CLI does not mention the signed evidence it reads. | Open, cosmetic. |
