# Enable offsite backups (R2 + Mac tier) and prove a restore from them — proposal

Status: **proposal, 2026-10-13 (UTC)**. The offsite scripts are deployed on `lucashome` and **disabled** (`OFFSITE_ENABLED=false`). No bucket, token, rclone config, age key or healthchecks check exists. This document is the decision-and-order layer on top of the step-by-step runbooks, which stay the source of truth for the exact prompts:
[OFFSITE-ENABLE.md](../../../deploy/lucashome/backup/OFFSITE-ENABLE.md) (R2 + bundle + restore drill) and [MAC-TIER.md](../../../deploy/lucashome/backup/MAC-TIER.md) (Mac pull). Design and cost model: [phase-f/proposal.md](../phase-f/proposal.md).

## Decision summary

- **Approve enabling the offsite tier.** Today every copy of the database, WAL, storage and secrets lives on the one NVMe in the laptop. A dead disk or a stolen laptop loses everything except the 2026-10-11 hosted export on the Mac. This is a release blocker in [risks.md](../../lucashome-selfhost/risks.md) and gate **G8** in [10-go-no-go-checklist.md](../10-go-no-go-checklist.md).
- **Your part (~45–60 min, only you ever see a secret):** create the R2 bucket + one bucket-scoped token, the rclone crypt password + salt, the `age` keypair on the Mac, three healthchecks checks, and type the secrets into `rclone config` / `backup.env` on `lucashome` yourself. One `sudo apt install rclone age`.
- **Engineer's part (~60–90 min):** dry runs, first sync, first restore **from R2**, cron lines, Mac pull set-up support, and the docs/status update. Uses only non-secret output.
- **Cost: $0 expected** (≈ 0.1 GB on R2 today, ≈ 3.5 GB at month 12 for a busy shop, against a 10 GB free tier). Worst plausible case is under $1/month.
- **No downtime.** Nothing in the Supabase stack changes. Local backups keep running unchanged throughout.
- **Done when (G8 offsite part):** `offsite-restore-test.sh` green twice (one manual, one scheduled Sunday), one bundle decrypted on the Mac, `backup-status.sh` OK with the offsite section populated, healthchecks `offsite` / `restore-test-offsite` / `mac-pull` green.

## 0. Current local backup facts (read-only `backup-status.sh`, 2026-10-13 02:01 UTC)

| Item | Value |
|---|---|
| Overall | `STATUS: OK` |
| Logical (hourly) | last success 2026-10-13 01:57 UTC, 987 KB per set; on disk **hourly 40/48, daily 3/14, weekly 2/8** = 34 MB |
| Base (daily `pg_basebackup` + `pg_verifybackup`) | last success 2026-10-13 01:56 UTC, 5.7 MB; **9/14** bases = 47 MB |
| Restore drill (weekly, local) | last ok 2026-10-11 23:59 UTC, logical=ok physical=ok |
| WAL archive | mode on; `archived=335 failed=0 pending=0`; 335 files, **21 MB**; oldest retained base `20261011T232753Z` has its first needed segment present |
| PITR drill | 2026-10-11 23:58 UTC ok, archive lag 223 ms |
| Total local backup footprint | dumps 34 MB + bases 47 MB + WAL 21 MB ≈ **0.1 GB**; storage volume ≈ 11 MB (phase-f §4, 2026-10-12) |
| Free space | 730 GB on `/srv` |
| Offsite | `offsite: disabled (OFFSITE_ENABLED=false …)` |
| Tools | `which rclone age` → nothing (exit 1) |
| Cron | the four local lines only; the seven `offsite-*` lines are not installed |

The two 01:56–01:57 runs are the pre-077 checkpoint backups (077–079 applied 2026-10-13 01:56 UTC per [status.md](../../lucashome-selfhost/status.md)).

## 1. Prerequisites

