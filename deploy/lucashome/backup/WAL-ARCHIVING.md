# WAL archiving for the `lucashome` Supabase stack — proposed change set

Status: **APPLIED 2026-10-11 23:49 UTC** with owner approval (one controlled
`docker compose up -d db`). §1–§4 are the change set as proposed; §6 records
what was actually done, measured results and the deviations from the proposal.

Why: today's backups give RPO = 1 hour (hourly logical dump) and a daily
physical base backup. The design target in
`docs/selfhost-migration/07-backup-disaster-recovery.md` is RPO <= 5 minutes,
which needs continuous WAL archiving plus point-in-time recovery (PITR). The
same change also unblocks `pg_basebackup`/`pg_verifybackup` (see §1.3).

Verified facts about the running stack (2026-10-11):

| Item | Value |
|---|---|
| Image | `supabase/postgres:17.6.1.136`, PostgreSQL 17.6, container user `postgres` = uid 100 / gid 101 |
| Config file | `/etc/postgresql/postgresql.conf` (from the image; compose `command: postgres -c config_file=/etc/postgresql/postgresql.conf -c log_min_messages=fatal`) |
| Custom-settings mechanism | `postgresql.conf` ends with `include_dir = '/etc/postgresql-custom/conf.d'`; `/etc/postgresql-custom` is the named volume `supabase_db-config` (contains `conf.d/`, `pgsodium_root.key`). Any `*.conf` dropped in `conf.d/` is loaded after the main file (this answers the **U** item in 07 §3.1) |
| Current settings | `wal_level = logical` (already what archiving needs), `archive_mode = off`, `max_wal_senders = 10`, `wal_segment_size = 16MB`, `wal_keep_size = 0` |
| pg_hba.conf | `/etc/postgresql/pg_hba.conf` from the image. Has `local all supabase_admin trust` and `host all all 127.0.0.1/32 trust`, but **no `replication` line**, and in pg_hba the database keyword `all` never matches replication connections. This is why `pg_basebackup` fails today with `FATAL: no pg_hba.conf entry for replication connection from host "[local]"/"127.0.0.1", user "supabase_admin"` |
| Tools in the image | `pg_basebackup`, `pg_verifybackup`, `pg_waldump`, `gzip`, `cp` present; `tar` is BusyBox |
| Roles | `supabase_admin` is SUPERUSER + REPLICATION; `postgres` has REPLICATION but is not superuser |

## 1. Change set

### 1.1 Host directory for the archive (owned by uid 100)

The container writes archived segments as `postgres` (uid 100). `lucario` has no
sudo, so the directory must be created with the right owner **from inside a
container** (root in a container may chown a bind mount):

```
ls$ mkdir -p /srv/supabase/stack/volumes/db/wal_archive
ls$ docker run --rm --network none -v /srv/supabase/stack/volumes/db/wal_archive:/wal_archive \
      --entrypoint sh supabase/postgres:17.6.1.136 -c 'chown 100:101 /wal_archive && chmod 0700 /wal_archive'
```

(`/srv/supabase/backups/wal` as in 07 §3.1 is **not** usable directly: the
backups tree is 0700 `lucario` and the container user is uid 100. A bind mount
of `stack/volumes/db/wal_archive` is the clean option; the backup jobs then
sync/prune it as `lucario` can read it only if the directory is made
group/other-readable — see §4 open items.)

### 1.2 Compose override — add to `deploy/lucashome/docker-compose.override.yml`, `db:` service

```yaml
  db:
    mem_limit: 2g
    logging: *default-logging
    volumes:
      - ./volumes/db/wal_archive:/var/lib/postgresql/wal_archive:z
      - ./volumes/db/custom-conf.d/10-wal-archive.conf:/etc/postgresql-custom/conf.d/10-wal-archive.conf:ro,z
      - ./volumes/db/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro,z
```

Compose merges the override's `volumes` list with upstream's, so the existing
PGDATA bind mount and the `db-config` named volume stay as they are.

### 1.3 `volumes/db/pg_hba.conf` — the image file plus replication lines

Copy the current file out (`docker compose cp db:/etc/postgresql/pg_hba.conf
volumes/db/pg_hba.conf`) and append:

