# Phase F · Offsite backups — proposal

Status: **proposal, 2026-10-12**. Nothing has been created: no R2 bucket, no
token, no healthchecks project, no `age` key, no rclone config. Sizing numbers
are from read-only commands on `lucashome` run today (§4). Legend: **V**
verified · **I** inferred · **U** unknown.

Builds on `docs/selfhost-migration/07-backup-disaster-recovery.md` (design)
and what is already running on `lucashome`
(`deploy/lucashome/backup/README.md`, `WAL-ARCHIVING.md`): hourly logical
dumps, daily `pg_basebackup` verified by `pg_verifybackup`, continuous WAL
archiving (`archive_timeout=300`), weekly restore drill, prune with WAL
cutoff, `backup-status.sh` thresholds — all local to
`/srv/supabase/backups` and `stack/volumes/db/wal_archive`.

## 0. Recommendation (decision-ready)

1. **Copy of record: Cloudflare R2 through an rclone `crypt` remote.** One
   bucket, one bucket-scoped Object Read & Write token on `lucashome`, every
   object encrypted client-side (file names too). R2 never sees plaintext
   and has no egress fees, so restore drills from R2 are free.
2. **Second tier: the owner's Mac, pulling over Tailscale.** The Mac pulls
   with a read-only `rrsync` key; `lucashome` holds no credential that can
   touch the Mac copy, so a compromised host cannot delete it. Best-effort
   (Mac intermittently online), but it is the copy that holds the `age`
   private key and is therefore the tier a rebuild starts from.
3. **What goes offsite:** base backups, WAL archive, logical dumps (hourly 48 h,
   daily 14, weekly 8), storage files, and a daily `age`-encrypted
   config/secrets bundle (`.env`, override, `db` config incl. `pgsodium_root.key`,
   functions, Tailscale serve export, backup config).
4. **Cadence:** WAL every 15 min, dumps hourly, base daily, storage every 6 h,
   bundle daily. **Retention mirrors local** (48 h / 14 d / 8 w; WAL ≥ oldest
   base) plus 30-day object versioning via `--backup-dir` on base, storage and
   bundle (not on WAL or hourly dumps — §3.3 explains why).
5. **Cost: $0 expected.** Today's footprint is ≈ 0.7 GB on R2 including
   versions; the 12-month busy-shop projection is ≈ 3.5 GB, under the 10 GB
   free tier with the 8 GB alert from doc 09. Operations are < 10 % of the
   free class A budget. Worst case if every assumption is wrong by 2×: under
   $1/month (§8).
6. **Owner must create (§9):** Cloudflare account + R2 bucket + scoped token;
   healthchecks.io project (or reuse the one from doc 09); `age` keypair on the
   Mac; rclone crypt password + salt in the password manager. The engineer
   never needs the `age` private key, the Cloudflare login, or the crypt
   password.
7. **Proof before G8 (§7):** an automated weekly restore from **R2** into a
   throwaway container, and a manual bundle decrypt on the Mac. Until the R2
   drill has been timed, the only RTO/RPO claims made are the ones already
   measured locally.

Build effort: two scripts (`offsite-sync.sh`, `restore-test-r2.sh`), a
`backup-status.sh` extension, one launchd plist on the Mac, ~1 day plus the
owner's 30 minutes of account setup.

## 1. Architecture

```
lucashome                                         Cloudflare R2 (copy of record)
┌──────────────────────────────────────┐   rclone sync (crypt)   ┌──────────────────────┐
│ /srv/supabase/backups/base/   ───────┼────────────────────────▶│ r2crypt:base/        │
│ /srv/supabase/backups/dump/   ───────┼────────────────────────▶│ r2crypt:dump/        │
│ stack/volumes/db/wal_archive/ ───────┼────────────────────────▶│ r2crypt:wal/         │
│ stack/volumes/storage/        ───────┼────────────────────────▶│ r2crypt:storage/     │
│ bundle-<ts>.tar.age  (age -r) ───────┼────────────────────────▶│ r2crypt:bundle/      │
│ golden/ (hosted snapshot)     ───────┼────────────────────────▶│ r2crypt:golden/      │
│                                      │                         │ r2crypt:.versions/   │ ◀ --backup-dir
│ offsite.json  → backup-status.sh → healthchecks.io              └──────────────────────┘
└──────────────▲───────────────────────┘
               │ rsync pull over Tailscale SSH (rrsync -ro), no --delete
        owner's Mac (second tier; holds the age private key; Time Machine behind it)
```

