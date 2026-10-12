# Offsite backups — enable runbook (Phase F)

Implements `docs/selfhost-migration/phase-f/proposal.md`. State as of
2026-10-12: the scripts are **deployed to `lucashome:/srv/supabase/backup/bin`
in a disabled state** (`OFFSITE_ENABLED=false` in `backup.env`); every offsite
script exits 0 with `offsite disabled`; no cron line is active (they are in
`crontab.lucario` commented out); **no R2 bucket, token, rclone config, age key
or healthchecks check exists yet**. `rclone` and `age` are **not installed** on
`lucashome` (verified read-only on 2026-10-12: `which rclone age` → nothing;
apt candidates `rclone 1.60.1`, `age 1.2.1`).

Roles: **owner** = the only person who ever sees a secret (R2 keys, crypt
password/salt, age private key, healthchecks URLs). **engineer** = runs the
scripts and reads non-secret output. Nothing below asks the owner to hand a
secret to the engineer.

## 0. What lands where

| Thing | Created by | Lives at | In git? |
|---|---|---|---|
| `rclone.conf` (R2 keys + obscured crypt password/salt) | owner, `rclone config` (§3) | `/srv/supabase/backup/rclone.conf` 0600 `lucario` | never (template: `rclone.conf.example`) |
| `backup.env` offsite keys (§4) | engineer prepared the block with defaults; owner fills `AGE_RECIPIENT`, `HEALTHCHECKS_*`, flips `OFFSITE_ENABLED` | `/srv/supabase/backup/backup.env` 0600 | example only |
| age keypair | owner, on the Mac (§2.5) | private: Mac `~/.config/age/shwephala-backup.key` + password manager; public: `AGE_RECIPIENT` | public key only |
| R2 bucket `shwephala-backups` + token | owner (§2.1–2.3) | Cloudflare | bucket name only |
| healthchecks checks `offsite`, `restore-test-offsite`, `mac-pull` | owner (§2.6) | healthchecks.io; URLs in `backup.env` / Mac `pull.env` | no |
| remote layout | `offsite-sync.sh` | `offsite:` = crypt over `r2:shwephala-backups`: `base/ wal/ dump/{hourly,daily,weekly}/ storage/ bundle/ .versions/{base,storage,bundle}/<YYYYMMDD>/ golden/` | — |
| local bundle dir | `secrets-bundle.sh` | `/srv/supabase/backups/bundle/<ts>.tar.age` 0600, keep 14 | — |
| state | jobs | `/srv/supabase/backups/offsite.json` (`jobs.wal/dump/base/storage/bundle/check`), `status.json` (`jobs.bundle`, `jobs.offsite-restore-test`), `logs/offsite-<tier>.log`, `logs/secrets-bundle.log`, `logs/offsite-restore-test.log`, `logs/offsite-status.log` | — |

## 1. Install the tools on `lucashome` (owner, needs sudo — once)

```
ls$ sudo apt update && sudo apt install -y rclone age
ls$ rclone version | head -n 1      # 1.60.1 from Ubuntu 26.04 is enough (crypt, cryptcheck, --backup-dir, Cloudflare provider)
ls$ age --version                   # 1.2.1
```

Newer rclone, if preferred: `curl -fsSL https://rclone.org/install.sh | sudo bash`
(installs to `/usr/bin/rclone`). Nothing else is needed; `docker`, `jq`,
`python3`, `flock`, `curl` are already present. Until this step is done
every offsite script that is **enabled** fails closed with `rclone not
installed` / `age not installed`.

## 2. What the owner creates (proposal §9)

### 2.1 Cloudflare R2 bucket
dash.cloudflare.com → R2 → Create bucket: name **`shwephala-backups`**, location
hint **APAC** (or automatic), storage class **Standard**. No public access, no
custom domain. Note the **account ID** (R2 overview page) — the S3 endpoint is
`https://<accountid>.r2.cloudflarestorage.com`. A payment method may be
required to enable R2 (proposal §8, unknown); the expected bill is $0.