1. Your approval of this document (data leaves the host for the first time; it leaves encrypted).
2. A password manager you will keep (the crypt password + salt and the `age` private key live **only** there and on the Mac; losing password + salt = losing every byte on R2).
3. A Cloudflare account. R2 may require a payment method on file even at $0 usage (unknown until you try).
4. FileVault on for the Mac (`fdesetup status` → `FileVault is On.`): the Mac tier holds plaintext base backups and dumps.
5. `backup-status.sh` → `STATUS: OK` immediately before starting.

## 2. What you create (owner) — and what you hand over

| # | Item | Steps | Hand to the engineer |
|---|---|---|---|
| O1 | rclone + age on `lucashome` (**sudo**) | `sudo apt update && sudo apt install -y rclone age` (1.60.1 / 1.2.1 are enough) | "installed" + `rclone version \| head -1` |
| O2 | R2 bucket `shwephala-backups` | OFFSITE-ENABLE §2.1: Standard class, location hint APAC or automatic, no public access, no custom domain | bucket name |
| O3 | Bucket lock availability | OFFSITE-ENABLE §2.2: just **check** whether the Settings page offers it; rules are added after the first sync (prefix names are encrypted) | yes / no |
| O4 | R2 token for `lucashome` | OFFSITE-ENABLE §2.3: Object Read & Write, **this bucket only**, optional 1-year TTL | TTL date if set (goes into `R2_TOKEN_EXPIRES`). Never the keys |
| O5 | (optional) read-only R2 token for the Mac | OFFSITE-ENABLE §2.4, for the manual drill on the Mac | nothing |
| O6 | `age` keypair on the Mac | OFFSITE-ENABLE §2.5: `age-keygen -o ~/.config/age/shwephala-backup.key`; copy the file into the password manager | the **public** key `age1…` |
| O7 | crypt password + salt | OFFSITE-ENABLE §2.6: two random strings in the password manager | nothing |
| O8 | healthchecks.io | OFFSITE-ENABLE §2.7: checks `offsite` (15 min / grace 30 min), `restore-test-offsite` (7 d / 1 d), `mac-pull` (6 h / 48 h); integrations email + Telegram. **Also decide whether `backup-status.sh` gets its own check** (`HEALTHCHECKS_URL`, the layer-A alert for the *local* backups; not confirmed set today) | nothing (ping URLs are secrets) |
| O9 | `rclone config` on `lucashome` (your SSH session as `lucario`) | OFFSITE-ENABLE §3 exactly: remote `r2` (s3 / Cloudflare / `no_check_bucket = true`, `upload_cutoff = 200M`, `chunk_size = 16M`) and crypt remote `offsite` over `r2:shwephala-backups` | "done". Never run `rclone config show` on a shared screen |
| O10 | `backup.env` (as `lucario`, `nano`) | OFFSITE-ENABLE §4: `AGE_RECIPIENT`, `HEALTHCHECKS_OFFSITE_URL`, `HEALTHCHECKS_OFFSITE_RESTORE_URL`, optional `R2_TOKEN_EXPIRES`, optional `OFFSITE_BWLIMIT`; **leave `OFFSITE_ENABLED=false`** for now | "done" |

## 3. Engineer steps after O1–O10 (as `lucario`, non-secret output only)

### 3.1 Remote sanity (OFFSITE-ENABLE §3 "Verify")

```
ls$ export RCLONE_CONFIG=/srv/supabase/backup/rclone.conf
ls$ rclone listremotes                                         # offsite:  r2:
ls$ rclone lsd r2:shwephala-backups                            # empty, no AccessDenied
ls$ rclone touch offsite:.probe && rclone ls offsite: && rclone ls r2:shwephala-backups
ls$ rclone delete offsite:.probe
```

Pass: the name under `r2:` is **not** `.probe` (encryption works). Fail → stop; you fix the crypt remote.

### 3.2 Dry runs (nothing uploaded)

```
ls$ cd /srv/supabase/backup/bin
ls$ OFFSITE_ENABLED=true ./secrets-bundle.sh --dry-run          # member list only
ls$ OFFSITE_ENABLED=true ./offsite-sync.sh all --dry-run
ls$ tail -n 50 /srv/supabase/backups/logs/offsite-all.log
```

