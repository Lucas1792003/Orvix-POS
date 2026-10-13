# lucashome — controlled reboot + host-hardening checklist

Status: **checklist, 2026-10-13 (UTC). Nothing in it has been executed.** No reboot, restart, stop, firewall, SSH, Tailscale, systemd, cron or file change was made. All findings come from read-only commands run as `lucario` on 2026-10-13 06:04–06:10 UTC via `ssh -o BatchMode=yes lucashome '<cmd>' </dev/null`, with no `sudo`. No secret values were read or printed: `.env*`, keys, `/etc/playit/playit.toml` and the netplan Wi-Fi file were checked for presence and permissions only.

This builds on and refreshes [`../next-phase/reboot-and-hardening.md`](../next-phase/reboot-and-hardening.md), the decision proposal with items W and H0–H10. That file has the long-form reasoning (ufw/Docker caveat, why no sshd `ListenAddress`, Tailscale ACL design, Studio options). **This file is the operator checklist**: current state, ranked gaps, and the exact steps for the window. Where the two disagree, this file has the newer host facts.

Cost: **$0**. Everything below uses packages already installed or free Ubuntu packages (`smartmontools`, `nvme-cli`), plus free Tailscale admin-console settings.

---

## 1. Current-state findings

Legend: **OK** fine for a reboot · **GAP** works today but is a risk · **?** cannot be seen without root.

### 1.1 Boot path

| # | Item | Finding | State | How checked |
|---|---|---|---|---|
| B1 | OS / kernel | Ubuntu 26.04.1 LTS, running `7.0.0-30-generic`, up 40 d 6 h (since 2026-09-02 23:47 UTC) | — | `cat /etc/os-release`, `uname -r`, `uptime` |
| B2 | Reboot pending | `/var/run/reboot-required` since **2026-10-08 06:45**. Pkgs: linux-image 7.0.0-31/-34/-38, linux-base, libc6. `/boot` holds `vmlinuz-7.0.0-30` and `-38` (+ initrd for both). **Next boot = 7.0.0-38**; 7.0.0-30 stays as the GRUB fallback | GAP (untested kernel) | `ls -l /var/run/reboot-required*`, `cat …pkgs`, `ls /boot` |
| B3 | Boot history | Last 8 boots on 7.0.0-30: **5 ended in `crash`** (2026-08-28 ×3, 2026-09-02 ×2). The current boot has been stable 40 d. `/var/crash` empty | GAP | `last -x reboot shutdown`, `journalctl --list-boots`, `ls /var/crash` |
| B4 | GRUB | `GRUB_DEFAULT=0`, `GRUB_TIMEOUT=0`, `GRUB_TIMEOUT_STYLE=hidden`. The menu is invisible unless you hold **Shift** (BIOS) or tap **Esc** (UEFI) during boot. After a failed boot Ubuntu's recordfail shows the menu (default 30 s) | GAP (fallback needs the keyboard) | `grep GRUB_ /etc/default/grub` |
| B5 | Kernel panic behaviour | `kernel.panic=0`, `panic_on_oops=1`. An oops becomes a panic and the machine **hangs forever** (no auto-reboot). `crashkernel` reserved (kdump) | GAP | `/proc/sys/kernel/panic*`, `/proc/cmdline` |
| B6 | Default target | `graphical.target`; sleep/suspend/hibernate/hybrid-sleep **masked**; `HandleLidSwitch*=ignore` (lid can be closed) | OK | `systemctl get-default`, `is-enabled sleep.target …`, logind.conf |
| B7 | Network at boot | Wi-Fi only (`wlp2s0`, 10.10.124.245/24, DHCP, gw 10.10.124.1) via netplan → systemd-networkd + `netplan-wpa-wlp2s0.service`. Comes up **without a user login**. Netplan file `00-installer-config.yaml` is 0600 root (not read) | OK | `ip -br addr`, `ip route`, `systemctl list-units`, `ls -l /etc/netplan` |
| B8 | Power | AC online=1; battery `Not charging` at 56 % with `charge_control_end_threshold=50` (charge limit active). Health 86.7/95.1 Wh ≈ 91 %. The battery is the only UPS (≈ 1–2 h at this load, not measured). No NUT/upower policy for a clean shutdown on low battery | GAP | `/sys/class/power_supply/BAT0/*`, `AC*/online` |
| B9 | BIOS power-on after AC loss | **Physical item, not checkable remotely.** On a laptop, "restore on AC power loss" usually doesn't exist; with a charged battery the laptop just stays on | ? | — |

### 1.2 Storage and mounts

| # | Item | Finding | State | How checked |
|---|---|---|---|---|
| S1 | Layout | One NVMe `WDC PC SN730 1 TB`: p1 `/boot/efi` (vfat 1 G), p2 `/boot` (ext4 2 G), p3 LVM → `ubuntu-lv` `/` (100 G) + `server-data` `/srv` (800 G) | — | `lsblk`, `/sys/class/nvme/nvme0/model` |
| S2 | `/srv` in fstab | `UUID=27a4… /srv ext4 defaults 0 2`. **No `nofail`**, so `srv.mount` is `RequiredBy=local-fs.target` and `Before=local-fs.target` | OK | `/etc/fstab`, `systemctl show srv.mount` |
| S3 | `/srv` before Docker | `docker.service` has `After=sysinit.target` (sysinit waits for local-fs.target), so `/srv` is mounted before dockerd starts. No explicit `RequiresMountsFor=/srv`, and no drop-in under `/etc/systemd/system/docker.service.d` | OK (implicit) | `systemctl show docker -p After,Requires,RequiresMountsFor` |
| S4 | Failure mode if `/srv` fails fsck/mount | local-fs.target fails → **emergency mode**: no network, no SSH, console only. Docker never starts, so the db cannot initdb into an empty dir on `/` | GAP (console-only recovery) | inferred from S2/S3 |
| S5 | DB bind mounts | `supabase-db` uses 12 legacy `HostConfig.Binds` (PGDATA `/srv/supabase/stack/volumes/db/data`, `wal_archive`, `10-wal-archive.conf`, `pg_hba.conf`, init SQL) + named volume `supabase_db-config` (pgsodium root key) under `/var/lib/docker` on `/`. Legacy binds **auto-create a missing source dir**, which is why S3/S4 matter | OK given S2 | `docker inspect supabase-db`, `docker compose config` |
| S6 | Disk usage | `/` 35 G used / 59 G free (38 %), inodes 11 %; `/srv` 16 G / 731 G free (3 %), inodes 1 %; `/boot` 11 %; `/boot/efi` 1 % | OK | `df -h`, `df -i` |
| S7 | Docker space on `/` | images 22.2 GB (**99 % reclaimable**), build cache 4.8 GB (4.0 GB reclaimable), volumes 1.2 GB; journald 198 MB | OK (cleanup available) | `docker system df`, `journalctl --disk-usage` |
| S8 | WAL archive | `/srv/supabase/stack/volumes/db/wal_archive`, mode 0770 uid 100/gid 101 (shows as `usbmux:lxd` on the host). 394 files, 32–33 MB; **307 segments ≈ 27 MB in the last 24 h** (`archive_timeout=300` forces ≥ 288/day). Range `…0009`..`…0186`. Growth is ~0.8 GB/month before prune; prune keeps ≥ the oldest base | OK | `du`, `find -mmin -1440`, `backup-status.sh` |
| S9 | NVMe SMART | `/dev/nvme0` is `crw------- root`; `smartctl` and `nvme` not installed; `smartd` absent | ? | `ls -l /dev/nvme0`, `command -v` |