### 2.2 Bucket lock (optional, verify availability)
Bucket → Settings → *Bucket lock* / *Object lock rules*. If the free plan
offers it: a **14-day** rule for the prefixes `base/`, `wal/`, `dump/daily/`,
`dump/weekly/`, `bundle/`, `golden/` and **none** for `dump/hourly/`,
`.versions/`, `storage/`. **Catch:** the crypt remote encrypts directory
names, so the prefixes R2 sees are ciphertext. Add the rules *after the first
sync* (§5) using the encrypted names from
`rclone --config /srv/supabase/backup/rclone.conf cryptdecode --reverse offsite: base wal dump/daily dump/weekly bundle golden`
(prints `plain<TAB>encrypted` — non-secret, fine to paste into the dashboard).
If bucket lock is not available, nothing changes: the Mac tier (MAC-TIER.md)
is the deletion-resistant copy, as the proposal says.

### 2.3 R2 API token for `lucashome`
R2 → Manage R2 API Tokens → Create: permission **Object Read & Write**,
*Specify bucket(s)* → `shwephala-backups` only, TTL 1 year (optional; if set,
put the date in `backup.env` `R2_TOKEN_EXPIRES=YYYY-MM-DD` so
`offsite-status.sh` warns 14 days before). Keep the **Access Key ID** and
**Secret Access Key** for §3 and the password manager. Never paste them into a
chat, a ticket or git.

### 2.4 Second token for the Mac (optional, for the manual drill §6.2)
Same, **Object Read** only, same bucket. Lives only on the Mac.

### 2.5 age keypair (on the Mac)
```
mac$ brew install age
mac$ mkdir -p ~/.config/age && chmod 700 ~/.config/age
mac$ age-keygen -o ~/.config/age/shwephala-backup.key      # prints "Public key: age1..."
mac$ chmod 600 ~/.config/age/shwephala-backup.key
```
Store the whole key file in the password manager too. The **public key**
(`age1…`, one line) goes to `AGE_RECIPIENT` in §4 — it can be shared with the
engineer. The private key never goes to `lucashome`, R2 or git.

### 2.6 rclone crypt password and salt
Generate two random strings in the password manager (or
`mac$ openssl rand -base64 32` twice) and store them as *"ShwePhaLa R2 crypt
password"* and *"… salt"*. They are typed into `rclone config` in §3; rclone
stores them obscured in `rclone.conf`, but the obscured form is reversible —
treat the file as a secret. **Losing password+salt = losing every byte on R2.**

### 2.7 healthchecks.io
Project (free): checks **`offsite`** (period 15 min, grace 30 min),
**`restore-test-offsite`** (period 7 d, grace 1 d), **`mac-pull`** (period 6 h,
grace 48 h). Integrations: email + Telegram as in doc 09. Copy each ping URL
(`https://hc-ping.com/<uuid>`) into `backup.env` (§4) / the Mac `pull.env`.

## 3. `rclone config` on `lucashome` (owner session, as `lucario`)

Interactive, so the secrets never land in a shell history. Answer exactly:

```
ls$ umask 077
ls$ rclone config --config /srv/supabase/backup/rclone.conf
n) New remote
name> r2
Storage> s3                       (type the word; rclone shows the number next to "Amazon S3 Compliant Storage Providers")
provider> Cloudflare
env_auth> 1                       (false — enter credentials here)
access_key_id> <paste the Access Key ID>
secret_access_key> <paste the Secret Access Key>
region> auto                      (or leave empty)
endpoint> https://<accountid>.r2.cloudflarestorage.com
acl> private                      (or leave empty; keep the default when not asked)
Edit advanced config? y
   ... press Enter to keep every default EXCEPT:
   upload_cutoff> 200M
   chunk_size> 16M
   no_check_bucket> true           (bucket-scoped tokens cannot ListBuckets; without this every sync fails)
   ... Enter through the rest
y) Yes this is OK

n) New remote
name> offsite
Storage> crypt
remote> r2:shwephala-backups
filename_encryption> standard     (1)
directory_name_encryption> true   (1)
password> y                       (Yes, type in my own password) -> paste the crypt PASSWORD, twice
password2> y                      (Yes, type in my own password) -> paste the SALT, twice
Edit advanced config? n
y) Yes this is OK
q) Quit config
ls$ chmod 600 /srv/supabase/backup/rclone.conf
```

