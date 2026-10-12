# 07 · Backup and Disaster Recovery

Status: **design**. Nothing is scheduled or running. Every mechanism below must
be proven by a restore before gate G8 can pass.

## 1. Objectives

| Objective | Target | Rationale |
|---|---|---|
| RPO (database) | **≤ 5 minutes** of committed sales | A nightly dump would expose a full trading day; the business cannot re-key a day of sales. WAL archiving with a 5-minute forced segment switch bounds loss |
| RPO (storage files) | ≤ 24 hours | Product images are re-uploadable; no money depends on them |
| RTO, same host (Postgres container lost or corrupted) | **≤ 30 minutes** | Restore base backup + replay WAL locally |
| RTO, host lost (laptop dead, disk dead, theft) | **≤ 4 hours** to a replacement machine | Requires offsite copy, documented rebuild, and the secrets bundle |
| Retention | 14 daily base backups, 14 days of WAL, 8 weekly dumps, 6 monthly dumps; storage files mirrored with 30-day version history; pre-cutover "golden" dump kept indefinitely | Fits inside R2's free 10 GB at this database's size |

Offline-first behaviour of the POS (local mirror + write outbox) means tills keep
selling through a backend outage; the RTO above is for restoring the backend,
not for the tills' ability to trade. See [02-production-dependencies.md](./02-production-dependencies.md).

## 2. What must be backed up

| Asset | Location on `lucashome` | Mechanism | Frequency |
|---|---|---|---|
| Postgres data | `stack/volumes/db/data` | physical base backup (`pg_basebackup` tar + manifest) **and** continuous WAL archive | base daily, WAL continuous (5-min cap) |
| Postgres logical dump | — | `pg_dumpall --roles-only` + `pg_dump -Fc` of `postgres` db (all schemas incl. `auth`, `storage`) | hourly, kept 48 h locally; daily copy kept per retention |
| pgsodium / vault key | `stack/volumes/db/config` (bind mount, D3) | included in the encrypted config bundle | daily and on change |
| Storage objects | `stack/volumes/storage` | `rclone sync` (crypt remote) | every 6 h |
| Edge functions | `stack/volumes/functions` | **git** (source of truth is `supabase/functions` in the app repo) + included in config bundle | on change |
| Configuration | `stack/.env`, `stack/docker-compose.override.yml`, `stack/.supabase-version`, `stack/volumes/api`, `stack/volumes/pooler` | encrypted tar (`age`) | daily and on change |
| Cron job definitions | `cron.job` table (in the DB dump) **and** `supabase/schedule_*.sql` in git | — | — |
| Tailscale serve config, ACL policy | `tailscale serve status --json`, admin-console policy file | exported to the config bundle; ACL policy also kept in git | on change |
| Deployment manifest | this docs folder + `stack/docker-compose.override.yml` | git | on change |
| Pre-cutover golden snapshot | roles/schema/data dumps from hosted at freeze + storage object manifest | immutable copy in both locations, **never pruned** | once |

Secrets never appear in git. The encrypted bundle's `age` recipient private key
is stored in the owner's password manager and on the Mac, not on `lucashome`.

## 3. Mechanisms

### 3.1 WAL archiving (RPO ≤ 5 min)

- `archive_mode = on`, `archive_timeout = 300`, `wal_level = logical` (already
  required by Realtime), `archive_command` that gzips the segment into a bind
  mount `stack/volumes/db/wal_archive` → `/srv/supabase/backups/wal/`.
  `cp`/`gzip` exist in the image; no extra binary needed. **U**: how the
  `supabase/postgres` image accepts custom settings (`/etc/postgresql-custom`
  include dir, or `-c` flags on the compose `command`) — confirm at G2 and
  record the exact method here.
- Idle segments are mostly zero padding and compress from 16 MiB to well under
  1 MiB, so 288 forced segments/day stay within a few hundred MB before
  retention.
- Monitoring: `pg_stat_archiver.last_failed_time` must be null and
  `last_archived_time` < 10 min old (see 09).

### 3.2 Base backups and logical dumps

- Daily 02:00 UTC: `docker exec supabase-db pg_basebackup -D - -Ft -X none
  --checkpoint=fast --manifest-checksums=SHA256 | gzip` →
  `/srv/supabase/backups/base/<date>.tar.gz` + manifest. Verified immediately
  with `pg_verifybackup` on the extracted manifest (**U**: `pg_verifybackup`
  present in image — check at G2).
- Hourly: `pg_dump -Fc` of the whole database (custom format, compressed) +
  `pg_dumpall --roles-only`. Cheap at 55 MB. Logical dumps are the fallback that
  survives a Postgres major-version change and allow single-table recovery.
- Pre-cutover golden snapshot: the exact `roles.sql`, `schema.sql`, `data.sql`
  taken from hosted at the write freeze, plus a storage object manifest
  (name, size, md5). Stored read-only in both locations.

### 3.3 Storage files

`rclone sync` from `stack/volumes/storage` to the offsite crypt remote with
`--backup-dir` so deleted/overwritten objects are retained 30 days. The local
copy is the live directory itself; a second local copy is pointless on the same
disk.

### 3.4 Offsite: Cloudflare R2 (primary) and the Mac (secondary)

