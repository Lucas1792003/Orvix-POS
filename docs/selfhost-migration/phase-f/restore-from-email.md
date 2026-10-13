# Runbook · Restore the POS backend from the emailed recovery archive

Use this runbook when `lucashome` and its local backups are gone (disk failure, theft, fire,
ransomware) and only the email tier is left. It is also the procedure for the
quarterly drill (§5). If the local backups still exist, use
`deploy/lucashome/backup/README.md` §A/§B/§B2 instead: they are newer (hourly
dumps, PITR) and faster.

Design and formats: [email-backup-design.md](email-backup-design.md). The
procedure in §3.4–§3.6 is exactly what the test harness runs (T3: fresh
`supabase/postgres:17.6.1.136`, `pg_restore --create --exit-on-error`
succeeds, and auth users, MFA factors, migration history, business tables and
storage objects match row for row).

What you need:
- The **backup mailbox**: login, 2SV device or recovery codes, from the password manager.
- The **owner's OpenPGP private key** and its passphrase. It lives on the
  owner's device, in the password manager (`owner-backup.SECRET.asc`) and on paper
  (`paperkey`).
- The **secrets**: the newest `[pos-backup] secrets` mail (if
  `EMAIL_SECRETS_MODE=email`), or `.env` + `pgsodium_root.key` from the password
  manager. Without them, see §3.2b.
- This repository: `deploy/lucashome/backup/email-unpack.py` and `tools/selfhost-migration/verify_objects.py`.
- A replacement Linux host. The steps below assume Ubuntu with Docker Engine and
  the compose plugin, Tailscale, and a non-root user in the `docker` group, as on
  `lucashome`.

Expected effort: 1–2 h, mostly OS and Docker setup. The data steps take minutes at
today's size. Tills keep selling offline in the meantime. Data loss is
everything after the archive's `created` time, up to one week (offsite RPO).

## 1. Pick the archive

1. In the mailbox, search `subject:"[pos-backup] archive"`. Take the newest
   archive id, e.g. `pos-2026-W42`. Each mail says `part i/N`, and its body
   lists every part's sha256 and the total sha256.
2. Download **every part** of that id. In Gmail use ⋮ → *Download message*
   (an `.eml` file), or use Google Takeout for the label (an `.mbox` file). Put
   them in one directory, e.g. `~/restore/mails/`.
3. Download the newest `[pos-backup] secrets` mail too, if there is one.

## 2. Reassemble, verify and decrypt (owner's device)

On a Mac: `brew install gnupg`. Import the private key if it is not already in
the keyring: `gpg --import owner-backup.SECRET.asc`. To rebuild from paper:
`paperkey --pubring owner-backup.pub.asc --secrets paper.txt | gpg --import`.

```bash
mkdir -m 0700 -p ~/restore/out && cd ~/restore
python3 -I <repo>/deploy/lucashome/backup/email-unpack.py --list mails/          # every id found, part counts, index present?
python3 -I <repo>/deploy/lucashome/backup/email-unpack.py --out out mails/       # verifies each part + the total; writes out/<id>.tar.gpg
```

`email-unpack.py` exits 1 and names the problem if any part is missing,
duplicated with a wrong hash, or tampered, or if the index copies disagree. In
that case try the previous week's archive. Do not try to repair a part.

```bash
gpg --output out/archive.tar --decrypt out/pos-2026-W42.tar.gpg; echo "gpg exit $?"
```

**Only continue if gpg's exit status is 0.** On a manipulated or corrupted
message, gpg still writes the plaintext it could not verify before it fails.
That file is untrusted: delete it. Never run `gpg -d … | tar -x`.

```bash
mkdir -m 0700 out/x && tar -C out/x -xf out/archive.tar
cd out/x && shasum -a 256 -c SHA256SUMS        # Linux: sha256sum -c SHA256SUMS ; every line must say OK
jq . MANIFEST.json | head -40                    # archive id, created, counts, stack version
```

Secrets, if mailed:
`gpg --output secrets.tar --decrypt <secrets>.tar.gpg && echo OK && mkdir -m 0700 s && tar -C s -xf secrets.tar`.
That gives `s/stack/.env`, `s/db-config/pgsodium_root.key`, and
`s/backup/backup.env`.

Contents of `out/x`: `db/{postgres.dump,_supabase.dump,globals.sql,db-settings.sql,counts.json,app_config.json}`,
`files/{storage.tar.gz,functions.tar.gz}`,
`config/{docker-compose.override.yml,.supabase-version,custom-conf.d/,pg_hba.conf}`.

## 3. Rebuild on a bare server