If an advanced option was missed, set it afterwards without touching the
secrets: `rclone --config /srv/supabase/backup/rclone.conf config update r2 no_check_bucket true upload_cutoff 200M chunk_size 16M`.
The resulting file has exactly the shape of `rclone.conf.example` (two
sections, `r2` and `offsite`). Do **not** run `rclone config show` in a
shared screen — it prints the obscured secrets.

Verify (non-secret output only):
```
ls$ export RCLONE_CONFIG=/srv/supabase/backup/rclone.conf
ls$ rclone listremotes                       # offsite:  r2:
ls$ rclone lsd r2:shwephala-backups          # empty, no AccessDenied
ls$ rclone touch offsite:.probe && rclone ls offsite: && rclone ls r2:shwephala-backups   # plaintext name vs ciphertext name
ls$ rclone delete offsite:.probe
```
`rclone ls r2:…` must show a name that is *not* `.probe` — that is the
encryption working. If the names match, the `offsite` remote is not a crypt
remote; fix it before enabling anything (`offsite-sync.sh` also warns).

## 4. `backup.env` on `lucashome`

The offsite block is already appended to `/srv/supabase/backup/backup.env`
with defaults (see `backup.env.example`). Edit as `lucario`
(`nano /srv/supabase/backup/backup.env`) — set:

| Key | Value | Who |
|---|---|---|
| `OFFSITE_ENABLED` | keep `false` until §5 is done, then `true` | owner |
| `RCLONE_CONFIG` | `/srv/supabase/backup/rclone.conf` (default) | — |
| `OFFSITE_REMOTE` | `offsite:` (default; the crypt remote name + colon) | — |
| `AGE_RECIPIENT` | `age1…` public key from §2.5 (several, space-separated, are allowed) | owner |
| `HEALTHCHECKS_OFFSITE_URL` | ping URL of the `offsite` check | owner |
| `HEALTHCHECKS_OFFSITE_RESTORE_URL` | ping URL of `restore-test-offsite` | owner |
| `OFFSITE_BWLIMIT` | optional, e.g. `4M` or `"09:00,2M 21:00,off"` (rclone timetable) if uploads hurt the shop's connection | owner |
| `R2_TOKEN_EXPIRES` | optional `YYYY-MM-DD` from §2.3 | owner |
| everything else (`KEEP_BUNDLE=14`, `OFFSITE_VERSIONS_KEEP_DAYS=30`, `OFFSITE_SIZE_WARN_GB=8`, thresholds, `OFFSITE_CHECK=cryptcheck`, `BUNDLE_TAR_MODE=docker`) | defaults match the proposal | — |

Precedence is environment > `backup.env` > built-in defaults, so a one-off
`OFFSITE_ENABLED=true offsite-sync.sh all --dry-run` can be tried without
flipping the flag (§5).

## 5. First sync (engineer or owner, as `lucario`)

```
ls$ cd /srv/supabase/backup/bin
ls$ OFFSITE_ENABLED=true ./secrets-bundle.sh --dry-run          # lists the members, reads nothing
ls$ OFFSITE_ENABLED=true ./offsite-sync.sh all --dry-run        # rclone --dry-run of every tier; nothing is uploaded or recorded
ls$ tail -n 50 /srv/supabase/backups/logs/offsite-all.log       # review the plan
```
Then enable for real: set `OFFSITE_ENABLED=true` in `backup.env` and
```
ls$ ./offsite-sync.sh all                                        # wal, dump, base, storage, bundle (builds one first), check — ~1 GB today, minutes
ls$ jq . /srv/supabase/backups/offsite.json                      # every tier last_result=ok, mismatches=0
ls$ rclone --config /srv/supabase/backup/rclone.conf size offsite:
ls$ ./offsite-status.sh                                          # PROBLEMS only about "restore-test never succeeded" at this point
ls$ ./offsite-restore-test.sh                                    # §6.1 — pulls base+WAL+dump FROM R2, restores into throwaways (minutes)
ls$ ./backup-status.sh                                           # STATUS: OK with the offsite section populated
```
Golden snapshot (once, by hand): `rclone --config … copy /path/to/hosted-snapshot offsite:golden/` — no job touches `golden/`.

