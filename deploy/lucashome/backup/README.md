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

All commands as `lucario` on `lucashome`. `docker compose` must be run in
`/srv/supabase/stack`. Pick `SRC` first, e.g.
`SRC=/srv/supabase/backups/dump/hourly/<ts>` and check it:
`(cd $SRC && sha256sum -c SHA256SUMS)`.

### A. Logical restore into the running stack (schema/data loss, same major version)

Use when PGDATA is healthy but data must be rolled back to an hourly point.
This **replaces** the contents of the `postgres` database.

1. Freeze writes: stop the API path (owner: `docker compose stop api-gw` or
   `tailscale serve reset`), confirm tills are in offline mode.
2. Take a safety dump first: `/srv/supabase/backup/bin/backup-logical.sh`.
3. Roles and settings (idempotent, errors about existing roles are expected):
   ```
   docker compose exec -T db psql -X -U supabase_admin -d postgres -f - </dev/null < $SRC/globals.sql
   ```
4. Recreate the database from the dump (the dump was taken with `--create`):
   ```
   docker compose stop auth rest storage realtime functions meta studio   # owner; they hold connections
   docker compose exec -T db psql -X -U supabase_admin -d template1 -c "alter database postgres rename to postgres_broken_$(date -u +%Y%m%dT%H%M%SZ)" </dev/null
   docker compose exec -T db pg_restore -U supabase_admin -d template1 --create --exit-on-error /dev/stdin < $SRC/postgres.dump
   docker compose exec -T db psql -X -U supabase_admin -d postgres -f - </dev/null < $SRC/db-settings.sql
   docker compose up -d
   ```
   `_supabase` (analytics/supavisor metadata, no business data) the same way
   from `_supabase.dump` if it is also lost.
5. Validate: counts vs `$SRC/counts.json`
   (`docker compose exec -T db psql -U supabase_admin -d postgres -Atc "<COUNTS_SQL from backup-lib.sh>" </dev/null`),
   log in with a till, then drop `postgres_broken_*` once satisfied.

Single-table recovery: `pg_restore -U supabase_admin -d postgres -t <table>
--data-only /dev/stdin < $SRC/postgres.dump` (add `-n <schema>`), or restore
the whole dump into a throwaway (see C) and copy rows across with `psql \copy`.

### B. Physical restore (PGDATA lost or corrupt) — 07 §5.1

`SRC=/srv/supabase/backups/base/<ts>`; read `$SRC/backup.json`.

1. Owner: `docker compose stop db` (the other services will error until db is back; tills keep selling offline).
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
   For PITR (after WAL archiving exists) add `recovery.signal` and
   `restore_command` here — WAL-ARCHIVING.md §3.
4. If the `db-config` volume was lost too, put `$SRC/pgsodium_root.key` back:
   `docker compose cp $SRC/pgsodium_root.key db:/etc/postgresql-custom/pgsodium_root.key`
   then fix ownership inside the container (`chown postgres:postgres`, `chmod 0600`). Without it vault secrets are unreadable.
5. Owner: `docker compose up -d db`, then `docker compose logs db | grep -E 'backup recovery|ready to accept'`.
   Expect `starting backup recovery with redo LSN …`, `completed backup recovery …`, `database system is ready`.
6. `docker compose up -d` for the rest; validate counts against `$SRC/counts.json`
   and against the newest hourly dump (which is more recent than the base backup).

### B2. Point-in-time recovery (bad migration / accidental delete) — 07 §5.2

Same as B, but before starting `db` (step 5) add to the new PGDATA:

```
: > /srv/supabase/stack/volumes/db/data/recovery.signal           # via the same container trick as step 3 (owner 100:101)
cat >> .../data/postgresql.auto.conf <<'EOF'
restore_command = 'gzip -dc /var/lib/postgresql/wal_archive/%f.gz > %p'
recovery_target_time = '2026-10-11 23:58:27+00'    # the last good moment, UTC; omit for "replay everything"
recovery_target_action = 'promote'
EOF
```

Postgres replays the base's own WAL, then every archived segment through the
target, logs `recovery stopping before commit of transaction …`, promotes to a
new timeline and accepts connections. `pitr-test.sh` performs exactly this in
a throwaway (see its log for the expected lines). Any retained base backup
works as the starting point as long as the archive is unbroken from the
segment after the base's own WAL to the target (`backup-status.sh` checks
that for the oldest base, and reports gaps).

### C. Inspect a backup without touching the stack

`restore-test.sh --logical-only --dump <dir>` or `--physical-only --base <dir>`
with `--keep-on-failure` leaves the throwaway running on failure; or do what the
script does by hand: `docker run --rm -d --name sb-restore-test-manual --network none --memory 1g …`
(see `tw_start` in `backup-lib.sh`), then `docker exec sb-restore-test-manual psql -U supabase_admin`.
Always remove the container and the temp dir afterwards; `backup-status.sh`
flags leftovers.

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
| `email-archive.sh` | weekly encrypted recovery archive (dumps, roles, storage files, functions, config, manifest) → gpg to the owner's public key → 15 MiB parts → one mail per part; resume-aware, idempotent per week; `--selftest` sends synthetic content only | Sun 04:30 UTC (+06:30 resume) |
| `email-secrets.sh` | separate gpg-encrypted `.env` + pgsodium key + backup config; kept locally, mailed only in `EMAIL_SECRETS_MODE=email` and only on change | Sun 04:40 UTC |
| `email-report.sh` (+ `.sql`, `.py`) | daily per-organization business report (read-only SQL) with a backup-health block | 01:00 UTC (+03:00 retry) |
| `email-status.sh` | email-tier health for `backup-status.sh` | embedded |
| `email-unpack.py` | owner side: reassemble + verify the parts from `.eml`/mbox | — |

Tests: `tests/email/run.sh` (Docker, synthetic data only; 194 checks).

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
  that second. `RESTORE_COUNT_TOLERANCE` (default 0) absorbs that if it ever bites;
  table counts must always match exactly.
- The offsite tier is built and deployed but **disabled** until the owner
  completes OFFSITE-ENABLE.md (R2 bucket, token, rclone crypt config, age key,
  healthchecks); until then everything is local to `lucashome`'s `/srv` disk.
- The `_supabase` database holds only `_analytics`/`_supavisor` metadata; it is
  dumped for completeness.
- `restore-test.sh` restores the dumps into a **vanilla** initdb of the same
  image (empty `/docker-entrypoint-initdb.d`), which proves the dumps are
  self-contained; the only expected error is `role "supabase_admin" already exists`
  (bootstrap superuser). Any other error fails the drill.