### 3.3 Enable + first sync (approval: data leaves the host)

You, or the engineer with your explicit OK, set `OFFSITE_ENABLED=true` in `backup.env`. Then:

```
ls$ ./offsite-sync.sh all                         # wal, dump, base, storage, bundle (builds one), check — ~0.1 GB today, minutes
ls$ jq . /srv/supabase/backups/offsite.json        # every tier last_result=ok, mismatches=0
ls$ rclone size offsite:                           # record objects/bytes
ls$ ./offsite-status.sh                            # only "restore-test never succeeded" may be listed
```

Pass: every tier `ok`, cryptcheck `mismatches=0 errors=0`, size ≈ 0.1 GB.

### 3.4 First offsite restore test

```
ls$ ./offsite-restore-test.sh                      # pulls base + WAL + newest hourly dump FROM R2 into throwaway containers
ls$ jq '.jobs["offsite-restore-test"]' /srv/supabase/backups/status.json
ls$ ./backup-status.sh
```

**Success criteria (all required):**

| # | Criterion | Where |
|---|---|---|
| S1 | exit 0; `result` ok | script output, `status.json` |
| S2 | downloaded base passes `SHA256SUMS`; the WAL sequence pulled from R2 has **no gap** from the base's start segment | `logs/offsite-restore-test.log` |
| S3 | physical restore (base + R2 WAL, target *latest*) reaches "database system is ready" | log |
| S4 | table counts of the restored DB **equal** the newest hourly dump's `counts.json` (tolerance 0 on a quiet stack) | log |
| S5 | logical drill: the R2 copy of the newest hourly dump restores into a vanilla throwaway with no error other than `role "supabase_admin" already exists` | log |
| S6 | `download_s`, `recovery_s`, `logical_s`, `total_s`, `bytes_downloaded`, `wal_segments` recorded = **first measured offsite RTO** | `status.json` |
| S7 | no leftover containers / temp dirs; `backup-status.sh` STATUS OK with the offsite section populated | `backup-status.sh` |
| S8 | healthchecks `restore-test-offsite` shows a success ping | healthchecks.io (you) |

Failure → `./offsite-restore-test.sh --keep-on-failure` once for diagnosis, read the log, fix, re-run. The local tier is unaffected either way.

### 3.5 Cron lines (approval: crontab change on `lucashome`)

Uncomment the seven `#offsite-*` lines in [`crontab.lucario`](../../../deploy/lucashome/backup/crontab.lucario) on the branch, then `mac$ deploy/lucashome/backup/deploy.sh --cron`. Cadence: wal `*/15`, dump `20 *`, base `45 2`, storage `0 */6`, bundle `50 2`, check `30 4`, restore test `30 5 * * 0`. Verify: `crontab -l` shows 11 job lines; after 15 min `jq .jobs.wal offsite.json` has a fresh `last_success`; healthchecks `offsite` green. (Small doc fix to make in the same change: the comment in `crontab.lucario` says "step 7 of OFFSITE-ENABLE.md"; the section is §5.1.)

### 3.6 Bucket lock (only if O3 = yes; you, in the dashboard)

Get the encrypted prefix names (non-secret): `rclone cryptdecode --reverse offsite: base wal dump/daily dump/weekly bundle golden`. Add a 14-day rule for those prefixes only (OFFSITE-ENABLE §2.2). If not available: the Mac tier is the deletion-resistant copy (phase-f §3.4).

### 3.7 Golden snapshot (once; your decision on the route)

The 2026-10-11 hosted export is on the **Mac** (`~/shwephala-migration/20261011T2347Z/`, 0700), not on `lucashome`. The Mac's optional R2 token is read-only. Proposed route: `scp -r` it into a 0700 temp dir on `lucashome` → `rclone copy <dir> offsite:golden/20261011T2347Z/` → `rclone check` → delete the temp dir. It contains customer/staff PII and password hashes. It is encrypted on R2, plaintext in transit only inside the Tailscale tunnel. No job ever touches `golden/`.