### 5.1 Enable the cron lines
Uncomment the seven `#offsite-*` lines in `deploy/lucashome/backup/crontab.lucario`
(repo) and install: `mac$ deploy/lucashome/backup/deploy.sh --cron` (asks the
owner first per the house rule), or `ls$ crontab -e` and paste them. Cadence:
wal `*/15`, dump `20 * * * *`, base `45 2`, storage `0 */6`, bundle `50 2`,
check `30 4`, restore test `30 5 * * 0`. `offsite-status.sh` needs no line —
`backup-status.sh` embeds it every 30 min and its own `HEALTHCHECKS_URL` ping
fails when any offsite threshold trips.

### 5.2 Bucket lock
Now that the prefixes exist, apply §2.2 with the encrypted names.

## 6. Verification (proposal §7)

### 6.1 Automated weekly: `offsite-restore-test.sh`
Pulls the newest `base/<ts>/` and every WAL segment it needs from
`offsite:wal/` (not from the local archive), checks `SHA256SUMS` and the WAL
sequence for gaps, restores into a throwaway with `restore_command` from the
pulled archive and target *latest*, compares counts with the newest hourly
dump pulled from `offsite:dump/hourly/`, then restores that dump into a
vanilla throwaway (logical drill). `status.json.jobs.offsite-restore-test`
gets `download_s`, `recovery_s`, `logical_s`, `total_s`, `bytes_downloaded`,
`wal_segments` — **this is the measured offsite RTO**; quote it in doc 07 §3.4
after the second green run. Pings `restore-test-offsite`. Options:
`--physical-only`, `--logical-only`, `--base <ts>`, `--keep-on-failure`, `--dry-run`.

### 6.2 Manual, on the Mac (before G8, then quarterly): decrypt a bundle
The Mac tier pulls `bundle/` (MAC-TIER.md), or copy one by hand:
```
mac$ scp lucashome:/srv/supabase/backups/bundle/<ts>.tar.age ~/tmp/
mac$ mkdir -p ~/tmp/bundle && cd ~/tmp/bundle
mac$ age -d -i ~/.config/age/shwephala-backup.key ../<ts>.tar.age | tar -x
mac$ shasum -a 256 -c manifest/MANIFEST.sha256      # every line OK
mac$ ls -R | head; cat meta/bundle.json              # members: stack/.env, override, .supabase-version, volumes/db/custom-conf.d, pg_hba.conf, functions, api, db-config/ (pgsodium_root.key, conf.d), backup/backup.env, backup/rclone.conf, meta/
mac$ cd ~ && rm -rf ~/tmp/bundle ~/tmp/<ts>.tar.age   # plaintext secrets: remove when done
```
Optionally the full DR drill from R2 on the Mac in Docker (proposal §7.2.3)
with the read-only token from §2.4 and a Mac-side `rclone config` that uses
the same crypt password/salt.

### 6.3 Acceptance for G8
Local drill green (already), `offsite-restore-test` green twice, one bundle
decrypt on the Mac, `backup-status.sh` OK with the offsite section populated,
healthchecks `offsite` / `restore-test-offsite` / `mac-pull` green.

## 7. Day-to-day

- `offsite-status.sh` (or the offsite block of `backup-status.sh`): per-tier
  age vs thresholds (wal 30 min, dump 2 h, base 26 h, storage 7 h, bundle 26 h,
  check 50 h), last run failed, cryptcheck mismatches/errors, remote size
  (> 8 GB warn, > 9 GB high), restore-test age (8 d) / failure, token expiry.
- Logs: `logs/offsite-<tier>.log` (rclone output included), `logs/secrets-bundle.log`.
- A failed tier: read its log; `offsite-sync.sh <tier>` by hand is always safe
  (idempotent `rclone sync`). Mismatches after a check: re-run the tier
  (re-uploads the differing objects), then `offsite-sync.sh check`.
- Size growth: `.versions/` is the lever (`OFFSITE_VERSIONS_KEEP_DAYS`), then
  WAL volume (`backup-status.sh` shows the archive size).
