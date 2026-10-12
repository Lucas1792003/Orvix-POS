# 01 · Infrastructure Audit — `lucashome`

Audit date: 2026-10-11 (19:40–20:00 UTC). Method: read-only commands over SSH as
`lucario`, no `sudo`, no writes, no container or network changes. Public IP
deliberately withheld.

Legend: **V** = verified (command output seen) · **U** = unknown (reason given)
· **I** = inferred from verified facts.

## Summary

`lucashome` is a **consumer laptop** (ASUS Zenbook UX535QA, Ryzen 7 5800H, 14 GiB
RAM, one 1 TB NVMe) in **Barrie, Ontario, Canada**, on a **Wi-Fi-only** uplink
from a residential ISP, running Ubuntu 26.04.1 with six Docker containers, no
firewall rules confirmed, no backups of any existing service, and a pending
kernel reboot. Three of its last five boots ended in a crash. It has enough
RAM, CPU, and disk to run the Supabase stack beside the existing services at
idle, with roughly 4–5 GiB of margin, but every other property of the box is a
production-availability risk that the migration plan must either mitigate or
explicitly accept. See [03-risk-register.md](./03-risk-register.md).

## 1. Hardware

| Item | Value | |
|---|---|---|
| Machine | ASUS Zenbook UX535QA_UM535QA, DMI chassis type 10 (laptop), BIOS .310 (2022-11-21) | V |
| CPU | AMD Ryzen 7 5800H, 8 cores / 16 threads, 0.4–3.2 GHz, governor `powersave`, L3 16 MiB | V |
| RAM | 14 GiB total; 5.8 GiB used, 4.5 GiB free, 4.5 GiB buff/cache, **8.7 GiB available** | V |
| Swap | `/swap.img` 4 GiB; **1.8 GiB in use**, steady at ~46 % for ≥24 h (sysstat) | V |
| Swap consumers | java/Minecraft 1.39 GiB, open-webui 146 MiB, house-app 65 MiB, dockerd 12 MiB | V |
| Memory pressure (PSI) | memory/cpu/io `some` and `full` avg10/60/300 all 0.00; no OOM events this boot | V |
| Load | 0.10 / 0.14 / 0.10 on 16 threads; thermal 36–42 °C | V |
| GPU | Integrated Radeon Vega only. No discrete GPU, no NVIDIA tooling | V |
| Disk | 1× WDC PC SN730 1 TB NVMe (953.9 G), non-rotational, state live | V |
| Layout | p1 1 G vfat `/boot/efi` · p2 2 G ext4 `/boot` · p3 950.8 G LVM → VG `ubuntu-vg`: LV `ubuntu-lv` 100 G ext4 `/`, LV `server-data` 800 G ext4 `/srv` | V |
| Free space | `/` 98 G, 28 G used, **66 G free** (Docker root `/var/lib/docker` lives here) · `/srv` 787 G, 16 G used, **732 G free** | V |
| Inodes | `/` 8 %, `/srv` 1 % | V |
| NVMe health (SMART, wear, spare) | **U** — `nvme-cli` and `smartmontools` not installed; `nvme smart-log` would also need root | U |
| LVM free extents | **U** — `vgs`/`lvs` need root; arithmetic suggests ~50 G unallocated | U/I |
| Battery | BAT0 present, 58 % charge, "Not charging" (charge-limit behaviour), 264 cycles, 86.7 of 95.1 Wh design (**91 % health**), AC online | V |
| Battery runtime on AC loss | **U** — not measurable read-only. Laptop battery acts as an unmanaged UPS of unknown duration | U |

## 2. Operating system

