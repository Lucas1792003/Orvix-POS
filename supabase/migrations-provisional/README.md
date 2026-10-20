# Provisional financial migrations (PFIN-A, PFIN-B)

These files are **not** in `supabase/migrations/` on purpose: nothing applies them automatically, and they carry no
number. Every number from 088 to 099 is already claimed by the 1.0.17 master implementation plan v2 (§5.2; a planning
document kept outside this repository's history), for example 088 sale_payments, 089 cash_movements / close_shift v2, 090 refund line model, 097 report RPCs). The coordinator
assigns numbers. Until then the identifiers below are the only names to use.

| Id | File | What | Touches 087-guarded tables | Depends on |
|---|---|---|---|---|
| PFIN-A | `PFIN-A_report_indexes.sql` | 5 indexes: `sales (shop_id, created_at)`, `sales (shift_id)`, `refund_void_requests (sale_id)`, two partial `audit_logs` indexes on REFUND / VOID_SALE rows | yes (indexes) | — |
| PFIN-B | `PFIN-B_financial_reports.sql` | read-only report RPCs `fin_report_summary`, `fin_shift_reconciliation` and 5 internal set-based helpers (`fin_report_scope`, `fin_items`, `fin_sale_line_net`, `fin_approval_times`, `fin_refund_lines`) | no | 068, 086 helpers (unchanged) |

PFIN-A and PFIN-B are independent of each other: either can be installed or rolled back without the other. PFIN-B
runs without PFIN-A's indexes, only slower. Rollbacks (`PFIN-*.rollback.sql`) only drop objects; none changes or
deletes data.

A third migration, the refund cap PFIN-C, is **held** and not part of this set. If present, it lives in `held/` with
its own notes; nothing here needs it. The PFIN-B rollback refuses to run while PFIN-C's triggers exist, and is a no-op
check otherwise.

## How they must be applied

- One file per transaction, as the **superuser migration runner** (`supabase_admin`) once 087 is installed.
  - PFIN-A refuses a non-superuser session when 087 is present.
  - PFIN-A and its rollback refuse to run when 087's whole backstop condition is already violated: a guarded table's
    fingerprint, or the registry of public 087 functions, evaluated under 087's own search_path. So they never bless
    unexplained drift.
  - After their DDL they call `recovery_guard.register_guards()`. PFIN-B touches no guarded table.
- Every PFIN-B function is SECURITY DEFINER and owned by `postgres`, like the other business functions. On the
  tested image (`supabase/postgres:17.6.1.136`) `postgres` is not a superuser; it has BYPASSRLS and owns the tables
  read. A superuser-owned definer function that calls postgres-owned helpers would let `postgres` act as superuser.
  `tests/fin/sql/f07_privileges.sql` is the regression test.
- Apply PFIN-A on its own. Its plain `CREATE INDEX` statements hold SHARE locks until commit. Building the indexes
  `CONCURRENTLY` by hand is not supported, because 087 would see them as drift; an INVALID index of the same name is
  refused.
- They do not replace any function whose body 086 pins by MD5 (`approve_refund_request`, `close_shift`, …), so 086's
  forward-recovery re-run stays valid. They do not change any executor RPC signature, request hash or stored response.
  Function names avoid 087's protected patterns (`%_v87`, `recovery_%`).
- Once numbered, the phase-d `t01` function inventory needs updating. It already fails at baseline 234b761 because it
  predates the 086 `op_*` helpers. PFIN-B adds 7 functions:
  - the 2 entry points, executable by `authenticated` and `service_role`;
  - 5 helpers, executable by `service_role` only.

## Tests

`supabase/tests/fin/run.sh` uses its own throwaway container (`zz-finbe-db`, 127.0.0.1:55493). It refuses the shared
harness names (`pos-test-db`, `phf-iso-*`, `zz-m087*`, `orvix-*`) and never pulls an image. By default it applies
**PFIN-A and PFIN-B only** and asserts that PFIN-C is absent at the start and at the end. The run:

1. baseline + 062..086 + phase-d seed
2. independence: PFIN-A alone, then its rollback; PFIN-B alone (without A) plus a report call, then its rollback
3. A + B applied twice, then rolled back B → A and re-applied
4. phase-d t01..t09 as a regression check
5. `f00..f05` and `f07`
6. installs 087 (held) and re-applies A + B
7. probes the DDL guard
8. runs `f06` and `f07` again

Two switches:
- `FIN_BASELINE_T01=1` runs phase-d t01 alone on the unmodified schema. It is the control for the 3 stale t01
  assertions.
- `FIN_WITH_HELD=1` additionally runs the held PFIN-C files from `held/` and `tests/fin/held/`. It fails if they are
  missing.

## Accounting definitions (stated in PFIN-B's header; not policy changes)

- **Business day:** the Asia/Yangon calendar date of `sales.created_at`. This is identical to fin-ui's `businessDay.ts`.
- **Revenue:** `total_mmk` after all discounts.
- **Refunds:** approved refund amounts are taken as recorded. Nothing is capped or rewritten; over-refunds are counted
  in `evidence`.
- **Net line amounts:** identical to fin-ui's `allocateNetLineAmounts`, ties included.
- **COGS:** uses the sale's own cost snapshot only, never today's product cost. A missing snapshot makes COGS
  incomplete, and gross profit is then null.
- **Refund payout method:** a refund is assumed to be paid back by the original sale method, and the report says so.
  No payout record exists before 089/090.
- **Evidence:** the approval time of a refund or void is the server-written audit row. Without one the time is
  reported as unknown and never guessed.
- **Shift close:** a closed shift's stored figures are never recomputed. The close cut-off is the server time from
  the idempotency ledger; without it, the window after a possibly client-stamped `ended_at` is reported as
  `closeWindowPayouts`.

**Not decided** (owner decisions):

| # | Decision | What the code does until decided |
|---|---|---|
| P-1 | Refund and void revenue date: sale date or approval date (D-07 recommends approval date; not approved) | `fin_report_summary` requires `p_refund_basis` and echoes it; no default |
| P-3 | Which drawer pays a refund approved after its sale's shift closed | not deducted from any shift; listed as `afterClosePayouts` (the sale's shift) and `crossShiftPayoutsDuringShift` (shifts open at approval time) until 089 records the paying shift |
| P-4 | Who sees COGS / profit (D-14 recommends MANAGER too) | `report:shop_profit` only (ADMIN by default); MANAGER gets `null` |
| P-5 | Whether to align `refund_void_requests_sel` with `sales_sel` (RLS) | unchanged; reports use aggregates so they do not depend on it |
| P-7 | Whether ADMIN org-wide reports need more than 93 days per call (needs pre-aggregation) | ORG level limited to 93 days; per-shop reports up to 367 days |

P-2 and P-6 concern the held PFIN-C. Its notes travel with the held files (`held/README.md`), which are not committed with this set.