- Disable temporarily: `OFFSITE_ENABLED=false` — every job becomes a no-op
  that still exits 0 (healthchecks will then go red for lack of pings, which is
  the intended signal).

## 8. Recovery procedures from the offsite copy (proposal §5, concrete)

All as `lucario`; `R=offsite:`; `export RCLONE_CONFIG=/srv/supabase/backup/rclone.conf`.

### 8.1 Local backups lost or suspect, host alive (5.2)
```
ls$ rclone lsf --dirs-only $R/base/ | tail -n 1                       # newest <ts>/
ls$ rclone copy $R/base/<ts>/ /srv/supabase/backups/base/<ts>/ && (cd /srv/supabase/backups/base/<ts> && sha256sum -c SHA256SUMS)
ls$ NEED=$(jq -r .start_wal_file /srv/supabase/backups/base/<ts>/backup.json)
ls$ rclone lsf $R/wal/ | awk -v n="$NEED" '/history/ || substr($0,1,24) >= n' > /tmp/wal.pull
ls$ rclone copy $R/wal/ /srv/supabase/stack/volumes/db/wal_archive/ --files-from-raw /tmp/wal.pull --no-traverse
       # the archive dir is 100:101 0770; lucario is in gid 101 so this works; files land 0640 via umask 027 if you `umask 027` first
ls$ # continue with README.md §B (physical) or §B2 (PITR) exactly as for a local restore
ls$ # storage gone too (owner: docker compose stop storage first):
ls$ rclone sync $R/storage/ /srv/supabase/stack/volumes/storage/ && docker compose -f /srv/supabase/stack/docker-compose.yml up -d storage
```
`offsite-restore-test.sh --keep-on-failure` leaves a fully pulled
`backups/restore-test/offsite-<ts>/{base,wal,dump}` behind that can be used
as the source as well.

### 8.2 New host (5.3)
1. Owner: Ubuntu + Docker + Tailscale (remove the old `lucashome` node first so the name re-issues), `sudo apt install rclone age`, user `lucario` in the `docker` group, `/srv/supabase` tree 0750 `lucario`.
2. Owner: recreate `/srv/supabase/backup/rclone.conf` with §3 (password manager) — or copy it from the decrypted bundle (`backup/rclone.conf`) if a bundle is at hand on the Mac.
3. Bundle: `ls$ rclone lsf $R/bundle/ | tail -n 1` → `rclone copy $R/bundle/<ts>.tar.age /tmp/` → decrypt on the **Mac** (§6.2) → `scp` to the new host: `stack/.env`, `stack/docker-compose.override.yml`, `stack/.supabase-version`, `stack/volumes/db/{custom-conf.d,pg_hba.conf}`, `stack/volumes/functions`, `stack/volumes/api`, `backup/backup.env`, `db-config/` (contains `pgsodium_root.key`).
4. Repo: `deploy/lucashome/README.md` "Rebuild from scratch" (clone upstream at `self-hosted/v0.8.2`, copy `docker/` to `/srv/supabase/stack`), drop the bundle files in, `docker compose config --quiet`.
5. PGDATA: §8.1 with the newest base and *every* WAL segment (target latest = README §B2 without `recovery_target_time`), via the container-chown trick in README §B step 2–3.
6. `db-config` volume: `docker volume create supabase_db-config` then `docker run --rm -v supabase_db-config:/dst -v $PWD/db-config:/src:ro --entrypoint sh supabase/postgres:17.6.1.136 -c 'cp -a /src/. /dst/ && chown -R postgres:postgres /dst && chmod 600 /dst/pgsodium_root.key'`.
7. `docker compose up -d`; `tailscale serve --bg --https=443 http://127.0.0.1:8000`; `mac$ deploy/lucashome/backup/deploy.sh --cron`; `backup-status.sh` → OK; `offsite-sync.sh all` (the remote is still the copy of record; a fresh base goes up at the next base run).
8. Tills reconnect (same hostname, same `JWT_SECRET`). Validate counts against `dump/hourly/<newest>/counts.json`.