### 3.1 Host

1. Install Ubuntu, Docker Engine and the compose plugin, and Tailscale. Create the
   backup user in the `docker` group, with `sudo mkdir -p /srv/supabase && sudo chown <user> /srv/supabase`.
2. Tailscale: remove the old `lucashome` node in the admin console first, so the
   `*.ts.net` name can be re-issued. Then `sudo tailscale up` with the hostname
   `lucashome`. Keeping the same name keeps the tills' backend URL valid.

### 3.2 Stack checkout and configuration

```bash
cd /srv/supabase
git clone --filter=blob:none --no-checkout --depth=1 --quiet --branch self-hosted/v0.8.2 https://github.com/supabase/supabase upstream
cd upstream && git sparse-checkout init --cone && git sparse-checkout set docker && git checkout --quiet
git rev-parse HEAD        # must be 564eab8ad7840b13324f68b1bfac074ef8d51c21
mkdir -p /srv/supabase/stack && cp -rf /srv/supabase/upstream/docker/. /srv/supabase/stack/
```

Copy the payload and secrets to the host over Tailscale SSH, into a 0700
directory such as `/srv/supabase/restore`. Then:

```bash
S=/srv/supabase/stack; X=/srv/supabase/restore/x
cp $X/config/docker-compose.override.yml $S/docker-compose.override.yml
cp $X/config/.supabase-version $S/.supabase-version
mkdir -p $S/volumes/db && cp -r $X/config/custom-conf.d $S/volumes/db/ && cp $X/config/pg_hba.conf $S/volumes/db/pg_hba.conf
install -m 0600 /srv/supabase/restore/s/stack/.env $S/.env        # 3.2a: the original secrets
mkdir -p $S/volumes/db/wal_archive                                # the override mounts it; set ownership per WAL-ARCHIVING.md
cd $S && docker compose config --quiet && echo compose-ok
```

**3.2b, no secrets file:** generate fresh secrets as for a new install
(upstream `docker/README`/`utils`, and the values listed in
`deploy/lucashome/env.settings.md`). Consequences:
- a new `JWT_SECRET` invalidates every session and the old anon key. Every
  user signs in again, and the apps need the new anon key;
- a new pgsodium key means existing `vault` secrets cannot be read. There are 0
  rows today, so nothing is lost now;
- passwords of the database roles come from `globals.sql` (§3.4). After the
  restore, set the roles the services log in as to the new `.env` values (as
  in the 05 migration runbook).

### 3.3 Database container only, then the pgsodium key

```bash
cd /srv/supabase/stack
docker compose up -d db                     # only db; nothing else may connect during the restore
docker compose ps db                        # wait for healthy
# 3.2a only: put back the original root key, then restart db
docker compose cp /srv/supabase/restore/s/db-config/pgsodium_root.key db:/etc/postgresql-custom/pgsodium_root.key
docker compose exec -T db sh -c 'chown postgres:postgres /etc/postgresql-custom/pgsodium_root.key && chmod 0600 /etc/postgresql-custom/pgsodium_root.key' </dev/null
docker compose restart db
```

### 3.4 Restore the databases (tested sequence)

```bash
X=/srv/supabase/restore/x
docker compose exec -T db psql -X -U supabase_admin -d postgres -q -f - < $X/db/globals.sql
#   "role ... already exists" errors are expected and harmless
docker compose exec -T db psql -X -U supabase_admin -d template1 -v ON_ERROR_STOP=1 <<'SQL'
ALTER DATABASE postgres ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid();
ALTER DATABASE postgres RENAME TO postgres_fresh;
SQL
docker compose exec -T db pg_restore -U supabase_admin -d template1 --create --exit-on-error < $X/db/postgres.dump
echo "pg_restore exit $?"                    # must be 0
docker compose exec -T db psql -X -U supabase_admin -d postgres -q -f - < $X/db/db-settings.sql
```

The stack's own init already created a fresh `_supabase`, which holds only
analytics and supavisor metadata. Keep it. Restore `_supabase.dump` only if a
service complains: rename that database aside the same way, then run
`pg_restore -d template1 --create`.

