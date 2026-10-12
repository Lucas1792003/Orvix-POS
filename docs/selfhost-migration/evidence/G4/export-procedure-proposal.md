# Phase C Step 4 — Hosted read-only export: proposed procedure (NOT executed)

Awaiting owner approval. Nothing below has been run. Credentials are redacted
as `<…>` and are never written to files.

## 1. Exact commands (Mac, repo dir)

```
mac$ W=~/shwephala-migration/$(date -u +%Y%m%dT%H%MZ); mkdir -p "$W"; chmod 700 ~/shwephala-migration "$W"; cd "$W"

# 1.1 consistency reference (read-only, Management API)
mac$ supabase db query --linked -f "$REPO/tools/selfhost-migration/sql/manifest.sql" > manifest-hosted.json

# 1.2 dumps — pg_dump via the CLI; needs the hosted DB password, typed by the owner into THIS shell only
mac$ read -s SUPABASE_DB_PASSWORD && export SUPABASE_DB_PASSWORD
mac$ supabase db dump --linked --role-only -f roles.sql
mac$ supabase db dump --linked -f schema.sql
mac$ supabase db dump --linked --data-only --use-copy -f data.sql \
      -x cron.job_run_details -x net._http_response -x net.http_request_queue \
      -x storage.objects -x storage.buckets -x storage.s3_multipart_uploads -x storage.s3_multipart_uploads_parts \
      -x storage.buckets_analytics -x storage.buckets_vectors -x storage.vector_indexes \
      -x auth.audit_log_entries -x auth.flow_state -x auth.one_time_tokens -x auth.mfa_challenges \
      -x auth.mfa_recovery_code_sets -x auth.mfa_recovery_codes -x auth.scim_tokens -x auth.scim_users
mac$ unset SUPABASE_DB_PASSWORD

# 1.3 storage objects + metadata (read-only)
mac$ mkdir -p storage && supabase storage cp --linked -r ss:///product-images/ ./storage/product-images/ -j 4
mac$ supabase db query --linked "select name, metadata->>'mimetype' as mime, (metadata->>'size')::bigint as size, metadata->>'cacheControl' as cc from storage.objects where bucket_id='product-images' order by name" > storage-objects.json
mac$ python3 "$REPO/tools/selfhost-migration/verify_objects.py" --make-manifest storage/product-images > storage-manifest.sha256

# 1.4 scrub + gates (no file leaves the Mac before these pass)
mac$ python3 "$REPO/tools/selfhost-migration/scrub_dump.py" data.sql data.scrubbed.sql
mac$ python3 "$REPO/tools/selfhost-migration/scrub_dump.py" --roles roles.sql roles.scrubbed.sql
mac$ python3 "$REPO/tools/selfhost-migration/check_secrets.py" roles.scrubbed.sql schema.sql data.scrubbed.sql storage-objects.json manifest-hosted.json   # must exit 0
mac$ python3 "$REPO/tools/selfhost-migration/schema_compat.py" inv-hosted.json inv-self.json --fix-dump data.scrubbed.sql --out data.final.sql
mac$ sha256sum roles.scrubbed.sql schema.sql data.final.sql storage-manifest.sha256 > SHA256SUMS
mac$ shred -u data.sql roles.sql 2>/dev/null || rm -P data.sql roles.sql   # unscrubbed originals removed immediately
```

Transfer to the server only after the gates pass:
```
mac$ rsync -av --chmod=F600,D700 "$W"/ lucashome:/srv/supabase/backups/import-$(basename "$W")/
```

## 2. Estimated sizes (from the verified inventory)

| Artefact | Estimate | Basis |
|---|---|---|
| `roles.sql` | < 10 KB | 15 platform roles, 0 custom |
| `schema.sql` | 0.5–1 MB | 31 tables, 58 functions, 59 policies, 70 indexes |
| `data.sql` (after `-x`) | 2–6 MB | 539 products, 956 prices, 931 units, 578 upload sessions, 176 brands, 81 audit rows, 10 auth users; excludes the 36 MB of cron/net logs |
| storage objects | 5.1 MB, 574 files | `storage.objects` metadata sum |
| Total on disk | < 15 MB | — |
| Duration | 2–5 minutes | Management API + pooler from Toronto to Singapore |

## 3. Where sensitive files live

