# Local PostgreSQL backups for the self-hosted Supabase stack on `lucashome`

Source of truth for the scripts is this directory; they run on `lucashome`
from `/srv/supabase/backup/bin/` as `lucario` (no sudo, no stack restarts).
Deploy with `./deploy.sh` (add `--cron` to (re)install the crontab).

This covers the **database** (07 §2 rows "Postgres data" and "Postgres
logical dump"): hourly logical dumps, daily base backups, continuous WAL
archiving (applied 2026-10-11, see [WAL-ARCHIVING.md](./WAL-ARCHIVING.md)) and
drills that restore all of it. The **offsite tier** (encrypted copy on
Cloudflare R2, age-encrypted secrets bundle, Mac pull) is implemented and
deployed **disabled** — see "Offsite tier" below, [OFFSITE-ENABLE.md](./OFFSITE-ENABLE.md)
and [MAC-TIER.md](./MAC-TIER.md).

## Jobs

| Job | Script | Schedule (UTC, cron) | What it does | Output |
|---|---|---|---|---|
| hourly logical dump | `backup-logical.sh` | `15 * * * *` | `pg_dumpall --roles-only` → `globals.sql`; database-level `ALTER DATABASE … SET` → `db-settings.sql`; `pg_dump -Fc --create` of `postgres` and `_supabase`; `counts.json` (auth.users, storage.buckets/objects, table counts per schema, roles, extensions); `pg_restore -l` must list >0 TOC entries per dump; size ±50 % warning vs previous run; `SHA256SUMS`, `meta.json`; promotion to daily/weekly; prune | `backups/dump/hourly/<ts>/` |
| daily base backup | `backup-base.sh` | `30 2 * * *` | physical backup of PGDATA, see "Base backup methods"; `counts.json`; copy of `pgsodium_root.key`; verification; `backup.json`, `SHA256SUMS`; prune | `backups/base/<ts>/` |
| weekly restore drill | `restore-test.sh` | `30 3 * * 0` | restores the newest dump set and the newest base backup into throwaway containers and compares counts with those recorded at backup time | `status.json` + log |
| failure detection | `backup-status.sh` | `*/30 * * * *` | one-screen summary; exit 1 when stale/failed/low disk/leftovers; optional healthchecks ping | `logs/backup-status.log` |
| retention | `backup-prune.sh` | called by the jobs | keeps hourly 48 / daily 14 / weekly 8 / base 14 and prunes the WAL archive below the oldest retained base (see "Retention math"); deletes only under `backups/dump/*/`, `backups/base/` and the archive dir | — |
| full DR drill | `dr-drill.sh run` (+ `dr-drill-fingerprint.sql`, `dr-drill-consistency.sql`) | by hand, from a scratch dir `~/phf-drill` (not deployed to `bin/`) | read-only on live: builds the weekly email archive from live data with a throwaway gpg key (`email-archive.sh --no-send`), reassembles/tamper-tests/decrypts it, restores it into a disposable compose project `phf-drill` (db, rest, auth, storage, functions, gateway on 127.0.0.1:18000, fresh throwaway secrets), compares every public table + auth/storage/migrations with live, verifies objects and functions, then PITR from base + WAL to targets around real events; `dr-drill.sh cleanup` removes everything. Evidence `docs/selfhost-migration/evidence/G6/2026-10-13-dr-drill.md` | `~/phf-drill/results/` (counts, md5s, timings) until cleanup |
| PITR drill | `pitr-test.sh` | by hand (touches the live db) | creates `public.pitr_marker`, inserts rows around a target time T1, forces a WAL switch, restores the newest base + archive to T1 in a throwaway, proves only pre-T1 rows exist, drops the table | `status.json` job `pitr-test` + log |
| WAL archiving | Postgres itself | continuous, `archive_timeout=300` | `archive_command` gzips every completed segment into `stack/volumes/db/wal_archive/` (bind mount) | `wal_archive/<segment>.gz` |
| offsite sync (**disabled**) | `offsite-sync.sh wal\|dump\|base\|storage\|bundle\|check\|all` | lines prepared in `crontab.lucario`, commented out: wal `*/15`, dump `20 *`, base `45 2`, storage `0 */6`, bundle `50 2`, check `30 4` | rclone sync/copy to the crypt remote `offsite:` with `--backup-dir .versions/<tier>/<date>` on base/storage/bundle, `rclone cryptcheck` after each tier, healthchecks `offsite` pings; `check` also prunes `.versions/` (30 d) and records the remote size | `offsite.json` + `logs/offsite-<tier>.log` |
| secrets bundle (**disabled**) | `secrets-bundle.sh` | called by `offsite-sync.sh bundle` (daily) | tar of `.env`, override, `.supabase-version`, `volumes/db/{custom-conf.d,pg_hba.conf}`, functions, api, the `db-config` volume (pgsodium key), `backup.env`, `rclone.conf`, crontab, `tailscale serve` JSON, `MANIFEST.sha256` — piped straight into `age -r $AGE_RECIPIENT`; keep 14 | `backups/bundle/<ts>.tar.age` (0600) |
| offsite restore drill (**disabled**) | `offsite-restore-test.sh` | `30 5 * * 0` (commented out) | pulls the newest base + the WAL it needs + the newest hourly dump **from the remote**, restores into throwaways (base+WAL to "latest", dump into vanilla initdb), compares counts; records the download/recovery times = offsite RTO | `status.json` job `offsite-restore-test` |
| offsite status | `offsite-status.sh` | embedded by `backup-status.sh` (`--json`) | per-tier sync age (wal 30 min, dump 2 h, base 26 h, storage 7 h, bundle 26 h), failed runs, cryptcheck mismatches, remote size > 8/9 GB, restore-drill age (8 d), token expiry; prints `offsite: disabled` while off | `logs/offsite-status.log` |

`<ts>` is UTC `YYYYMMDDTHHMMSSZ`. All files 0600 in 0700 directories, owner `lucario`.
Every script has `--help`; the jobs have `--dry-run`. Each job takes a lock
(`backups/.locks/<job>.lock`) so overlapping runs are skipped, not stacked.

## Paths on `lucashome`

```
/srv/supabase/backup/bin/*.sh           scripts (deployed from here; mac-pull.sh is for the Mac and is not deployed)
/srv/supabase/backup/bin/dr-*.sql       the restore gate's checks + post-restore fix-ups; MANIFEST.sha256, PACKAGE (§P)
/srv/supabase/backup/migrations/        supabase/migrations/NNN_*.sql at the deployed commit: the gate's --migrations
/srv/supabase/backup/backup.env         non-secret config (from backup.env.example; never overwritten by deploy.sh)
/srv/supabase/backup/rclone.conf        OWNER-created (OFFSITE-ENABLE.md §3), 0600: R2 token + obscured crypt password/salt — not in git, not deployed
/srv/supabase/backup/rclone.conf.example  the non-secret shape of that file (deployed)
/srv/supabase/backups/
  bundle/<ts>.tar.age   age-encrypted config/secrets bundle (offsite tier; keep 14)
  offsite.json          last run / last success / objects / bytes / mismatches per offsite tier (jobs.wal|dump|base|storage|bundle|check)
  dump/hourly/<ts>/   globals.sql db-settings.sql postgres.dump _supabase.dump counts.json meta.json SHA256SUMS
  dump/daily/<ts>/    hard links of the first successful hourly run of each UTC day
  dump/weekly/<ISO week>_<ts>/   hard links of the first run of each ISO week
  base/<ts>/          base.tar.gz [pg_wal.tar.gz backup_label tablespace_map] backup.json counts.json pgsodium_root.key SHA256SUMS
  restore-test/       temp dirs of the drills (empty when nothing runs)
  config-backup-<ts>/ copy of the db container's config taken before the WAL-archiving change (0600)
/srv/supabase/stack/volumes/db/wal_archive/   WAL archive: <segment>.gz (0640, owner 100:101 = container postgres; host gid 101 includes lucario)
/srv/supabase/stack/volumes/db/custom-conf.d/10-wal-archive.conf, volumes/db/pg_hba.conf   mounted into the db container (override)
  logs/<job>.log      per-job logs (rotated to .1 at 10 MB); logs/cron.log catches anything uncaught
  status.json         last run / last success / result per job (jobs.logical, jobs.base, jobs.restore-test, jobs.status)
```

Promotion uses hard links (`cp -al`): daily/weekly copies cost no space and
survive the hourly prune.

## Base backup methods

`backup-base.sh` uses `BASE_METHOD` (`pg_basebackup` since 2026-10-11; `auto`
would fall back to `sqlapi` when pg_hba forbids replication):

1. **pg_basebackup** (in use) — `pg_basebackup -U supabase_admin -D - -Ft -X fetch
   --checkpoint=fast --manifest-checksums=SHA256` run inside the db container
   over its Unix socket (TCP `localhost` with `POSTGRES_PASSWORD` forwarded
   from `stack/.env` via the environment is the second attempt), gzipped on
   the host; verified by extracting and running `pg_verifybackup` in a
   throwaway container. `backup_label` is kept as a sidecar and `backup.json`
   records `start_wal_file`, `wal_ranges` and the WAL carried in the tar.
   Needs the `replication` lines in `volumes/db/pg_hba.conf` (WAL-ARCHIVING.md §1.3).
2. **sqlapi** (fallback, used before 2026-10-11) — one psql session calls
   `pg_backup_start(label, fast)`; PGDATA is tarred by `docker compose exec db
   tar` (BusyBox tar; excludes `pg_wal/*`, `pg_replslot/*`, `pg_dynshmem/*`,
   `pg_notify/*`, `pg_serial/*`, `pg_snapshots/*`, `pg_stat_tmp/*`,
   `pg_subtrans/*`, `postmaster.pid/.opts`, `log/*`); `pg_backup_stop()`
   returns the `backup_label`; `pg_switch_wal()` closes the last segment and
   every segment from start to stop LSN is copied into `pg_wal.tar.gz`. A
   temporary physical replication slot `sb_backup_<ts>` pins those segments
   during the copy and is dropped afterwards (also by the EXIT trap on
   failure; `backup-status.sh` alerts if one is ever left). Verification:
   `gzip -t`, tar listing contains `PG_VERSION`/`global/pg_control`/`pg_wal/`,
   `backup_label` parses, every needed WAL segment is present and exactly
   `wal_segment_size` bytes. There is no manifest, so `pg_verifybackup` cannot
   run — the weekly physical restore drill is the real proof.

Both layouts are restorable with the steps below; `backup.json.method` says
which one a directory is.

## Restore manually

All commands on `lucashome` in `/srv/supabase/stack` (`docker compose` must run there); `sudo` only
where shown. Pick `SRC` first, e.g. `SRC=/srv/supabase/backups/dump/hourly/<ts>`.

**Restore validation alone never authorizes reopening the API.** The gate only reads; whatever it
answers, the API stays closed until §R, which needs the gate result reviewed, every till reconciled or
quarantined, and a separate owner authorization. Nothing in these scripts reopens anything.

### 0. Before any restore (A, B, B2 and restore-from-email.md): close the API

1. Close every API entry point and confirm it — **before PostgreSQL is restored, stopped or restarted**:
   ```
   sudo /srv/supabase/backup/bin/restore-api-guard.sh close     # must end with "API CLOSED (confirmed)"
   ```
   `close` resets Tailscale Serve/Funnel, stops the gateway (`api-gw`), Studio and every other stack service
   except `db`, then runs `verify`. `verify` exits 1 — **stop, do not touch PostgreSQL** — unless: only `db`
   runs; nothing answers on 127.0.0.1:8000 (gateway) or 127.0.0.1:54323 (Studio); no container publishes those
   ports and no stack container publishes any; `tailscale serve status --json` is readable and empty (no
   tailscale CLI = not confirmed); no foreign container sits on the stack network; the boot unit
   `supabase-stack.service` (H-D3, if ever installed) is not enabled — a reboot would `compose up` the API.
   Stopped containers stay stopped across a reboot (`restart: unless-stopped`, host-reboot-hardening.md D3).
2. Pause the scheduled jobs, so no hourly dump or prune records the half-restored database or rotates good
   sets out: `crontab -l > ~/crontab.restore-$(date -u +%Y%m%dT%H%M%SZ) && crontab -r`.
3. **Disconnect every till from the network now** (Wi-Fi off / cable out, or Tailscale disconnected on the
   device; a Tailscale ACL that blocks the tills works too) and label each one. "Offline" here means *no network
   path*, not only "the server is down": the moment Tailscale Serve is back (§R step 4) every connected till
   would reconnect at once and drain. Since W8/W10 Phase 0 a till no longer fences an operation the server has no
   record of (it holds it for an owner: "Reconciliation required"), keeps a journal of every operation, and pauses
   automatic sync when a full load shows server rows it had loaded are gone — but tills running older builds still
   fence, and the pause needs a full load (restart the app after reconnecting) by the SAME user as the till's last
   load before the restore (a different user, role, shop or permission set is never compared — its view differs).
   The tills keep selling offline; nobody signs a till in, and no till syncs, until §R step 6.
4. The restore tools are complete and the migration source matches (no database access):
   ```
   /srv/supabase/backup/bin/dr-verify-restore.sh preflight --migrations /srv/supabase/backup/migrations --expect-version <NNN>
   ```
   Exit 1 (a `dr-*.sql` missing, no migration source): redeploy from the Mac (§P) first.
5. The backup set itself: `(cd $SRC && sha256sum -c SHA256SUMS)` and, for a dump set,
   `/srv/supabase/backup/bin/dr-verify-restore.sh backup --dir $SRC --expect-version <NNN>` (exit 0). A set older
   than 26 h fails as STALE: add `--accept-stale` only after deciding to lose everything after it (write it down).

**Starting containers during a restore:** only the database, only with `--no-deps`
(`restore-api-guard.sh start-db` = `docker compose up -d --no-deps db` + `verify`). A plain `docker compose up`
honours `depends_on`, and `functions` depends on `api-gw`: `up -d <anything but api-gw>` still starts the
gateway (reproduced by `tests/dr/api-isolation-test.sh`). Run `restore-api-guard.sh verify` after every
PostgreSQL start or restart.

### A. Logical restore into the running stack (schema/data loss, same major version)

Use when PGDATA is healthy but data must be rolled back to an hourly point.
This **replaces** the contents of the `postgres` database.

1. §0 (API closed and confirmed, cron paused, tills offline, preflight, backup set verified).
2. Take a safety dump first: `/srv/supabase/backup/bin/backup-logical.sh --no-prune`.
3. Roles and settings (idempotent, errors about existing roles are expected):
   ```
   docker compose exec -T db psql -X -U supabase_admin -d postgres -f - </dev/null < $SRC/globals.sql
   ```
4. Recreate the database from the dump (the dump was taken with `--create`; §0 already stopped every
   service that holds connections, but background workers such as pg_cron's launcher still hold one — block
   new connections and terminate them, or the rename fails; this is the sequence the drill runs):
   ```
   docker compose exec -T db psql -X -U supabase_admin -d template1 -v ON_ERROR_STOP=1 \
     -c "ALTER DATABASE postgres ALLOW_CONNECTIONS false" \
     -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid()" \
     -c "ALTER DATABASE postgres RENAME TO postgres_broken_$(date -u +%Y%m%dT%H%M%SZ)" </dev/null
   docker compose exec -T db pg_restore -U supabase_admin -d template1 --create --exit-on-error /dev/stdin < $SRC/postgres.dump
   docker compose exec -T db psql -X -U supabase_admin -d postgres -f - </dev/null < $SRC/db-settings.sql
   ```
   `_supabase` (analytics/supavisor metadata, no business data) the same way
   from `_supabase.dump` if it is also lost.
5. Post-restore fix-ups (a logical restore loses the USAGE grants on the extension schemas
   `graphql`/`graphql_public`; found by the DR drill):
   ```
   docker compose exec -T db psql -X -U supabase_admin -d postgres -f - </dev/null < /srv/supabase/backup/bin/dr-restore-fixups.sql
   ```
6. Still closed: `sudo /srv/supabase/backup/bin/restore-api-guard.sh verify` (exit 0). No other service is started.
7. The gate (read-only; nothing is started or exposed by it):
   ```
   /srv/supabase/backup/bin/dr-verify-restore.sh restore --compose-dir /srv/supabase/stack --expect-version <NNN> \
     --migrations /srv/supabase/backup/migrations --accept-no-reference --counts $SRC/counts.json \
     --storage-dir /srv/supabase/stack/volumes/storage | tee ~/restore-gate-$(date -u +%Y%m%dT%H%M%SZ).log
   echo "gate exit ${PIPESTATUS[0]}"          # the gate's status, not tee's
   ```
   Exit 0 `HEALTHY` needs a `--reference` (only a drill has one). For a lost source the best verdict is exit 3
   `ACCEPTED-WITHOUT-REFERENCE`: per-table row counts and every invariant passed, content was **not** compared
   (disaster-recovery.md §5). Exit 1 `FAILED`/`INCONCLUSIVE`: keep the API closed and investigate
   (disaster-recovery.md §5.3). A FAILED log that contains `NOTE  COUNTS-ONLY` failed **only** the counts
   comparison (every backup made before 2026-10-18 has no per-table counts; a PITR legitimately changes
   them) — the one exit 1 the owner may override, after §5.3, in writing (§R). Exit 2: a usage error —
   nothing was checked.
8. Review the results (owner): the saved gate log, every `FAIL`/`NOTE` line, the `info:` totals of
   `dr-financial-checks.sql` against the last daily report. Write down the decision.
9. Tills: every till reconciled or quarantined (disaster-recovery.md §6). None has synced yet.
10. Separate owner authorization, then §R. Drop `postgres_broken_*` once satisfied.

Single-table recovery: `docker compose exec -T db pg_restore -U supabase_admin -d postgres -t <table>
--data-only /dev/stdin < $SRC/postgres.dump` (add `-n <schema>`), or restore
the whole dump into a throwaway (see C) and copy rows across with `psql \copy`.
A single-table restore into the live database is still a restore: §0 first, §R after; its counts check
FAILs by design (the other tables keep their newer rows) and can only be overridden as COUNTS-ONLY.

### B. Physical restore (PGDATA lost or corrupt) — 07 §5.1

`SRC=/srv/supabase/backups/base/<ts>`; read `$SRC/backup.json`.

1. §0 (API closed and confirmed **before** the database is touched, cron paused, tills offline, preflight;
   for a base set `(cd $SRC && sha256sum -c SHA256SUMS)`). Then stop the database and confirm it is still closed:
   ```
   docker compose stop db
   sudo /srv/supabase/backup/bin/restore-api-guard.sh verify      # exit 0: nothing runs, nothing answers
   ```
2. Move the broken directory aside — it is owned by uid 100, so do it from a container:
   ```
   docker run --rm --network none -v /srv/supabase/stack/volumes/db:/db --entrypoint sh supabase/postgres:17.6.1.136 \
     -c 'mv /db/data /db/data.broken.$(date -u +%Y%m%dT%H%M%SZ) && mkdir -m 0700 /db/data && chown 100:101 /db/data'
   ```
3. Extract (as `lucario`, into a staging dir, then let a container move it in with the right owner):
   ```
   STAGE=/srv/supabase/backups/restore-test/manual-$(date -u +%Y%m%dT%H%M%SZ); mkdir -m 0700 -p $STAGE/pgdata
   tar -xzf $SRC/base.tar.gz -C $STAGE/pgdata
   # sqlapi-method backups only (backup.json.method == "sqlapi"):
   mkdir -p $STAGE/pgdata/pg_wal/archive_status $STAGE/pgdata/pg_wal/summaries
   tar -xzf $SRC/pg_wal.tar.gz -C $STAGE/pgdata/pg_wal
   cp $SRC/backup_label $STAGE/pgdata/;  [ -f $SRC/tablespace_map ] && cp $SRC/tablespace_map $STAGE/pgdata/
   rm -f $STAGE/pgdata/postmaster.pid $STAGE/pgdata/postmaster.opts
   docker run --rm --network none -v $STAGE/pgdata:/src -v /srv/supabase/stack/volumes/db/data:/dst \
     --entrypoint sh supabase/postgres:17.6.1.136 -c 'cp -a /src/. /dst/ && chown -R 100:101 /dst && chmod 0700 /dst'
   rm -rf $STAGE
   ```
   For PITR add `recovery.signal` and `restore_command` here — B2.
4. If the `db-config` volume was lost too, the pgsodium key goes back **after step 5** (the `exec` needs a
   running container), then the database is stopped and started again the same way:
   ```
   docker compose cp $SRC/pgsodium_root.key db:/etc/postgresql-custom/pgsodium_root.key
   docker compose exec -T db sh -c 'chown postgres:postgres /etc/postgresql-custom/pgsodium_root.key && chmod 0600 /etc/postgresql-custom/pgsodium_root.key' </dev/null
   docker compose stop db && sudo /srv/supabase/backup/bin/restore-api-guard.sh start-db
   ```
   Without it vault secrets are unreadable.
5. Start **only** the database (`--no-deps`; nothing that depends on it, no gateway) and confirm closure:
   ```
   sudo /srv/supabase/backup/bin/restore-api-guard.sh start-db    # up -d --no-deps db, wait, verify; exit 0
   docker compose logs db | grep -E 'backup recovery|ready to accept'
   ```
   Expect `starting backup recovery with redo LSN …`, `completed backup recovery …`, `database system is ready`.
6. The gate, as A step 7 (`--accept-no-reference --counts $SRC/counts.json`; a physical restore keeps the
   extension-schema grants, no fix-ups needed). The base's counts match only a restore to the base's own end
   point; after WAL replay (B2, or "replay everything") they legitimately differ and the counts check FAILs.
   Only a `NOTE  COUNTS-ONLY` result (every other check passed) may then be overridden by the owner after
   disaster-recovery.md §5.3 — never a tolerance, never any other failure.
7. Review (A step 8), tills reconciled or quarantined (A step 9), separate owner authorization, then §R.

### B2. Point-in-time recovery (bad migration / accidental delete) — 07 §5.2

Exactly B — §0 first, the API closed and confirmed before the database is stopped, `start-db` (never a
plain `up`), the gate, the review, the tills, the owner authorization, §R — with one addition: before
B step 5 add to the new PGDATA (owned by uid 100, so through a container as in B step 3):

```
P=$(mktemp); cat > $P <<'EOF'
restore_command = 'gzip -dc /var/lib/postgresql/wal_archive/%f.gz > %p'
recovery_target_time = '2026-10-11 23:58:27+00'
recovery_target_action = 'promote'
EOF
#   recovery_target_time: the last good moment, UTC; delete that line for "replay everything"
docker run --rm --network none -v $P:/pitr.conf:ro -v /srv/supabase/stack/volumes/db/data:/d --entrypoint sh supabase/postgres:17.6.1.136 \
  -c 'cat /pitr.conf >> /d/postgresql.auto.conf && : > /d/recovery.signal && chown 100:101 /d/postgresql.auto.conf /d/recovery.signal'
rm -f $P
```

Postgres replays the base's own WAL, then every archived segment through the
target, logs `recovery stopping before commit of transaction …`, promotes to a
new timeline and accepts connections. `pitr-test.sh` performs exactly this in
a throwaway (see its log for the expected lines). Any retained base backup
works as the starting point as long as the archive is unbroken from the
segment after the base's own WAL to the target (`backup-status.sh` checks
that for the oldest base, and reports gaps).