Properties:

| | R2 via rclone crypt | Mac via rsync pull |
|---|---|---|
| Who initiates | `lucashome` (cron) | the Mac (launchd), only when `lucashome` is reachable on the tailnet |
| Credential on `lucashome` | R2 token scoped to one bucket, Object Read & Write; crypt password+salt (obscured) in `/srv/supabase/backup/rclone.conf` 0600 | an `authorized_keys` entry for the Mac restricted to `command="rrsync -ro /srv/supabase/backups"` plus a second one for `stack/volumes/db/wal_archive` and `stack/volumes/storage` (or one `rrsync -ro /srv/supabase` entry) |
| Can `lucashome` delete the copy? | yes, within what the token allows; mitigated by `--backup-dir` versions and by an R2 **bucket lock** rule if available (§3.4) | **no** — the Mac pulls; nothing on `lucashome` can write to the Mac |
| Encryption at rest | client-side (rclone crypt, AES-256 NaCl secretbox, filename + directory name encryption) | plaintext files on the Mac's encrypted APFS volume (FileVault assumed — **U**, owner to confirm) + the `.tar.age` bundle stays encrypted |
| Availability | always | intermittent; alert only when > 48 h stale |

Why not R2 only: the deletion question. A token that can `PutObject` can
`DeleteObject`; versions made by `--backup-dir` are ordinary objects that the
same token can delete. The Mac tier is the one copy an attacker on `lucashome`
cannot reach. Why not Mac only: it is a laptop that sleeps and travels.

Why rclone crypt rather than server-side encryption: R2 SSE is on by default
but Cloudflare holds the key; with crypt the key material lives only in the
password manager and in `rclone.conf` on `lucashome`. A leaked bucket
listing shows only encrypted names.

## 2. Encryption and key management

| Secret | Generated where | Lives where | Must not be on | Needed for |
|---|---|---|---|---|
| rclone crypt **password** and **salt** (password2) | by the owner with `rclone config` on `lucashome` (or `rclone obscure` on the Mac) | `/srv/supabase/backup/rclone.conf` (0600, `lucario`) **and** the owner's password manager (plaintext form, not the obscured form) | git, the bundle only (circular: the bundle is inside the crypt) → it must also be in the password manager | reading anything from R2 |
| R2 API token (Access Key ID + Secret Access Key) | Cloudflare dashboard, by the owner | `rclone.conf` on `lucashome`; password manager | git, the engineer's machine | writing/reading the bucket |
| `age` **private** key | `age-keygen` on the Mac | the Mac (`~/.config/age/shwephala-backup.key`, 0600) and the password manager | `lucashome`, git, R2 (even inside the crypt) | decrypting the config/secrets bundle |
| `age` **public** key (`age1…`) | same | `backup.env` on `lucashome` as `AGE_RECIPIENT`; fine in git docs | — | encrypting the bundle |
| healthchecks.io ping URLs | healthchecks.io, by the owner | `backup.env` (0600); inside the bundle | git | dead-man pings |
| Mac → `lucashome` SSH key | Mac | Mac `~/.ssh`; public half in `lucario`'s `authorized_keys` with `command="rrsync -ro …",no-pty,no-port-forwarding` | — | the pull |

The bundle (`bundle-<ts>.tar.age`): `tar` of `stack/.env`,
`stack/docker-compose.override.yml`, `stack/.supabase-version`,
`stack/volumes/db/custom-conf.d/`, `stack/volumes/db/pg_hba.conf`,
`stack/volumes/functions/`, `stack/volumes/api/` (if present),
`pgsodium_root.key` (copied out of the `db` container as `backup-base.sh`
already does), `tailscale serve status --json`, `backup.env`, `rclone.conf`,
`crontab -l`, and a `MANIFEST.sha256` — piped to `age -r $AGE_RECIPIENT`.
Plaintext never touches disk (`tar … | age … > bundle.tar.age` in a 0700 dir).
Taken daily at 02:45 UTC (after the base backup) and whenever `deploy.sh`
or the owner changes `.env`.

