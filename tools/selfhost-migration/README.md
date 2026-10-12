# Self-host migration tooling

Scripts and SQL that implement the mechanical steps of
[docs/selfhost-migration/05-migration-runbook.md](../../docs/selfhost-migration/05-migration-runbook.md)
§3, §4 and §7. Python 3 standard library only (tested on 3.14), no third-party
packages. Nothing here embeds a secret: keys come from environment variables at
run time, URLs and paths from arguments.

Conventions: `mac$` = this repo on the Mac; `ls$` = the self-hosted server as
the deploy user; `db$` = inside the `db` container
(`docker compose exec -T db psql -U supabase_admin -d postgres`). Dump files
live in `~/shwephala-migration/<ts>/` (0700, outside the repo), never in `tools/`.

## Tools

| File | Purpose |
|---|---|
| `gen_manifest.py` → `sql/manifest.sql` | one SELECT returning `(object, metric, value)`: row counts, id checksums, `max(created_at)`, sequence, publication, policies, functions, migrations, cron |
| `manifest_diff.py` | compare two manifest outputs (CLI JSON or `psql -A -F '\|'`), exit 1 on any non-ignored difference |
| `scrub_dump.py` | remove `cron.job` (redacted copy kept), drop excluded/hosted-only COPY blocks, comment `SET transaction_timeout`, hard-stop on any remaining secret; `--roles` removes `cli_login_postgres`; `--schema` comments `transaction_timeout` and reports `pg_net … SCHEMA public` |
| `check_secrets.py` | gate: scan files/dirs for JWTs, `postgres://` URLs with an embedded password, Tailscale keys, Resend keys, `sb_secret_`, `sk_`; exit 1 if any |
| `schema_compat.py` + `sql/columns_inventory.sql` + `sql/constraints_inventory.sql` | compare hosted vs self-hosted `auth`/`storage` columns; `--fix-dump` removes hosted-only columns from COPY blocks and drops COPY blocks of hosted-only tables |
| `upload_objects.py` | re-upload storage objects by name with original `Content-Type`/`Cache-Control`, 4 threads, 3 retries, `--dry-run`, `upload-report.json` |
| `verify_objects.py` | fetch every public URL, compare sha256/md5 and size, print `N/N ok`; `--make-manifest DIR` |
| `sql/post_restore_checks.sql` | orphan / URL-host / sequence / publication / anon-EXECUTE / RLS / policy / migration / cron / extension checks with a `status` column |
| `render_cron.py` + `sql/recreate_cron.sql.template` | render the two `cron.schedule` statements (same expressions as `supabase/schedule_*.sql`) with the self-hosted URL and the key from `SERVICE_ROLE_KEY`, into a 0600 file |
| `tests/` | `python3 -m unittest discover -s tests -t .` — synthetic fixtures only, a local HTTP server for upload/verify |

Common input shapes: everything that reads query output accepts both the CLI's
`supabase db query --linked -f x.sql > out.json` shape (`{"rows":[...]}`) and
`psql -A -F '|'` unaligned output (with or without header / `(N rows)` footer).

## End-to-end order

```
export  → scrub → check_secrets → schema_compat → restore → upload → verify → post-checks → cron → manifest_diff
```

All commands below run from the repo root (`mac$`) unless marked. `T` is the
tools dir: `T=tools/selfhost-migration`; `W` is the dump workspace.

### 0. Prepare (once)

```
mac$ python3 $T/gen_manifest.py                              # refresh sql/manifest.sql if sql/tables.default.txt changed
mac$ python3 -m unittest discover -s $T/tests -t $T          # all green
```

### 1. Export from hosted (runbook §3 — read-only commands, run by the owner)

```
mac$ supabase db query --linked -f $T/sql/manifest.sql           > $W/manifest-hosted.json
mac$ supabase db query --linked -f $T/sql/columns_inventory.sql  > $W/columns-hosted.json
mac$ supabase db query --linked -f $T/sql/constraints_inventory.sql > $W/constraints-hosted.json
mac$ supabase db dump --linked --role-only -f $W/roles.sql
mac$ supabase db dump --linked -f $W/schema.sql
mac$ supabase db dump --linked --data-only --use-copy -f $W/data.sql -x … (list in runbook §3.2)
mac$ supabase storage cp --linked -r ss:///product-images/ $W/storage/product-images/ -j 4
mac$ supabase db query --linked "select name, metadata->>'mimetype' mime, metadata->>'size' size, metadata->>'cacheControl' cc from storage.objects where bucket_id='product-images' order by name" > $W/storage-objects.json
mac$ python3 $T/verify_objects.py --make-manifest $W/storage/product-images --out $W/storage-manifest.sha256
```

### 2. Scrub (runbook §3.4) — mandatory before any file leaves the Mac

```
mac$ python3 $T/scrub_dump.py $W/data.sql --out $W/data.scrubbed.sql \
        --roles $W/roles.sql --schema $W/schema.sql
```
Produces `data.scrubbed.sql`, `roles.scrubbed.sql`, `schema.scrubbed.sql`,
`cron-job.redacted.txt` (the two job definitions with `<REDACTED_JWT>`) and
`data.scrubbed.sql.report.json`. Exit 2 = a secret-shaped token survived →
nothing is written; inspect the reported line, add `--drop schema.table` if it
is a whole table, re-run. The default drop list is in `scrub_dump.DEFAULT_DROPS`
(runbook §3.2 exclusions + `auth.mfa_recovery_code_sets`, `auth.mfa_recovery_codes`,
`auth.scim_tokens`, `auth.scim_users`, which do not exist on self-hosted GoTrue).

### 3. Secret gate