| Item | Value | |
|---|---|---|
| Distro / kernel | Ubuntu 26.04.1 LTS, running kernel **7.0.0-30-generic** | V |
| Uptime | since 2026-09-02 23:47 UTC (38 d 20 h at audit time) | V |
| Boot history (`last reboot`, `journalctl --list-boots`) | 5 boots since 2026-08-28: Aug 28 20:18 **crash**, Aug 28 20:32 clean (19 min), Sep 2 02:32 **crash**, Sep 2 23:38 **crash**, Sep 2 23:47 current. Boot −1 ended with `i2c SMBus Timeout` and `amdgpu DMCUB error` kernel messages seconds before the unclean end | V |
| Reboot required | **YES** since 2026-10-08 06:45. Installed but not running: linux-image 7.0.0-31, -34, **-38**, linux-base, libc6. Running kernel is three releases behind | V |
| Upgradable packages | 28 | V |
| Unattended upgrades | enabled and active (`20auto-upgrades`: lists=1, upgrade=1); `apt-daily` and `apt-daily-upgrade` timers active. Kernel updates install automatically but need a manual reboot | V |
| Time | TZ `Etc/UTC`, chrony NTP synchronized, RTC in UTC | V |
| Sleep / lid | `sleep.target`, `suspend.target`, `hibernate.target`, `hybrid-sleep.target` all **masked**; `HandleLidSwitch*` = ignore. Correct for headless use | V |
| fstab | `/`, `/boot`, `/boot/efi`, `/swap.img`, `/srv` (ext4, fsck pass 2). No network mounts | V |
| Cron | no crontab for `lucario`; system cron only has distro defaults (logrotate, man-db, apt, e2scrub) | V |

## 3. Docker

| Item | Value | |
|---|---|---|
| Versions | Docker 29.1.3 (Ubuntu build), Compose v2.40.3 | V |
| Daemon | storage driver `overlayfs`, cgroup v2 (systemd), json-file logging **with no size limit**, root dir `/var/lib/docker` on `/`, **live-restore off**, no `/etc/docker/daemon.json` | V |
| `docker system df` | images 7 / 15.0 GB (open-webui 7.2 GB), containers 79 MB, volumes 3 / 1.17 GB, build cache 36 entries / 4.8 GB (**4.0 GB reclaimable**) | V |
| Networks | bridge, host, none, `house_house` (172.19/16), `minecraft_default` (172.18/16) | V |
| Volumes | `house_postgres_data`, `house_tailscale_state`, `open-webui` | V |
| Compose projects | `house` (3 containers, `/home/lucario/personal/House/`), `minecraft` (1, `/srv/minecraft/`). `postgres` and `open-webui` are plain `docker run` containers with no compose file | V |
| Resource limits | **None.** No container has a memory, memory+swap, or CPU limit | V |

Running containers (all `restart=unless-stopped`, all `OOMKilled=false`, `RestartCount=0`):

| Name | Image | Up | Published ports | RSS |
|---|---|---|---|---|
| minecraft | itzg/minecraft-server:latest (Paper 1.21.1, `MEMORY=4G` → `-Xms4G -Xmx4G`) | 3 w | 0.0.0.0:25565/tcp, 0.0.0.0:19132/udp | **3.97 GiB** + 1.55 GiB swapped |
| open-webui | ghcr.io/open-webui/open-webui:main | 5 w | 0.0.0.0:3000 → 8080 | 521 MiB |
| house-app-1 | house-app:latest (Next.js) | 13 d | 0.0.0.0:3100 → 3000 | 99 MiB |
| house-postgres-1 | postgres:17 | 13 d | none (internal) | 17 MiB |
| postgres | postgres:18 | 5 w | 127.0.0.1:5432 → 5432 | 21 MiB |
| house-tailscale-1 | tailscale/tailscale:stable (userspace, Funnel) | 13 d | none | 24 MiB |

Non-Docker services of note: `ollama` (systemd, 127.0.0.1:11434, models in `/srv/ai/models`, 1.36 GB cgroup at audit time — grows to many GB when a model is loaded), `nginx` (port 80 default page, port 11435 → ollama), `playit` (`/opt/playit/playitd`, public tunnel agent; what it exposes is **U**, config unreadable).

## 4. Listening ports