What a rebuild needs, minimum: (1) the crypt password + salt, (2) R2 access
(token or dashboard), (3) the `age` private key, (4) the repo at tag
`self-hosted/v0.8.2` + these docs. From those four, everything else comes
out of the bundle. From the Mac tier alone: (3) and the Mac's disk.

Rotation:

| Secret | When | How |
|---|---|---|
| R2 token | yearly, or on suspicion | create a new token in the dashboard, swap in `rclone.conf`, run one sync, revoke the old one. No re-upload |
| crypt password/salt | only on compromise | new crypt remote on a new prefix/bucket, full re-sync (≈ 1–4 GB), delete the old prefix after the next restore drill passes. Keep the old password in the password manager until the old objects are gone |
| `age` key | on compromise or owner change | `age-keygen`, update `AGE_RECIPIENT`, next daily bundle uses it; older bundles stay decryptable only by the old key — keep it until they are pruned (14 days) |
| Mac SSH key | with the Mac | replace the `authorized_keys` line |

## 3. What is synced, how often, retention

### 3.1 Jobs on `lucashome` (cron, `lucario`, same lock pattern as the existing jobs)

| Job | Schedule (UTC) | rclone operation | Source → destination | Pings |
|---|---|---|---|---|
| `offsite-wal` | `*/15 * * * *` | `rclone copy --no-traverse --max-age 24h` (new segments only; HEAD per candidate instead of a full LIST) then, once per day, `rclone sync` with `--min-age 10m` to apply the local prune (delete segments below the WAL cutoff) | `stack/volumes/db/wal_archive/` → `r2crypt:wal/` | `offsite` check (fail on error) |
| `offsite-dump` | `20 * * * *` (5 min after `backup-logical.sh`) | `rclone sync` of `dump/hourly`, `dump/daily`, `dump/weekly` (hard links become separate objects on R2) | `backups/dump/` → `r2crypt:dump/` | `offsite` |
| `offsite-base` | `45 2 * * *` (after `backup-base.sh` 02:30) | `rclone sync --backup-dir r2crypt:.versions/base/<date>` | `backups/base/` → `r2crypt:base/` | `offsite` |
| `offsite-storage` | `0 */6 * * *` | `rclone sync --backup-dir r2crypt:.versions/storage/<date>` | `stack/volumes/storage/` → `r2crypt:storage/` | `offsite` |
| `offsite-bundle` | `50 2 * * *` + on change | build bundle, `rclone copy`, keep 14 on R2 (`rclone delete --min-age 14d r2crypt:bundle/`) | `backups/bundle/` → `r2crypt:bundle/` | `offsite` |
| `offsite-check` | `30 4 * * *` | `rclone cryptcheck` on `base/`, `dump/daily`, `dump/weekly`, `storage/`, `bundle/`; `rclone size r2crypt:` → `offsite.json` | — | `offsite` |
| `restore-test-r2` | `30 5 * * 0` (after the local drill at 03:30) | §7.1 | R2 → throwaway container | `restore-test-r2` |
| `golden` | once, by hand | `rclone copy` of the pre-cutover hosted snapshot (05 runbook) | → `r2crypt:golden/` | — |

Every job writes `last_run`, `last_success`, `bytes`, `objects`,
`mismatches`, `duration_s` into `/srv/supabase/backups/offsite.json`, which
`backup-status.sh` reads (§6). A single `offsite` healthchecks check is enough
because `backup-status.sh` turns per-tier staleness into its own failing ping;
`restore-test-r2` gets its own check because it is the proof.

### 3.2 Mac pull (launchd, every 6 h, only if `tailscale status` shows `lucashome` online)

`rsync -a --ignore-existing` (no `--delete`) of `backups/base/`,
`backups/dump/daily/`, `backups/dump/weekly/`, `backups/bundle/`,
`stack/volumes/db/wal_archive/`, `stack/volumes/storage/` into
`~/Backups/shwephala/` on the Mac; prune on the Mac with its own policy (90
days for base/WAL/dumps, bundles 30) so nothing on `lucashome` can shorten it.
Pings `mac-pull` on success. Time Machine, if on, adds another layer for free.
Hourly dumps are not pulled (the daily tier is enough for a second copy).

### 3.3 Retention on R2