```
mac$ python3 $T/check_secrets.py $W --exclude 'data.sql' --exclude 'roles.sql' --exclude 'schema.sql'
```
Must print `0 secret-shaped hit(s)`. Only the `*.scrubbed.sql` files, the
manifests, `storage/` and `cron-job.redacted.txt` are transferred (rsync
them explicitly, not the whole directory).

### 4. Schema compatibility (runbook §4.2, third bullet)

```
ls$  docker compose exec -T db psql -U supabase_admin -d postgres -A -F '|' -f /tmp/columns_inventory.sql     > columns-selfhost.txt
ls$  docker compose exec -T db psql -U supabase_admin -d postgres -A -F '|' -f /tmp/constraints_inventory.sql > constraints-selfhost.txt
mac$ python3 $T/schema_compat.py --hosted $W/columns-hosted.json --selfhost $W/columns-selfhost.txt \
        --constraints-hosted $W/constraints-hosted.json --constraints-selfhost $W/constraints-selfhost.txt \
        --fix-dump $W/data.scrubbed.sql --out $W/data.fixed.sql
```
Exit 0 = `data.fixed.sql` restores cleanly (hosted-only columns such as
`auth.one_time_tokens.expires_at` removed, hosted-only tables dropped). A
`FAIL` that is not fixable (type mismatch, self-hosted NOT NULL column without
default) needs a decision; `--ignore schema.table.column` records it. Re-run
`check_secrets.py` on the new file.

### 5. Restore (runbook §4.2–§4.4)

As in the runbook, with `data.fixed.sql` in place of `data.scrubbed.sql`.

### 6. Upload and verify storage objects (runbook §4.5)

```
mac$ export SB_SERVICE_KEY='<NEW service-role key>'          # this shell only; unset afterwards
mac$ python3 $T/upload_objects.py $W/storage/product-images $W/storage-objects.json https://<new-base> --dry-run
mac$ python3 $T/upload_objects.py $W/storage/product-images $W/storage-objects.json https://<new-base> --report $W/upload-report.json
mac$ unset SB_SERVICE_KEY
mac$ python3 $T/verify_objects.py $W/storage-manifest.sha256 https://<new-base> --dir $W/storage/product-images --objects $W/storage-objects.json
```
Expect `uploaded 574, skipped 0, failed 0` and `574/574 ok`. `--only-missing`
makes a re-run skip objects already served with the right size. The runbook's
`storage-manifest.md5` (`find product-images … md5sum`) is accepted too.

### 7. URL rewrite + post-restore checks (runbook §4.6–§4.7)

The `UPDATE … replace(image_url, …)` statements stay in the runbook (SQL run by
hand). Then:
```
ls$ docker compose exec -T db psql -U supabase_admin -d postgres -f /tmp/post_restore_checks.sql
```
Every row must be `ok` or `INFO`; `ACTION` rows print the statement to run
(`setval` for `auth.refresh_tokens_id_seq`); any `FAIL` stops the gate.

### 8. Cron jobs (runbook §4.8 — production only, not rehearsal before R1.12)

```
mac$ SERVICE_ROLE_KEY='<NEW service-role key>' python3 $T/render_cron.py --out $W/recreate_cron.sql
ls$  docker compose cp $W/recreate_cron.sql db:/tmp/recreate_cron.sql
ls$  docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/recreate_cron.sql
ls$  docker compose exec -T db rm /tmp/recreate_cron.sql; rm $W/recreate_cron.sql
```
`--functions-base-url` defaults to `http://api-gw:8000/functions/v1`. The file
is 0600 and contains the key: delete both copies afterwards.

### 9. Manifest comparison (runbook §4.10)

```
ls$  docker compose exec -T db psql -U supabase_admin -d postgres -A -F '|' -t -f /tmp/manifest.sql > manifest-selfhost.txt
mac$ python3 $T/manifest_diff.py $W/manifest-hosted.json $W/manifest-selfhost.txt \
        --left-name hosted --right-name selfhost \
        --ignore object=storage.objects \
        --ignore object=public.functions,metric=anon_executable \
        --ignore object=cron.job
```
Expected ignores: `storage.objects` (compared via `verify_objects.py`
instead), `public.functions/anon_executable` (0 after §4.7 vs 58 on hosted
until migration 062 lands there), `cron.job` (re-created). Everything else —
every count, checksum, `max_created_at`, policy count, publication membership,
migration count — must be equal; exit 1 otherwise.

## Notes and assumptions

- `sql/manifest.sql` is generated; edit `sql/tables.default.txt` and re-run
  `gen_manifest.py` (a test fails if the committed SQL is stale). Composite-key
  tables (`inventory`, `supplier_products`) use `id=<expr>` checksums.
  `max(created_at)` is rendered in UTC with a fixed format so psql and the CLI
  agree regardless of session settings.
- COPY blocks are parsed structurally: a block ends only on a line that is
  exactly `\.`; data lines beginning with `--` or containing backslashes are
  never mistaken for SQL. Column removal splits rows on literal TAB only
  (`\t`, `\N`, `\\` escapes untouched).
- `scrub_dump.py` always handles `cron.job`, even with `--no-default-drops`.
- `upload_objects.py` retries 5xx/429/network errors (1 s, 2 s, 4 s); 4xx is
  final. `verify_objects.py` streams nothing to disk; the report JSON lists
  every object.
- `check_secrets.py` run over this directory reports 0 hits: the test
  fixtures build their fake tokens at run time.
- Validated locally (2026-10-11) against a throwaway
  `public.ecr.aws/supabase/postgres:17.6.1.159` container with synthetic
  schemas: all four SQL files execute; `post_restore_checks.sql` flagged every
  planted defect. Nothing in this directory contacts hosted Supabase or the
  server.
