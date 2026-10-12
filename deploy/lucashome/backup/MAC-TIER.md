# Mac tier — the owner's Mac pulls the backups over Tailscale (proposal §1, §3.2)

Second copy, independent of R2 and of any credential on `lucashome`: the Mac
**pulls** with SSH keys that `lucashome` restricts to `rrsync -ro` (read-only
rsync, no shell). `lucashome` holds nothing that can write to or delete the
Mac copy, so a compromised host cannot reach it. Best effort (the laptop
sleeps and travels); it is also the machine that holds the `age` private key,
so a full rebuild starts here.

State 2026-10-12: **nothing installed**. `mac-pull.sh` and the launchd template
`com.shwephala.backup-pull.plist` are in this directory only. `rrsync` is
present on `lucashome` (`/usr/bin/rrsync`, the Python version shipped with
rsync 3.4.1 — verified read-only). The Mac runs macOS 26 with Apple's
`openrsync` (supports `--ignore-existing`, `--partial`, `--bwlimit`, `--dry-run`,
`--itemize-changes` — verified); `brew install rsync` is optional.

What is pulled (never `--delete`, `--ignore-existing`: a file once pulled is
never overwritten from the host):

| lucashome | restricted root | Mac (`~/shwephala-backups/`) | kept on the Mac |
|---|---|---|---|
| `/srv/supabase/backups/base/` | backups key | `base/` | 90 d |
| `/srv/supabase/backups/dump/daily/`, `dump/weekly/` | backups key | `dump/daily/`, `dump/weekly/` | 90 d |
| `/srv/supabase/backups/bundle/` (`*.tar.age`) | backups key | `bundle/` | 30 d |
| `/srv/supabase/stack/volumes/db/wal_archive/` | volumes key | `wal_archive/` | 90 d (by mtime) |
| `/srv/supabase/stack/volumes/storage/` | volumes key | `storage/` | live mirror (never pruned) |

Hourly dumps are not pulled (daily/weekly are enough for a second copy).
Size today ≈ 60 MB; ≈ 2 GB at month 12 (proposal §4).

## 1. Keys and the `authorized_keys` lines (owner)

Two keys, so the task statement's `rrsync -ro /srv/supabase/backups` root
stays exactly that and the WAL/storage volumes get their own, equally narrow
root (the proposal's alternative `rrsync -ro /srv/supabase` would also expose
`stack/.env` to the pull key — not needed).

On the Mac:
```
mac$ ssh-keygen -t ed25519 -N '' -C shwephala-pull-backups -f ~/.ssh/shwephala-pull-backups
mac$ ssh-keygen -t ed25519 -N '' -C shwephala-pull-volumes -f ~/.ssh/shwephala-pull-volumes
mac$ cat ~/.ssh/shwephala-pull-backups.pub ~/.ssh/shwephala-pull-volumes.pub
```

On `lucashome`, the owner appends **exactly** these two lines to
`/home/lucario/.ssh/authorized_keys` (one line each; replace `AAAA…` with the
matching public key; nothing else on the line):

```
restrict,command="/usr/bin/rrsync -ro /srv/supabase/backups" ssh-ed25519 AAAA…backups-key… shwephala-pull-backups
restrict,command="/usr/bin/rrsync -ro /srv/supabase/stack/volumes" ssh-ed25519 AAAA…volumes-key… shwephala-pull-volumes
```

`restrict` = no pty, no port/agent/X11 forwarding, no user rc; `command=`
replaces whatever the client asks for with `rrsync`, which only accepts
`rsync --server --sender` requests confined to that directory; `-ro` makes it
read-only. The existing two entries (interactive access) stay untouched.
**This repo does not add these lines**; `ssh-copy-id` must not be used (it
would add an unrestricted line).

Verify from the Mac (must list the directory; a shell must be refused):
```
mac$ rsync --list-only -e 'ssh -i ~/.ssh/shwephala-pull-backups -o IdentitiesOnly=yes' lucashome:          # base/ dump/ bundle/ logs/ …
mac$ rsync --list-only -e 'ssh -i ~/.ssh/shwephala-pull-volumes -o IdentitiesOnly=yes' lucashome:          # db/ storage/ functions/ …
mac$ ssh -i ~/.ssh/shwephala-pull-backups -o IdentitiesOnly=yes lucashome true                              # must fail: "rrsync error: ..." (no shell)
mac$ rsync -e 'ssh -i ~/.ssh/shwephala-pull-backups -o IdentitiesOnly=yes' /etc/hosts lucashome:x           # must fail: read-only
```
(`lucashome` here is the existing `~/.ssh/config` alias → `100.74.43.4`, user `lucario`; `lucashome.tail8a86e4.ts.net` works the same.)

## 2. Install the script and its config (owner, on the Mac)

