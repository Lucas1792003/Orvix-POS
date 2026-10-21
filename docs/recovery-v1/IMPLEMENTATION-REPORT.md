# Safe Recovery V1 — implementation report (Script 1, after the mandatory correction pass)

Date: 2026-10-21. Worktree: `~/Projects/personal/Orvix/worktrees/recovery-v1`, branch `ws/recovery-v1`, based on POS `4971b55`. Everything is **uncommitted**. Nothing was pushed, merged, deployed or migrated. No production, lucashome, Control or existing Docker resource was touched. **Production remains NO-GO.**

Script 1 was implemented in one session. The correction pass (P0–P6 of the correction brief) was carried out in a second session that took the worktree over. The pre-correction state is preserved read-only, with SHA-256 checksums, at `~/Projects/personal/Orvix/artifacts/recovery-v1-prefix-20261021T101400Z/`.

## 1. Code inventory

**Changed tracked files (16).**

| Area | Files |
|---|---|
| Queue and journal | `src/stores/data/{outbox,idempotentRpc,opJournal,reconcile,recovery87,recoveryGate}.ts` |
| Export | `src/lib/queueExport/{format,collect}.ts` |
| UI | `src/components/sync/RecoveryBanner.tsx` |
| Test fakes and tests | `src/stores/data/testing/fakeSupabase.ts`, four test files |
| Provisional SQL | `supabase/migrations-provisional/PSAFE-A_no_086_rerun_after_087.sql` (a 6-line fix of a pre-existing absent-087 preflight defect) |
| Config | `vitest.config.ts` (excludes the `node:test` files) |

**New files (46, excluding evidence).**

| Area | Files |
|---|---|
| Client modules | `src/recovery/{canonical,trust,deviceVault,evidence,witness,assessment,journalCapture,sync,client,testing}.ts` |
| Client tests | `src/recovery/*.test.ts`, including `offlineCompat.test.ts` and `reviewRound2.test.ts` |
| Export tests | `src/lib/queueExport/evidenceFormat.test.ts`, plus `__fixtures__/format.4971b55.ts` (a frozen copy of the shipped reader) |
| Provisional SQL | `supabase/migrations-provisional/RECOVERY_V1_guards.sql` (unnumbered; not migration 088) |
| Backup tools | `tools/recovery-v1/{backup-archive,restore-verification,email-archive-adapter,backup-fixture-roundtrip}.mjs` and their tests |
| Verifier and witness | `tools/recovery-v1/{verify-recovery,witness-local,integration-smoke}.ts` |
| DB harness | `tools/recovery-v1/db/{db-smoke.py, smoke.sql, financial-smoke.sql, cross-org-seed.sql, cross-org-smoke.sql, cross-org-cost-smoke.sql, retention-smoke.sql, psafe-regression.sql, dr-fence-keys.sql, dr-unfence-key.sql}` |
| Schema fixture | `tools/recovery-v1/db/fixtures/schema-061.scrubbed.sql` (schema only, no data) |
| Docs | `docs/recovery-v1/{backup-readiness.md, reviews/crypto.md, IMPLEMENTATION-REPORT.md}`, `docs/selfhost-migration/phase-g/safe-recovery-v1-device-witness.md`, `tools/recovery-v1/db/README.md` |
| Evidence | `docs/recovery-v1/evidence/` |

**Dependencies.** No dependency was added or changed: `package.json` and the lockfile are unchanged. The modules use WebCrypto, `node:crypto` and the existing Dexie and zod.

**Module boundaries.**
- `canonical` is the protocol and crypto core.
- `trust` holds the independent trust-source interface; its default is absent, so it fails closed.
- `deviceVault` holds the non-extractable device key.
- `evidence` and `journalCapture` handle signed observations inside the existing journal transaction.
- `witness` covers checkpoints and the LOCAL TEST witness.
- `client` holds recovery status, detection, and the write gate used by the gate, outbox and send boundary.
- `sync` uploads evidence while restricted.
- `assessment` aggregates results and has no release authority.
- On the server, `RECOVERY_V1_guards.sql` provides the per-organization state, row guards, fencing and the evidence/checkpoint store.
- Offline, the tools handle backup sealing and verification and the email-archive adapter.

## 2. What actually works