## 4. Mac pull tier (MAC-TIER.md; you on the Mac, engineer guides)

1. Two pull keys (`shwephala-pull-backups`, `shwephala-pull-volumes`) with `ssh-keygen` (MAC-TIER §1).
2. **You** append the two `restrict,command="/usr/bin/rrsync -ro …"` lines to `/home/lucario/.ssh/authorized_keys`. Never `ssh-copy-id`. `rrsync` is present on `lucashome` (`/usr/bin/rrsync`, verified 2026-10-12).
3. Run the four verification commands in MAC-TIER §1: listings work, `ssh … true` is refused, an upload is refused.
4. Install `mac-pull.sh` + `pull.env` (MAC-TIER §2); `--check`, `--dry-run`, then the first pull. Add the `mac-pull` healthchecks URL.
5. Load the launchd agent (MAC-TIER §3, every 6 h + at login, `--snapshot`).
6. Confirm FileVault on; optionally Time Machine including `~/shwephala-backups`.

Expected size on the Mac today ≈ 0.1 GB (base + daily/weekly dumps + WAL + storage), ≈ 2 GB at month 12 with 90-day pruning.

## 5. Verify the bundle decrypts on the Mac (G8 item; you, ~5 min)

```
mac$ ls -1 ~/shwephala-backups/bundle/ | tail -n 1            # or: scp lucashome:/srv/supabase/backups/bundle/<ts>.tar.age ~/tmp/
mac$ mkdir -p ~/tmp/bundle && cd ~/tmp/bundle
mac$ age -d -i ~/.config/age/shwephala-backup.key ~/shwephala-backups/bundle/<ts>.tar.age | tar -x
mac$ shasum -a 256 -c manifest/MANIFEST.sha256 | grep -vc ': OK$'   # 0 = every line OK
mac$ cat meta/bundle.json                                     # member list (non-secret)
mac$ ls stack db-config backup                                # names only; do NOT cat .env / rclone.conf / pgsodium_root.key
mac$ cd ~ && rm -rf ~/tmp/bundle                              # plaintext secrets: remove when done
```

Pass: decrypt succeeds with the Mac key, `0` failed manifest lines, members include `stack/.env`, the override, `db-config/pgsodium_root.key`, `backup/backup.env`, `backup/rclone.conf`. Report only "decrypt OK, N members, 0 manifest failures". Optional later: the full rebuild drill on the Mac from R2 (phase-f §7.2.3) replaces the 4 h RTO estimate with a measured number.

## 6. Monitoring and alerts

| Signal | Source | Threshold | Severity |
|---|---|---|---|
| WAL offsite age | `offsite-status.sh` (inside `backup-status.sh`, `*/30`) | > 30 min | high; > 2 h critical (offsite RPO breached) |
| dump / base / storage / bundle age | same | 2 h / 26 h / 7 h / 26 h | high (base: critical) |
| cryptcheck mismatches/errors | `offsite.json.check` | > 0 | high |
| R2 size | `rclone size` in `check` | > 8 GB warn, > 9 GB high | — |
| restore-test age / failure | `status.json` | > 8 d or failed | critical |
| token expiry | `R2_TOKEN_EXPIRES` | < 14 d | high |
| Dead-man | healthchecks `offsite` (every job pings), `restore-test-offsite`, `mac-pull` | missed ping | email + Telegram |

Test the alert path once: in healthchecks.io use "Send test notification" for each integration, and confirm it reaches your phone (P6 in [08](../08-cutover-rollback.md)).

## 7. Cost recap (phase-f §8)

