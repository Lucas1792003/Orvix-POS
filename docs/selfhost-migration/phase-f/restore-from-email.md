# Runbook · Restore the POS backend from the emailed recovery archive

Use this runbook when `lucashome` and its local backups are gone (disk failure, theft, fire,
ransomware) and only the email tier is left. It is also the procedure for the
quarterly drill (§5). If the local backups still exist, use
`deploy/lucashome/backup/README.md` §A/§B/§B2 instead: they are newer (hourly
dumps, PITR) and faster.

Design and formats: [email-backup-design.md](email-backup-design.md). Tested locally on disposable
copies only:
- the database and file restore in §3.5 and §3.7 is what the email-tier harness runs (through `docker exec`
  on a plain container rather than compose; it also restores `_supabase`) (T3: fresh
  `supabase/postgres:17.6.1.136`, `pg_restore --create --exit-on-error` succeeds, and auth users, MFA
  factors, migration history, business tables and storage objects match row for row);
- the fix-ups and the gate (§3.6, §3.9) are run by `deploy/lucashome/backup/tests/dr/run.sh`, from an
  offsite copy only;
- the API closure (§3.3, §3.4) is run by `tests/dr/api-isolation-test.sh`, against a compose model of the
  stack;
- the step order is enforced by `tests/dr/runbook-check.sh`.

None of it has been run on a real server.

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

1. Install Ubuntu, Docker Engine and the compose plugin, Tailscale, and `jq` + `curl`
   (`sudo apt-get install -y jq curl`: the restore guard and the gate need them and fail closed without). Create the
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

### 3.3 Restore tools on the host, API exposure disabled

The order from here is fixed: **API exposure disabled → database restored → fix-ups → gate → results
reviewed → tills reconciled or quarantined → separate owner authorization → reopening (§4.4)**.
Restore validation alone never authorizes reopening the API.

From the Mac (Tailscale SSH), deploy the backup and restore tools. This copies the scripts, every
`dr-*.sql` the gate needs and the migration source, and refuses if anything is missing. Do not pass `--cron`,
because the jobs stay off until §4 step 7:

```bash
mac$ LUCASHOME=<new host> deploy/lucashome/backup/deploy.sh
```

On the host, before any container starts:

```bash
cd /srv/supabase/stack
sudo /srv/supabase/backup/bin/restore-api-guard.sh close     # must end "API CLOSED (confirmed)"; exit 1 = stop here
/srv/supabase/backup/bin/dr-verify-restore.sh preflight --migrations /srv/supabase/backup/migrations --expect-version <NNN>
/srv/supabase/backup/bin/dr-verify-restore.sh backup --dir /srv/supabase/restore/x --expect-version <NNN> --accept-stale   # exit 0
```

`<NNN>` is the archive's schema version (`MANIFEST.json`). A weekly archive is almost always older than the
gate's 26 h freshness limit: `--accept-stale` records the decision to lose everything after its `created`
time (write it down). On a fresh node, `tailscale serve` has no configuration and no container runs, so
`close` only confirms that.

**Every till is disconnected from the network** (Wi-Fi off / cable out, or Tailscale disconnected on the
device) and labelled, as in README §0 step 3: the moment Tailscale Serve is back (§4 step 4), every
connected till would reconnect at once and its first drain fences its in-doubt keys (disaster-recovery.md
W10). The tills keep selling offline. No till signs in or syncs until §4 step 6.

### 3.4 Database container only, then the pgsodium key

```bash
cd /srv/supabase/stack
sudo /srv/supabase/backup/bin/restore-api-guard.sh start-db  # docker compose up -d --no-deps db; waits; verifies closure
# 3.2a only: put back the original root key, then restart db
docker compose cp /srv/supabase/restore/s/db-config/pgsodium_root.key db:/etc/postgresql-custom/pgsodium_root.key
docker compose exec -T db sh -c 'chown postgres:postgres /etc/postgresql-custom/pgsodium_root.key && chmod 0600 /etc/postgresql-custom/pgsodium_root.key' </dev/null
docker compose stop db                                       # not `restart`: only start-db (--no-deps) starts it
sudo /srv/supabase/backup/bin/restore-api-guard.sh start-db  # exit 0: still only db, nothing answers
```

Never use a plain `docker compose up`. It honours `depends_on`, and `functions` depends on `api-gw`.

### 3.5 Restore the databases (tested sequence)

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

### 3.6 Post-restore fix-ups

A logical restore loses the USAGE grants on the extension schemas `graphql`/`graphql_public`. The DR
drill found this, and the gate fails without the fix:

```bash
docker compose exec -T db psql -X -U supabase_admin -d postgres -f - </dev/null < /srv/supabase/backup/bin/dr-restore-fixups.sql
```

### 3.7 Storage objects and Edge Functions (files only, nothing started)

```bash
S=/srv/supabase/stack; X=/srv/supabase/restore/x
mkdir -p $S/volumes/storage && tar -C $S/volumes/storage -xzf $X/files/storage.tar.gz
mkdir -p $S/volumes/functions && tar -C $S/volumes/functions -xzf $X/files/functions.tar.gz
```

### 3.8 `app_config`

```bash
docker compose exec -T db psql -X -U supabase_admin -d postgres -Atc "select key, value from public.app_config" </dev/null
cat /srv/supabase/restore/x/db/app_config.json
```

The two must match. If the public URL changed (different tailnet name), update
`supabase_public_url` to the new `https://<host>.<tailnet>.ts.net` as described
in migration 080's header. Phone uploads depend on it.

### 3.9 The gate (read-only; it starts and exposes nothing)