| Protection | Classification | Notes |
|---|---|---|
| A. Device-signed evidence | **Implemented and locally verified** | P-256 ECDSA, non-extractable WebCrypto key, low-S and canonical base64 only. Binding covers org, shop, device, key, operation, RPC, payload, sequence, chain and authorization. Visible gap marker when a signature is expected but cannot be produced. There is no hardware attestation, and enrollment authority **requires independent infrastructure** (none exists). |
| B. Checkpoint witness | **Interface implemented and verified with a LOCAL TEST DOUBLE only** | Fork, rollback, withheld-boundary and missing-receipt detection, with `latestEstablished` always false. An independent witness **requires external infrastructure**. |
| C. Encrypted backup readiness | **Implemented and locally verified (synthetic)**; email path **partially integrated** | AES-256-GCM + RSA-OAEP-3072 + Ed25519 with a provenance allow-list; WAL name/size coverage; email-archive adapter for owner-side packaging. Offsite survival **not established**, and delivery is disabled. Physical/PITR verification is unsupported. |
| D. Duplicate-execution fencing | **Implemented and locally verified** | Same key only. Never overwrites a completed record. Survives the real prune, which V1 disables entirely. Unfence is always denied. |
| E. Server-enforced restricted recovery | **Implemented and locally verified** | Per-organization state with ENABLE ALWAYS row guards; cross-organization, dangling and identity-change refusal; 087 incompatibility detected at runtime. Reopening is **blocked by architecture**, because no independent owner authorization exists. |
| F. Compatibility | **Implemented and verified for 085, 086 and 086+financial**; 087+V1 **incompatible by design** | Legacy offline selling preserved; export format 4; old readers refuse. 1.0.15 needs upgrade or isolation. |
| G. Integration | **Implemented** | One write gate across new operations, drain and sends; evidence inside the journal transaction; evidence-only upload while restricted; owner export of evidence and receipts. |

## 3. Evidence

Each row compares the result before the correction pass with the final result.

| Check | Before the correction pass | Final |
|---|---|---|
| TypeScript (app, tools) | pass | pass |
| ESLint, full | 63 errors / 2 warnings (baseline) | identical file set and counts to the 4971b55 baseline |
| ESLint, changed areas | 0 | 0 |
| Production build | pass | pass |
| Vitest, full | 3 failed in queueExport, plus 2 `node:test` files mis-collected | **152 files passed, 15 skipped; 1891 tests passed, 228 skipped, 0 failed** |
| `node --test` (backup readiness + email adapter) | 20/20 (readiness only) | 28/28 |
| Integration smoke / witness smoke | 8/8 / pass | 8/8 / pass |
| DB harness, stage 085 | 75/0 | **102/0** (29 original financial checks/0) |
| DB harness, stage 086 | not run | **102/0** |
| DB harness, stage 086 + PFIN-A/B, PCOST-A, PSAFE-A | 81/0 | **115/0** |
| Concurrent resend/fence race; encrypted restore | preserved; verified | preserved; verified (all three stages) |
| Install refused without acknowledgement (plain `psql -f`, session-level, database-level, statement-per-connection) | n/a (no acknowledgement existed) | refused, nothing created (all four cases, all three stages) |
| Real 087 applied after V1 | ran unrestricted (found by review) | every guarded write refused, status QUARANTINED; rolled back |
| Phase-d business suites t05–t19, guarded with all orgs ACTIVE vs unguarded | not run | unguarded 445/5, guarded 428/18. All 13 guarded-only failures are still refusals (6 message masking, 7 `app_config` by design); no write allowed that unguarded refuses |

**The regressions, shown on the pre-fix code.**
- **Offline selling.** On a legacy 085 server whose status request failed, `src/recovery/offlineCompat.test.ts` failed 4 tests on the pre-fix copy and passes 11/11 on the fixed code (`docs/recovery-v1/evidence/correction-pass/{prefix,fixed}-client-offlineCompat.log`). The pre-fix error was "Recovery authorization could not be established", thrown before the sale was saved.
- **Cross-organization writes.** Against the pre-fix guard SQL, all 8 cross-organization privileged writes succeeded (`prefix-guard-sql-stage085/cross-org-smoke.log`). All are refused now.

