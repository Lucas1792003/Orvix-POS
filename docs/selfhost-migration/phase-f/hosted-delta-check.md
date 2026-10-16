# Phase F · Hosted delta check (what changed on hosted since the export)

Status 2026-10-16: **prepared, not run.** The owner runs one read-only query
in the hosted dashboard. No tool and no engineer connects to hosted
Supabase. The engineer compares the result on the Mac.

Question answered: has anything been added to or changed in hosted Supabase
since the export of **2026-10-11 23:47 UTC** (workspace
`~/shwephala-migration/20261011T2347Z/`)? If not, the self-hosted copy is
complete and the cut-over can go ahead on that export. If yes, a delta
migration plan is needed first.

| Piece | Where |
|---|---|
| Query (owner runs it) | [`tools/selfhost-migration/hosted-delta.sql`](../../../tools/selfhost-migration/hosted-delta.sql) |
| Compare (engineer, Mac) | [`tools/selfhost-migration/hosted_delta_compare.py`](../../../tools/selfhost-migration/hosted_delta_compare.py) |
| Tests + fixtures | `tools/selfhost-migration/tests/test_hosted_delta.py`, `tests/fixtures/hosted_delta/` |
| Baseline | `~/shwephala-migration/20261011T2347Z/manifest-hosted.json` (the export manifest, read-only; only its `count`, `checksum`, `max_created_at` rows are used) |

## 1. What the query reads, and what it never reads

It reads **numbers only**, for every table in `public` (found at run time)
plus `auth.users`, `auth.identities`, `auth.mfa_factors`, `storage.buckets`
and `storage.objects`:

| Field | Meaning |
|---|---|
| `n` | `count(*)` |
| `max_c`, `max_u` | `max(created_at)`, `max(updated_at)` (only where the column exists) |
| `c_after`, `u_after` | rows with `created_at` / `updated_at` after the cutoff |
| `o_after` | rows where any other timestamp column is after the cutoff (shift ended, login code consumed, last sign-in, transfer received, ...). `*expires_at`, `*until` and `storage.objects.last_accessed_at` are left out, because they are set ahead of time or by reads |
| `ids` | md5 over the sorted ids, the same expression as the export manifest. It shows rows that were deleted and re-created with the count unchanged |

It also records the migration count and max version, the PostgreSQL version,
the time it ran and whether the transaction was read-only.

It **never** selects a row, an e-mail, a phone number, a name, metadata, a
key or a storage object name. The result is one row with one column,
`hosted_delta`: a JSON text of about 4–5 KB.

**Read-only.** The file runs as one implicit transaction, and its first
statement is `set transaction read only`. Inside it are only `SELECT`s.
The per-table queries are built from catalog names with `format(%I)` and
run through `query_to_xml`. Any write would fail with `cannot execute … in a
read-only transaction`. The result repeats the setting (`"read_only":
"on"`), and the compare script prints a note if it is not `on`. A test
(`test_no_writes_or_ddl`) checks that the file contains no write or DDL
keyword.

**Schema.** Column names come from `pg_catalog`, not a fixed list. A table
without `created_at` or `updated_at` (at migration 061: `inventory`,
`sale_items`, `shifts`, `reprint_logs`, `product_barcodes`,
`purchase_order_items`, `stock_transfer_items`; `business_profile` has only
`updated_at`) is still counted. A missing table is listed under `missing`, and
an extra table shows up as a new table. The expected list matches
`sql/tables.default.txt`, and a test enforces this.

## 2. Owner steps

Do this once, right before the cut-over decision. It takes about 2 minutes.

1. Sign in to the hosted dashboard and open the ShwePhaLa project. Go to
   **SQL Editor** and click **New query**.
2. Open `tools/selfhost-migration/hosted-delta.sql` from the repo (or the
   copy the engineer sends). Select **all** of it, copy it, and paste it into
   the empty editor. Do not change or delete any line. The first line must be
   `set transaction read only;`.
3. Click **Run** once, with nothing highlighted. Do not use "Run selected".
   - Expected result: **one row**, one column `hosted_delta`, starting with
     `{"v": 1, "pg": …`.
   - If the editor asks "this query may be destructive / confirm", **stop**.
     This query is not destructive, so a prompt like that means the text
     changed. Send the engineer a screenshot of the prompt only.
   - If you get an error (for example `permission denied for table …`),
     send the error text. It contains no data.
4. Copy the result cell. Use whichever of these the editor offers:
   - click the cell, then **Copy cell content** (right-click menu); or
   - **Export → Copy as JSON**, or **Export → Download CSV**.
   All three are accepted. The script finds the JSON inside.
5. Send it to the engineer. Paste it into a plain text file on the Mac,
   `~/shwephala-migration/hosted-delta-<YYYYMMDD>.txt` (outside the repo),
   or into the chat with the engineer. It holds only table names, counts,
   timestamps and md5 sums.
6. Close the query tab without saving, or delete the saved snippet.

### What NOT to paste or send

- Nothing else from the dashboard: no API keys page, no project URL with a
  key, no database password or connection string, no Settings → API page.
- No rows from the Table Editor, no Authentication → Users list (it shows
  e-mails), no Storage file list, no screenshots of those pages.
- No other query and no edited version of this one. Do not run any other
  SQL in the hosted editor, and above all nothing with `delete`, `update`,
  `insert`, `drop` or `truncate`.
- If the result contains anything that looks like an e-mail address, a name
  or a long random key, **do not send it**. It cannot come from this query,
  so tell the engineer instead.

