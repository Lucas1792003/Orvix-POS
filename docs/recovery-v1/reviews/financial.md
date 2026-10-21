# Review: financial integrity and idempotency (correction pass)

Date: 2026-10-21. One independent read-only review of the correction pass. Final verdict: **GO for a completed local checkpoint**. No CRITICAL or HIGH findings.

## What the reviewer ran
- Full `npx vitest run`: 151 files passed, 15 skipped (environment-gated live/disposable files); 1882 passed, 228 skipped, 0 failed.
- `npx tsc -b`.
- DB harness: stage 85 at 93/0 and stage 86 with the financial provisionals at 99/0. The race was preserved, the install was refused without the acknowledgement, and the encrypted restore was verified. These were the counts at review time; the final runs are 102/0 and 115/0.
- Six probes added to a scratch copy of `offlineCompat.test.ts`; all 16 passed.

## Questions answered (all CLEAN)
- **No double execution, dropped operation, re-key, or retry of an uncertain outcome under a new key.**
  - `keepUnknown` keeps an uncertain outcome unknown, and RECOVERY is never retried automatically.
  - The drain-level block returns backoff and keeps the queue.
  - Blocked queued entries stay pending, with the same key and their in-doubt flag.
- **Offline selling on a legacy 085 server.** A failed status request before detection falls back to the legacy rules and is never persisted as "absent". After detection, every failure blocks.
- **Fencing.** A fence never overwrites an existing ledger row, uses exactly `idem_begin`'s advisory lock, applies to the same key only, survives the real prune (V1 skips all ledger deletes), and unfencing is always denied.
- **Restricted writes.** They are refused server-side with a retryable PT503. Clients hold the operation and never present it as a final refusal.

## Findings and disposition
| Severity | Finding | Disposition |
|---|---|---|
| MEDIUM | The export silently dropped malformed evidence and receipts, and exported unreadable ones without their bytes. | Fixed in rounds 2–4. Evidence is now exported as redacted contents only when every org field is the exporting organization; otherwise as a key, size and fingerprint marker. Tested in `src/recovery/reviewRound2.test.ts`. |
| MEDIUM | Offline tests were weaker than their names: no cached-ACTIVE start, and set comparison of sent keys. | Fixed. Added a test that starts from cached ACTIVE, and exact sent-key arrays on reconnect. |
| LOW | The "No retry…" message also appeared on held entries that are in fact retried automatically. | Fixed: the message now depends on the block reason. |
| LOW | The journal records a send for an attempt that was blocked before sending. | Documented. It overstates uncertainty and never hides it. |
| LOW | `EvidenceIntegrityError` is held and re-checked by the outbox, not left for a person. | Documented in the device-witness doc. Nothing is sent. |
| LOW | A malformed 200 status reply quarantines a not-yet-detected server. | Accepted as fail-closed. |
| LOW | Stale assertion counts in the README and `summary.json`. | Fixed. |
