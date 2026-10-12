# Evidence · Phase D — migrations applied to lucashome and live QA integration tests

Date: 2026-10-12 01:22–04:45 UTC. Hosted untouched. No container restarted. Nothing committed.

## Migrations 062–066 (applied 01:22 UTC via `deploy/lucashome/apply-migrations.sh`)
- Reviewed files, sha256 prefixes: 062 `e4c4a142…`, 063 `9981d619…`, 064 `9f5edf04…`, 065 `22aefb10…`, 066 `1d78471f…` (same working-tree files the Mac harness ran: 135/135).
- Pre-flight: 10/10 healthy, backup status OK; fresh logical `dump/hourly/20261012T012205Z` and base `base/20261012T012206Z` (pg_basebackup, verified); **pre-migration LSN `0/22000090`** (`/srv/supabase/backups/migration-checkpoints.txt`).
- Applied in ONE transaction with `ON_ERROR_STOP`; zero errors; versions 062–066 recorded; `supabase_admin` default function ACL hardened.
- Post state: 61 public functions, **0 overloaded names** (old signatures dropped), 30 RPCs with `p_idempotency_key`; EXECUTE: anon 2 (`get_product_image_upload_session_by_token`, `complete_product_image_upload_session`), authenticated 57 (all but `complete_stock_transfer`, idem helpers), service_role 61; `idempotency_keys` RLS on, 0 policies, PK + created_at index; default ACLs for functions carry no anon/PUBLIC for `postgres` and `supabase_admin`; RLS policy fingerprint unchanged (58 policies, `8600aa8c…` before and after); business manifest unchanged (146 metrics equal; only functions/indexes/migrations differ). Post-migration logical backup `dump/hourly/20261012T012217Z`.

## Live integration tests (`src/live/phase-d.live.test.ts`, 16 tests, real supabase-js + real store modules on fake-indexeddb)
Seed: QA org/2 shops/4 users (auth via GoTrue signup, `@qa.invalid`)/3 products/supplier, inserted with triggers disabled so no cross rows touched real data (`inventory_cross_rows=0`).

| # | Test | Result | Key evidence |
|---|---|---|---|
| 0 | PO create→approve→receive with replays | PASS | self-approval blocked; replays byte-equal |
| 1 | normal checkout | PASS | stock 100→99, receipt `QA…-0001`, ledger row stores response |
| 2 | duplicate submission | PASS | 1 sale, stock −1 once |
| 3 | commit-then-timeout (+ real abort) | PASS | retry returns same sale id; after abort exactly 1 sale consistent with DB |
| 4 | concurrent duplicates | PASS | equal responses, 1 sale |
| 5 | same key, different payload | PASS | 409 / 23505 `IDEMPOTENCY_MISMATCH`, no sale |
| 6 | adjust_stock replay | PASS | one movement, one audit row |
| 7 | supplier payment + lump-sum replays | PASS | paid once each |
| 8 | multi-terminal 2×15 concurrent | PASS | 100→70, 30 unique receipts, 30 ledger rows |
| 9 | offline queue replay (real store) | PASS | `seq` shift→sale, provisional ids swapped, server order confirmed |
| 10a | tampered JWT + valid refresh | PASS | refresh, continue, tampered token never sent |
| 10b | refresh tokens revoked | PASS | `needs-reauth`, nothing lost, drains after sign-in |
| 11 | staff-user creation / unauthorized / extra org arg | PASS | org_id = caller's org; cashier denied; `p_org_id` → PGRST202 |
| 12 | RLS / RPC authorization | PASS | cross-shop `[]`, anon 42501, service role full |
| 13 | phone-upload token security (19 sub-checks) | PASS | 128-hex token (~488 bits), sha256 stored, 10-min expiry, scoped, expired/canceled/wrong rejected, second complete rejected, anon 42501 on other RPCs |
| 14 | Realtime inventory (RLS-scoped) | PASS | UPDATE in 606 ms; other shop not delivered |

First run: two failures in test code only (JWT equality assumption; Realtime readiness timing) — fixed, fresh seed, re-run: 16/16.

## Cleanup and verification
- `cleanup.sql` (single txn): 39 sales/39 items/3 shifts/43 movements/4 inventory/2 payments/2 POs/8 upload sessions/3 products/3 units/1 supplier/54 audit/54 ledger rows/5 users/2 shops/1 org/5 auth users.
- `verify_clean.sql`: CLEAN (31 checks) — re-run independently by the coordinator: CLEAN.
- Coordinator's extra sweep: `auth.audit_log_entries` held 99 GoTrue entries (76 QA, 23 Phase-B/TOTP probe accounts, 0 real users) → deleted, committed, 0 remain. `auth.flow_state`, `one_time_tokens`, `mfa_challenges`, `realtime.subscription` all 0.
- Post-QA manifest vs pre-test: 145 equal; explained differences: `auth.refresh_tokens_id_seq` 1330→1362 (sequence consumed by QA logins, not reversible, harmless), `tables_rls_enabled` 31→32 (new ledger table).
- Storage: 575 files on disk before and after (574 objects + `.gitkeep`); 574 `storage.objects`.
- Backups: status OK, archiver 70 archived / 0 failed; QA activity archived; pre-migration bases retained.

## Residual facts for the owner
- `anon` keeps full table grants (hosted parity, 065); RLS policies are `TO authenticated`, so anon reads return `[]`.
- PostgREST does not expose the `storage` schema on this stack (upstream default `public,graphql_public`) — not needed by the app.
- The 1,362 refresh-token sequence value and ~66 `inventory_movements` ids are the only numeric traces of QA activity (no rows).