### 1.3 Docker and the Supabase stack

| # | Item | Finding | State | How checked |
|---|---|---|---|---|
| D1 | Daemons | `docker` enabled+active, `docker.socket` enabled+active, `containerd` enabled+active. Packages: Ubuntu `docker.io 29.1.3-0ubuntu4.1`, `containerd 2.2.2`, `runc 1.4.0`, `docker-compose-v2 2.40.3` | OK | `systemctl is-enabled/is-active`, `dpkg -l` |
| D2 | `daemon.json` | **absent**: `LiveRestore=false`, no default log limits (json-file, unbounded for non-Supabase containers) | GAP | `ls /etc/docker`, `docker info` |
| D3 | How the stack returns at boot | **No systemd unit.** All 10 Supabase containers have `restart: unless-stopped`, so dockerd restarts them itself when it starts. ⚠ A container stopped with `docker stop` / `docker compose stop` stays **stopped** after a reboot. Never stop the stack "to be safe" before rebooting | OK (with that caveat) | `docker inspect … RestartPolicy`, `docker compose config` |
| D4 | `depends_on` | api-gw→studio(healthy); auth, rest, meta, realtime → db(healthy); storage → db(healthy)+imgproxy+rest(started); functions → api-gw(healthy); db, imgproxy, studio none. **These only apply to `docker compose up`.** On a daemon/boot restart, dockerd starts all containers in parallel with no ordering. Dependants that lose the race exit and are retried by the restart policy (100 ms backoff doubling, max 1 min). Realtime did exactly that on the 2026-10-11 db restart (`RestartCount=1` today) | GAP (self-healing, untested at boot) | `docker compose config --format json \| jq .services[].depends_on` |
| D5 | Healthchecks | db `pg_isready` 5 s×10; auth/storage `wget` 5 s×3; rest `postgrest --ready`; meta/studio `node fetch`; functions/envoy TCP probe; imgproxy `imgproxy health`; realtime `curl` tenant health 30 s×3. The realtime check embeds the stack's **anon JWT** in its config. That key is public by design, but `docker inspect` output must still not be pasted into docs | OK | `docker inspect … .Config.Healthcheck` |
| D6 | Current health | 10/10 `healthy`; db + realtime started 2026-10-11 23:49, the others 21:54 | OK | `docker compose ps` |
| D7 | Limits / logs (Supabase) | mem: db 2 G; storage/functions/realtime/studio 512 M; auth/rest/meta/envoy/imgproxy 256 M. json-file 20 MB × 5 on all 10 | OK | `docker inspect … Memory, LogConfig` |
| D8 | Stop timeout | No `StopTimeout` set, so Docker's **10 s default** applies before SIGKILL. db stop signal `SIGINT` (Postgres fast shutdown: fine for this 6 MB-base DB). `docker.service` `TimeoutStopUSec=infinity`, `KillMode=process` | OK for db; GAP for minecraft (see O3) | `docker inspect … StopTimeout,StopSignal`, `systemctl show docker` |
| D9 | Gateway exposure | `supabase-envoy` publishes `127.0.0.1:8000` only; Supavisor removed | OK | `docker ps` ports, `ss -tln` |

### 1.4 Database, WAL and backups

| # | Item | Finding | State | How checked |
|---|---|---|---|---|
| P1 | DB | schema version **080**; `pg_is_in_recovery=f`; LSN `1/870007B8` @ 06:06:35 UTC; `wal_level=logical`, `archive_mode=on`, `archive_timeout=300`, `max_wal_size=1024 MB` | OK | `psql -XAt` (SELECT only) |
| P2 | Archiver | `archived=394 failed=0`, last `…0186` at 06:03:58, `pending=0`. Note: `pg_stat_archiver` counters survive a clean shutdown but **reset to 0 after a crash/SIGKILL**. Post-reboot checks must test `failed=0` and a new `last_archived_wal`, not "archived went up" | OK | `pg_stat_archiver`, `backup-status.sh` |
| P3 | Latest verified backups | logical 05:39:02Z and base `20261013T053857Z` (05:38:59Z, `pg_verifybackup` OK), recorded as post-080 LSN `1/82004780` in `migration-checkpoints.txt`. Restore drill 2026-10-11 OK; PITR drill 2026-10-11 OK (lag 223 ms) | OK | `backup-status.sh`, `tail migration-checkpoints.txt` |
| P4 | Retention | dump hourly 48/48, daily 3/14, weekly 2/8; base 13/14; 112 MB total | OK | `backup-status.sh` |
| P5 | Monitoring | `backup-status.sh --quiet` every 30 min writes `logs/backup-status.log` (STATUS OK). **Nothing alerts off-box**: no healthchecks.io URL configured, `MAILTO=""`, and offsite is disabled. A dead host or a failing backup is noticed only when someone looks | GAP | `crontab -l`, status output |
| P6 | Offsite | `OFFSITE_ENABLED=false`. Every backup, the WAL archive and the `pgsodium_root.key` copies (inside each base dir) are on the **same NVMe** | GAP (top) | `backup-status.sh`, `ls base/<ts>/` (names only) |

### 1.5 Scheduling, time, memory

| # | Item | Finding | State | How checked |
|---|---|---|---|---|
| C1 | cron | `cron.service` enabled+active. `lucario` crontab = the 4 lines of [`crontab.lucario`](../../../deploy/lucashome/backup/crontab.lucario): `15 * * * *` logical, `30 2 * * *` base, `30 3 * * 0` restore-test, `*/30 * * * *` status. Offsite lines absent (commented in the repo copy). `MAILTO=""`. User cron needs no linger (`Linger=no` is fine) | OK | `systemctl is-enabled cron`, `crontab -l` |
| C2 | Time | TZ `Etc/UTC`; **chrony** enabled+active (systemd-timesyncd not installed), synced to `ntp-nts-2.ps6.canonical.com`, offset 0.7 ms, leap normal | OK | `timedatectl`, `chronyc tracking` |
| C3 | Memory | 14 GiB, 7.2 used, 7.4 available; **swap 2.0 / 4.0 GiB used** (`/swap.img`, swappiness 60) | GAP (minor) | `free -h`, `swapon --show` |
| C4 | Unlimited containers | house-*, minecraft (`MEMORY=4G` heap), `postgres`, open-webui have `mem=0` (no limit) and default unbounded json-file logs | GAP | `docker inspect … Memory, LogConfig` |
| C5 | Journald | persistent (`/var/log/journal`), 198 MB; 118 `err`-priority lines this boot, the recent ones all benign `networkctl … veth not found` | OK | `journalctl -b -p err` |

### 1.6 Tailscale