Why the rename and terminate: background workers (pg_cron's launcher) hold a
connection to `postgres`, and a database with connections cannot be renamed.
`postgres_fresh` can be dropped once everything is verified.

### 3.5 Storage objects and Edge Functions

```bash
S=/srv/supabase/stack; X=/srv/supabase/restore/x
mkdir -p $S/volumes/storage && tar -C $S/volumes/storage -xzf $X/files/storage.tar.gz
mkdir -p $S/volumes/functions && tar -C $S/volumes/functions -xzf $X/files/functions.tar.gz
```

### 3.6 Start everything and expose it

```bash
cd /srv/supabase/stack && docker compose up -d && docker compose ps     # all healthy
sudo tailscale serve --bg --https=443 http://127.0.0.1:8000             # tailnet only, never funnel (04 D16)
```

### 3.7 `app_config`

```bash
docker compose exec -T db psql -X -U supabase_admin -d postgres -Atc "select key, value from public.app_config" </dev/null
cat /srv/supabase/restore/x/db/app_config.json
```

The two must match. If the public URL changed (different tailnet name), update
`supabase_public_url` to the new `https://<host>.<tailnet>.ts.net` as described
in migration 080's header. Phone uploads depend on it.

## 4. Verify

1. Counts against the archive (exact match expected):
   ```bash
   jq 'del(.captured_at)' /srv/supabase/restore/x/db/counts.json
   docker compose exec -T db psql -X -U supabase_admin -d postgres -Atc "select json_build_object(
     'auth_users',(select count(*) from auth.users),'auth_mfa_factors',(select count(*) from auth.mfa_factors),
     'storage_objects',(select count(*) from storage.objects),'products',(select count(*) from public.products),
     'organizations',(select count(*) from public.organizations),'sales',(select count(*) from public.sales),
     'schema_version',(select max(version) from supabase_migrations.schema_migrations))" </dev/null
   ```
   `schema_version` must be the archive's value (`080` as of 2026-10-13).
2. Storage objects served correctly, checked through the public URLs with the existing tool:
   ```bash
   cd /srv/supabase/stack/volumes/storage/stub/stub
   find product-images -type f | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f%/*}"; done > /tmp/restored-objects.sha256
   python3 -I <repo>/tools/selfhost-migration/verify_objects.py /tmp/restored-objects.sha256 https://lucashome.<tailnet>.ts.net \
     --bucket product-images --report /tmp/verify-restore.json            # expect "N/N ok", N = storage_objects
   ```
   (The file backend stores `<bucket>/<object name>/<version>`, and `${f%/*}`
   strips the version. An object overwritten in place has several versions;
   only the newest one is served, so older ones report a hash mismatch. Check
   them against `storage.objects.version`.)
3. Owner signs in as ADMIN with the **existing authenticator app**. The TOTP
   factor was restored with `auth.mfa_factors`. One till signs in and syncs.
4. Backups first, before anything else changes: deploy the backup scripts
   (`deploy/lucashome/backup/deploy.sh`), restore `backup.env` from the
   secrets file, then run `backup-logical.sh` once and `backup-status.sh` →
   OK. Re-enable the email tier with a **new** send-only credential (revoke the old
   one, which was on the lost host: for `gmail-api`, sender account → Security →
   *Third-party apps & services* → remove the app, then re-mint with
   `gmail-oauth-mint.py` on the Mac) per the design doc §10, and run
   `--selftest` and `--selftest --selftest-parts 3`.
5. Clean up the plaintext: on the host, `rm -rf /srv/supabase/restore`. On the
   device, `rm -rf ~/restore/out ~/restore/s` and delete the
   `secrets.tar`/`archive.tar` files. Drop `postgres_fresh` after a day of
   normal operation.
6. Record the incident and the measured times in
   `docs/lucashome-selfhost/incidents.md`.

## 5. Quarterly drill (owner device, no server involved)

Steps 1–2 above, then a throwaway restore in Docker. Delete everything afterwards.

```bash
docker run -d --name drill-db --network none -e POSTGRES_PASSWORD=drill supabase/postgres:17.6.1.136
sleep 30   # wait for init
docker exec -i drill-db psql -X -U supabase_admin -d postgres -q -f - < out/x/db/globals.sql 2>/dev/null
docker exec -i drill-db psql -X -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -c "ALTER DATABASE postgres ALLOW_CONNECTIONS false" \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid()" \
  -c "ALTER DATABASE postgres RENAME TO postgres_fresh"
docker exec -i drill-db pg_restore -U supabase_admin -d template1 --create --exit-on-error < out/x/db/postgres.dump && echo RESTORE-OK
docker exec drill-db psql -X -U supabase_admin -d postgres -Atc "select count(*) from auth.users; select count(*) from auth.mfa_factors; select max(version) from supabase_migrations.schema_migrations"
docker rm -f drill-db && rm -rf out/x out/archive.tar
```

Pass criteria: `RESTORE-OK`, and counts equal `db/counts.json`. Write the
date, the archive id and the time taken in
`docs/lucashome-selfhost/status.md` under Backups.