**Baseline versus new failures.** The 3 queue-export test failures were introduced by the Script 1 session and are fixed. The 32 failures of `recovery087.client.test.ts` were introduced and then fixed within the correction pass; they were caused by status-marker writes escaping the storage-failure refusal. The 5 phase-d failures seen in both guarded and unguarded runs are a pre-existing ordering artifact of running t05–t19 after the harness's t02/t03.

**Skipped and why.**
- Live/disposable-stack Vitest files (15) need a running backend.
- Old-client behaviour against V1 over real HTTP/PostgREST was not tested; there is no stack.
- Full Supabase restore, physical/PITR restore, and real email delivery or retrieval are not available locally or not permitted.
- Phase-d t13 dials a default socket the harness does not provide.

## 4. Independent reviews

Four separate review passes were run, plus re-reviews after each fix round.

Full review records: `docs/recovery-v1/reviews/` (README index, financial, postgres, crypto + crypto-correction, offline-compat).

| Area | First pass | Re-review(s) | Status of the last independent verdict |
|---|---|---|---|
| Financial integrity | GO (2 MEDIUM) | — | GO; both MEDIUMs fixed |
| PostgreSQL security / tenant isolation | **NO-GO** (H1 087 bypass, H2 acknowledgement bypass, H3 resolver gaps) | **NO-GO** twice. Round 2: product-with-cost regression, a meta-command-ignoring client, audit flooding. Round 3: cost forward-reference relink, a statement-per-connection client. | **Conditional GO (round 4)**: no CRITICAL/HIGH; single-transaction forward reference, per-user quota and installer equivalence confirmed. Its conditions were six doc statements, all corrected. Its stored-setting install finding was closed in code (the acknowledgement is now the installer's argument) and re-run green. Remaining LOW items are listed as known limits. |
| Cryptographic trust / recovery | GO with conditions (4 MEDIUM) | **NO-GO** (base64 re-encoding), then CLOSED in round 3 (base64, high-S, provenance allow-list) | GO for crypto and backup |
| Offline clients / compatibility | GO (2 MEDIUM) | GO for client | GO |

The fixes are described in the correction-pass section of each doc and in sections 5–7 below. Each fixed item has a test that failed or was missing before.

## 5. Outstanding guarantees

These answers assume trust pins come from custody the server does not control, and that the client code is not served altered by the server.

- **Can a compromised server forge device evidence?** No: it holds no device key. It can withhold evidence. If it also serves the app's JavaScript, it can make a device sign anything, so independent client distribution is required.
- **Can a compromised server enroll an attacker device as trusted?** No, not without the pinned enrollment authority's signature and a fresh independent ACTIVE status. No production enrollment authority exists.
- **Can an attacker hide later checkpoints?** Yes. Only an independently supplied trusted boundary limits withholding, and an authentic receipt never proves it is the latest.
- **Can incomplete transaction replay be detected?** Only up to a trusted boundary, and only for the device streams supplied. There is no device roster, so omitted devices cannot be detected.
- **Can every lost transaction be reconstructed?** No. Hashes and receipts can show that something is missing; they cannot recover its content.
- **Can financial operations execute twice?**
  - Under the same key, no: the idempotency ledger, and a fence where one exists.
  - Under a different key, the fence does not apply. V1 blocks manual re-entry while restricted, but a person entering the same sale again under a new key after reopening is not prevented by the fence.
- **Can old clients bypass restricted recovery?** Not through supported interfaces. The database refuses their writes with PT503. 1.0.16 holds them; 1.0.15 marks them as a conflict and needs upgrade or isolation. Superusers and table owners are outside the boundary.
- **Does offsite data actually survive host loss?** Not established. Email delivery is disabled and only a simulated recipient was used.
- **Who controls the keys that establish independent trust?** Nobody yet. Every key exercised is a synthetic in-memory test key; independent custody is a deployment prerequisite.

## 6a. Unresolved production requirement: Orvix is offline-first

**Recorded by owner instruction, 2026-10-21.** Orvix is an offline-first POS. A healthy ACTIVE organization must ultimately keep a safe offline-selling capability.

The current V1 client permanently refuses offline financial operations once a till has detected the recovery protocol on its server, even when the organization is ACTIVE. Combined with one-way detection, a till that has seen V1 can never sell offline again. This is **not approved as the final production behaviour**. It was deliberately left unchanged in this checkpoint and is an **unresolved production blocker**.

A production design must define an independently authorized offline-execution policy for ACTIVE organizations that preserves duplicate-execution safety and recovery evidence. Bounded offline windows and pre-authorized offline epochs are possible approaches.

**Other production blockers carried with this checkpoint:**
- Owner-held key enrollment and authorization. No independent owner, enrollment or status authority exists, so no organization can be reopened.
- Independent witness custody.
- Real offsite encrypted backup delivery and owner-verified restore.
- Installation restricts every organization at once, and onboarding is closed while installed.
- Migration 087 is incompatible with V1; a reviewed adapter is required.
- Ledger retention and growth: pruning is disabled while V1 is installed.
- Legacy-client compatibility: 1.0.15 must be upgraded or isolated, and nothing was tested over real HTTP/PostgREST.
- Cross-branch integration with the cleanup branch (`ws/cleanup-orvix`), which edits four of the same files.

## 6. Recovery installation and activation risks

- **Installing is an outage.** It restricts every organization at once, and there is no reopen path except a superuser `UPDATE`, which is not an authorization. It now requires an explicit per-invocation acknowledgement and is refused otherwise. It must never be installed on a database serving live trading.
- **Onboarding is closed.** New organizations cannot be created while V1 is installed, and `app_config` / `platform_admins` writes are refused.
- **Detection is one-way on tills.** Removing the SQL or restoring a pre-V1 backup leaves every till that saw V1 refusing financial writes. Export first.
- **Ledger growth.** Pruning and the 086 response purge are disabled indefinitely. `ledger_retention_report()` gives sizing data, and retention requirements are documented.
- **Write cost.** About 0.25–0.45 ms extra per guarded row (bulk writes about 80× slower).
- **087.** Applying 087 after V1 quarantines every write. A reviewed adapter is required; neither 087+V1 nor 088 is implemented.

## 7. Remaining external trust and backup prerequisites

1. **Independent owner and enrollment custody:** keys held outside the recovering host, a status service, and pinning in client builds.
2. **An independently operated, append-only witness**, and a source for the trusted boundary.
3. **An owner-signed release statement verified in the database** (for example ES256 in PL/pgSQL, as Control 205 does), against an owner key pinned outside the host. Until this exists, no organization can be reopened.
4. **Independent backup decryption custody**, a proven offsite copy (delivery enabled and retrieval verified by the owner), a streaming envelope for archives larger than 128 MiB, and physical/PITR verification.
5. **Durable denial logging** shipped off the host. Today denials of rejected writes survive only in the PostgreSQL server log.
6. **Client release:** V1-aware clients everywhere, with 1.0.15 upgraded or isolated first.

## 8. Owner decisions needed

- Whether and when to build the independent owner and witness infrastructure in section 7.
- The ledger retention policy, using the documented requirements.
- The 087 + V1 adapter design, and the sequencing of V1 with 086/087.
- Whether the V1 offline policy, which blocks offline financial writes once a till has detected V1, is acceptable.
- Whether to accept the onboarding closure while V1 is installed, or design an independently authorized organization-creation path.

## 9. GO / NO-GO

- **Completed local checkpoint: GO.** All four review areas now end on an independent GO; the PostgreSQL area is a conditional GO whose conditions were met:
  - **Its six doc statements** are corrected.
  - **Its stored-setting finding** is closed in code: the acknowledgement is the installer's argument.
  - **The DB harness** re-ran green: 085 102/0, 086 102/0, 086+financial 115/0, all four install-refusal cases, 087 incompatible.
  - **The rest of the validation** is green: full Vitest 1891/0, TypeScript, build, `node --test` 28/28, smokes, ESLint identical to baseline.

  The remaining LOW items are documented as known limits in `tools/recovery-v1/db/README.md` and the device-witness doc:
  - a two-session cost-row race;
  - stale unit-cost product ids;
  - quota overshoot under concurrency;
  - a few damaged journal or vanished records dropped without a marker;
  - `local-test` accepted on any backup format.

  Nothing is committed; committing is a separate decision.
- **Production: NO-GO.**
  - Independent owner, enrollment and witness custody do not exist, so no organization can be reopened (section 7).
  - Offsite backup survival is not established.
  - The install is an outage and closes onboarding, and 087 + V1 is incompatible.
- **Not done, by instruction:** no commit, no integration with the cleanup branch, no Script 2.