| Port | Bind | Owner | |
|---|---|---|---|
| 22/tcp | 0.0.0.0, [::] | sshd — reachable from LAN and tailnet, not restricted | V |
| 53 | 127.0.0.53/54 | systemd-resolved | V |
| **80/tcp** | 0.0.0.0, [::] | nginx `sites-enabled/default` (placeholder page) | V |
| **443/tcp** | 100.95.109.83, [fd7a:…:6dcc] | root-owned socket on a Tailscale IP **the node no longer holds** (journal shows host `tailscaled` had that address until ≈2026-09-16; current IP is 100.74.43.4). Likely a stale listener inside the 38-day-old `tailscaled` process. Owner **U** without root | V/U |
| **3000/tcp** | 0.0.0.0, [::] | docker-proxy → open-webui | V |
| 3100/tcp | 0.0.0.0 | docker-proxy → house-app | V |
| **5432/tcp** | 127.0.0.1 only | docker-proxy → `postgres` (postgres:18) | V |
| 11434, 11435/tcp | 127.0.0.1 | ollama, nginx→ollama | V |
| 25565/tcp, 19132/udp | 0.0.0.0, [::] | Minecraft (Java + Bedrock) | V |
| 41641/udp | 0.0.0.0 | tailscaled WireGuard | V |
| 59508/tcp, 63375/tcp | Tailscale IPs | tailscaled peerapi | I |
| 41917/tcp | 127.0.0.1 | **U** (no root for `-p`; probably playit or tailscale local API) | U |

Consequence for the stack: host ports **8000** (API gateway) and **6543** are
free; **5432 is taken**, so the upstream stack's pooler port mapping must be
overridden (see [04-target-architecture.md](./04-target-architecture.md)).
Ports 80/443/3000 are not needed by the chosen design.

## 5. Tailscale