### 8.3 PITR from offsite (5.4)
§8.1 steps 1–3, then README §B2 with `recovery_target_time = '<last good moment>'`.
`offsite-restore-test.sh` rehearses the same path weekly (target latest).

### 8.4 Ransomware / malicious deletion on `lucashome` (5.5)
R2 holds ciphertext only; the crypt password is in the password manager; the
Mac copy is unreachable from `lucashome`. Rebuild onto a **clean** host (§8.2).
If the token was stolen and R2 wiped (no bucket lock), use the Mac tier as
the source (MAC-TIER.md §6) — it holds base, daily/weekly dumps, WAL,
storage and bundles for 90 days.

## 9. Rotation

| Secret | When | How |
|---|---|---|
| R2 token | yearly / on suspicion | create a new token (§2.3); `rclone --config … config update r2 access_key_id <id> secret_access_key <key>` (owner types it; or `rclone config` → `e` edit); `offsite-sync.sh check` must pass; revoke the old token in the dashboard; update `R2_TOKEN_EXPIRES`. No re-upload. |
| crypt password/salt | on compromise only | create a second crypt remote `offsite2` over `r2:shwephala-backups-2` (new bucket) with new password/salt; `OFFSITE_REMOTE=offsite2:` in `backup.env`; `offsite-sync.sh all` (full re-upload ≈ 1–4 GB); after the next green `offsite-restore-test.sh`, `rclone purge r2:shwephala-backups` and delete the old bucket; keep the old password in the manager until then. |
| age key | on compromise / owner change | `age-keygen` on the Mac (§2.5); replace `AGE_RECIPIENT` (both keys may be listed, space-separated, during the overlap); the next daily bundle uses it; bundles older than that stay decryptable only by the old key — keep it until they are pruned (14 d local, 30 d versions, 30 d Mac). |
| Mac pull key | with the Mac | MAC-TIER.md §1: new key, replace the two `authorized_keys` lines. |
| healthchecks URL | on leak | regenerate in healthchecks.io, update `backup.env` / `pull.env`. |

## 10. Design notes that matter for cost and correctness

- `wal`, `dump`, `base`, `bundle` are write-once trees: synced with
  `--size-only` (and `--use-server-modtime` for `wal`) so R2 sees only
  LIST + PUT/DELETE, never a HEAD per object. `storage/` uses rclone's default
  size+modtime comparison (one HEAD per same-size object per run; ≈ 150 k class
  B/month at today's 1 200 objects — within the 10 M free).
- `wal` runs an incremental `rclone copy --no-traverse --max-age 24h` (HEAD per
  candidate) every 15 min and one full `rclone sync --min-age 10m` per day
  (`OFFSITE_WAL_FULL_EVERY_S`; stamp file `backups/.locks/offsite-wal-full.stamp`;
  `--full` forces it). The full sync is what applies `backup-prune.sh`'s WAL
  cutoff remotely.
- `--backup-dir offsite:.versions/<tier>/<YYYYMMDD>` on `base`, `storage`,
  `bundle` only. The daily `check` purges `.versions/<tier>/<date>` directories
  older than `OFFSITE_VERSIONS_KEEP_DAYS` **by name**, not by object modtime
  (moved objects keep their original mtime, which would shorten the window).
- Verification is `rclone cryptcheck` (plaintext hash vs the hash of the
  encrypted object): it needs the remote's MD5 = ETag, i.e. single-part
  uploads — hence `upload_cutoff = 200M`. Today's largest object is ≈ 5 MB.
- `secrets-bundle.sh` tars inside a throwaway container (`PG_IMAGE`,
  `--network none`, every input mounted `:ro`, the db-config **named volume**
  mounted `:ro`) and pipes to `age`; the manifest is computed on a tmpfs; the
  only files written on the host are the encrypted `<ts>.tar.age` and a 0700
  tmpdir with `crontab -l` / `tailscale serve status --json` / `bundle.json`
  (non-secret), removed afterwards.
- Everything exits 0 with `offsite disabled` while `OFFSITE_ENABLED != true`;
  when enabled but `rclone`/`age`/`rclone.conf`/`AGE_RECIPIENT` are missing
  the scripts exit 1 (fail closed) and ping `/fail`.