| Tier | Retention | Mechanism | Why |
|---|---|---|---|
| `wal/` | every segment ≥ the start segment of the oldest retained base (≈ 14 days) | mirrors the local prune (`backup-prune.sh` cutoff), applied by the daily `sync` | PITR from any retained base |
| `base/` | 14 daily | `sync` + `--backup-dir` 30 days | a pruned base stays recoverable for 30 more days |
| `dump/hourly` | 48 | `sync` only, **no `--backup-dir`** | with versioning, 24 pruned dumps/day × 30 days ≈ 720 objects ≈ 0.7 GB today, 2–3 GB at 12 months — the single biggest waste; the daily/weekly tiers already cover it |
| `dump/daily`, `dump/weekly` | 14 / 8 | `sync` only | separate objects (no hard links on S3) |
| `storage/` | live + 30-day versions of deleted/overwritten files | `--backup-dir` | the 07 §3.3 requirement |
| `bundle/` | 14 daily | `rclone delete --min-age 14d` | each bundle is complete; 14 is plenty |
| `golden/` | forever | never touched by any job | pre-cutover evidence |
| `.versions/` | 30 days | `rclone delete --min-age 30d r2crypt:.versions/` daily | versioning cost cap |

### 3.4 Deletion resistance on R2 (to verify at build time)