| Item | Value | |
|---|---|---|
| Version | 1.102.3; auto-update check + apply enabled | V |
| Node | `lucashome.tail8a86e4.ts.net`, 100.74.43.4, online, Health [] | V |
| Node key expiry | **2027-03-15** (≈5 months). Not disabled | V |
| HTTPS | `CertDomains = ['lucashome.tail8a86e4.ts.net']` → HTTPS certificates are enabled for the tailnet | V |
| Capabilities | funnel, https, funnel-ports 443/8443/10000, ssh, tailnet-lock, **is-admin, is-owner** (this node's login is the tailnet owner) | V |
| Prefs | no exit node, no subnet routes, no tags, `NoStatefulFiltering=true`, netfilter on, SSH off | V |
| `tailscale serve` / `funnel` | "No serve config" (both readable as `lucario`) | V |
| Operator | **U** — `serve status` and `debug prefs` ran without an operator error, but `tailscale cert` earlier replied "Use sudo … or `sudo tailscale set --operator=$USER`", so the operator is **not** set and any `serve`/`cert` change will need one sudo command | V |
| Tailnet | owner `waiyanpaing183@gmail.com`; peers: wais-macbook-air (macOS), cyfro-staging (linux), househub (the house-app sidecar, **Funnel ON**, public), lucas (Windows, offline 44 d), `cyfrosec-server.tailbe604c.ts.net` (**shared in from a different tailnet**) | V |
| `tailscale netcheck` | UDP yes, IPv4 yes, **IPv6 no**, **no UPnP/NAT-PMP/PCP**, nearest DERP **Toronto 8 ms**; Tokyo 151 ms; **Singapore 243 ms** | V |
| `tailscale ping wais-macbook-air` | 3 pongs **via DERP (Toronto)**, 17 / 120 / 61 ms — **direct connection not established** | V |

The last two rows matter for Myanmar tills: the box is behind a NAT with no port
mapping, on Wi-Fi, and already fails to form a direct path to a peer on the same
continent. Relayed traffic works but adds the DERP hop. See
[02-production-dependencies.md](./02-production-dependencies.md) §Network.

## 6. Firewall and access

| Item | Value | |
|---|---|---|
| ufw | `/etc/ufw/ufw.conf` says **`ENABLED=no`** while `ufw.service` is enabled+active → effective rule set **U** (root needed for `ufw status`, `iptables -S`, `nft list ruleset`) | V/U |
| sshd | main config sets only `KbdInteractiveAuthentication no`; `Port`, `PermitRootLogin`, `PasswordAuthentication` left to defaults; `sshd_config.d/50-cloud-init.conf` is root-only (27 bytes, the exact length of `PasswordAuthentication yes\n`) → password login **probably enabled**; binds all interfaces | V/I |
| fail2ban | not installed | V |
| hosts.allow/deny | present, no active rules | V |
| `lucario` | member of `sudo`, `docker`, `adm`, `lxd` → docker-group membership is root-equivalent on the host | V |
| Public exposure | 80 (nginx placeholder), 3000 (open-webui), 3100 (house-app), 25565/19132 (Minecraft) bound to all interfaces; playit tunnel; Funnel for househub. Whether the ISP router forwards any of these is **U** | V/U |

## 7. Boot, recovery, power

| Item | Value | |
|---|---|---|
| Services enabled at boot | docker, containerd, tailscaled, ssh — all enabled and active | V |
| Containers on reboot | all `unless-stopped` → restart automatically after a reboot (not after a manual stop) | V |
| Timers | distro defaults only (apt, fstrim weekly, e2scrub, logrotate, sysstat). **No backup timer of any kind** | V |
| UPS | no `apcupsd`/`nut`; laptop battery is the only buffer | V |

## 8. Backups (existing)

| Item | Value | |
|---|---|---|
| `/srv/backups` | **empty** | V |
| Backup scripts | only `~/personal/House/scripts/backup-postgres.sh` (pg_dump, gzip, 7 daily / 4 weekly) and `restore-postgres.sh`, run by `deploy.sh` — **one** backup exists, 13 days old, no schedule | V |
| Minecraft world, `postgres:18` data (`/srv/database/postgres`), open-webui volume, ollama models | **no backup mechanism** | V |
| Off-host copies | **none** | V |
| Tools | `rsync` only; rclone, restic, borg absent; no rclone config | V |

## 9. Location, ISP, connectivity

| Item | Value | |
|---|---|---|
| Geolocation (ipinfo) | **Barrie, Ontario, Canada**; ISP AS394233 "Cloudwifi"; tz America/Toronto | V |
| Uplink | **Wi-Fi only** (`wlp2s0`, 10.10.124.245/24, netplan + wpa_supplicant); **no wired NIC present** | V |
| Latency from the box | 1.1.1.1: 12.6–13.5 ms, 0 % loss (5 probes); `api.supabase.com` TCP connect 16 ms | V |
| DERP latencies | Toronto 8 ms, NYC 21, Chicago 20, Ashburn 28, London 87, Frankfurt 98, Tokyo 151, **Singapore 243** | V |
| Shops | Myanmar (business locale Asia/Yangon per application docs). Till-side measurements **not yet taken** — see test plan in [06-rehearsal-test-plan.md](./06-rehearsal-test-plan.md) | U |

## 10. Existing Supabase clone (verification of "existing progress")

| Claim | Finding | |
|---|---|---|
| Official repo cloned | `/srv/supabase/upstream` = github.com/supabase/supabase, **master** at `8617532ae1a41571d5d557cd24c6f5f2565d9230` (2026-10-09), blobless sparse clone of `docker/`, 6.2 MB. **Not a release tag** — latest tag is `self-hosted/v0.8.2` (commit `564eab8a…`) | V |
| No Supabase containers | `docker ps -a` has 0 supabase containers | V |
| No stack directory, no `.env` | `/srv/supabase/stack` absent; no `.env*` under `/srv/supabase` | V |
| No production data exported | scratchpad dump directory empty; the dump command was rejected before execution | V |
| Hosted Supabase unmodified | only `SELECT` queries and `supabase functions list` / `migration list` / `storage ls` were run | V |
| Earlier read-only check | `tailscale cert` was attempted on 2026-10-11 and refused (needs root/operator); it issued nothing and changed nothing | V |

## 11. Logs

| Item | Value | |
|---|---|---|
| `journalctl -p err -b` | only `networkctl` veth noise and one `fwupd-refresh` failure | V |
| OOM | 0 kernel OOM lines this boot; no Docker OOM events in 30 days | V |
| `dmesg` | restricted (`kernel.dmesg_restrict`); `journalctl -k` used instead | V |

## Capacity assessment

Measured baseline: 14 GiB RAM, 5.8 GiB used, 8.7 GiB available (4.5 GiB of it is
reclaimable page cache). Minecraft holds a fixed 4 GiB heap, 1.5 GiB of which is
currently swapped out; ollama is the only tenant whose footprint can change by
many gigabytes at once (a loaded 14B model would exceed available RAM on its own).

Supabase upstream guidance: minimum 4 GB RAM / 2 cores / 40 GB SSD, recommended
8 GB+ / 4 cores+ / 80 GB+. The default stack is 11 containers; realistic idle
footprint 2–3.5 GiB, 4–5 GiB under load.

| Scenario | Estimated RAM | Fits in 14 GiB? |
|---|---|---|
| Today | 5.8 GiB used + 1.8 swap | yes |
| + Supabase idle | ≈ 9 GiB | yes, ~4–5 GiB margin, swap use will rise |
| + Supabase under POS load + Minecraft busy (swap reclaimed) | ≈ 11–12 GiB | yes, little margin |
| + ollama with a 7B–14B model resident | 15–20 GiB | **no** — swap thrash / OOM; no container limits mean the kernel picks the victim |

CPU and disk are not constraints (16 threads at <1 % average; 66 GiB free on `/`
for images, 732 GiB on `/srv` for data). Docker's image root on the 98 GiB `/`
LV is adequate but the 4 GB of reclaimable build cache should be pruned before
pulling ~3–5 GB of Supabase images.

**Verdict:** the stack fits, *provided* ollama is not used for large models while
the POS backend is live, Minecraft keeps its 4 GiB cap, and memory limits are
set on the Supabase containers so a runaway tenant cannot evict Postgres.
Peak-load headroom is thin, not generous.

## Items requiring root / unknown

- `ufw status`, `iptables`/`nft` rule sets, `/etc/ufw/user.rules`.
- `vgs`/`lvs` free extents.
- NVMe SMART data (tools not installed; needs root).
- Process owners of listening sockets (`ss -p`), including the stale 443 listener.
- Effective `PasswordAuthentication` (root-only cloud-init drop-in).
- `/etc/playit/playit.toml` (what playit publishes).
- Battery runtime under load with AC removed.
- Whether a Tailscale operator is configured (indirect evidence says no).

## Risks observed (carried into the risk register)

1. Pending kernel reboot since 2026-10-08; 28 upgradable packages.
2. 3 of the last 5 boots ended in a crash; amdgpu/i2c kernel errors before one of them.
3. Firewall state unknown; sshd on all interfaces; fail2ban absent; password auth probably on.
4. Public exposure of several services plus playit and Funnel; the POS backend would share the host with them.
5. Stale root-owned 443 listener on an abandoned Tailscale IP.
6. No backups of anything; no off-host copy; no backup tooling.
7. No container resource limits; json-file logs unbounded; Docker live-restore off.
8. 1.8 GiB swap in steady use at 40 % RAM utilisation.
9. Wi-Fi-only uplink, residential ISP, no port mapping, IPv6 absent, DERP-relayed peer path.
10. Node key expires 2027-03-15; the node's login is the tailnet owner; a foreign-tailnet node is shared in.
11. Laptop battery is the only power buffer and is unquantified; no UPS daemon to trigger a clean shutdown.
12. Single NVMe, no redundancy, SMART health unknown.