```
mac$ mkdir -p ~/shwephala-backups/bin ~/.config/shwephala-backup && chmod 700 ~/shwephala-backups ~/.config/shwephala-backup
mac$ cp deploy/lucashome/backup/mac-pull.sh ~/shwephala-backups/bin/ && chmod 700 ~/shwephala-backups/bin/mac-pull.sh
mac$ cat > ~/.config/shwephala-backup/pull.env <<'EOF'
LUCASHOME_HOST=lucashome
PULL_KEY_BACKUPS=~/.ssh/shwephala-pull-backups
PULL_KEY_VOLUMES=~/.ssh/shwephala-pull-volumes
DEST=~/shwephala-backups
KEEP_DAYS=90
KEEP_BUNDLE_DAYS=30
BWLIMIT_KBPS=
HEALTHCHECKS_MAC_PULL_URL=
EOF
mac$ chmod 600 ~/.config/shwephala-backup/pull.env
mac$ ~/shwephala-backups/bin/mac-pull.sh --check        # config, FileVault status, reachability, both listings
mac$ ~/shwephala-backups/bin/mac-pull.sh --dry-run      # what would be pulled
mac$ ~/shwephala-backups/bin/mac-pull.sh                # first pull; log in ~/Library/Logs/shwephala-pull.log
mac$ ls ~/shwephala-backups/{base,dump/daily,dump/weekly,bundle,wal_archive,storage}
```
Put the `mac-pull` healthchecks URL (OFFSITE-ENABLE.md §2.7; period 6 h,
grace 48 h) into `HEALTHCHECKS_MAC_PULL_URL` when ready. When `lucashome` is
not on the tailnet the script exits 0 without pinging — healthchecks turns
red only after the 48 h grace.

`DEST` must be under `$HOME` (prune safety). The directory should **not** be
inside iCloud Drive / Desktop / Documents if those are iCloud-synced
(`~/shwephala-backups` is not).

## 3. launchd (every 6 h, and at login)

```
mac$ sed "s#__HOME__#$HOME#g" deploy/lucashome/backup/com.shwephala.backup-pull.plist > ~/Library/LaunchAgents/com.shwephala.backup-pull.plist
mac$ launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shwephala.backup-pull.plist
mac$ launchctl kickstart -k gui/$(id -u)/com.shwephala.backup-pull        # run now
mac$ launchctl print gui/$(id -u)/com.shwephala.backup-pull | grep -E 'state|last exit'
mac$ tail ~/Library/Logs/shwephala-pull.log
```
The template runs `mac-pull.sh --snapshot` (§4). Remove with
`launchctl bootout gui/$(id -u)/com.shwephala.backup-pull`. macOS may ask once
for *Full Disk Access* / network permission for `bash` — grant it to
`/bin/bash` under System Settings → Privacy & Security if the log shows
`Operation not permitted`.

## 4. Disk encryption, APFS snapshots, Time Machine

- **FileVault must be on** (`fdesetup status` → `FileVault is On.`; proposal §1
  assumes it — owner to confirm). The pulled files are plaintext (only the
  bundle is `age`-encrypted); the Mac's disk encryption is what protects them.
- **APFS local snapshots**: `--snapshot` runs `tmutil localsnapshot` after a
  successful pull, giving a point-in-time copy of the whole volume that a
  later accidental `rm -rf ~/shwephala-backups` or a sync bug cannot touch.
  List: `tmutil listlocalsnapshots /`; restore a file: Finder → Time Machine
  browser, or mount the snapshot
  (`mkdir /tmp/snap && mount_apfs -s com.apple.TimeMachine.<date>.local / /tmp/snap`).
  macOS thins local snapshots automatically (24 h / disk pressure), so they
  are a short-term safety net, not the retention mechanism; `tmutil
  localsnapshot` needs Time Machine to be set up at least once (it fails
  politely otherwise — the log says so).
- **Time Machine** to an external disk or NAS, if the owner has it, adds the
  long-term copy for free; make sure `~/shwephala-backups` is **not** excluded.
- The `age` private key `~/.config/age/shwephala-backup.key` (0600) is on the
  same volume; its copy in the password manager is the real safeguard.

## 5. Retention on the Mac

Applied by `mac-pull.sh` after every successful pull, only under `DEST`:
`base/<ts>`, `dump/daily/<ts>`, `dump/weekly/<week>_<ts>` and
`bundle/<ts>.tar.age` by the timestamp in their names (`KEEP_DAYS` /
`KEEP_BUNDLE_DAYS`), `wal_archive/*.gz` by mtime (`rsync -a` preserves it;
`*.history*` never). `storage/` is never pruned (it mirrors live data; a file
deleted on `lucashome` simply stays). Nothing on `lucashome` can shorten this.
`--no-prune` and `--dry-run` are available.

## 6. Using the Mac copy for a rebuild

When R2 is unavailable or wiped (OFFSITE-ENABLE.md §8.4): the Mac holds the
same `base/<ts>/`, `wal_archive/`, `dump/daily|weekly/`, `storage/`, and the
bundles. Push them to the (new) host over Tailscale with an interactive key:
```
mac$ rsync -a ~/shwephala-backups/base/<ts>/ lucashome:/srv/supabase/backups/base/<ts>/
mac$ rsync -a ~/shwephala-backups/wal_archive/ lucashome:/srv/supabase/stack/volumes/db/wal_archive/
mac$ rsync -a ~/shwephala-backups/storage/ lucashome:/srv/supabase/stack/volumes/storage/      # owner: storage container stopped
mac$ age -d -i ~/.config/age/shwephala-backup.key ~/shwephala-backups/bundle/<newest>.tar.age | tar -x -C ~/tmp/bundle
```
then OFFSITE-ENABLE.md §8.2 from step 3 (the bundle is already decrypted).
`backups/base/<ts>/SHA256SUMS` and the WAL gap check in `backup-status.sh`
validate what was pushed.

## 7. Checklist for the owner

1. §1 keys generated, two `authorized_keys` lines added on `lucashome`, the four verification commands behave as stated.
2. §2 script + `pull.env` installed, `--check` green, first pull done, `mac-pull` healthchecks URL set.
3. §3 launchd agent loaded; a scheduled run visible in the log.
4. §4 FileVault on; Time Machine (optional) includes `~/shwephala-backups`.
5. OFFSITE-ENABLE.md §6.2 bundle decrypt done once on this Mac.
