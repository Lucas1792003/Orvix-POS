# Phase C — Restoration into lucashome: proposed procedure (NOT executed)

Awaiting owner approval. Source: verified export workspace
`~/shwephala-migration/20261011T2347Z/` on the Mac (0700, outside the repo).
Target: the running self-hosted stack `/srv/supabase/stack` on `lucashome`
(empty database, WAL archiving on, base backups verified).

This instance is intended to become the production backend, so **nothing in
the data is masked or altered** beyond the documented host rewrites. Outbound
side effects are prevented structurally: no Resend key is configured and no
cron jobs are created in this phase.

## 0. Pre-restore safety point (lucashome)

```
ls$ /srv/supabase/backup/bin/backup-logical.sh && /srv/supabase/backup/bin/backup-base.sh   # pre-restore point
ls$ cd /srv/supabase/stack && docker compose exec -T db psql -U supabase_admin -d postgres -Atc "select pg_current_wal_lsn(), now()" </dev/null   # record LSN + time → rollback target
```
Rollback at any later step = PITR to this timestamp (proven procedure), or
simply `TRUNCATE`/drop of the restored objects since the DB is otherwise empty.

## 1. Transfer (Mac → lucashome)

Only scrubbed artefacts; the raw dumps no longer exist.
```
mac$ W=~/shwephala-migration/20261011T2347Z
mac$ python3 tools/selfhost-migration/check_secrets.py "$W"        # 0 hits (re-run as the last gate before transfer)
mac$ rsync -a --chmod=F600,D700 "$W"/ lucashome:/srv/supabase/backups/import-20261011T2347Z/
ls$  cd /srv/supabase/backups/import-20261011T2347Z && shasum -a 256 -c SHA256SUMS --quiet && echo "transfer verified"
```

## 2. Database restore (single transaction, triggers off)

Run as `supabase_admin` (needed for `session_replication_role` and for the
`OWNER TO "postgres"` statements). The dump references only the roles
`anon`, `authenticated`, `service_role`, `postgres` — all present.
```
ls$ cd /srv/supabase/stack && I=/srv/supabase/backups/import-20261011T2347Z
ls$ docker compose cp $I/roles.scrubbed.sql db:/tmp/roles.sql && docker compose cp $I/schema.scrubbed.sql db:/tmp/schema.sql && docker compose cp $I/data.fixed.sql db:/tmp/data.sql
ls$ docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction \
      --file /tmp/roles.sql --file /tmp/schema.sql \
      --command 'SET session_replication_role = replica' --file /tmp/data.sql </dev/null 2>&1 | tee $I/restore.log
```
Expected notices (not errors): `extension "pg_net" already exists, skipping`
(dump says `WITH SCHEMA public`, image has it in `extensions`; function
bodies reference the `net` schema, which is the same either way),
`CREATE EXTENSION pg_cron` installs the preloaded extension. The schema dump
contains `ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."inventory"`
(migration 058), which is what we want; `CREATE PUBLICATION` lines are
commented out by the CLI.

If psql exits non-zero: the transaction is rolled back, nothing is applied;
inspect `restore.log`, fix the dump offline, repeat. No partial state is
possible at this step.

## 3. Post-restore SQL (one file, `post_restore.sql`, run with ON_ERROR_STOP)

1. `supabase_migrations.schema_migrations` recreated with the 61 versions and
   names from the repo file names (so `supabase migration list` against this
   DB is correct and future `db push` works).
2. `SELECT setval('auth.refresh_tokens_id_seq', (SELECT max(id) FROM auth.refresh_tokens));`
3. Image URL host rewrite on `products.image_url` and `business_profile.logo_url`
   from `https://gzqiukxnzfdouwaotelx.supabase.co` to
   `https://lucashome.tail8a86e4.ts.net` (533 + 1 rows expected).
4. `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;` +
   `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;`
   (audit finding A7; also to be applied to hosted later as migration 062).
5. Publication check: `inventory` present in `supabase_realtime` (from the dump);
   add if missing.
6. **No cron jobs** created in this phase (they email through Resend). Deferred
   to Phase E with a decision on email handling. `pg_cron` extension itself is
   installed by the schema dump.

## 4. Storage objects

```
mac$ export SB_SERVICE_KEY=<new service-role key, read from lucashome .env into this shell only>
mac$ curl -s -X POST https://lucashome.tail8a86e4.ts.net/storage/v1/bucket -H "Authorization: Bearer $SB_SERVICE_KEY" -H "apikey: $SB_SERVICE_KEY" -H 'Content-Type: application/json' -d '{"id":"product-images","name":"product-images","public":true}'
mac$ python3 tools/selfhost-migration/upload_objects.py "$W/storage/product-images" "$W/storage-objects.json" https://lucashome.tail8a86e4.ts.net --dry-run
mac$ python3 tools/selfhost-migration/upload_objects.py "$W/storage/product-images" "$W/storage-objects.json" https://lucashome.tail8a86e4.ts.net --report "$W/upload-report.json"
mac$ unset SB_SERVICE_KEY
mac$ python3 tools/selfhost-migration/verify_objects.py "$W/storage-manifest.sha256" https://lucashome.tail8a86e4.ts.net --dir "$W/storage/product-images" --objects "$W/storage-objects.json"   # expect 574/574 ok
```
Uploads go over the tailnet from the Mac (5.1 MB). Content-type and
cache-control come from the hosted metadata.

## 5. Verification gates (all must pass)

| Gate | Command | Pass |
|---|---|---|
| Manifest | `manifest.sql` on self-hosted → `manifest_diff.py` vs `manifest-hosted.json` with ignores `storage.objects`, `public.functions/anon_executable`, `cron.job` | every count, checksum, max_created_at, policy count, publication, migration count equal |
| Integrity | `sql/post_restore_checks.sql` | no FAIL rows |
| Objects | `verify_objects.py` | 574/574 ok, sizes equal |
| Function bodies | `pg_get_functiondef` of all 58 public functions, md5 compared with hosted (read-only SELECT on hosted) | identical |
| Policies / grants | `pg_policies` and `has_function_privilege('authenticated', …)` compared with hosted | identical (anon EXECUTE deliberately false) |
| Auth | counts 10/10/2/1/3 (users/identities/mfa_factors/sessions/refresh_tokens); password login for the owner's own account over the tailnet; **TOTP**: (a) synthetic QA user created on self-hosted, enrolled via API with a generated secret, verified with a TOTP generator; (b) the owner logs in with the migrated factor from the real authenticator app | both pass |
| Services | auth/rest/storage/realtime/functions health unchanged; Realtime receives an `inventory` UPDATE | pass |
| Backups | `backup-logical.sh` + `backup-base.sh` run after restore; `backup-status.sh` OK; WAL archived | pass |

## 6. Cleanup

```
ls$ shred -u /srv/supabase/backups/import-20261011T2347Z/* && rmdir /srv/supabase/backups/import-20261011T2347Z   # after gate 5 + post-restore base backup
mac$ # workspace kept until G13 (encrypted offsite bundle takes the golden copy in Phase F), then removed
```

## 7. What is NOT done by this procedure

- Cron jobs (Phase E), email masking (none: production data), Resend key
  (absent), Electron build (Phase G), offsite backups (Phase F), hosted
  changes (none, ever).