### R. Reopening the API — manual, owner-authorised, never automatic

Documented here; run only by the owner, by hand, after all four preconditions are written down in the
restore record:

- the gate's exit status and log: `0 HEALTHY`, or `3 ACCEPTED-WITHOUT-REFERENCE` explicitly accepted by the
  owner, or — the only exception — exit 1 whose log carries `NOTE  COUNTS-ONLY`, after the investigation of
  disaster-recovery.md §5.3 and an explicit written owner override. Any other exit 1 (an invariant, the
  ledger or its checksums, the schema version, storage, a failed query, INCONCLUSIVE) or exit 2 never reopens;
- the results reviewed (A step 8);
- every till reconciled or quarantined (disaster-recovery.md §6), and every till still disconnected (§0 step 3);
- a **separate** owner authorization to reopen, given after the three above (not the approval to restore).

Steps:

1. `sudo /srv/supabase/backup/bin/restore-api-guard.sh verify` — still closed (nothing reopened behind your back).
2. The services behind the gateway, without the gateway (`--no-deps`; not `functions`, not `studio`):
   ```
   docker compose up -d --no-deps auth rest meta realtime imgproxy storage && docker compose ps
   ```
3. The gateway and functions, on loopback only, then a local probe:
   ```
   docker compose up -d --no-deps api-gw functions
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/rest/v1/     # 403 "RBAC: access denied" = gateway up
   ```