| Property | R2 | Mac over Tailscale |
|---|---|---|
| Cost | Free: 10 GB storage, 1 M class-A, 10 M class-B ops/month, no egress fees (V, 2026 docs) | Free |
| Encryption | rclone **crypt** remote — R2 only ever sees ciphertext; key material lives in the config bundle recipient, not in R2 | same crypt remote |
| Credentials on `lucashome` | R2 API token scoped to **one bucket**, Object Read & Write (**U**: whether a write-only/no-delete token is possible; R2 tokens are read / read-write / admin). Mitigation for stolen-token deletion: R2 **bucket lock / retention** if available on the free plan (**U**, verify), otherwise rely on the secondary copy | SSH key limited by `command=` to rsync only |
| Independence from `lucashome` | yes | yes, but the Mac is intermittently online; treated as best-effort |
| Deletion protection | retention policy (if available) + rclone `--backup-dir` versions | APFS local snapshots or Time Machine on the Mac |

Budget check at this database's size: base backups ≈ 14 × ~30 MB, WAL ≈ 14 days
× ≤ 300 MB worst case, dumps ≈ 100 MB, storage files ≈ tens of MB, golden
snapshot once → comfortably < 10 GB. Growth is monitored (09); exceeding 8 GB
alerts before billing starts.

### 3.5 Secrets bundle

Daily and on change: `tar` of `.env`, `docker-compose.override.yml`,
`.supabase-version`, `volumes/db/config`, `volumes/functions`, Tailscale serve
export, ACL policy export → `age -r <recipient>` → stored alongside the other
offsite artefacts. Without this bundle a replacement host cannot decrypt vault
secrets, verify existing JWTs, or run functions with the same keys.

## 4. Integrity and verification

| Check | How | Frequency | Alert if |
|---|---|---|---|
| WAL archive continuity | `pg_stat_archiver`, plus a script that confirms the archived segment sequence has no gaps | every 10 min | gap, or last archive > 10 min |
| Base backup validity | `pg_verifybackup` right after creation | daily | non-zero exit |
| Logical dump validity | `pg_restore --list` succeeds, size within ±50 % of previous | hourly | failure or size anomaly |
| Offsite sync | `rclone check` (crypt-aware) after each sync | per sync | mismatches |
| **Automated restore test** | weekly: pull the latest base + WAL from **R2 (not local)**, restore into a throwaway `supabase/postgres:17.6.1.136` container on a different port, recover to "now", run `SELECT count(*)` on `sales`, `sale_items`, `inventory`, `auth.users` and compare with production counts at backup time; then `pg_dump` the throwaway and `pg_restore --list` | weekly | any step fails |
| Manual full DR drill | rebuild the whole stack on a second machine (the Mac, or a VM) from the offsite copy and the documented procedure, run the app against it | before G8, then quarterly | — |
| Backup age dead-man's switch | each job pings a healthchecks.io check on success; a missed ping alerts (independent of `lucashome`) | per job | missed |

**A backup that has never been restored is not a backup.** G8 requires one
successful local restore, one successful restore from R2, and one restore of the
secrets bundle on a machine that is not `lucashome`.

## 5. Recovery procedures

### 5.1 Postgres container broken, data directory intact
1. `docker compose stop db` → inspect; usually `docker compose up -d db` suffices.
2. If PGDATA is corrupt: move it aside, extract the latest base backup into
   `volumes/db/data`, create `recovery.signal`, set `restore_command` to gunzip
   from the WAL archive, start `db`, wait for "database system is ready",
   remove the recovery settings. RTO target 30 min.
3. Validate: counts vs the last hourly dump, `pg_stat_archiver` resumes.

### 5.2 Point-in-time (bad migration, accidental delete)
Same as 5.1 with `recovery_target_time = '<timestamp>'` and
`recovery_target_action = promote`. Practise once during G8 with a deliberate
test-row deletion on the rehearsal stack.

### 5.3 Host lost
1. New Ubuntu host with Docker; join the tailnet as `lucashome` (reusing the
   name re-issues the same `ts.net` hostname once the old node is removed).
2. `rclone` from R2: config bundle → decrypt with the recipient key; latest base
   + WAL; storage files.
3. Recreate `stack/` from tag `self-hosted/v0.8.2`, drop in `.env`, override,
   `db/config`, functions; restore PGDATA as in 5.1; `docker compose up -d`;
   `tailscale serve` as in 04.
4. Tills reconnect automatically (same hostname, same JWT secret ⇒ sessions
   remain valid). RTO target 4 h. Tills keep selling offline meanwhile.

### 5.4 Ransomware / malicious deletion on `lucashome`
Offsite copies are encrypted with a key not present on the compromised host, and
the secondary copy on the Mac is reachable only by an rsync-restricted key.
Recover as 5.3 onto a clean host. The open question (**U**) is whether a
stolen R2 token can delete the R2 copy; until bucket lock is confirmed, the Mac
copy is the deletion-resistant tier.

## 6. Why one nightly backup is not enough (explicit)

- 24 h RPO on a POS is a day of sales. Unacceptable; hence WAL archiving.
- A local backup on the same NVMe dies with the NVMe; hence offsite is the copy
  of record and local is only for fast RTO.
- A successful nightly restore proves the mechanism once; it does not prove the
  WAL chain, the offsite copy, or the secrets bundle. G8 tests all three.
- The laptop's battery is not a UPS daemon: a power cut after the battery
  drains is a hard stop with no clean shutdown. Postgres is crash-safe
  (fsync on), but the archive command may lag by up to `archive_timeout`.

## 7. Open items before G8

- Confirm custom-setting mechanism in the `supabase/postgres` image (3.1).
- Confirm `pg_verifybackup` availability in the image.
- Confirm R2 bucket-lock/retention availability on the free plan; otherwise
  document the Mac copy as the deletion-resistant tier.
- Obtain an R2 API token (user action) and an `age` recipient key pair
  (generated on the Mac, public key copied to `lucashome`).
- Decide the healthchecks.io account (user action; free tier covers ≤ 20 checks).