```
# backups: pg_basebackup / pg_verifybackup from inside the container only
local replication supabase_admin                 trust
host  replication supabase_admin 127.0.0.1/32    scram-sha-256
host  replication supabase_admin ::1/128         scram-sha-256
```

Nothing is exposed: the db container publishes no ports and the gateway is
loopback-only on the host. With this in place `backup-base.sh` (BASE_METHOD=auto)
automatically switches from the SQL-API fallback to `pg_basebackup -X fetch
--manifest-checksums=SHA256` verified by `pg_verifybackup`. `pg_hba.conf` can be
reloaded without restart (`select pg_reload_conf();`), but the file is in the
image layer today, so making it persistent needs the bind mount, i.e. a
container recreate anyway.

### 1.4 `volumes/db/custom-conf.d/10-wal-archive.conf`

```
# WAL archiving (07 §3.1). archive_mode needs a restart; the rest reloads.
archive_mode = on
archive_command = 'test ! -f /var/lib/postgresql/wal_archive/%f.gz && gzip -1 -c %p > /var/lib/postgresql/wal_archive/%f.gz.tmp && mv /var/lib/postgresql/wal_archive/%f.gz.tmp /var/lib/postgresql/wal_archive/%f.gz'
archive_timeout = 300
# wal_level is already 'logical' (Realtime needs it); no change.
```

Notes on the command: `test ! -f` makes it refuse to overwrite an existing
segment (the Postgres-documented safety rule); writing to `.tmp` then `mv`
makes each archived file atomic so a crash never leaves a truncated `.gz` that
`restore_command` would trust. Idle 16 MiB segments compress to a few KB.
`gzip -1` keeps the archive command fast; the archiver is single-threaded.

Alternative without the pg_hba change: put the settings on the compose
`command:` as `-c archive_mode=on -c ...`. The `conf.d` file is preferred
because `docker compose config` then shows the full command unchanged from
upstream and the settings are reviewable as a file.

### 1.5 Apply (owner runs; ~1 min db downtime)

```
ls$ cd /srv/supabase/stack
ls$ docker compose config --quiet                    # validates the override
ls$ /srv/supabase/backup/bin/backup-logical.sh       # fresh dump right before the restart
ls$ docker compose up -d db                          # recreates ONLY db with the new mounts/settings
ls$ docker compose ps                                # all healthy again (auth/rest/storage reconnect by themselves)
ls$ docker compose exec -T db psql -U supabase_admin -d postgres -c "show archive_mode; show archive_command; show archive_timeout;" </dev/null
ls$ docker compose exec -T db psql -U supabase_admin -d postgres -c "select pg_switch_wal();" </dev/null
ls$ sleep 5; ls -la volumes/db/wal_archive/          # first <segment>.gz appears
ls$ docker compose exec -T db psql -U supabase_admin -d postgres -c "select last_archived_wal, last_archived_time, last_failed_wal, last_failed_time from pg_stat_archiver;" </dev/null
ls$ /srv/supabase/backup/bin/backup-base.sh          # should now report method=pg_basebackup, verify=pg_verifybackup
```

Rollback: remove the three lines from the override, `docker compose up -d db`.
A base backup taken with archiving on is still restorable without the archive
(it carries its own WAL).

## 2. Retention and monitoring of the archive (to add after approval)

- Keep 14 days of segments (07 §1). Segments older than the oldest kept base
  backup's `START WAL LOCATION` are useless; a prune step in `backup-prune.sh`
  will delete `wal_archive/*.gz` whose segment name sorts below the oldest base
  backup's start segment, and never anything else.
- `backup-status.sh` will add: `pg_stat_archiver.last_failed_time` must be null
  and `last_archived_time` < 10 min old; archived segment sequence has no gaps
  (names are sequential hex; a gap means a lost segment and a broken PITR
  chain). Both become `PROBLEMS` entries → non-zero exit → healthchecks fail
  ping.
- The archive directory must be included in the offsite copy (07 §3.4). Local
  only, it dies with the disk, exactly like the base backups.

## 3. How PITR restore will use it

Given base backup `B` (any `base/<ts>/`, either method) and the archive:

1. Stop the broken db (`docker compose stop db` — owner), move PGDATA aside.
2. Extract `B/base.tar.gz` into a fresh `volumes/db/data` (plus `pg_wal.tar.gz`,
   `backup_label` for sqlapi-method backups; see README "Restore manually").
3. Create `volumes/db/data/recovery.signal` (empty file) and put in
   `postgresql.auto.conf`:
   ```
   restore_command = 'gzip -dc /var/lib/postgresql/wal_archive/%f.gz > %p'
   recovery_target_time = '2026-10-11 12:34:00+00'   # omit for "latest"
   recovery_target_action = 'promote'
   ```
4. `docker compose up -d db`. Postgres replays from `START WAL LOCATION` through
   the archive until the target, then promotes (new timeline). Logs show
   `recovery stopping before commit of transaction ... time ...` and
   `database system is ready to accept connections`.
5. Validate counts against the last hourly dump; `pg_stat_archiver` resumes on
   the new timeline (`00000002...` segments).

The sqlapi-method base backups produced today are valid starting points for
PITR: they contain `backup_label` with the start LSN, and the archive supplies
everything after. The only requirement is that the archive is unbroken from
the start segment of the chosen base backup to the target time.

## 4. Test plan for a timed recovery (run once after enabling, then at each G8 drill)

All in a throwaway container (`docker run --rm --name sb-restore-test-pitr-<ts> --network none --memory 1g`), never against the stack:

1. `T0`: `backup-base.sh` (method pg_basebackup now).
2. Insert a marker: `create table public.pitr_marker(t timestamptz default now()); insert into public.pitr_marker default values;` — note `T1 = now()`.
3. Wait > `archive_timeout` (5 min) or `select pg_switch_wal()`; confirm the segment holding `T1` is in `wal_archive/`.
4. `T2`: `delete from public.pitr_marker;` (the "accident"), `pg_switch_wal()` again.
5. Restore the `T0` base into `/srv/supabase/backups/restore-test/pitr-<ts>/pgdata`, bind-mount the archive **read-only** at `/var/lib/postgresql/wal_archive`, set `restore_command` + `recovery_target_time = T1 + 30s`, `recovery_target_action = promote`, create `recovery.signal`, start the throwaway.
6. Expect: `select count(*) from public.pitr_marker` = 1 (row present: recovered past T1, before T2); timeline = 2 (`select timeline_id from pg_control_checkpoint()`).
7. Repeat with target = "latest" (no `recovery_target_time`): expect 0 rows.
8. Measure wall time from step 5 to "ready" — this is the RTO figure for 07 §1 (target 30 min).
9. Remove the container and the temp dir; `docker ps -a | grep sb-restore-test` must be empty.

Pass criteria: both targets produce the expected row count, no `invalid record`
/ `could not find WAL` errors in the log, and the archive gap check is clean.

## 5. Open items / decisions for the owner

- Approve the db recreate (§1.5) and pick the window.
- Decide whether `lucario` may read `wal_archive/` (needed for offsite sync and
  for the restore test to mount it): either `chmod 0750` + add `lucario` to a
  group with gid 101 on the host (needs sudo), or let the archive_command write
  world-readable files (`umask` in the command) inside a 0711 dir. Simplest with
  no sudo: `chmod 0755` on the directory in §1.1 and `-m 0644` files; the parent
  `volumes/db/` is already 0775 `lucario`, and nothing else on the host runs as
  another user that should be kept out. Recommendation: 0755/0644 and rely on
  the host being single-purpose, as `.env` (0600) already is the real secret.
- `wal_level = logical` is already set; no Realtime impact.
- Disk: 288 forced segments/day at a few KB each when idle; worst case 16 MiB
  × 288 = 4.5 GB/day uncompressed under heavy write load, far below the 732 GB
  free. Retention keeps it bounded at 14 days.

## 6. Applied 2026-10-11 — record of what was done