```bash
X=/srv/supabase/restore/x
/srv/supabase/backup/bin/dr-verify-restore.sh restore --compose-dir /srv/supabase/stack --expect-version <NNN> \
  --migrations /srv/supabase/backup/migrations --accept-no-reference --counts $X/db/counts.json \
  --storage-dir /srv/supabase/stack/volumes/storage | tee ~/restore-gate-$(date -u +%Y%m%dT%H%M%SZ).log
echo "gate exit ${PIPESTATUS[0]}"
sudo /srv/supabase/backup/bin/restore-api-guard.sh verify    # still closed
```

The gate compares counts with the archive's own `counts.json` for equality, including per-table row counts.
It checks every financial, isolation and ledger invariant, and that the migration ledger exactly matches the
deployed migrations up to `<NNN>`. It also checks every storage object's bytes against `storage.objects`.
The exit codes are in `deploy/lucashome/backup/README.md` §A step 7:
- **3, ACCEPTED-WITHOUT-REFERENCE:** the best verdict possible here, because the lost server cannot provide
  a reference fingerprint.
- **1:** keep the API closed and investigate (disaster-recovery.md §5.3). The only exit 1 the owner may
  override is a log containing `NOTE  COUNTS-ONLY` (every other check passed), after §5.3, in writing.
- **2:** nothing was checked.

An archive made before 2026-10-18 has no per-table counts. The gate then answers FAILED with
`NOTE  COUNTS-ONLY` (see disaster-recovery.md §5.3).

## 4. Review, tills, then reopen (in this order)

1. **Results reviewed (owner).** Read the saved gate log and every `FAIL`/`NOTE` line. Compare the
   `info:` totals (supplier payments, outstanding, ledger states, audit rows, migrations) with the last daily
   report mail. Write the decision in the incident record.
2. **Tills reconciled or quarantined** (disaster-recovery.md §6). Each till is still disconnected:
   - export its queue and reconcile it with the owner;
   - or quarantine it: keep it offline, list it in the incident record, and resolve it before it may
     connect.

   **No till signs in or syncs before step 6.**
3. **Separate owner authorization** to reopen, recorded with its time. This is not the approval to
   restore, and a passing gate is not authorization. It requires exit 3 accepted in writing, or a
   `COUNTS-ONLY` exit 1 overridden in writing after disaster-recovery.md §5.3; any other result never reopens.
4. **Reopening:** exactly `deploy/lucashome/backup/README.md` §R, run by the owner by hand:
   - `restore-api-guard.sh verify`;
   - `docker compose up -d --no-deps auth rest meta realtime imgproxy storage`;
   - `docker compose up -d --no-deps api-gw functions`;
   - a loopback probe;
   - then `sudo tailscale serve --bg --https=443 http://127.0.0.1:8000` (tailnet only, never funnel, 04 D16).

   Nothing in this runbook or the scripts does this automatically.
5. **After reopening, before the tills.** Check that storage objects are served correctly through the
   public URLs, using the existing tool:
   ```bash
   cd /srv/supabase/stack/volumes/storage/stub/stub
   find product-images -type f | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f%/*}"; done > /tmp/restored-objects.sha256
   python3 -I <repo>/tools/selfhost-migration/verify_objects.py /tmp/restored-objects.sha256 https://lucashome.<tailnet>.ts.net \
     --bucket product-images --report /tmp/verify-restore.json            # expect "N/N ok", N = storage_objects
   ```
   The file backend stores `<bucket>/<object name>/<version>`, and `${f%/*}` strips the version. An object
   overwritten in place has several versions. Only the newest one is served, so older ones report a hash
   mismatch: check them against `storage.objects.version`.

   Then the owner signs in as ADMIN with the **existing authenticator app**. The TOTP factor was restored
   with `auth.mfa_factors`.
6. **Reconnect tills one at a time,** in the order disaster-recovery.md §6 sets: reconciled tills first; a
   quarantined till stays disconnected until its queue is resolved. A reconnecting till drains and fences
   its in-doubt keys (W10): its reconciliation record must already list them.
7. **Backups back on, before the business changes anything else.**
   - Restore `backup.env` from the secrets file.
   - Install the crontab: `deploy.sh --cron`.
   - Run `backup-logical.sh` once, then `backup-status.sh`, which must report OK.
   - Re-enable the email tier with a **new** send-only credential, per the design doc §10. Revoke the old
     one first, because it was on the lost host: for `gmail-api`, go to the sender account → Security →
     *Third-party apps & services* → remove the app, then re-mint with `gmail-oauth-mint.py` on the Mac.
   - Run `--selftest` and `--selftest --selftest-parts 3`.
8. **Clean up the plaintext.**
   - On the host: `rm -rf /srv/supabase/restore`.
   - On the device: `rm -rf ~/restore/out ~/restore/s`, and delete the `secrets.tar`/`archive.tar` files.
   - Drop `postgres_fresh` after a day of normal operation.
9. **Record the incident** and the measured times in `docs/lucashome-selfhost/incidents.md`.

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
docker exec -i drill-db psql -X -U supabase_admin -d postgres -q -f - < <repo>/deploy/lucashome/backup/dr-restore-fixups.sql
<repo>/deploy/lucashome/backup/dr-verify-restore.sh restore --container drill-db --expect-version <NNN> \
  --migrations <repo>/supabase/migrations --accept-no-reference --counts out/x/db/counts.json; echo "gate exit $?"
docker rm -f drill-db && rm -rf out/x out/archive.tar
```

Pass criteria: `RESTORE-OK`, and the gate exits 3 (`ACCEPTED-WITHOUT-REFERENCE`); an archive made before
2026-10-18 can only reach exit 1 with `NOTE  COUNTS-ONLY` (no per-table counts). Write the
date, the archive id and the time taken in
`docs/lucashome-selfhost/status.md` under Backups.