| # | Item | Finding | State | How checked |
|---|---|---|---|---|
| T1 | Daemon | `tailscaled` enabled+active, `Restart=on-failure`, state `/var/lib/tailscale/tailscaled.state` (dir not readable by lucario: OK). Package 1.102.3 (1.104.1 available from the Tailscale repo, which unattended-upgrades does not cover) | OK | `systemctl`, `tailscale version`, `apt list --upgradable` |
| T2 | Prefs | `BackendState=Running`, `WantRunning=true`, `LoggedOut=false`, **`OperatorUser=lucario`**, `RunSSH=false`, `ShieldsUp=false`, no routes, `CorpDNS=true` | OK | `tailscale debug prefs \| jq` (selected fields) |
| T3 | Serve | `https://lucashome.tail8a86e4.ts.net (tailnet only)` → `/ proxy http://127.0.0.1:8000`. Created with `--bg`, so it is stored in tailscaled state and **persists across a restart/reboot**. Funnel status lists the same, *tailnet only* (no Funnel). Node has the `funnel` capability attribute (tailnet policy) but no Funnel config | OK | `tailscale serve status`, `tailscale funnel status`, `.Self.CapMap` key |
| T4 | Cert | LE cert `notAfter=Jan 9 21:12:22 2027 GMT`; HTTPS probe `/auth/v1/health` → 401 in 0.07 s (TLS + gateway up) | OK | `openssl s_client`, `curl` from the Mac |
| T5 | Node key expiry | `.Self.KeyExpiry = 2027-03-15T03:53:46Z` (153 days), untagged (`Tags=null`). Expiry ⇒ the node drops off the tailnet until someone re-authenticates **at the console** | GAP | `tailscale status --json \| jq .Self.KeyExpiry` |
| T6 | Peers / path | tailnet `waiyanpaing183@gmail.com`; peers cyfro-staging, cyfrosec-server (shared), househub, lucas (Windows, offline), wais-macbook-air. Self relay `tor` (DERP); Mac→lucashome active via relay | OK | `tailscale status` |
| T7 | Stale listeners | `100.95.109.83:443` and `[fd7a:…:a101:6dcc]:443` (old tailnet IPs) still bound next to the live `100.74.43.4:443` / `[fd7a:…:a835:2b05]:443`. A reboot clears them | GAP (cosmetic) | `ss -tln` |

### 1.7 Network exposure, firewall, SSH, updates

| # | Item | Finding | State | How checked |
|---|---|---|---|---|
| N1 | Firewall | `/etc/ufw/ufw.conf`: **`ENABLED=no`**. `ufw.service` is enabled+active, but with ENABLED=no it loads no rules. `user.rules` (307 B) / `user6.rules` exist, 0640 root, unreadable. iptables/nft rules are unreadable without root. Effectively **no host firewall** apart from Docker's own chains | GAP | `cat ufw.conf`, `ls -l /etc/ufw`, `systemctl` |
| N2 | 0.0.0.0 / [::] listeners | **22** sshd (`ssh.socket`, `ListenStream=0.0.0.0:22` + `[::]:22`), **80** nginx (sites `default`, `ollama`), **3000** open-webui (docker), **3100** house-app (docker, v4 only), **25565/tcp + 19132/udp** minecraft (docker), udp **41641** tailscaled, udp 41201/56474 and `*:42038`/`*:43263` (root-owned, likely tailscaled/playit; owner not visible without root) | GAP | `ss -tlnpuH` (no process info for root sockets) |
| N3 | Loopback only | 8000 Supabase gateway, 5432 `postgres:18`, 11434 ollama (`OLLAMA_HOST=127.0.0.1:11434`), 11435 (nginx→ollama), **41917** (owner unknown, root), 53 resolved, 323 chrony | OK | `ss`, `systemctl show ollama -p Environment` |
| N4 | Tailnet only | 443 on 100.74.43.4 / fd7a…2b05 (tailscaled serve); 100.74.43.4:59508 and fd7a…:63375 (tailscaled) | OK | `ss` |
| N5 | LAN reachability | Everything in N2 is reachable from the home LAN 10.10.124.0/24 and, if the router forwards ports (unknown), from the internet. Minecraft is also published via **playit** (outbound tunnel) | GAP | inferred; router config not visible |
| N6 | sshd | `sshd_config`: `Include sshd_config.d/*.conf`, `KbdInteractiveAuthentication no`; no explicit `PasswordAuthentication`/`PermitRootLogin`/`ListenAddress`/`Port`. `sshd_config.d/50-cloud-init.conf` is 27 bytes, 0600 root, which is exactly the length of `PasswordAuthentication yes\n`, so **password auth is very likely ON** (effective config needs `sudo sshd -T`). `PermitRootLogin` default = `prohibit-password`. fail2ban not installed. Socket activation (`ssh.socket` enabled) | GAP | `grep` on sshd_config, `ls -l sshd_config.d`, `systemctl cat ssh.socket` |
| N7 | Unattended upgrades | enabled; `Update-Package-Lists "1"`, `Unattended-Upgrade "1"`; origins = release + **-security** + ESM; blacklist empty; `Automatic-Reboot` not set (default false). Last run 2026-10-13 02:58. `docker.io`/`containerd`/`runc` come from the Ubuntu archive, so a **security update to them restarts dockerd and every container** (with `live-restore=false`) | GAP | `/etc/apt/apt.conf.d/20auto-upgrades`, `50unattended-upgrades`, log tail, `dpkg -l` |
| N8 | needrestart | installed (3.11), apt hook `-m u`; `$nrconf{restart}` left at the package default; `qr(^docker) => 0` override, so needrestart never restarts docker itself | OK | `needrestart.conf`, `99needrestart` |
| N9 | Upgradable | 30 packages incl. `openssh-server/-client/-sftp-server 1:10.2p1-2ubuntu3.7` (from `-updates`, so **not** auto-installed) and tailscale 1.104.1. **Do not upgrade in the reboot window** | — | `apt list --upgradable` |
| N10 | Sudo | `lucario` is in `sudo`, `docker`, `adm`, `lxd`, `playit`, `ollama`. Sudo needs the owner's password | — | `id` |

### 1.8 Unrelated home services (must survive the reboot; do not touch)