Config backup first: `/srv/supabase/backups/config-backup-20261011T234707Z/`
(0600/0700): `/etc/postgresql/{postgresql.conf,pg_hba.conf,pg_ident.conf,logging.conf}`,
all of `/etc/postgresql-custom/` (incl. `conf.d/`, `pgsodium_root.key`),
PGDATA's `postgresql.conf`, `pg_hba.conf`, `postgresql.auto.conf`, and the
effective settings (`effective-settings.txt`: `archive_mode=off`,
`archive_command=(disabled)`, `archive_timeout=0`, `wal_level=logical`).

Change set as applied (diff vs the proposal in §1):

| Item | Proposed | Applied | Why |
|---|---|---|---|
| `wal_archive/` owner/mode | 100:101, 0700 | **100:101, 0770** | host gid 101 (`lxd`) contains `lucario` → prune/offsite as `lucario` without sudo; nobody else is in that group |
| `archive_command` | `test ! -f … && gzip -1 -c %p > ….tmp && mv …` | same, **prefixed with `umask 027`** | archived files are 0640 → readable by gid 101 |
| conf file | `volumes/db/custom-conf.d/10-wal-archive.conf` → `/etc/postgresql-custom/conf.d/` (ro) | as proposed | loaded via the image's `include_dir` (verified with `show archive_mode`) |
| `pg_hba.conf` | image file + 3 `replication` lines, bind-mounted ro | as proposed (`volumes/db/pg_hba.conf`, diff = the 3 lines + comment) | — |
| compose override | 3 volume entries on `db` | as proposed (`deploy/lucashome/docker-compose.override.yml`), no `:z` flags (no SELinux on the host) | — |
| rehearsal | — | the exact mounts were first started on a throwaway vanilla cluster: archived 2 segments, `pg_basebackup` over the socket worked | de-risk the one restart |

Restart: `docker compose up -d db` only (db has no `depends_on`; nothing else
was recreated). Measured: compose returned after 865 ms, `pg_isready` after
1021 ms, container `healthy` after 6.2 s. Side effect: **Realtime crashed on
the lost connection (`FATAL 57P01 admin_shutdown`) and was restarted by its
Docker `unless-stopped` policy** (`RestartCount=1`, started 23:49:13, healthy,
0 errors afterwards). PostgREST reconnected in place at 23:49:08–15; GoTrue
and Storage reconnected lazily (proven by a failed-login probe → HTTP 400
`invalid_credentials`, i.e. an `auth.users` lookup; `storage/v1/bucket` → 200).
`/auth/v1/health` → 200. The bare `/rest/v1/` root is `403 RBAC: access denied`
from the Envoy gateway with or without a JWT (gateway policy, not the db); a
table path returns PostgREST's schema-cache answer.

Archiver after restart: first forced `pg_switch_wal()` landed as
`000000010000000000000009.gz` after **113 ms**; during the PITR drill the
switched segment (74 KB gz) landed after **223 ms**. `archive_timeout`
produced `…0A.gz` 5 min after the first switch on the otherwise idle stack,
so the idle cadence is one segment per 5 min. `pg_stat_archiver`:
`failed_count=0`.

`backup-base.sh` with `BASE_METHOD=pg_basebackup`: socket connection
accepted, `pg_verifybackup` → `backup successfully verified` (4.3 MB, 2 s).

PITR drill (`pitr-test.sh`, base `20261011T235750Z`, archive mounted
read-only into a throwaway): 3 rows inserted, T1 = 23:58:27.516787+00, 3 more
rows at 23:58:29.82; recovery log: `restored log file …0C/…0D from archive`,
`recovery stopping before commit of transaction 2748, time 23:58:29.821354+00`,
`selected new timeline ID: 2`; restored table = rows 1–3 only, 0 post-T1 rows,
`pg_is_in_recovery() = f`, timeline 2. `public.pitr_marker` dropped from the
live db afterwards. Total 9 s.

RPO evidence for the owner: the loss window is `archive_timeout` (300 s) plus
the archive time (0.1–0.3 s measured) for the segment in flight; a crash
inside a 5-minute window loses at most that window's WAL. Whether this
satisfies the "≤ 5 minutes" target is the owner's call; the measurement shows
the archive time itself is negligible and the bound is the timeout.

Still open: offsite copy of `wal_archive/` and `base/` (07 §3.4); retention
of the config backup dir (manual); the sqlapi code path remains for a host
without the pg_hba change.