## 3. Engineer: compare

```
mac$ python3 tools/selfhost-migration/hosted_delta_compare.py ~/shwephala-migration/hosted-delta-<YYYYMMDD>.txt
#    (default --manifest ~/shwephala-migration/20261011T2347Z/manifest-hosted.json, read-only)
mac$ python3 tools/selfhost-migration/hosted_delta_compare.py <file> --json > <file>.result.json   # for the record
```

Output: one line per table (`NO-CHANGE` / `CHANGED (+n since cutoff)` with
the reasons and `export->now` counts), then the verdict. Exit `0` = no delta,
`1` = delta, `2` = unusable input (not this query's output, a truncated copy
(`n_tables` does not match), wrong cutoff, or manifest not found). On exit 2,
ask the owner to copy the cell again.

Baseline choice: `manifest-hosted.json` (23:47 UTC). The only hosted change
made in this project since then was the authorised removal of the single QA
orphan auth user (created 2026-10-12 05:23, deleted ≈ 06:4x UTC;
[evidence](../evidence/G9/2026-10-12-hosted-orphan-cleanup.md)). It nets out:
`auth.users` / `auth.identities` are 10 / 10 again, with the same checksums as
the export. `manifest-hosted-post-orphan-delete.json` gives the same result
for every metric this check uses.

## 4. Interpretation

| Line | Meaning | Action |
|---|---|---|
| `NO-CHANGE` | count, ids and every timestamp are as in the export | none |
| `CHANGED (+n since cutoff) … +n created since cutoff` | new rows on hosted, not on self-hosted | delta: copy those rows |
| `… count a -> b` | rows added (no `created_at` column: the count is the only measure, shown as `+n`) or **deleted** (b < a) on hosted | delta, or a deliberate deletion that must be repeated |
| `… n updated since cutoff` | existing rows edited on hosted | delta: re-copy those rows (self-hosted has the old values) |
| `… another timestamp after cutoff` | a shift closed, a login code used, a transfer received, a **sign-in** (`auth.users` / `auth.identities` `last_sign_in_at`) | someone used hosted after the export. For `auth.users` alone: sign-in activity. A password or MFA change also shows as `updated` |
| `… same count but different ids` | rows deleted and re-created | delta |
| note `created after the cutoff but in the export (same ids)` | the rows came in during the export minutes and the id set is unchanged | none |
| `INFO table not in the export, empty` | table exists on hosted only, no rows | none |
| `missing on hosted` | a table from the export no longer exists | stop: hosted schema changed; investigate |

**Verdict**

- `VERDICT: NO DELTA … OK to cut over`: the 2026-10-11 export is complete.
  Record the output (`--json` file) in the cut-over record. If more than
  about a day passes before the cut-over, run the check again.
- `VERDICT: CHANGED … needs a delta migration plan`: do not cut over on the
  old export. Plan per changed table: freeze hosted writes (tills
  offline/read-only), then re-export only the changed tables. Run the same
  `export → scrub → check_secrets → schema_compat` path for them
  (`--data-only -t public.<table>`), compare ids, and apply with
  `ON CONFLICT` upserts or a delete+copy of those tables in one transaction.
  Then repeat this check plus `manifest_diff.py` until the result is
  "equal". Changed `storage.objects` means the
  `upload_objects.py --only-missing` + `verify_objects.py` steps run again.
  Changed `auth.users` / `auth.identities` / `auth.mfa_factors` means
  logins, password or MFA changes. Those rows are re-copied too, or the
  affected staff re-enroll after the cut-over.

**Limits (stated):** an in-place edit of a table that has **no**
`updated_at` and no other timestamp (for example `inventory.quantity` without
a movement row, or a `sale_items` edit) is not visible. Counts, ids and the
related `inventory_movements` / `audit_logs` / `sales` rows usually reveal
it. Ask the owner to confirm that no till used hosted after the export. Auth
sessions and refresh tokens are not checked: they do not carry over and
staff sign in again after the cut-over.

## 5. Test evidence (2026-10-16, local only)

- `python3 -m unittest discover -s tools/selfhost-migration/tests -t tools/selfhost-migration`
  → **56 tests OK** (19 new in `test_hosted_delta.py`: read-only first
  statement, no write/DDL keyword, no personal column named, expected list =
  `tables.default.txt` (36 tables), cutoff, four paste shapes, truncation,
  no-change, changed, JSON output, export-window rows, missing / new tables,
  exit 2 cases, read-only note, CLI-JSON manifest shape).
- Fixtures come from running the real `hosted-delta.sql` (sent as one query
  message, like the editor does) and the real `sql/manifest.sql` against a
  throwaway local PostgreSQL 16. That database had the hosted column layout of
  migration 061, generated from the export's schema dump and column inventory
  (column names and types only, no data), and synthetic rows:
  - unchanged → 36/36 `NO-CHANGE`, ids equal to the manifest checksums,
    `read_only: on`, exit 0;
  - after one sale (+1 `sale_items`), one `product_units` edit, one
    `inventory` row deleted and re-created, a shift closed, one sign-in, and
    storage reads → exactly those 6 tables `CHANGED`. Storage reads (only
    `last_accessed_at`) stay `NO-CHANGE`. Exit 1;
  - `set transaction read only; create table …` in the same message →
    `ERROR: cannot execute CREATE TABLE in a read-only transaction`.
- The mock output compared against the real export manifest (CLI JSON
  shape) parses and reports per table. All counts differ there, as expected
  for an empty mock.