| # | Service | Type / how it starts | Ports | Restart / health | Notes |
|---|---|---|---|---|---|
| O1 | **house** (compose project `house`, `/home/lucario/personal/House`): `house-app-1` (`house-app:latest`), `house-postgres-1` (`postgres:17`), `house-tailscale-1` (`tailscale/tailscale:stable` → node **househub**, `100.123.108.123`, **Funnel on** `https://househub.tail8a86e4.ts.net`, key expiry 2027-03-27) | docker, `unless-stopped` | 3100→3000 (v4 all ifaces) | app + postgres healthy; tailscale no healthcheck | tailscale state on volume `house_tailscale_state` (persists); serve config bind `docker/tailscale-serve.json` |
| O2 | **minecraft** (`itzg/minecraft-server:latest`, project `minecraft`, `/srv/minecraft/data`) | docker, `unless-stopped` | 25565/tcp, 19132/udp (v4+v6) | healthy (`mc-health`) | heap 4 G, no mem limit; also tunnelled by **playit** |
| O3 | Minecraft shutdown | Docker kills after 10 s (D8). An itzg server usually saves within that, but a large world may not | — | — | owner may run `docker exec minecraft rcon-cli save-all` before the reboot (optional, owner's call) |
| O4 | **postgres** (`postgres:18`, plain `docker run`) | docker, `unless-stopped` | 127.0.0.1:5432 | no healthcheck | unknown consumer |
| O5 | **open-webui** (`ghcr.io/open-webui/open-webui:main`, plain `docker run`) | docker, `unless-stopped` | 0.0.0.0/[::]:3000→8080 | healthy | `:main` tag, so a re-pull would change the version; don't pull |
| O6 | **ollama** | systemd, enabled | 127.0.0.1:11434 | — | |
| O7 | **nginx** | systemd, enabled | 0.0.0.0/[::]:80, 127.0.0.1:11435 | — | sites `default`, `ollama` |
| O8 | **playit** (`/opt/playit/playitd`, user `playit`) | systemd, enabled | outbound tunnel | — | secret in `/etc/playit/playit.toml`: never print |
| O9 | Base | ssh(.socket), tailscaled, cron, chrony, docker, containerd, unattended-upgrades, apparmor, systemd-networkd/resolved, wpa_supplicant, rsyslog, fwupd, ModemManager, multipathd, udisks2, upower, polkit | — | all enabled | |

Full list of running services at check time: chrony, containerd, cron, dbus, docker, fwupd, getty@tty1/tty2, ModemManager, multipathd, netplan-wpa-wlp2s0, networkd-dispatcher, nginx, ollama, playit, polkit, rsyslog, ssh, systemd-journald/logind/networkd/resolved/udevd, tailscaled, udisks2, unattended-upgrades, upower, user@1000, wpa_supplicant.

---

## 2. Gaps and risks, ranked

| Rank | Risk | Impact | Likelihood | Fix (section 8) |
|---|---|---|---|---|
| 1 | **Single NVMe, no offsite copy.** All backups, WAL and pgsodium key copies are on the disk being rebooted (P6) | total data loss if the disk dies | low per event, unbounded | Owner chose email backups (2026-10-13); no R2 and no Mac tier. Before the reboot: a weekly encrypted email archive must have been delivered and confirmed (step A6) — see [email-backup-design.md](email-backup-design.md) |
| 2 | **First boot of kernel 7.0.0-38 on a box with 5/8 crashed boots** (B2, B3); GRUB menu hidden (B4); `kernel.panic=0` hangs on panic (B5) | host down until someone is at the keyboard | medium | Owner at the console for the window; H-K1 `kernel.panic=10`; H-K2 visible GRUB menu |
| 3 | **Boot-time container race** (D4): `depends_on` ignored on daemon restart; auth/rest/realtime/storage may crash-loop until db is healthy | slower recovery; G3 fails if anything needs a hand-start | medium (self-heals in tests so far) | Observe in the window. If it needs a hand-start, add H-D3 (systemd unit running `docker compose up -d --wait`) |
| 4 | **No off-box alerting** (P5) | outage or backup failure goes unnoticed | high over time | H-M1 healthchecks.io free ping + H-M2 disk thresholds |
| 5 | **No host firewall + sshd on 0.0.0.0 with password auth likely on** (N1, N2, N6) | LAN/WAN brute force; exposure of open-webui 3000, house 3100, nginx 80 | depends on router forwards (unknown) | H-F1 ufw, H-S1 sshd key-only, H-F2 Docker port rebinding (owner's projects) |
| 6 | **Unattended security upgrade of docker.io/containerd restarts all containers** (N7, D2) | unplanned 1–2 min outage of POS + home services | low-medium | H-D1 `live-restore`, optionally H-U1 blacklist |
| 7 | **Tailscale node key expires 2027-03-15** (T5) | POS backend off the tailnet; needs console re-auth | certain if not changed | H-T1 disable key expiry (admin console) |
| 8 | **`/srv` fsck/mount failure → emergency mode** (S4) | console-only recovery | low | Section 7.4; optional H-D2 `RequiresMountsFor=/srv` (belt and braces) |
| 9 | Unlimited memory/logs on non-Supabase containers; swap 2 G used (C3, C4, D2) | OOM pressure on db (2 G limit, but host-wide OOM can pick anything); `/` fill from logs | low-medium | H-D1 default log limits; H-D4 mem limits (owner's containers) |
| 10 | No SMART visibility (S9) | silent disk wear | low | H-M3 `smartmontools` |
| 11 | Laptop on Wi-Fi, battery as UPS without a shutdown policy (B7, B8) | long outage drains battery, then a hard power-off | low | H-P1 (`upower` critical action) or accept; physical: Ethernet if possible |
| 12 | Stale tailnet 443 listeners (T7) | cosmetic | — | cleared by the reboot |

**Tills and offline queueing:** today **no till talks to lucashome**. The published desktop v1.0.15 points at hosted Supabase, so this reboot has no POS-sales impact. The client's owner-decided offline window is 12 h for writes / 24 h for reads from the last authenticated contact, far above a ≤ 2 h outage. Once tills are on lucashome (1.0.16+), step A2 below becomes mandatory.

---

## 3. Pre-reboot checklist

Do every item; any **NO** → stop and reschedule. The engineer runs A1–A6 from the Mac as `lucario` (no sudo). The owner does A0/A2/A7.

| # | Step | Command / action | Pass |
|---|---|---|---|
| A0 | Owner approval in writing; owner (or someone who can use the keyboard) **physically at the laptop**, with monitor/keyboard reachable, AC charger plugged in, knows `lucario`'s local console password | — | yes |
| A1 | Window choice: avoid :15 (hourly dump), 02:30 (base), Sun 03:30 (restore drill), :00/:30 (status). **Good slot: hh:35–hh:55**, not Sunday 03:xx | — | agreed |
| A2 | Announce to family/users: house app (househub), Minecraft (+playit), open-webui, ollama will drop for ~5 min (up to 30 if the kernel misbehaves). **Tills:** if any till is on lucashome by then, confirm each shows its offline banner and queues sales (outbox) and that the outage target is ≤ 2 h. Otherwise note "no tills on lucashome" | message sent | yes |
| A3 | Baseline snapshot | `mkdir -p ~/g3 && cd ~/g3`<br>`ssh -o BatchMode=yes lucashome 'docker ps -a --format "{{.Names}} {{.Status}}"' </dev/null \| sort > pre-docker.txt`<br>`ssh -o BatchMode=yes lucashome 'cd /srv/supabase/stack && docker compose ps --format "{{.Service}} {{.Health}}"' </dev/null > pre-health.txt`<br>`ssh -o BatchMode=yes lucashome 'docker inspect --format "{{.Name}} {{.RestartCount}}" $(docker ps -q)' </dev/null > pre-restarts.txt`<br>`ssh -o BatchMode=yes lucashome 'uname -r; uptime -s; tailscale serve status; tailscale funnel status; crontab -l; ss -Htlnu; systemctl list-units --type=service --state=running --no-legend --plain \| cut -d" " -f1' </dev/null > pre-host.txt`<br>`echo \| openssl s_client -connect lucashome.tail8a86e4.ts.net:443 -servername lucashome.tail8a86e4.ts.net 2>/dev/null \| openssl x509 -noout -enddate > pre-cert.txt` | 16 containers listed; 10/10 healthy; cert `Jan 9 … 2027` |
| A4 | Fresh logical + verified base (normal cron scripts, write only under `/srv/supabase/backups`) | `ssh -o BatchMode=yes lucashome '/srv/supabase/backup/bin/backup-logical.sh && /srv/supabase/backup/bin/backup-base.sh && /srv/supabase/backup/bin/backup-status.sh' </dev/null \| tail -n 25 \| tee pre-backup.txt` | both `ok`, new base dir, `STATUS: OK`, WAL `failed=0 pending=0` |
| A5 | Record LSN | `ssh -o BatchMode=yes lucashome 'cd /srv/supabase/stack && B=$(ls -1 /srv/supabase/backups/base \| tail -1); L=$(docker compose exec -T db psql -U supabase_admin -d postgres -XAtc "select pg_current_wal_lsn()" </dev/null); echo "$L\|$(date -u "+%F %H:%M UTC")\|pre-reboot base=$B verified" \| tee -a /srv/supabase/backups/migration-checkpoints.txt'` | line appended (LSN, base name) |
| A6 | Offsite copy for this window: the most recent weekly **encrypted email archive** was delivered and the owner confirmed receipt (once email backups are enabled). Until then, the owner accepts that the only copies are on this disk, or approves a one-off encrypted archive send first | owner confirms archive id + part count from the daily report / inbox | archive id recorded |
| A7 | No other change in flight: no migration, no stack edit, no `apt upgrade` (30 pending upgrades must **not** be pulled in) | — | yes |
| A8 | Note the archiver state | `ssh … 'backup-status.sh' \| grep "wal archive:"` → `pre-wal.txt` | `failed=0` |

**Do not** run `docker compose stop` / `docker stop` before the reboot (D3: `unless-stopped` containers you stop yourself stay stopped after boot).

---

## 4. Controlled reboot procedure

Roles: **owner** at the console (sudo); **engineer** on the Mac.

| t (approx.) | Who | Step |
|---|---|---|
| T−2 min | engineer | Start the probe (no key sent; any 200/401 = up, `000` = down):<br>`while :; do printf '%s %s\n' "$(date -u +%T)" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' https://lucashome.tail8a86e4.ts.net/auth/v1/health)"; sleep 10; done \| tee ~/g3/probe.log` |
| T−1 min | owner (optional, own call) | `docker exec minecraft rcon-cli save-all` (O3) |
| T−30 s | owner | Optional, shortens db shutdown: `cd /srv/supabase/stack && docker compose exec -T db psql -U supabase_admin -d postgres -c 'CHECKPOINT' </dev/null` |
| **T0** | owner | `date -u` (write it down) then **`sudo systemctl reboot`**. Do not use `shutdown -h`/power button; do not `apt upgrade` first |
| T0 → +30 s | — | systemd stops units; dockerd stops containers (≤ 10 s each, in parallel); Postgres fast shutdown via SIGINT; tailscaled down. Probe → `000` |
| +30 s → +75 s | — | firmware POST + GRUB (hidden, timeout 0) + kernel 7.0.0-38 + initrd. **Watch the screen**: a panic or hang shows here |
| +60 s → +100 s | — | fsck/mount `/`, `/boot`, `/srv` → local-fs.target; systemd-networkd + wpa_supplicant join Wi-Fi (10–20 s); chrony; tailscaled starts and reconnects (DERP 5–20 s), restoring serve + cert from state |
| +70 s → +150 s | — | dockerd starts, all 16 `unless-stopped` containers start **in parallel**; db ready in ~5–20 s (crash recovery adds seconds if it was killed); auth/rest/realtime/storage/meta may exit once and be restarted by Docker (backoff ≤ 1 min) |
| +2 → +4 min | — | Supabase 10/10 healthy (the slowest healthcheck interval is realtime's 30 s ×3); probe returns `401` |
| **+5 min** | engineer | **G3 deadline:** everything in section 5 must pass with no manual action. Hand-starting anything = G3 fail (record it, restore service, retry in a later window) |
| +10 min | owner | if the probe is still `000` → section 7 |

Expected POS downtime: **2–4 min** nominal, 5 min budget; ~30 min worst case with a kernel fallback at the console. Whole window incl. pre/post checks: 60–90 min.

---

## 5. Post-reboot verification

Run from the Mac (`ssh -o BatchMode=yes lucashome '<cmd>' </dev/null`). Record raw output in `docs/selfhost-migration/evidence/G3/<date>-reboot.md`.

| # | Check | Command | Pass |
|---|---|---|---|
| V1 | New kernel, reboot flag cleared | `uptime -s; uname -r; test -e /var/run/reboot-required && echo STILL-REQUIRED \|\| echo cleared` | boot after T0; `7.0.0-38-generic`; `cleared` |
| V2 | Base services | `systemctl is-active docker containerd tailscaled ssh.socket cron chrony nginx ollama playit` | all `active` |
| V3 | Mounts | `findmnt -no TARGET,SOURCE /srv; df -h / /srv` | `/srv` on `ubuntu--vg-server--data`; free ≈ as before |
| V4 | **Stack 10/10 healthy** | `cd /srv/supabase/stack && docker compose ps --format "{{.Service}} {{.Health}}"` and `docker compose ps --format json \| jq -r .Health \| sort \| uniq -c` | `10 healthy`; diff vs `pre-health.txt` empty |
| V5 | All 16 containers back, none hand-started | `docker ps -a --format "{{.Names}} {{.Status}}" \| sort` (diff vs `pre-docker.txt`); `docker inspect --format "{{.Name}} {{.RestartCount}} {{.State.StartedAt}}" $(docker ps -q)` | 16 `Up`; latest `StartedAt` ≤ boot + 5 min; note any RestartCount increase (expected for race-losers, D4) |
| V6 | **Tailscale + serve HTTPS** | `tailscale status --self; tailscale serve status; tailscale funnel status`; from the Mac: `curl -s -o /dev/null -w '%{http_code}\n' https://lucashome.tail8a86e4.ts.net/auth/v1/health`; `openssl … -enddate` | Running; serve output identical to `pre-host.txt`, *tailnet only*; `401`; `notAfter=Jan 9 21:12:22 2027 GMT` |
| V7 | Stale listeners gone | `ss -Htln \| grep -cE '100\.95\.109\.83\|a101:6dcc'` | `0` |
| V8 | Gateway still loopback-only | `ss -Htln \| grep ':8000 '` | only `127.0.0.1:8000` |
| V9 | **DB accepts writes** | `cd /srv/supabase/stack && docker compose exec -T db psql -U supabase_admin -d postgres -XAtc "select pg_is_in_recovery(), txid_current(), pg_current_wal_lsn()" </dev/null` | `f`, an xid, LSN > the A5 value |
| V10 | **WAL archiving resumes, failed=0** | `docker compose exec -T db psql -U supabase_admin -d postgres -XAtc "select pg_switch_wal()" </dev/null; sleep 20; docker compose exec -T db psql -U supabase_admin -d postgres -XAtc "select archived_count, failed_count, last_archived_wal, last_archived_time from pg_stat_archiver" </dev/null` then `/srv/supabase/backup/bin/backup-status.sh \| grep -A1 'wal archive:'` | `failed_count=0`; `last_archived_wal` newer than in `pre-wal.txt`, `last_archived_time` after boot; `pending=0`; no gap reported (`archived` may have reset to a low number after an unclean stop, which is fine) |
| V11 | Data unchanged | compare the next hourly `counts.json` with the A4 one: `cd /srv/supabase/backups/dump/hourly && diff <(jq -S .tables <A4-ts>/counts.json) <(jq -S .tables $(ls -1d * \| tail -1)/counts.json) && echo SAME` | `SAME` |
| V12 | Schema version | `… -XAtc "select max(version) from supabase_migrations.schema_migrations"` | `080` (or whatever is current) |
| V13 | **cron running** | `systemctl is-active cron; crontab -l \| grep -c '/srv/supabase/backup/bin'`; after the next :00/:30: `tail -n 3 /srv/supabase/backups/logs/backup-status.log`; `journalctl -u cron --since "-40 min" --no-pager \| grep -c CMD` | `active`; `4`; a fresh run logged after boot |
| V14 | **backup-status OK** | `/srv/supabase/backup/bin/backup-status.sh` | `STATUS: OK` |
| V15 | Realtime | `docker inspect --format '{{.State.Health.Status}} {{.RestartCount}}' realtime-dev.supabase-realtime` | `healthy` |
| V16 | Storage / REST via serve | `curl -s -o /dev/null -w '%{http_code}\n' https://lucashome.tail8a86e4.ts.net/storage/v1/status` and `…/rest/v1/` | `200` and `401` (no key sent) |
| V17 | **Phone-upload route** (edge function `phone-upload-token`) | `B=https://lucashome.tail8a86e4.ts.net; curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS -H 'Origin: http://localhost' $B/functions/v1/phone-upload-token; curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/functions/v1/phone-upload-token` | `200` then `401` (baseline 2026-10-13: 200/401). Optional full check: one real-UI phone upload per [`../phase-g/phone-upload-jit.md`](../phase-g/phone-upload-jit.md) (writes a QA image, so needs separate approval) |
| V18 | **Unrelated services** | `docker ps --format "{{.Names}} {{.Status}}" \| grep -E '^(house-app-1\|house-postgres-1\|house-tailscale-1\|minecraft\|postgres\|open-webui) '`; `systemctl is-active nginx ollama playit`; `docker exec house-tailscale-1 tailscale status --self \| head -1`; `curl -s -o /dev/null -w '%{http_code}\n' https://househub.tail8a86e4.ts.net/api/health`; `ss -Htlnu \| grep -E ':(25565\|19132\|3000\|3100\|80) '` | 6 containers Up (healthy where applicable); 3× active; househub online; house health 200; ports back as in `pre-host.txt`. A miss is reported to the owner but does not fail POS G3 unless the owner says so |
| V19 | Time / memory | `chronyc tracking \| grep -E 'Leap\|System time'; free -h` | synced; swap now ~0 (record) |
| V20 | Errors this boot | `journalctl -b -p err --no-pager \| grep -vE 'networkctl.*veth' \| tail -20`; `dmesg` needs root, so the owner runs `sudo dmesg -l err,crit \| tail` | nothing new (amdgpu/i2c errors are a finding) |

Stop the probe and record the first non-`000` timestamp (the downtime).

---

## 6. G3 pass/fail

**Pass** = V1–V17 green within 5 min of `uptime -s` with **no manual action**. Hand-started anything (`docker compose up`, `tailscale serve`, `systemctl start`) = **fail**, even if service is restored. Write the evidence and decide on H-D3 (systemd unit) before retesting.

---

## 7. Rollback and physical recovery

All of these happen **at the laptop** (monitor/keyboard). Network-level tools are useless until the box is on Wi-Fi and the tailnet.

### 7.1 No probe answer after 10 min
1. Look at the screen: black/firmware → hold power 10 s, power on. Kernel panic text or frozen boot → hard power cycle.
2. At power-on tap **Esc** (UEFI) or hold **Shift** to show GRUB → *Advanced options for Ubuntu* → **`Ubuntu, with Linux 7.0.0-30-generic`**. After a failed boot the menu usually appears on its own (recordfail).
3. Booted OK on -30 → record 7.0.0-38 as a finding (G3 fail on the new kernel). The default stays -38 until the owner pins `GRUB_DEFAULT` (separate approval).

### 7.2 Emergency mode / `/srv` did not mount (S4)
1. Console prompt "You are in emergency mode" → enter the root password (or press Enter if root is locked → use GRUB *recovery mode*).
2. `journalctl -xb | grep -iE 'srv|fsck|lvm'`; `lvs`; `fsck -f /dev/mapper/ubuntu--vg-server--data` (only with the owner's OK; read the prompt carefully); `mount /srv`; `systemctl default`.
3. **Never** let docker start with `/srv` missing. If you must boot without `/srv`, first `systemctl mask docker.service docker.socket`, then unmask after `/srv` is back.

### 7.3 Console login, docker and stack by hand
```
login: lucario (local password)
systemctl is-active docker containerd || sudo systemctl start containerd docker
cd /srv/supabase/stack && docker compose up -d --wait        # honours depends_on; ~1–2 min
docker compose ps --format "{{.Service}} {{.Health}}"
# other projects only if they did not return by themselves (owner's call):
#   cd /home/lucario/personal/House && docker compose up -d ;  cd /srv/minecraft && docker compose up -d
#   docker start postgres open-webui
```
db unhealthy: `docker compose logs --tail 100 db`. If PGDATA is damaged, stop and restore from the A4 base + WAL per [`../../../deploy/lucashome/backup/README.md`](../../../deploy/lucashome/backup/README.md) §B, **only after owner approval** (target the A5 LSN). The latest emailed encrypted archive (A6) is the second source.

### 7.4 Wi-Fi / Tailscale
- No IP: `networkctl status wlp2s0`; `sudo systemctl restart systemd-networkd netplan-wpa-wlp2s0` (owner). As a stopgap, plug in a USB-Ethernet adapter if available.
- tailscaled not running: `sudo systemctl start tailscaled`; `tailscale status`.
- Serve missing: `tailscale serve --bg --https=443 http://127.0.0.1:8000` (`lucario` is operator, no sudo). Confirm `tailscale funnel status` shows *tailnet only*.
- **Node key expired / logged out** (`tailscale status` shows "Logged out" or "NeedsLogin"): `sudo tailscale up` prints a login URL → owner opens it on a phone/Mac and signs in with the tailnet owner account (`waiyanpaing183@gmail.com`). **Do not** add `--reset` or other flags: `up` keeps the operator and serve settings. Then re-check serve. Afterwards disable key expiry (H-T1). The IP 100.74.43.4 and the MagicDNS name stay the same for the same node.
- Lost tailnet but LAN works: SSH from a LAN device to `10.10.124.245` (sshd listens on 0.0.0.0). Keep this path when applying H-F1 (LAN ssh allow).

### 7.5 Disk fills
- `/` (Docker images, logs, journal): `df -h /`; `docker system df`; free space safely in this order, each with the owner's OK: `sudo journalctl --vacuum-size=200M`; `docker builder prune -f` (4 GB build cache); `docker image prune` (dangling only); `docker image prune -a` (22 GB reclaimable, but it removes unused images, so the next pull needs internet).
- `/srv` (backups/WAL): `backup-status.sh` (min 20 GB threshold); `backup-prune.sh` honours the WAL cutoff. **Never `rm` WAL files by hand**: archive_command failure → `pg_wal` grows inside PGDATA (also `/srv`) → db stops at a full disk. If the archive dir is unwritable, `failed_count` rises in `pg_stat_archiver`.
- db PANIC "No space left": free space first, then `docker compose restart db` (or let `unless-stopped` retry) and re-run V9/V10.

### 7.6 Power loss during the window
The battery carries it (limit 50 %, ~1–2 h). If it powers off: plug in, press power, boot, run section 5.

---

## 8. Hardening change list — **every item needs owner approval; none executed**

Order of application: after a successful G3, one item at a time, verify, then the next. Each is $0.

| ID | Change | Exact commands (owner, `sudo` unless noted) | Verify | Revert | Approval |
|---|---|---|---|---|---|
| **H0** | Read-only sudo inspection (answers N1/N6/N2 unknowns) | `sudo ufw status verbose; sudo iptables -S \| head -60; sudo nft list ruleset \| head -80; sudo sshd -T \| grep -E '^(port\|listenaddress\|passwordauthentication\|kbdinteractiveauthentication\|permitrootlogin\|pubkeyauthentication) '; sudo ss -tlnpu` | paste to engineer (no secrets) | n/a | **needs owner approval** |
| **H-F1** | ufw: default deny incoming, allow tailnet, LAN ssh, tailscale direct; keep only chosen public ports | `sudo ufw default deny incoming`<br>`sudo ufw default allow outgoing`<br>`sudo ufw allow in on tailscale0 comment 'tailnet'`<br>`sudo ufw allow 41641/udp comment 'tailscale direct'`<br>`sudo ufw allow from 10.10.124.0/24 to any port 22 proto tcp comment 'LAN ssh'`<br>(optional) `sudo ufw allow 80/tcp` only if nginx :80 must stay public<br>`sudo ufw show added` → `sudo ufw enable` → `sudo ufw status numbered` | new `ssh lucashome true` from the Mac; probe 401; LAN ssh from another LAN device | `sudo ufw disable` | **needs owner approval** |
| **H-F2** | Docker-published ports bypass ufw (DNAT/FORWARD). To really close 3000/3100/25565/19132, rebind or use `DOCKER-USER`. Example drop for WAN-ish traffic to open-webui from non-LAN/non-tailnet: `sudo iptables -I DOCKER-USER -i wlp2s0 ! -s 10.10.124.0/24 -p tcp --dport 8080 -j DROP` (container port; not persistent: use `iptables-persistent` or rebind instead). Preferred: rebind open-webui to `127.0.0.1:3000` / tailnet IP when recreating it; house-app `3100` → `127.0.0.1` in its compose (Funnel goes via the sidecar) | owner's projects, so the owner decides per service | port scan from a LAN device | remove rule / rebind back | **needs owner approval** (per service) |
| **H-S1** | sshd key-only, no root | Keep session A open (`sudo -v`). In a 2nd terminal prove keys: `ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no lucashome true`.<br>`printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' \| sudo tee /etc/ssh/sshd_config.d/10-hardening.conf`<br>`sudo sshd -t && sudo sshd -T \| grep -E '^(passwordauthentication\|kbdinteractiveauthentication\|permitrootlogin) '`<br>`sudo systemctl reload ssh` | new key login OK; `ssh -o PubkeyAuthentication=no lucashome true` → `Permission denied (publickey)` | `sudo rm /etc/ssh/sshd_config.d/10-hardening.conf && sudo systemctl reload ssh` | **needs owner approval** |
| H-S2 | Do **not** bind sshd/`ssh.socket` to the tailnet IP (it binds before tailscaled → no SSH after reboot). Use H-F1 instead | — | — | — | (recommendation, no change) |
| **H-D1** | Docker `live-restore` + default log limits (new/recreated containers only for logs) | `printf '{\n  "live-restore": true,\n  "log-driver": "json-file",\n  "log-opts": {"max-size": "20m", "max-file": "5"}\n}\n' \| sudo tee /etc/docker/daemon.json && sudo dockerd --validate --config-file /etc/docker/daemon.json && sudo systemctl reload docker` | `docker info --format '{{.LiveRestoreEnabled}}'` → `true`; containers keep running | `sudo rm /etc/docker/daemon.json && sudo systemctl reload docker` | **needs owner approval** |
| **H-D2** | Explicit mount dependency (belt and braces for S3/S4) | `sudo systemctl edit docker.service` → add `[Unit]` / `RequiresMountsFor=/srv` → save; `sudo systemctl daemon-reload` (no docker restart needed; takes effect next boot) | `systemctl show docker -p RequiresMountsFor` → `/srv` | `sudo systemctl revert docker.service` | **needs owner approval** |
| **H-D3** | Only if G3 shows a boot race needing a hand-start: systemd unit that runs `docker compose up -d --wait` after docker | `/etc/systemd/system/supabase-stack.service`: `[Unit] Description=Supabase stack (lucashome) Requires=docker.service After=docker.service network-online.target tailscaled.service RequiresMountsFor=/srv` / `[Service] Type=oneshot RemainAfterExit=yes User=lucario Group=docker WorkingDirectory=/srv/supabase/stack ExecStart=/usr/bin/docker compose up -d --wait --wait-timeout 300 TimeoutStartSec=420` / `[Install] WantedBy=multi-user.target`; then `sudo systemctl daemon-reload && sudo systemctl enable supabase-stack.service` (**no `--now`**; the stack is already up). Keep `unless-stopped`; `up` is idempotent | next reboot: `systemctl status supabase-stack` = active (exited) | `sudo systemctl disable supabase-stack && sudo rm …service && sudo systemctl daemon-reload` | **needs owner approval** |
| H-D4 | Memory limits on the owner's containers (no restart) | `docker update --memory 5g --memory-swap 5g minecraft` ; `docker update --memory 2g --memory-swap 2g open-webui` (check `docker stats --no-stream` first) | `docker inspect -f '{{.HostConfig.Memory}}'` | `docker update --memory 0 --memory-swap -1 <name>` | **needs owner approval** |
| **H-U1** | Keep docker runtime out of unattended upgrades (optional if H-D1 done) | `printf 'Unattended-Upgrade::Package-Blacklist { "docker.io"; "containerd"; "runc"; };\n' \| sudo tee /etc/apt/apt.conf.d/51unattended-upgrades-local` ; `sudo unattended-upgrade --dry-run --debug 2>&1 \| grep -i blacklist` | dry-run shows the blacklist | `sudo rm /etc/apt/apt.conf.d/51unattended-upgrades-local` | **needs owner approval** |
| H-U2 | Keep unattended-upgrades as is (security on, `Automatic-Reboot` off). Plan a monthly kernel reboot window using this checklist | — | — | — | (recommendation) |
| **H-K1** | Auto-reboot on kernel panic (no more indefinite hang) | `echo 'kernel.panic = 10' \| sudo tee /etc/sysctl.d/90-panic-reboot.conf && sudo sysctl --system` | `cat /proc/sys/kernel/panic` → `10` | `sudo rm` the file; `sudo sysctl -w kernel.panic=0` | **needs owner approval** |
| H-K2 | Visible GRUB menu (makes the 7.1 fallback easier) | `sudo sed -i 's/^GRUB_TIMEOUT_STYLE=hidden/GRUB_TIMEOUT_STYLE=menu/; s/^GRUB_TIMEOUT=0/GRUB_TIMEOUT=5/' /etc/default/grub && sudo update-grub` | menu visible next boot (+5 s boot time) | reverse sed + `update-grub` | **needs owner approval** |
| **H-T1** | Disable node key expiry for `lucashome` | Tailscale admin console → Machines → `lucashome` → ⋯ → **Disable key expiry** | `tailscale status --json \| jq .Self.KeyExpiry` → `null` | re-enable in console | **needs owner approval** (owner acts) |
| H-T2 | Tailscale ACLs (tills → `lucashome:443` only; admins → 22/443; Studio restriction); second tailnet admin | per [`../next-phase/reboot-and-hardening.md`](../next-phase/reboot-and-hardening.md) H6/H6s/H7 | per that doc | paste back the saved policy | **needs owner approval** (before tills join) |
| **H-M1** | Off-box alert (optional third-party free tier; the email daily report's backup-health line is the primary $0 channel): healthchecks.io free ping from `backup-status.sh` (already supported "if configured") + a dead-man ping | owner creates a free healthchecks.io check (period 30 min, grace 15 min) and sets `HEALTHCHECKS_URL=<ping url>` in `/srv/supabase/backup/backup.env` (0600; `backup-status.sh` already pings it, or `/fail` on non-OK); the engineer never sees the value | next `*/30` run shows as up on healthchecks.io; pausing cron → alert | blank the variable | **needs owner approval** |
| **H-M2** | Disk alert thresholds: `/srv` free < 20 GB already in `backup-status.sh`; add `/` < 15 GB and inodes > 80 %, and `reboot-required` older than 7 d, to the same status output (repo change to `backup-status.sh`, deploy via `deploy.sh`) | engineer prepares the script diff for review; deploy only after approval | `backup-status.sh` prints the new lines; `STATUS: WARN` when forced | redeploy the previous script | **needs owner approval** |
| **H-M3** | SMART visibility | `sudo apt install -y smartmontools nvme-cli && sudo smartctl -H -A /dev/nvme0 && sudo nvme smart-log /dev/nvme0` (smartd is enabled by the package; default config scans all disks) | `systemctl is-active smartd`; record Percentage Used / Media Errors / Unsafe Shutdowns | `sudo apt remove smartmontools nvme-cli` | **needs owner approval** |
| H-P1 | Clean shutdown on low battery (UPS substitute) | `sudo cp /etc/UPower/UPower.conf /etc/UPower/UPower.conf.bak`, then edit `/etc/UPower/UPower.conf`: `UsePercentageForPolicy=true`, `PercentageAction=5`, `CriticalPowerAction=PowerOff`; `sudo systemctl restart upower` (upower is a running service, so this is a restart of that daemon only) | `upower -d \| grep -i critical` | restore the file | **needs owner approval** |
| H-X1 | Reclaim `/` space: `docker builder prune -f` (4 GB), journald cap `SystemMaxUse=500M` in `/etc/systemd/journald.conf.d/size.conf` + `sudo systemctl restart systemd-journald` | as written | `docker system df`, `journalctl --disk-usage` | n/a (cache) / delete the conf | **needs owner approval** |
| H-O1 | Offsite backups (rank 1) | email backups per [email-backup-design.md](email-backup-design.md) (R2 and Mac pull dropped by owner 2026-10-13) | per runbook | per runbook | **needs owner approval** |
| H-W1 | Physical: wired Ethernet if a cable reaches; check BIOS for "power on AC attach"/"restore on AC loss" (often absent on Zenbooks); keep the charge limit; keep lid-close ignore | at the laptop | — | — | owner (physical) |

Not recommended: fail2ban (redundant once H-F1 limits 22 to tailnet + LAN), `apt upgrade` in the same window, `tailscale up` with new flags, Funnel on `lucashome`.

---

## 9. Evidence of the inspection (selected raw facts, no secrets)

- `uname -r` → `7.0.0-30-generic`; `uptime -s` → `2026-09-02 23:47:24`; reboot-required since `Oct 8 06:45`.
- `systemctl is-enabled`: docker, docker.socket, containerd, tailscaled, ssh, ssh.socket, cron, ufw, unattended-upgrades, chrony, nginx, ollama, playit → `enabled`; fail2ban, smartd, nut-server, needrestart (unit) → `not-found`.
- `docker info` → `LiveRestore=false LogDriver=json-file Storage=overlayfs Cgroup=2`; `/etc/docker/daemon.json` absent.
- 16 containers, all `RestartPolicy=unless-stopped`; Supabase 10/10 healthy; realtime `RestartCount=1`, the rest 0.
- `pg_stat_archiver` → `394|0|…0186|06:03:58`; `pg_current_wal_lsn` → `1/870007B8`; schema `080`.
- `backup-status.sh` → `STATUS: OK`, base `20261013T053857Z`, dump 05:39:02Z, `failed=0 pending=0`, offsite disabled.
- `tailscale status --json` → Self `KeyExpiry 2027-03-15T03:53:46Z`, `Tags null`, Online, relay `tor`; prefs `OperatorUser=lucario`, `WantRunning=true`.
- serve: `https://lucashome.tail8a86e4.ts.net (tailnet only) |-- / proxy http://127.0.0.1:8000`; cert `notAfter=Jan 9 21:12:22 2027 GMT`; `/auth/v1/health` → 401; `/storage/v1/status` → 200; `/rest/v1/` → 401; `phone-upload-token` OPTIONS 200 / POST 401.
- `/etc/ufw/ufw.conf` → `ENABLED=no`; `ssh.socket` → `ListenStream=0.0.0.0:22`, `[::]:22`; `50-cloud-init.conf` 27 B, 0600.
- `/etc/fstab` `/srv … defaults 0 2`; `srv.mount RequiredBy=local-fs.target`; `docker.service After=… sysinit.target …`, `RequiresMountsFor=` empty.
- `kernel.panic=0`, `panic_on_oops=1`; GRUB `TIMEOUT=0`, `TIMEOUT_STYLE=hidden`.
- Battery `Not charging`, 56 %, threshold 50, AC online; sleep targets masked; lid ignore.