| Item | Today | Month 12 (busy) | Free tier | Expected bill |
|---|---|---|---|---|
| R2 storage | ≈ 0.1 GB now; ≈ 0.65 GB once 30-day versions + golden fill | ≈ 3.5 GB | 10 GB | $0 |
| Class A ops | — | ≈ 32 k/month | 1 M | $0 |
| Class B ops | — | ≈ 30 k/month (drills) | 10 M | $0 |
| Egress (restore drills) | — | — | free on R2 | $0 |
| healthchecks.io | 3 new checks (10 with doc 09's set) | — | 20 | $0 |
| Worst case (2× everything, or WAL runaway ignored) | — | 7–30 GB | — | **< $1/month** |

Use the **Standard** storage class. Infrequent Access adds retrieval fees, which the weekly drill would trigger.

## 8. Abort / rollback

| When | Action | Effect |
|---|---|---|
| Any time | `OFFSITE_ENABLED=false` in `backup.env` | every offsite job becomes a no-op exiting 0; healthchecks goes red (intended signal) |
| After 3.5 | `deploy.sh --cron` with the lines commented again (or `crontab -e`) | no offsite runs |
| Abandon R2 | `rclone purge r2:shwephala-backups`, delete bucket, revoke token(s) in the dashboard | R2 copy gone; local tier unchanged |
| Abandon Mac tier | `launchctl bootout gui/$(id -u)/com.shwephala.backup-pull`; remove the two `authorized_keys` lines | Mac copy stays on disk until you delete it |
| Suspected leak | rotation table, OFFSITE-ENABLE §9 | — |

Nothing in this plan touches the stack, the local backup jobs, or the database. Rollback is always "turn the tier off".

## 9. Risks

| Risk | Mitigation |
|---|---|
| Crypt password/salt lost → R2 unreadable | password manager entry + the age-encrypted bundle also carries `rclone.conf` (decryptable with the Mac key) |
| `rclone.conf` on `lucashome` is a secret (obscured ≠ encrypted) | 0600 `lucario`; it never leaves the host except inside the age-encrypted bundle |
| Stolen R2 token can delete objects (no write-only R2 token type) | bucket lock if offered; otherwise the Mac tier, which `lucashome` cannot reach |
| Residential Wi-Fi upload | ≈ 0.1 GB initial, then KB–MB per run; `OFFSITE_BWLIMIT` exists if needed |
| WAL volume under real trading differs from the projection | `check` records size; 8 GB warn; re-run the projection after the first trading month |
| Single-part MD5 for `cryptcheck` | `upload_cutoff = 200M`; largest object today ≈ 6 MB |
| Mac asleep / travelling | `mac-pull` 48 h grace; it is the second copy, R2 is the copy of record |

## 10. Time and approvals

| Step | Who | Time | Approval | Sudo |
|---|---|---|---|---|
| O1 install tools | owner | 5 min | yes | **yes** |
| O2–O8 accounts/keys | owner | 30–40 min | — (your own accounts) | no |
| O9–O10 rclone config + backup.env | owner | 10 min | yes (secrets land on `lucashome`) | no |
| 3.1–3.2 sanity + dry runs | engineer | 10 min | covered by this doc | no |
| 3.3 enable + first sync | engineer | 10 min | **yes** (data leaves the host) | no |
| 3.4 offsite restore test | engineer | 10–20 min | covered | no |
| 3.5 cron lines | engineer | 5 min | **yes** (crontab change) | no |
| 3.6 bucket lock | owner | 5 min | — | no |
| 3.7 golden upload | engineer | 10 min | **yes** (PII leaves the Mac) | no |
| §4 Mac tier | owner + engineer | 20 min | **yes** (`authorized_keys` change) | no |
| §5 bundle decrypt | owner | 5 min | — | no |

Evidence: `docs/selfhost-migration/evidence/G8/<date>-offsite-enable.md` (offsite.json, `rclone size`, restore-test status block, bundle-decrypt outcome, healthchecks screenshots). Then update `lucashome-selfhost/status.md` (Backups → Offsite), tick the Phase F item in [roadmap.md](../../lucashome-selfhost/roadmap.md), and mark the "Single disk, no offsite copy" risk resolved once the second restore test is green.