- Mac: `~/shwephala-migration/<ts>/` (0700, owner only), on the FileVault-encrypted system volume, **outside** the repo and outside any iCloud/Dropbox-synced path. Nothing under the repo tree.
- Server: `/srv/supabase/backups/import-<ts>/` (0700, `lucario`), on `/srv` (unencrypted ext4 — same exposure class as the live database itself).
- Never: git, the scratchpad, `/tmp`, chat output.

## 4. How hosted stays read-only

- `supabase db dump` is `pg_dump`/`pg_dumpall --roles-only`: SELECT-only.
- `supabase db query` is used only with SELECT statements (manifest, metadata).
- `supabase storage cp` with a local destination only downloads.
- No `db push`, `migration`, `functions deploy`, `secrets set`, `storage rm/mv`, Dashboard changes, or writes of any kind. The CLI's temporary login role (`cli_login_postgres`) is the one side effect the Management API already creates for every `db query`; it is a platform artefact, not business data, and is removed from the roles dump by the scrubber.
- After export, the project continues to run untouched; the keep-alive ping (08 P8) is not started until cutover is scheduled.

## 5. Cron-definition secrets

`cron.job` rows embed the hosted **service-role JWT** inside `command`. Handling:
1. `scrub_dump.py` removes the entire `cron.job` COPY block and writes a
   redacted copy (`<REDACTED_JWT>`) for reference.
2. `check_secrets.py` must report zero JWT-shaped tokens across all files that
   will be transferred; the run aborts otherwise.
3. The two jobs are re-created on the self-hosted DB from the repo templates
   with the **new** service key and the internal URL `http://api-gw:8000/functions/v1/…`
   (`render_cron.py`, key from the environment).
4. The hosted service-role key is never copied, stored, or used on `lucashome`.

## 6. Auth and MFA preservation

- `auth.users` (10 rows incl. bcrypt password hashes), `auth.identities`,
  `auth.mfa_factors` (2 verified TOTP, plain base32), `auth.mfa_amr_claims`,
  `auth.sessions`, `auth.refresh_tokens` are in the data dump and restored
  with `session_replication_role = replica`.
- Hosted-only tables (recovery codes, SCIM) are empty and excluded; column
  sets of all restored auth tables are identical on both sides (evidence:
  `2026-10-11-schema-compatibility.md`).
- The JWT secret differs ⇒ existing sessions/refresh tokens are dead on
  arrival (expected; 1 live session today). Users log in again; TOTP factors
  are expected to verify unchanged — **proven only by the Step 5 test** with a
  QA account enrolled on hosted? No: QA accounts cannot be created on hosted
  (read-only). TOTP proof = the real admin logging into the rehearsal with the
  migrated factor, or a synthetic factor inserted into the self-hosted copy
  with a known secret and verified with a TOTP generator. Both are planned.

## 7. Storage objects and metadata

- Download all 574 objects with `supabase storage cp -r`; capture
  name/mime/size/cache-control from `storage.objects`; build a SHA-256 manifest.
- On the self-hosted side: create the bucket `product-images` (public) via
  API; `upload_objects.py` re-uploads by name with original content-type and
  cache-control (storage-api creates `objects` rows and the on-disk layout
  `stub/stub/product-images/<name>/<version>`); `verify_objects.py` fetches
  every public URL and checks SHA-256 and size (574/574).
- `products.image_url` (533 rows) and the business-profile logo URL are
  rewritten by SQL from the hosted origin to `https://lucashome.tail8a86e4.ts.net`.
- The 41 unreferenced objects are copied too (no data is dropped in a migration).

## 8. Secure removal after migration

- Mac: the unscrubbed `data.sql`/`roles.sql` are removed right after
  scrubbing (`rm -P` overwrite on APFS is best-effort; FileVault makes the
  residue unreadable at rest). The scrubbed set is kept until G13 is accepted
  and then deleted; the **golden snapshot** copy that must be retained goes
  into the encrypted offsite bundle (Phase F), not left in the home directory.
- Server: `/srv/supabase/backups/import-<ts>/` is `shred -u`'d after the
  manifest comparison passes and the first base backup of the restored
  database exists; the physical/logical backups then supersede the import.
- A `tools/selfhost-migration/cleanup_import.sh` with a dry-run mode will
  list exactly what it deletes before doing so.
