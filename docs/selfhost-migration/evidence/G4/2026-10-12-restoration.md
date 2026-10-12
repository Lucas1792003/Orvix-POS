# Evidence · G4 — Restoration of the hosted export into lucashome (Phase C)

Date: 2026-10-12 00:13–00:26 UTC. Source: verified export workspace
`~/shwephala-migration/20261011T2347Z` (Mac). Target: `/srv/supabase/stack` on
`lucashome`. Hosted Supabase: read-only SELECTs only (fingerprints), unchanged.

## Pre-restore (all passed)
10/10 containers healthy · backup status OK · archiver 9 archived / 0 failed · disk 59 GB (`/`) / 731 GB (`/srv`) · fresh logical backup `dump/hourly/20261012T001357Z` · **pre-restore checkpoint LSN `0/110001B8` at 2026-10-12 00:13:57 UTC (WAL 0x11)** · target empty (0 public tables, 0 auth users, 0 objects) · no Resend/SMTP secrets, `pg_cron` not installed (no jobs possible) · 587 export checksums OK · secrets gate 0 hits · raw dumps absent · transfer (588 files, 8.6 MB) verified by SHA-256 on the server.

## Restore stages and their recovery procedure

| Stage | Result | Recovery if it had failed |
|---|---|---|
| 1 roles/settings + 2 schema + 3 data, one transaction, `ON_ERROR_STOP`, triggers off inside the transaction only | psql exit 0, 49 COPY blocks, 3,363 rows, 0 errors, `session_replication_role` back to `origin` | transaction rolls back → nothing applied |
| 4 migration history (61 rows, CLI shape) | 61 / max 061 | re-run (idempotent, `ON CONFLICT DO NOTHING`) |
| 5 sequence `auth.refresh_tokens_id_seq` | 1326 = max(id) | re-run setval |
| 6 publication | `supabase_realtime` → `public.inventory` (carried by the dump; verified) | `ALTER PUBLICATION … ADD TABLE` |
| 7a image URL rewrite | 533 products → new host, 0 old host; logo_url is NULL on hosted (0 rewrites, correct) | reverse `replace()` |
| 7b security: `REVOKE EXECUTE … FROM anon` **and `FROM PUBLIC`** (the 19 helper/trigger functions carried the default PUBLIC grant) | anon 0 / authenticated 58 / service_role 58 | re-grant from hosted list |
| 7c table-grant parity: self-hosted had broader grants than hosted (upstream default privileges applied at CREATE TABLE; the dump carries no REVOKEs). Fixed by revoking all and re-granting exactly the hosted set (32 relations, 188 statements) | `table_grants_fingerprint` = hosted `1b502454…` | re-run the generated SQL |
| Storage: bucket `product-images` public; 574 objects uploaded by name with original mime/cache-control (13 s); verified via public URLs | **574/574 ok** (SHA-256 + size); `storage.objects` 574 rows, 574 distinct names, 5,333,131 bytes, 0 null versions; 0 image_url without object | re-run uploader (`x-upsert`) |
| PITR safety | pre-restore base backups retained (`base/20261011T232753Z`, `…235750Z`), archive continuous | PITR to `0/110001B8` / 00:13:57 UTC |

## Verification gates

| Gate | Result |
|---|---|
| Manifest (154 metrics) | 148 equal, 5 ignored by design (storage.objects checksum/max_created_at, cron.job, anon_executable), **1 different: `storage.buckets.max_created_at`** (bucket created 2026-10-12 — expected) |
| `post_restore_checks.sql` | 47 rows, all ok/INFO: orphans 0 (8 checks), 533 URLs on new host, 0 on supabase.co, sequence ok, publication ok, anon-exec 0, RLS 31/31, leftover `authenticated_all` 0, policies 58, migrations 61 |
| Foreign keys (RI triggers were off during restore) | generic scan: **55 constraints checked, 0 violations** |
| RLS policies | 58 on 29 tables; `policy_fingerprint` **identical** to hosted (`d9edf86f…`) |
| Functions | 58/58; `pg_get_functiondef` fingerprint differs **only because 33 hosted bodies contain carriage returns** that the dump pipeline normalised; with CRs stripped the source fingerprint is identical on both sides (`a597f757…`) |
| Table grants | identical to hosted after 7c |
| Triggers / indexes | 15 / 70 on both sides |
| Auth | 10 users (10 bcrypt hashes, 10 confirmed), 10 identities, 2 verified TOTP factors (both on the ADMIN account — confirmed via GoTrue admin API), 3 app users linked; migrated admin login with a wrong password → `invalid_credentials` (user lookup + hash path live) |
| Sessions | the 1 hosted session, its 2 AMR claims and 3 refresh tokens were **invalidated** (deleted/revoked) on the self-hosted side by decision (old JWTs are unverifiable here; carrying refresh tokens forward was judged unsafe). Users log in again. Passwords and MFA factors untouched |
| Synthetic TOTP | QA user: enrol → challenge → verify → `aal2`; fresh login reports `next=aal2`; wrong code rejected; QA user deleted |
| Realtime | `postgres_changes` UPDATE on `public.inventory` delivered over `wss://` (service-role subscription; a no-op update, qty unchanged). First attempt timed out because the poller restarts a few seconds after schema changes |
| API via gateway | auth 200, rest 200 (shops), storage 200; anon on products → `[]` (RLS); functions → 401 JSON |
| Containers | 10/10 healthy; Realtime restart count 1 (from the earlier WAL change) |

## Post-restore backup
Logical `dump/hourly/20261012T002345Z` (882 KB, counts auth_users 10 / objects 574 / public tables 31) · base `base/20261012T002347Z` (`pg_basebackup`, `pg_verifybackup` ok, 5.3 MB) · archiver 14 / 0 failed, last `…14.backup` · **post-restore LSN `0/15000E40` at 00:24:41 UTC** · retention keeps 14 bases, so the two pre-restore bases survive ≥ 11 more daily runs; status OK. Import directory on the server shredded (591 files). Mac workspace retained as the golden copy until the encrypted offsite bundle exists (Phase F).

## Explained differences (none unexplained)
1. `storage.buckets.max_created_at` — bucket re-created.
2. `storage.objects` ids/versions/timestamps — re-uploaded through the API (names, bytes, hashes identical).
3. One `product_image_upload_sessions.signed_upload_token` cell nulled at export (expired hosted-signed token).
4. `cron.job` 0 vs 2 — deliberately not created (Phase E).
5. anon EXECUTE 0 vs 58 — intentional hardening (A7).
6. Sessions/refresh tokens 0 vs 1/3 — intentional invalidation.
7. Function source CRs — formatting only.
