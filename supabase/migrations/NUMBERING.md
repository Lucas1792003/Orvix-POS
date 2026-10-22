# Migration numbering registry (POS)

The planner (`deploy/lucashome/migration_plan.py`) refuses gaps, duplicate versions and files it does not know. This
page says what each number means, so a number is never read two ways. History is never renumbered or rewritten.

| Number | Meaning | State |
|---|---|---|
| 001–061 | Hosted-era schema, captured as the baseline | in production |
| 062–083, 085 | Self-host migrations | in production (server ledger: max 085, 2026-10-16) |
| 084 | Validated image uploads only | **held** (needs every till on the validated-upload client) |
| 086 | Operation outcomes (`op_execute`, `op_status`, ledger `(org_id, key)`) | committed, not applied anywhere |
| 087 | Recovery hold and rollback detection | committed, not applied anywhere |
| **088** | **Retired.** `088_retired_number.sql` is a no-op tombstone; its rollback removes only its own ledger row | never assign 088 to anything; it needs 087 recorded (the planner refuses gaps), so skipping 087 is an owner decision that must put 087 on the runner's held list |
| 089 and up | Unassigned | next free number, assigned by the coordinator at owner approval |

## Why 088 is retired

"088" already has two incompatible meanings, and neither was ever implemented:

1. **The original Recovery Migration 088.** The committed 087 and `docs/selfhost-migration/phase-g/migration-087.md` name it
   as the release that restores financial outcomes, receipt continuity, bulk approval and reopening. That design was
   rejected. Recovery V1 replaces it and is **not** 088.
2. **The 1.0.17 master plan v2 register.** This planning document is kept outside this repository's history. It uses 088
   for `sale_payments`.

A new file numbered 088 would be read as one of the two. The tombstone keeps the sequence contiguous for the planner, and
the planner refuses a second 088 file as a duplicate version.

## Planning labels are not numbers

The master plan v2 register (its §6.2) numbers work that does not exist yet:
- 088 `sale_payments`;
- 089 `cash_movements` / `close_shift` v2;
- 090 refund line model;
- 091 price history;
- 092 discount approvals;
- 093 cost tables;
- 094 offline exceptions;
- 095 `complete_sale` extension;
- 096 admin assurance;
- 097 report RPCs;
- 098 image URL rewrite;
- 099 financial ledger.

Its 086 and 087 rows describe other work (`org_settings`, `guard_admin_continuity`, `apply_catalog_write`) than the
committed 086 and 087. Those numbers were taken by history. Treat every one of these as a label. Each gets the next free
number when it is implemented and approved.

## Unnumbered steps

These are identifiers, not numbers. The order, prerequisites, checksums and gates are in
`supabase/migrations-provisional/SEQUENCE.json`, checked by `tools/migration-sequence/verify.py`.

| Id | Where | Number |
|---|---|---|
| PSAFE-A, PFIN-A, PFIN-B, PCOST-A | `supabase/migrations-provisional/` | assigned by the coordinator at owner approval; never 088 |
| PFIN-C | `supabase/migrations-provisional/held/` | held: owner decisions P-2 and P-6 |
| RECOVERY_V1 | `supabase/migrations-provisional/RECOVERY_V1_guards.sql` | **never numbered.** It needs a psql variable, opens its own transaction and restricts every organization. The runner must never apply it implicitly. |

## Other ranges

| Range | Owner |
|---|---|
| 100–102 | POS organization-lifecycle hooks, reserved by the plan, not implemented |
| 200–299 | Orvix Control (its own repository and ledger). Not POS numbers. |
