# Provisional financial migrations (PFIN-A, PFIN-B, PCOST-A)

These files are **not** in `supabase/migrations/` on purpose: nothing applies them automatically, and they carry no
number. Every number from 088 to 099 is already claimed by the 1.0.17 master implementation plan v2 (§5.2; a planning
document kept outside this repository's history), for example 088 sale_payments, 089 cash_movements / close_shift v2, 090 refund line model, 097 report RPCs). The coordinator
assigns numbers. Until then the identifiers below are the only names to use.

| Id | File | What | Touches 087-guarded tables | Depends on |
|---|---|---|---|---|
| PFIN-A | `PFIN-A_report_indexes.sql` | 5 indexes: `sales (shop_id, created_at)`, `sales (shift_id)`, `refund_void_requests (sale_id)`, two partial `audit_logs` indexes on REFUND / VOID_SALE rows | yes (indexes) | — |
| PFIN-B | `PFIN-B_financial_reports.sql` | read-only report RPCs `fin_report_summary`, `fin_shift_reconciliation` and 6 internal set-based helpers (`fin_report_scope`, `fin_items`, `fin_sale_line_net`, `fin_approval_times`, `fin_refund_lines`, `fin_line_costs`) | no | 068, 086 helpers (unchanged) |
| PCOST-A | `PCOST-A_cost_privacy.sql` | P-4 cost privacy: moves purchase cost and COGS snapshots into 3 permission-gated tables, nulls the legacy columns, redirects/refuses writes (see below) | yes (triggers on `products`, `product_units`, `sale_items`, `purchase_order_items`; null-out of 3 columns) | 068 helpers; PFIN-B optional (`fin_line_costs` reads the gated table when it exists) |

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
  predates the 086 `op_*` helpers. PFIN-B adds 8 functions:
  - the 2 entry points, executable by `authenticated` and `service_role`;
  - 6 helpers, executable by `service_role` only.
  PCOST-A adds 5 trigger/helper functions (execute revoked from everyone) and 3 tables, which t01's grant-parity
  check excludes for now (exact grants are asserted in `tests/fin/sql/f08_cost_privacy.sql`).

## PCOST-A: cost privacy (P-4)

PostgreSQL RLS filters rows, not columns, and every app user is the same `authenticated` role, so a column grant
cannot separate an owner from a cashier. PCOST-A therefore moves the values out of the shared rows:

- `product_costs`, `product_unit_costs`, `sale_item_costs`. RLS is enabled with SELECT-only policies:
  - product tables: own org and `report:shop_profit`;
  - sale lines: `report:shop_profit` and the line's shop in scope (ADMIN: org shops; others: own shop).
- `authenticated` and `service_role` may only SELECT. Writes happen only in SECURITY DEFINER triggers on the
  087-guarded parent tables, so a held server stops cost writes too.
- Backfill with count and sum assertions, then `products.cost_mmk`, `product_units.purchase_price_mmk` and
  `sale_items.unit_cost_mmk_snapshot` are set NULL. The columns stay, so a released client's `select=*` keeps
  working. A revoked column would make it fail with 42501.
- `zzc_cost_redirect` BEFORE triggers move any written cost into the gated table and null the column. NULL means
  "no change", so an old client that sends a blank cost does not erase it. An API caller (JWT role `anon` or
  `authenticated`) without `report:shop_profit` who sends a non-NULL cost is refused with 42501.
  - A cost row never changes organisation. An insert naming another organisation's product or unit id with a
    cost is refused even under ignore-duplicates, because a BEFORE INSERT trigger runs before the
    primary-key conflict is detected.
  - `complete_sale` keeps snapshotting the cost (from the gated table when the line has none). Its reply no
    longer carries it.
  - That fill happens only inside an API request. A SQL-session insert of a line without a snapshot (a
    data-only restore, an import) stays uncosted rather than taking today's cost.
  - `zzc_cost_po_unit_price` fills `purchase_order_items.unit_purchase_price_snapshot` on receipt.
- Apply with `--single-transaction` (required by `LOCK TABLE`). The move takes SHARE ROW EXCLUSIVE locks on
  `products`, `product_units`, `sale_items` and `purchase_order_items`: writers wait and readers do not. Without
  the locks, a till's write between the copy and the triggers would be lost or stay readable. Past the 3 s
  `lock_timeout` the file fails with nothing changed, so run it at a quiet time. On a large `sale_items` table the
  null-out rewrites every costed line, so check that 087's lease covers the run. It ends with
  `NOTIFY pgrst, 'reload schema'`.
- Apply as the superuser runner **while the server is OPEN** (087 not held). The null-out writes guarded tables, which
  a held server refuses. A re-run while held is safe and moves nothing. It calls `register_guards()` at the end.
- `PCOST-A.rollback.sql` copies every value back (asserted) before dropping anything. Afterwards cost is again
  readable by every org user.

Not covered (owner decisions):
- `complete_sale` replies stored before the migration (`idempotency_keys.response`, the client op journal) still
  contain line cost. 087 signs those replies' sha256 as recovery evidence, so scrubbing them is left for an
  088-era decision.
- `purchase_order_items` unit prices stay readable to whoever can read purchase orders. Receiving a PO copies the
  unit's purchase price into it, so a user who can create, receive and view POs can look up any unit's price.
- A MANAGER or buyer without `report:shop_profit` can no longer set a cost or unit purchase price: a save that
  includes one is refused, and a blank one is kept. New POs default the unit cost to 0 for them, so they must
  type it (D-14).
- Released ADMIN clients show blank cost and wrong client-side profit until updated. Cashier clients need no update.

## Tests

`supabase/tests/fin/run.sh` uses its own throwaway container (`zz-finbe-db`, 127.0.0.1:55493). It refuses the shared
harness names (`pos-test-db`, `phf-iso-*`, `zz-m087*`, `orvix-*`) and never pulls an image. By default it applies
**PFIN-A, PFIN-B and PCOST-A** and asserts that PFIN-C is absent at the start and at the end. The run:

1. baseline + 062..086 + phase-d seed
2. independence: PFIN-A alone, then its rollback; PFIN-B alone (without A) plus a report call, then its rollback;
   PCOST-A alone, its rollback (values copied back exactly), re-applied
3. A + B applied twice, then rolled back B → A and re-applied
4. phase-d t01..t09 as a regression check
5. `f00..f05`, `f07` and `f08` (cost privacy: per-role read matrix, `select *`, write redirect/refusal, reports,
   `complete_sale` reply)
6. installs 087 (held) and re-applies A + B + PCOST-A (PCOST-A moves nothing while held)
7. probes the DDL guard
8. runs `f06` and `f07` again

Switches:
- `FIN_WITH_PCOST=0` leaves PCOST-A out (the pre-P-4 control run).
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
| P-4 | Who sees COGS / profit / purchase cost (D-14 recommends MANAGER too) | `report:shop_profit` only (ADMIN by default; grantable per manager), enforced in the database by PCOST-A; MANAGER gets `null` |
| P-5 | Whether to align `refund_void_requests_sel` with `sales_sel` (RLS) | unchanged; reports use aggregates so they do not depend on it |
| P-7 | Whether ADMIN org-wide reports need more than 93 days per call (needs pre-aggregation) | ORG level limited to 93 days; per-shop reports up to 367 days |

P-2 and P-6 concern the held PFIN-C. Its notes travel with the held files (`held/README.md`), which are not committed with this set.