R2 has had **bucket locks** (retention rules that block deletes/overwrites
for N days, per prefix) since 2025 (**I**; confirm in the dashboard under the
bucket's Settings). If available on the free plan, apply a 14-day lock to
`base/`, `wal/`, `dump/daily/`, `dump/weekly/`, `bundle/`, `golden/` and
**not** to `dump/hourly/`, `.versions/`, `storage/` (their prune cadence is
shorter than 14 days; a lock would block it and inflate storage). With a lock,
a stolen token cannot destroy the copy of record and the Mac tier becomes a
convenience rather than the last line. Without it, the design above already
holds: the Mac tier is the deletion-resistant copy, as 07 §5.4 says.

## 4. Storage requirements — real numbers

Measured 2026-10-12 04:52 UTC (`du -sh`, `backup-status.sh`, `status.json`), ≈ 5 h after WAL archiving was switched on:

| Item | Today | Per-unit | Notes |
|---|---|---|---|
| `backups/base` | 25 MB, 5 dirs | **5.4 MB** per base (gz tar + manifest + key copy) | DB is 55 MB uncompressed; `pg_verifybackup` ok |
| `backups/dump` | 8.2 MB, 12 hourly (+2 daily, +2 weekly hard links) | **0.95 MB** per hourly set | `postgres.dump` + `_supabase.dump` + globals + counts |
| `wal_archive` | 5.0 MB, 72 segments | **~67 KB** average (idle 17–25 KB; drill/base segments larger); 72 in ~5 h ≈ 14/h with drills, 12/h idle | 288/day idle ≈ 6 MB/day; today's mix ≈ 20 MB/day |
| `volumes/storage` | 11 MB | 574 objects, 5.1 MB payload on hosted; storage-api layout doubles it | product images, ≤ 40 KB each |
| config bundle | < 1 MB | (`config-backup-…` is 224 KB; functions + env + serve JSON) | |
| golden snapshot | ≈ 60–100 MB once | **I** — hosted `schema.sql` + `data.sql` + roles, uncompressed | |
| logs/status | < 0.1 MB | | |

12-month projection. Assumptions: docs 04 estimates sales data at 8–15
MB/month, so the DB grows to ≈ 150–250 MB; `pg_dump -Fc` and gzip compress
real rows ≈ 3–4×; WAL under trading is dominated by `sales`/`sale_items`/
`inventory`/`audit_logs` writes and index churn — assumed 20 MB/day idle-ish
shop to 60 MB/day compressed for a busy one (the local measured 4.5 GB/day
is the theoretical uncompressed worst case, not expected).

| Tier on R2 | Today (steady state after retention fills) | Month 12, quiet shop | Month 12, busy shop |
|---|---|---|---|
| `base/` 14 × | 76 MB | 14 × 30 MB = 420 MB | 14 × 50 MB = 700 MB |
| `.versions/base` 30 d | 160 MB | 900 MB | 1.5 GB |
| `wal/` ≈ 14 d | 14 × 15 MB = 210 MB | 14 × 20 MB = 280 MB | 14 × 60 MB = 840 MB |
| `dump/` 48 + 14 + 8 = 70 sets | 67 MB | 70 × 2.5 MB = 175 MB | 70 × 4 MB = 280 MB |
| `storage/` + versions | 15 MB | 40 MB | 80 MB |
| `bundle/` 14 × | 14 MB | 14 MB | 14 MB |
| `golden/` | 100 MB | 100 MB | 100 MB |
| **Total** | **≈ 0.65 GB** | **≈ 1.9 GB** | **≈ 3.5 GB** |

Headroom to the 8 GB warning (doc 09): > 2× even in the busy case. If the
`.versions/base` line is judged unnecessary (the Mac tier + bucket lock cover
the same risk), the busy-shop total drops to ≈ 2 GB. On the Mac: base + daily
+ weekly + WAL + storage ≈ 0.3 GB today, ≈ 2 GB at month 12 with 90-day
pruning. Local disk is unaffected (730 GB free).

## 5. Recovery procedures

RTO/RPO figures: **measured** = from `status.json`/`WAL-ARCHIVING.md` §6 on
this 55 MB database; **target** = doc 07 §1, not yet proven at the offsite
tier. Nothing below should be quoted as proven until §7 has been run and timed.

### 5.1 Same host, local backups intact (unchanged)
`deploy/lucashome/backup/README.md` §B (physical) / §B2 (PITR) / §A (logical).
Measured: physical restore 3 s, PITR drill 9 s end-to-end, logical restore 3 s
(all throwaway, 2026-10-11). RPO: `archive_timeout` 300 s + 0.1–0.3 s archive
time (measured). The offsite tier plays no part.

### 5.2 Same host, local backups lost or suspect (disk partially failed, `rm -rf` of `/srv/supabase/backups`)
1. `rclone copy r2crypt:base/<latest ts>/ /srv/supabase/backups/base/<ts>/`
   and `rclone copy r2crypt:wal/ stack/volumes/db/wal_archive/` filtered to
   segments ≥ that base's `start_wal_file` (from `backup.json`).
2. `sha256sum -c SHA256SUMS` in the base dir; continue with README §B/§B2.
3. If `volumes/storage` is also gone: `rclone sync r2crypt:storage/ stack/volumes/storage/`
   (owner: stop `storage` container first, start after).
RTO: download time (≈ 100–900 MB on a home connection: minutes) + 5.1. Target
≤ 30 min remains a target.

### 5.3 New host (laptop dead, disk dead, theft) — 07 §5.3 made concrete
1. Owner: new Ubuntu host, Docker, Tailscale joined as `lucashome` (old node
   removed first so the `ts.net` name re-issues), `rclone` and `age` installed,
   `lucario` user, `/srv/supabase` tree.
2. Owner enters the crypt password + salt and the R2 token into a fresh
   `rclone.conf` (from the password manager); engineer never sees them.
3. `rclone copy r2crypt:bundle/<latest> .` → on the **Mac** (where the `age`
   key is): `age -d -i ~/.config/age/shwephala-backup.key bundle.tar.age |
   tar -x` → `scp` the extracted `.env`, override, `db/custom-conf.d`,
   `pg_hba.conf`, functions, `pgsodium_root.key`, `backup.env`, `rclone.conf`
   to the new host (over Tailscale SSH). Alternative: decrypt on the new host
   with the key pasted from the password manager, then shred it there.
4. `git clone` the repo at tag `self-hosted/v0.8.2` → `stack/`; drop the
   bundle files in; `docker compose config --quiet`.
5. Restore PGDATA: 5.2 steps 1–2 with the target "latest" (replay every
   archived segment) — README §B2 without `recovery_target_time`.
6. Put `pgsodium_root.key` into the `db-config` volume (README §B step 4).
7. `docker compose up -d`; `tailscale serve` as in 04; `backup/deploy.sh --cron`;
   re-create cron jobs (Phase E §8); run `backup-status.sh` → OK.
8. Tills reconnect by themselves (same hostname, same `JWT_SECRET` from the
   bundle → sessions stay valid). Validate counts against the newest dump's
   `counts.json`.
RTO target 4 h (07). Expected on today's data: 1–2 h, dominated by OS/Docker
setup, not data. Tills sell offline meanwhile.

### 5.4 PITR from offsite (bad migration / accidental delete, local archive gone)
As 5.2 but with `recovery_target_time = '<last good moment>'`. Locally this
is proven (`pitr-test.sh`, 9 s, rows at target 3/3). From R2 it is the same
procedure with a download step in front; it is what `restore-test-r2.sh`
rehearses weekly (§7.1), so after the first successful run the claim "PITR
from offsite works, in N minutes" can be made with a number.

### 5.5 Ransomware / malicious deletion on `lucashome`
R2 holds ciphertext only; the crypt password is in the password manager; the
Mac copy is unreachable from `lucashome`. Recover as 5.3 onto a clean host
using the Mac tier if R2 was also wiped (token stolen, no bucket lock).

## 6. Alerting

Extends `backup-status.sh` (runs `*/30`, pings `HEALTHCHECKS_URL`, fails on any
PROBLEM) with an `offsite` section read from `offsite.json`, and adds three
healthchecks.io checks. Thresholds are initial values, to re-tune after two
weeks like the rest of doc 09.

| Condition | Source | Threshold → severity | Action |
|---|---|---|---|
| WAL sync age | `offsite.json.wal.last_success` | > 30 min → **high**; > 2 h → **critical** (RPO at the offsite tier is breached) | `rclone` logs; R2 reachability; token validity |
| dump sync age | `.dump.last_success` | > 2 h → high | same |
| base sync age | `.base.last_success` | > 26 h → **critical** | same |
| storage sync age | `.storage.last_success` | > 12 h → warn; > 48 h → high | same |
| bundle age | `.bundle.last_success` | > 26 h → high | same; also check `age` recipient still set |
| `cryptcheck` mismatches | `.check.mismatches`, `.check.errors` | > 0 → **high** (a corrupted or truncated object; re-upload) | `rclone cryptcheck --one-way` of the named prefix, re-sync |
| R2 total size | `.check.size_bytes` (`rclone size`) | > 8 GB → warn (doc 09); > 9.5 GB → high | shorten `.versions/` retention; check WAL growth |
| WAL gap | existing local check extended: the segment sequence **on R2** (listing of `wal/`) is contiguous from the oldest retained base's start segment | gap → **critical** | copy the missing segment from local; if local is gone too, the PITR chain is broken at that point — take a fresh base immediately |
| R2 restore test | `restore-test-r2` healthchecks check, period 7 d, grace 1 d | missed or `/fail` → **critical** | read `logs/restore-test-r2.log` |
| Mac pull age | `mac-pull` check, period 6 h, grace 48 h | missed → warn (laptop closed) ; > 7 d → high | open the Mac on the tailnet |
| offsite job errors | `offsite` check: each job pings `/start` → `/` or `/fail` with the rclone summary as the body | any `/fail` → high | rclone exit code in the log |
| token expiry (if the owner sets a TTL on the R2 token) | `backup.env` `R2_TOKEN_EXPIRES` | < 14 d → high | rotate per §2 |

Dead-man coverage: `offsite` (period 15 min, grace 30 min — pinged by every
offsite job, so a stalled cron or a dead host shows within 45 min),
`restore-test-r2`, `mac-pull`. Together with the existing checks from doc 09
(`heartbeat`, `collector`, `backup-base`, `backup-dump`, `backup-wal-check`,
`restore-test`, `probe-staging`) that is 10 of the 20 free checks.

## 7. Verification plan

### 7.1 Automated weekly: restore from R2 into a throwaway container (`restore-test-r2.sh`)
1. `rclone lsjson r2crypt:base/` → pick the newest; `rclone copy` it to
   `backups/restore-test/r2-<ts>/base/`; `sha256sum -c`.
2. From `backup.json.start_wal_file`, `rclone copy --include` every WAL
   segment ≥ that name (and `*.history`) to `…/wal/` — **from R2, not from
   the local archive** (the point is to prove the offsite chain).
3. Reuse `restore-test.sh --physical-only --base <dir>` logic with the WAL
   dir mounted read-only at `/var/lib/postgresql/wal_archive`,
   `restore_command` set, target "latest"; wait for `database system is ready`.
4. Compare `COUNTS_SQL` against the **newest hourly dump's** `counts.json`
   (more recent than the base) — exact match expected on a quiet stack;
   `RESTORE_COUNT_TOLERANCE` as today.
5. Also `rclone copy` the newest `dump/hourly` set and run the existing
   logical drill against it (proves the dump tier offsite).
6. Record wall time per step into `status.json.jobs.restore-test-r2`
   (`download_s`, `recovery_s`, `total_s`) — this becomes the measured
   offsite RTO. Ping `restore-test-r2`. Remove container and temp dir;
   `backup-status.sh` flags leftovers as today.

### 7.2 Manual, on the Mac (before G8, then quarterly)
1. `rclone` on the Mac configured **read-only** against the same crypt remote
   (owner types the password/salt; a second R2 token with Object Read only).
2. `rclone copy r2crypt:bundle/<latest> ~/tmp/` → `age -d -i
   ~/.config/age/shwephala-backup.key bundle.tar.age | tar -t` lists the
   expected files; `MANIFEST.sha256` verifies; then `rm`.
3. Full rebuild drill on the Mac in Docker from R2 only (07 §4 "manual full
   DR drill"): proves steps 5.3/2–7 end to end without touching `lucashome`.
   Time it; that number replaces the 4 h target.

### 7.3 Acceptance for G8 (adds to 07 §4)
- one local restore (already green), one restore from R2 (7.1 green at least
  twice), one bundle decrypt on a machine that is not `lucashome` (7.2),
  `backup-status.sh` OK with the offsite section populated, healthchecks
  showing all three new checks green.

## 8. Recurring cost

Free-tier limits used (**V** from docs 07/09 as of 2026, re-check at build):
R2 10 GB-month storage, 1 M class A ops (PUT/COPY/POST/LIST/DELETE), 10 M
class B (GET/HEAD) per month, no egress fees; beyond: $0.015/GB-month,
$4.50 per M class A, $0.36 per M class B. healthchecks.io free: 20 checks.
Tailscale Personal: free (3 users / 100 devices). Resend free: 3,000/month.

Expected operations per month from the cadence in §3.1:

| Job | Runs/month | Class A per run | Class A/month | Class B/month |
|---|---|---|---|---|
| `offsite-wal` (copy, `--no-traverse`) | 2,880 | ~3.5 PUTs (≈ 300–350 new segments/day) | ≈ 10,500 | ≈ 10,500 HEADs |
| `offsite-wal` daily sync/prune | 30 | LIST (≈ 5 per 1,000 objects) + ≈ 300 DELETEs | ≈ 9,000 | — |
| `offsite-dump` | 720 | LIST 1–2 + ≈ 6 PUT + ≈ 6 DELETE | ≈ 10,000 | — |
| `offsite-base` | 30 | LIST + 6 PUT + 6 COPY (versions) + 6 DELETE | ≈ 600 | — |
| `offsite-storage` | 120 | LIST 1–2 + changed files (few) | ≈ 500 | — |
| `offsite-bundle` | 30 | 1 PUT + 1 LIST + 1 DELETE | ≈ 100 | — |
| `offsite-check` (`cryptcheck` + `size`) | 30 | ≈ 10 LISTs (whole bucket ≈ 6–8 k objects) | ≈ 300 | ≈ 0 (hashes come from listings) |
| `.versions/` prune | 30 | LIST + DELETEs | ≈ 1,000 | — |
| `restore-test-r2` | 4 | LIST | ≈ 50 | ≈ 4 × (1 base + ≈ 4,500 WAL + 1 dump) ≈ 18,000 GETs |
| **Total** | | | **≈ 32,000 (3 % of 1 M)** | **≈ 30,000 (0.3 % of 10 M)** |

Storage: ≈ 0.65 GB today, ≈ 3.5 GB at month 12 busy (§4) → within 10 GB.
Egress for drills: free.

**Expected recurring cost: $0.** healthchecks.io stays within 20 checks (10
used); Tailscale and Resend unchanged.

Worst case, if everything is 2× the busy projection: 7 GB storage (still
free), 65 k class A (free). Paid only if storage passes 10 GB: at 15 GB,
5 GB × $0.015 = **$0.08/month**; at 30 GB (WAL run-away without the 8 GB
alert being acted on) $0.30/month + negligible ops. A Cloudflare account may
need a payment method on file to enable R2 at all (**U**; commonly required).
Upper bound for any plausible failure mode: **under $1/month**. The only
way to a real bill is a storage-class misconfiguration (e.g. Infrequent
Access with retrieval fees) — use Standard.

## 9. What the owner must create (nothing is created by the engineer)

| # | Item | Where | Scope / settings | Hand to the engineer? |
|---|---|---|---|---|
| 1 | Cloudflare account, R2 enabled | dash.cloudflare.com | Standard storage class; location hint APAC (nearest to Yangon) or automatic | account login: **never**. Account id and the S3 endpoint host (`<accountid>.r2.cloudflarestorage.com`): yes |
| 2 | R2 bucket | R2 → Create bucket | name `shwephala-backups`; **no** public access, **no** custom domain; bucket lock rule 14 d on the prefixes in §3.4 if available | name: yes |
| 3 | R2 API token for `lucashome` | R2 → Manage R2 API Tokens | permission **Object Read & Write**, scoped to **this bucket only**, optional TTL 1 year | the Access Key ID + Secret: **owner pastes them** into `/srv/supabase/backup/rclone.conf` (engineer prepares the file with placeholders and the `no_check_bucket = true`, `provider = Cloudflare`, `upload_cutoff = 200M` settings; bucket-scoped tokens cannot `ListBuckets`, hence `no_check_bucket`) |
| 4 | R2 API token for the Mac (optional, for 7.2) | same | Object **Read** only, same bucket | owner's Mac only |
| 5 | rclone crypt password + salt | `rclone config` on `lucashome` (owner session) or `rclone obscure` on the Mac | filename encryption `standard`, directory name encryption on | **never** to the engineer; stored in the password manager in plaintext form |
| 6 | `age` keypair | `age-keygen` on the Mac | private key at `~/.config/age/shwephala-backup.key` (0600) + password manager | **public key only** (`age1…`) goes into `backup.env` |
| 7 | healthchecks.io project | healthchecks.io (free) | checks `offsite` (15 min / grace 30 min), `restore-test-r2` (7 d / 1 d), `mac-pull` (6 h / 48 h) plus the doc 09 set; Telegram + email integrations | ping URLs: owner pastes into `backup.env` (treated as secrets) |
| 8 | SSH key for the Mac pull | `ssh-keygen` on the Mac | `authorized_keys` line on `lucashome` with `command="rrsync -ro /srv/supabase"` (engineer writes the line, owner supplies the public key) | public key: yes |
| 9 | Password-manager entries | — | crypt password + salt; `age` private key; R2 token(s); healthchecks URLs; this doc's path | — |

Not shared with the engineer, ever: the `age` private key, the crypt
password/salt, the Cloudflare login, the R2 secret keys, the password manager.
The engineer works with: bucket name, endpoint host, `age` public key, the
scripts, and a `rclone.conf` on `lucashome` that already contains the secrets
(0600, `lucario`), which the engineer can *use* via `rclone` but has no reason
to read.

## 10. Build plan (after approval)

1. Owner: §9 items 1–7 (≈ 30 min).
2. Engineer: `offsite-sync.sh` (one script, `--tier wal|dump|base|storage|bundle|check`,
   lock per tier, `offsite.json`, healthchecks pings with `/start`), crontab
   lines, `backup-status.sh` offsite section, `restore-test-r2.sh`,
   `rclone.conf.example`, docs in `deploy/lucashome/backup/`.
3. First sync by hand with `--dry-run`, then real; `rclone cryptcheck` clean;
   `backup-status.sh` OK.
4. Mac: launchd plist for the pull; first pull by hand; `mac-pull` green.
5. 7.1 run by hand, then wait for the first scheduled Sunday; 7.2 on the Mac.
6. Update 07 §3.4/§5 and 09 §2 "Backups" with the measured numbers; G8 item.

## 11. Open items / uncertain

- R2 bucket lock availability and semantics on the free plan (§3.4) — **U**.
- Whether enabling R2 requires a payment method (§8) — **U**.
- Mac disk encryption (FileVault) status — **U**, owner.
- WAL volume under real trading (§4 assumptions) — measure during the first
  trading month and re-run the projection.
- `rclone cryptcheck` on R2 relies on single-part uploads for MD5 (ETag);
  `upload_cutoff = 200M` keeps every object single-part today — revisit if a
  base backup ever exceeds it.
- `rrsync` is shipped with rsync on Ubuntu (`/usr/bin/rrsync` since rsync
  3.2.4) — **I**; verify on `lucashome` at build time (read-only `which`).
- Nothing on the server has been changed; the `du`/`status` commands above
  were the only ones run.