4. Expose it on the tailnet (never funnel, 04 D16): `sudo tailscale serve --bg --https=443 http://127.0.0.1:8000`.
5. Owner signs in as ADMIN (existing authenticator app) and checks a few records.
6. Reconnect tills **one at a time** (each was disconnected in §0 step 3), in the order disaster-recovery.md
   §6 sets: reconciled tills first; a quarantined till stays disconnected until its queue has been resolved.
   A reconnecting till drains its queue; an in-doubt operation the restored server has no record of is held as
   "Reconciliation required" (never fenced automatically, Phase 0) — decide each one with Sync › Stop on server (after
   checking it did not happen) or re-enter it. If the till shows "Automatic sync is paused", export (owner: the
   export carries the till's journal) before acknowledging. Tills on builds before Phase 0 still fence on their first
   drain (W10): their reconciliation record must list every in-doubt entry first.
7. Backups back on: `crontab ~/crontab.restore-<ts>`, then `backup-logical.sh` once by hand and
   `backup-status.sh` → OK. Studio only when needed (`docker compose up -d --no-deps studio`, SSH tunnel).
   If `supabase-stack.service` was disabled for the restore, re-enable it.

### P. Packaging the restore tools (Mac)

`./deploy.sh` copies the package to `/srv/supabase/backup/bin/` and the migration source the gate needs to
`/srv/supabase/backup/migrations/` (`supabase/migrations/NNN_*.sql` at the deployed commit; the server has no
repo checkout). It stages the package locally first and refuses — before any `ssh` — when a file listed in
`deploy-manifest.txt` is missing or empty (every `dr-*.sql` the gate opens, `dr-restore-fixups.sql`,
`restore-api-guard.sh`, …), when the filter would pick up an unlisted file, or when no migrations are found.
After the copy it re-verifies `bin/MANIFEST.sha256` and `migrations/SHA256SUMS` on the server and runs the
gate's `preflight` there. `bin/PACKAGE` records the commit. `./deploy.sh --package-to DIR` builds and verifies
the same package locally without contacting the server (`tests/dr/packaging-test.sh`).

### C. Inspect a backup without touching the stack

`restore-test.sh --logical-only --dump <dir>` or `--physical-only --base <dir>`
with `--keep-on-failure` leaves the throwaway running on failure; or do what the
script does by hand: `docker run --rm -d --name sb-restore-test-manual --network none --memory 1g …`
(see `tw_start` in `backup-lib.sh`), then `docker exec sb-restore-test-manual psql -U supabase_admin`.
Always remove the container and the temp dir afterwards; `backup-status.sh`
flags leftovers.

### D. Full DR drill (disposable, read-only on live)

```
mac$ ssh lucashome 'mkdir -m 0700 -p ~/phf-drill/bin ~/phf-drill/input' </dev/null
mac$ scp deploy/lucashome/backup/{dr-drill.sh,dr-drill-*.sql,backup-lib.sh,email-lib.sh,email-archive.sh,email-mime.py,email-unpack.py} \
         tools/selfhost-migration/{verify_objects.py,_common.py} lucashome:phf-drill/bin/
mac$ scp <export>/storage-manifest.sha256 lucashome:phf-drill/input/          # hashes only
ls$  ~/phf-drill/bin/dr-drill.sh run            # ~70 s today; needs >= 3.5 GB available, port 18000 free
ls$  cut -f1,2,4,5 ~/phf-drill/results/results.tsv; cat ~/phf-drill/results/timings.tsv
ls$  ~/phf-drill/bin/dr-drill.sh cleanup        # removes containers, networks, volumes and ~/phf-drill
```

Configuration is by environment (`DRILL_PORT`, `DRILL_MEM_*`, `IMG_*`, `PITR_EVENTS_SQL`,
`PITR_PROBE_SQL`, `PITR_EXPECT`; see the script header). The PITR defaults target the three
transactions of the 080 rollout; once the base backup before 080 is pruned (14 days), point
`PITR_EVENTS_SQL`/`PITR_EXPECT` at newer real events.

## Retention math

- Base backups: `KEEP_BASE=14` daily → the oldest retained base is 13–14 days old.
- WAL archive: `backup-prune.sh` deletes only segments whose name sorts below
  the `START WAL LOCATION` segment of the **oldest retained base** (read from
  `backup.json.start_wal_file`, else `backup_label`). Everything from that
  segment onward is kept, so every retained base can be rolled forward to any
  later instant: PITR window ≈ 14 days, identical to the base retention. The
  cutoff moves forward only when the oldest base is pruned, and never past a
  base that is still on disk; with no base on disk nothing in the archive is
  touched. `*.history` files are always kept; `*.backup` history files follow
  their segment; stale `*.gz.tmp` (> 1 h) are removed. The sqlapi-era base
  carries its own `pg_wal.tar.gz`, so the archive only has to start at the
  segment *after* its last included one — `backup-status.sh` checks exactly that.
- Size: an idle segment compresses to ~17–25 KB; with `archive_timeout=300`
  that is ≤ 288 files/day ≈ 5–7 MB/day idle, 16 MiB per segment uncompressed
  under heavy write load (worst case 4.5 GB/day). The archive is counted in
  `backup-status.sh` ("wal archive dir: … files= size= range=").
- Dumps: hourly 48 (2 days), daily 14, weekly 8 — hard links, so a daily/weekly
  copy costs no space while the hourly original exists.

## Verify

- `backup-status.sh` — the summary (last success, age, size, duration, counts
  on disk, free space, leftovers, WAL archiver state) and exit code 0/1.
  Thresholds: logical 2 h, base 26 h, restore-test 8 d, free space 20 GB,
  archive lag 10 min (`MAX_ARCHIVE_LAG_S`). Archive checks: `archive_mode=on`;
  `pg_stat_archiver.last_failed_time` newer than the last success → problem
  (an older failure with later successes is only a note; clear it with
  `select pg_stat_reset_shared('archiver')`); unarchived segments (`.ready`)
  older than 10 min → problem; `last_archived_time` older than 10 min →
  problem when segments are pending, otherwise shown as "idle" (Postgres only
  switches on `archive_timeout` after WAL activity); segment-sequence gaps on
  the current timeline → problem; the oldest retained base's first needed
  archive segment missing → problem. Runs every 30 min from cron;
  the summary is appended to `logs/backup-status.log`. Set `HEALTHCHECKS_URL`
  in `backup.env` to get an external dead-man alert (it pings `<url>` on OK and
  `<url>/fail` otherwise).
- `jq . /srv/supabase/backups/status.json` — machine-readable state.
- `restore-test.sh` — run it any time; it never touches the stack
  (throwaway containers `sb-restore-test-*`, `--network none`, no ports,
  `--memory 1g`, temp dirs under `backups/restore-test/`, removed by trap).
- Per-run checks are in the logs: `pg_restore -l` TOC counts and size deltas in
  `backup-logical.log`; method, LSNs, WAL files and verification in
  `backup-base.log` / `base/<ts>/backup.json`; count tables and Postgres
  recovery lines in `restore-test.log`.

## Offsite tier (Phase F) — deployed disabled

Design: `docs/selfhost-migration/phase-f/proposal.md`. Copy of record on
Cloudflare R2 through an rclone **crypt** remote (`offsite:` over
`r2:shwephala-backups`; file and directory names encrypted, key material only
in `rclone.conf` on `lucashome` and in the owner's password manager); second
tier on the owner's Mac, pulled over Tailscale with `rrsync -ro` keys
(MAC-TIER.md). Everything is gated by `OFFSITE_ENABLED` in `backup.env`:

```
ls$ /srv/supabase/backup/bin/offsite-sync.sh wal        # -> "offsite disabled (OFFSITE_ENABLED=false ...)", exit 0
```

| Remote prefix | Source | Cadence | Mechanism | Versions |
|---|---|---|---|---|
| `wal/` | `stack/volumes/db/wal_archive/` | 15 min (`copy --no-traverse --max-age 24h`) + daily full `sync --min-age 10m` | `--size-only --use-server-modtime` (segments are immutable) | none (mirrors the local prune) |
| `dump/` | `backups/dump/{hourly,daily,weekly}` | hourly | `sync --size-only` | none (proposal §3.3) |
| `base/` | `backups/base/` | daily | `sync --size-only --backup-dir .versions/base/<date>` | 30 d |
| `storage/` | `stack/volumes/storage/` | 6 h | `sync --backup-dir .versions/storage/<date>` (size+modtime) | 30 d |
| `bundle/` | `backups/bundle/*.tar.age` | daily (built first) | `sync --size-only --backup-dir .versions/bundle/<date>` | 30 d |
| `.versions/` | — | daily `check` | purge `<tier>/<YYYYMMDD>` older than `OFFSITE_VERSIONS_KEEP_DAYS` (by name) | — |
| `golden/` | hosted snapshot | once, by hand | `rclone copy` | never touched |

Every tier is verified with `rclone cryptcheck` right after its sync (the
`check` tier repeats it for everything daily and records `rclone size`).
Config keys: see the offsite block of `backup.env.example`
(`OFFSITE_ENABLED`, `RCLONE_CONFIG`, `OFFSITE_REMOTE`, `AGE_RECIPIENT`,
`HEALTHCHECKS_OFFSITE_URL`, `HEALTHCHECKS_OFFSITE_RESTORE_URL`, limits and
thresholds). Scripts: `offsite-lib.sh` (gate, rclone wrappers, cryptcheck
parsing, `offsite.json`, healthchecks), `offsite-sync.sh`,
`secrets-bundle.sh`, `offsite-restore-test.sh`, `offsite-status.sh`,
`mac-pull.sh` + `com.shwephala.backup-pull.plist` (Mac only),
`rclone.conf.example`. Enabling, first sync, verification, rotation and the
recovery procedures: **OFFSITE-ENABLE.md**.

Tested without credentials (2026-10-12, Linux container with rclone 1.68 /
age 1.2.1 against a local-backend crypt remote): disabled gate on every
script, fail-closed on missing `rclone.conf` / `age` / `AGE_RECIPIENT`,
`--dry-run` of every tier, file selection (no `.tmp`/`.partial`/dotfiles,
hard-linked daily/weekly dumps become objects), `--backup-dir` layout,
`.versions` purge by date, cryptcheck detecting a corrupted object, bundle
round-trip (decrypt + `MANIFEST.sha256`), bundle retention, status
thresholds. shellcheck clean.

**Superseded (2026-10-13):** the owner chose email as the offsite channel; the
R2/Mac tier above stays in the repo, disabled and unused.

## Email tier (Phase F) — prepared, not deployed

Design, sizes, owner checklist: `docs/selfhost-migration/phase-f/email-backup-design.md`;
restore runbook: `docs/selfhost-migration/phase-f/restore-from-email.md`.
Everything is gated by `EMAIL_ENABLED` (and `EMAIL_REPORT_ENABLED`) in `backup.env`:
while false the scripts exit 0 with "email tier disabled" and `backup-status.sh`
only gains the line `email tier: disabled`.

| Script | What | Cadence (commented in `crontab.lucario`) |
|---|---|---|
| `email-archive.sh` | weekly encrypted recovery archive (dumps, roles, storage files, functions, config, manifest) → gpg to the owner's public key → 15 MiB parts → one mail per part; resume-aware, idempotent per week; `--selftest [--selftest-parts N] [--selftest-mib M]` sends synthetic content only (single part or forced multipart) | Sun 04:30 UTC (+06:30 resume) |
| `email-secrets.sh` | separate gpg-encrypted `.env` + pgsodium key + backup config; kept locally, mailed only in `EMAIL_SECRETS_MODE=email` and only on change | Sun 04:40 UTC |
| `email-report.sh` (+ `.sql`, `.py`) | daily per-organization business report (read-only SQL) with a backup-health block | 01:00 UTC (+03:00 retry) |
| `email-status.sh` | email-tier health for `backup-status.sh` | embedded |
| `email-unpack.py` | owner side: reassemble + verify the parts from `.eml`/mbox | — |
| `gmail-oauth-mint.py` | owner's Mac: mint the `gmail.send`-only OAuth credential (`gmail-oauth.json`, 0600) for `MAIL_TRANSPORT=gmail-api`; on the server `--check FILE` does one token refresh and prints only scope/expiry | by hand |
| `email-archive.sh --no-send [--output-dir DIR]` | drills/tests: build + encrypt + split exactly like a real run, never send or alert, not gated by `EMAIL_ENABLED`, status job `email-archive-nosend` | by hand (`dr-drill.sh`) |

Transports (`MAIL_TRANSPORT`): `gmail-api` (Gmail API `users.messages.send`, OAuth scope
`gmail.send` only, from a dedicated sender Gmail; recommended without a domain), `resend`, `smtp`.
Credentials live in `/srv/supabase/backup/credentials/` (0600, owned by the backup user; refused
otherwise) and never appear in argv, logs or status. A broken Gmail token fails closed with
`gmail oauth token invalid — owner must re-mint`; no alert can travel that path, so a missing Sunday
archive / daily report and the `backup-status.sh` PROBLEM line are the dead-man signals.

Tests: `tests/email/run.sh` (Docker, synthetic data only; 340 checks: 210 for T1–T15 incl. `--no-send`,
130 for T16 Gmail API against a local mock of Google; `PHF_PREFIX=phf-gm` names the containers).

## Restore gate and disposable DR drill (2026-10-18)

- `dr-verify-restore.sh` — the gate between "PostgreSQL started" and "this restore may serve tills":
  `backup --dir SET` (checksums, components, readable archives, age, schema version inside the dump),
  `fingerprint` (rows + schema of a source), `restore` (fingerprint equality, every invariant of
  `dr-drill-consistency.sql` and `dr-financial-checks.sql`, migration ledger exactly the repo's versions,
  schema version, storage bytes). Prints `RESULT: HEALTHY`, `ACCEPTED-WITHOUT-REFERENCE`, `INCONCLUSIVE` or
  `FAILED … keep the API closed` (with `NOTE  COUNTS-ONLY` when only the counts comparison failed, the run was
  not INCONCLUSIVE and no table that had rows is now empty — an emptied table is lost data, never COUNTS-ONLY).
  SQL: `dr-schema-fingerprint.sql` (effective grants, functions, constraints, policies, roles …),
  `dr-financial-checks.sql` (payments vs purchase orders, isolation, stock arithmetic, 086 ledger rules),
  `dr-restore-fixups.sql` (after a logical restore: the extension schemas' grants). Without a reference the
  gate answers INCONCLUSIVE, never HEALTHY by default. Exit codes: 0 HEALTHY, 3 ACCEPTED-WITHOUT-REFERENCE
  (counts + invariants, content not compared), 1 FAILED/INCONCLUSIVE, 2 usage (also `-h`). `preflight` checks
  its SQL, tools and migration source without touching a database; `restore` runs the same check first.
  Counts are compared for equality; `--count-tolerance N` (non-negative integer, else exit 2) applies only to
  GoTrue's session-churn tables (`auth.sessions`, `auth.refresh_tokens`, `auth.audit_log_entries`,
  `auth.flow_state`, `auth.one_time_tokens`, `auth.mfa_challenges`, `auth.mfa_amr_claims`) and is reported
  when used. A failed or empty query is a FAIL.
- `restore-api-guard.sh close|verify|start-db` — keeps every API entry point closed during a restore (§0);
  it has no reopen command (§R is manual).
- `tests/dr/run.sh 085|086` — disposable drill: synthetic organisations through the real RPCs, the real
  `backup-logical.sh` and `email-archive.sh --no-send`, the source destroyed, restores into fresh servers
  from the local dump set and from the offsite copy alone, backup and restore fault injection, app checks
  through a fresh PostgREST. `tests/dr/run.sh tills` — offline tills vs a server restored to an older backup.
  Assessment and results: `docs/selfhost-migration/phase-g/disaster-recovery.md`.
- Seconds-long checks without a stack: `tests/dr/gate-unit-test.sh` (gate decisions through a fake `docker`),
  `tests/dr/packaging-test.sh` (deploy.sh package, local only), `tests/dr/runbook-check.sh` (runbook order:
  API closed before PostgreSQL is touched, `--no-deps`, no till sync or reopening before §R).
  `tests/dr/api-isolation-test.sh`: the guard against a disposable local compose model of the stack.
- The backup jobs (`backup-logical.sh`, `backup-base.sh`, `email-archive.sh`) exit through their cleanup on
  TERM/INT/HUP too (and the cleanup ignores further signals): a killed run leaves no `.partial` output and
  is recorded as failed.

## Known limitations / open items

- RPO: bounded by `archive_timeout=300` plus archive time (measured 113–223 ms
  for a forced switch on 2026-10-11, see WAL-ARCHIVING.md §6); the owner
  decides whether that demonstrates the 5-minute target.
- Restarting the db container makes Realtime crash and be restarted by its
  Docker restart policy (observed 2026-10-11: `restarts=1`, healthy again
  within seconds); PostgREST/GoTrue/Storage reconnect in place.
- The Envoy gateway answers `403 RBAC: access denied` on the bare `/rest/v1/`
  root; use a table path (e.g. `/rest/v1/<table>?select=*`) to probe PostgREST.
- `counts.json` is captured a moment before the dump starts, not inside the
  dump's snapshot; under write load the row counts can differ by the writes of
  that second. `RESTORE_COUNT_TOLERANCE` (default 0, `restore-test.sh` only) absorbs that if it ever bites;
  table counts must always match exactly. The restore gate is stricter: only the session-churn tables above
  may use `--count-tolerance`; a business-table difference FAILs and is investigated
  (disaster-recovery.md §5.3), never tolerated.
- The offsite tier is built and deployed but **disabled** until the owner
  completes OFFSITE-ENABLE.md (R2 bucket, token, rclone crypt config, age key,
  healthchecks); until then everything is local to `lucashome`'s `/srv` disk.
- The `_supabase` database holds only `_analytics`/`_supavisor` metadata; it is
  dumped for completeness.
- `restore-test.sh` restores the dumps into a **vanilla** initdb of the same
  image (empty `/docker-entrypoint-initdb.d`), which proves the dumps are
  self-contained; the only expected error is `role "supabase_admin" already exists`
  (bootstrap superuser). Any other error fails the drill.
