# Maintenance window: reboot + G3 persistence test, then host hardening — proposal

Status: **proposal, 2026-10-13 (UTC)**. Nothing in this document has been executed. Host facts below come from read-only commands run 2026-10-13 02:01 UTC (listed in §0); everything else is cited from [01-infrastructure-audit.md](../01-infrastructure-audit.md), [06-rehearsal-test-plan.md](../06-rehearsal-test-plan.md) and [10-go-no-go-checklist.md](../10-go-no-go-checklist.md).

## Decision summary

| # | Decision for the owner | Recommendation | Outage | Sudo | Reversible |
|---|---|---|---|---|---|
| **W** | Approve one maintenance window: pre-checks (A), **reboot** (B), **G3 persistence test** (C) | **Yes.** Do it first, before any hardening, so that G3 proves the host as it is today | everything on the host, ~2–5 min | one command (`systemctl reboot`) | n/a. The old kernel stays bootable from GRUB |
| H1 | Firewall: ufw default-deny incoming with explicit allows | Yes, **after you answer the port questions in H1** | none if the order is followed | yes | `sudo ufw disable` |
| H2 | sshd: keys only, no root login | Yes | none (existing sessions survive) | yes | delete one drop-in file and reload |
| H2b | sshd `ListenAddress` on the tailnet IP | **No.** Restrict port 22 with H1 instead (see why there) | n/a | n/a | n/a |
| H3 | fail2ban | **Skip** if H1 limits 22 to tailnet (+ LAN); install only if 22 stays reachable from outside | none | yes | `apt remove` |
| H4 | Docker `daemon.json`: `live-restore` + default log limits | Yes | none (`reload`) | yes | delete the file and reload |
| H5 | Memory limits for minecraft / open-webui (and ollama) | Yes for minecraft + open-webui; ollama is your call | none (`docker update` is live) | no (docker group); ollama needs sudo | `docker update` back |
| H6 | Tailscale ACL policy (tills → `lucashome:443` only, admins → 22/443) | Yes, **must be in place before the first till joins** | none if existing flows are listed first | admin console | paste the saved old policy back |
| H6s | Studio admin-only | Stop Studio when not in use (short term); separate port before tills join if you use it often | none | no | `docker compose start studio` |
| H7 | Second tailnet admin | Yes | none | admin console | remove the user |
| H8 | Disable node key expiry on `lucashome` (tills: automatic via tagged keys) | Yes | none | admin console | re-enable |
| H9 | NVMe SMART tooling (+ optional sudo rule for monitoring) | Yes | none | yes | `apt remove`, delete the sudoers file |
| H10 | Keep `docker.io` / `containerd` out of unattended upgrades | Optional; H4 already removes most of the risk | none | yes | delete one apt.conf file |

Time: window W ≈ 60–90 min wall clock (≈ 5 min actual outage). Hardening H1–H5 + H9 ≈ 90 min in a second session with no outage. H6–H8 ≈ 30–60 min of your time in the Tailscale admin console, any day before a till joins.

Notifications: **none needed for the POS.** It is pre-production: no till talks to `lucashome` (the published v1.0.15 points at hosted, see [../../desktop-app/status.md](../../desktop-app/status.md)). Minecraft players, the house app and open-webui users go down for the reboot too. Whether to tell them is up to you.

## 0. Host facts this plan relies on (read-only, 2026-10-13 02:01 UTC)

| Command (via `ssh -o BatchMode=yes lucashome`) | Output (no secrets) |
|---|---|
| `systemctl is-enabled / is-active docker tailscaled ssh` | enabled ×3, active ×3 |
| `uptime -s` | `2026-09-02 23:47:24` (40 days) |
| `uname -r` | `7.0.0-30-generic` |
| `ls /boot \| grep vmlinuz` | `vmlinuz`, `vmlinuz-7.0.0-30-generic`, `vmlinuz-7.0.0-38-generic`, `vmlinuz.old`. The reboot boots **7.0.0-38**; 7.0.0-30 stays as the GRUB fallback (31 and 34 are no longer in `/boot`) |
| `cat /var/run/reboot-required.pkgs` | linux-image 7.0.0-31/-34/-38, linux-base, libc6 |
| `docker inspect … RestartPolicy` | all 16 running containers `unless-stopped`: 10 Supabase (`supabase-db`, `-storage`, `-edge-functions`, `realtime-dev.supabase-realtime`, `-meta`, `-auth`, `-rest`, `-envoy`, `-studio`, `-imgproxy`) + `house-tailscale-1`, `house-app-1`, `house-postgres-1`, `minecraft`, `postgres`, `open-webui` |
| `cat /etc/docker/daemon.json` | absent (exit 1): no live-restore, no default log limits |
| `cat /etc/ufw/ufw.conf` | `ENABLED=no`, `LOGLEVEL=low`; `user.rules` / `user6.rules` exist (contents need root) |
| `grep -E '^(PasswordAuthentication\|PermitRootLogin\|ListenAddress)' /etc/ssh/sshd_config` | no match (defaults); `sshd_config.d/` has only `50-cloud-init.conf` (root-only; the audit inferred `PasswordAuthentication yes`) |
| `tailscale status --self` | `lucashome` 100.74.43.4; peers `cyfro-staging`, `cyfrosec-server.tailbe604c.ts.net` (shared in), `househub`, `lucas` (Windows, offline 46 d), `wais-macbook-air` (relay "tor") |
| `tailscale serve status` | `https://lucashome.tail8a86e4.ts.net (tailnet only)` → `/ proxy http://127.0.0.1:8000` |
| `cat /sys/class/power_supply/BAT0/{status,capacity}` | `Not charging`, `57` |
| `df -h` / `free -h` | `/` 59 G free; `/srv` 731 G free; RAM 7.5 Gi available; **swap 2.0 Gi of 4.0 Gi used** |
| `crontab -l` | the four local backup lines from [`crontab.lucario`](../../../deploy/lucashome/backup/crontab.lucario); offsite lines not installed |
| `backup-status.sh` | `STATUS: OK`; WAL `archived=335 failed=0 pending=0` (details in [offsite-backup-enable.md](offsite-backup-enable.md) §0) |

Not readable without root (to be read in H0): effective firewall rules, effective sshd settings, socket owners (`ss -p`), whether `ssh.socket` activation is used.

## Prerequisites (all must be true before W starts)

1. **You are physically at the laptop, or someone who can use its keyboard is.** 3 of its last 5 boots ended in a crash (amdgpu/i2c errors before one of them, audit §2). If 7.0.0-38 hangs, recovery is picking 7.0.0-30 in GRUB "Advanced options". Nobody can do that over SSH.
2. AC power connected (battery shows `Not charging` at 57 %, which is the charge-limit behaviour with AC present; confirm the charger is in).
3. Window agreed (any time; there is no POS trading on `lucashome`). Avoid 02:30 UTC (base backup) and Sunday 03:30 UTC (restore drill) so the post-boot checks are not confused by a running job.
4. The Mac is on the tailnet, the `lucashome` SSH alias works, and the repo is on `feature/selfhost-supabase-migration`.
5. No other change is in flight on `lucashome`. No migration apply or stack edit happens in the same window.
6. Your written approval for W (and separately for each H step you want).

## Part A — pre-checks (engineer, as `lucario`, ~20 min)

```
mac$ mkdir -p ~/g3 && cd ~/g3                       # evidence scratch, copied into the evidence file afterwards
mac$ ssh -o BatchMode=yes lucashome '/srv/supabase/backup/bin/backup-status.sh' | tee pre-backup-status.txt
mac$ ssh -o BatchMode=yes lucashome 'docker ps --format "{{.Names}} {{.Status}}"' | sort | tee pre-docker.txt
mac$ ssh -o BatchMode=yes lucashome 'cd /srv/supabase/stack && docker compose ps --format "{{.Name}} {{.Health}}"' | tee pre-health.txt
mac$ ssh -o BatchMode=yes lucashome 'docker inspect --format "{{.Name}} {{.RestartCount}}" $(docker ps -q)' | tee pre-restarts.txt
mac$ ssh -o BatchMode=yes lucashome 'tailscale serve status; tailscale funnel status; crontab -l; uname -r; ss -Htln' | tee pre-host.txt
mac$ echo | openssl s_client -connect lucashome.tail8a86e4.ts.net:443 -servername lucashome.tail8a86e4.ts.net 2>/dev/null | openssl x509 -noout -enddate | tee pre-cert.txt
```

Fresh backups right before the reboot. These are the normal cron scripts; they write only under `/srv/supabase/backups`:

```
mac$ ssh -o BatchMode=yes lucashome '/srv/supabase/backup/bin/backup-logical.sh && /srv/supabase/backup/bin/backup-base.sh && /srv/supabase/backup/bin/backup-status.sh' | tail -n 25 | tee pre-fresh-backup.txt
mac$ ssh -o BatchMode=yes lucashome 'ls -1d /srv/supabase/backups/dump/hourly/* | tail -n 1'   # note <pre-dump-ts> for the count comparison in C11
```

**Go criteria for B:** `STATUS: OK`; WAL `failed=0 pending=0`; 10/10 Supabase containers `healthy`; 16 containers `Up`; cert end date 2027-01-09; fresh base + logical dump just succeeded. Any miss → stop, fix, reschedule.

## Part B — reboot (owner, sudo, ~5 min)

Start a probe on the Mac first. It sends no key: any HTTP status (200/401) means TLS and the gateway are up; `000` means down.

```
mac$ while :; do printf '%s %s\n' "$(date -u +%T)" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' https://lucashome.tail8a86e4.ts.net/auth/v1/health)"; sleep 10; done | tee ~/g3/probe.log
```

Then, on `lucashome` (console or SSH):

```
ls$ date -u      # T0: write it down
ls$ sudo systemctl reboot
```

Do **not** run `apt upgrade` first. The kernels are already installed. Pulling in more packages (there were 28 upgradable at the audit) would widen what the test has to prove.

## Part C — G3 persistence test (engineer, read-only, ~15–30 min)

Pass condition (G3, [10-go-no-go-checklist.md](../10-go-no-go-checklist.md)): every item below returns **without any manual action** within **5 minutes of `uptime -s`**. If anything has to be started by hand, G3 fails even though service is restored. Record that and repeat in a later window.

| # | Check | Command | Pass |
|---|---|---|---|
| C1 | Booted the new kernel | `ssh lucashome 'uptime -s; uname -r; test -f /var/run/reboot-required; echo reboot-required=$?'` | boot time after T0; `7.0.0-38-generic`; `reboot-required=1` (file gone) |
| C2 | Base services | `ssh lucashome 'systemctl is-active docker tailscaled ssh'` | active ×3 |
| C3 | All containers back, same restart policy | `docker ps --format "{{.Names}} {{.Status}}" \| sort` vs `pre-docker.txt`; `docker inspect --format '{{.Name}} {{.HostConfig.RestartPolicy.Name}} {{.State.StartedAt}}' $(docker ps -q)` | 16/16 `Up`; latest `StartedAt` ≤ boot + 5 min |
| C4 | Supabase healthy | `cd /srv/supabase/stack && docker compose ps --format "{{.Name}} {{.Health}}"` | 10/10 `healthy` |
| C5 | Tailscale + serve persisted | `tailscale status --self; tailscale serve status; tailscale funnel status` | online; serve output identical to `pre-host.txt`; no Funnel for `lucashome` |
| C6 | Cert still served | `openssl s_client …` as in A | `notAfter` 2027-01-09 (same cert) |
| C7 | Stale 443 listener gone | `ssh lucashome 'ss -Htln \| grep -c 100.95.109.83'` | `0` |
| C8 | Probe | `~/g3/probe.log` | first non-`000` line ≤ boot + 5 min; record the gap |
| C9 | Backup cron resumes | after the next :00/:30: `ssh lucashome 'tail -n 3 /srv/supabase/backups/logs/backup-status.log; jq -r .jobs.status.last_run /srv/supabase/backups/status.json'` | a run after boot, `STATUS: OK` |
| C10 | WAL archiver resumes | after the next hourly dump (:15) has produced WAL: `backup-status.sh` | `failed=0`, `archived` > the value in `pre-fresh-backup.txt`, `pending=0`, no gap reported |
| C11 | Data unchanged | `ssh lucashome 'cd /srv/supabase/backups/dump/hourly && diff <(jq -S .tables <pre-dump-ts>/counts.json) <(jq -S .tables $(ls -1d * \| tail -n 1)/counts.json) && echo SAME'` (if `counts.json` keys differ, compare the whole file minus timestamps) | `SAME` (no writes happen in the window) |
| C12 | Realtime reconnected | `docker inspect --format '{{.State.Health.Status}} {{.RestartCount}}' realtime-dev.supabase-realtime` and, with the anon key read into a shell variable only: `curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON" https://lucashome.tail8a86e4.ts.net/realtime/v1/api/tenants/realtime-dev/health` | `healthy`; `200` |
| C12+ | Realtime delivers events (optional, writes QA rows) | live test 14 of [`supabase/tests/phase-d/live/README.md`](../../../supabase/tests/phase-d/live/README.md), then `cleanup.sql` → `verify_clean.sql` prints CLEAN | test 14 PASS; CLEAN |
| C13 | Other workloads | `docker ps` (minecraft, open-webui, house-app/postgres/tailscale, postgres:18 `Up`); `systemctl is-active ollama nginx`; `tailscale status` shows `househub` online | all back; any not-back item is reported to you but does **not** fail POS G3 unless you say it should |
| C14 | Resource baseline | `free -h; df -h /srv /` | recorded (swap was 2.0 Gi before) |

Evidence: `docs/selfhost-migration/evidence/G3/<date>-reboot.md` with T0, boot time, probe gap, the C-table with raw outputs, and anything done by hand.

**Optional, same window, each separately approved** (rest of G3 per 06 §4):
- **F4** `sudo systemctl stop tailscaled` for 10 min, then `start`. Run it from the console, because SSH over the tailnet drops. Expect: probe `000`, local services fine; after `start`, serve + cert back with no other action.
- **F5** Wi-Fi off for 15 min at the console. Expect: `tailscale status` recovers by itself after reconnect, with no re-login; WAL keeps archiving locally the whole time.

## Abort / rollback for W

| Situation | Action | Who |
|---|---|---|
| A fails a go criterion | Do not reboot. Fix, reschedule | engineer |
| No probe answer 10 min after T0 | At the console: is it at GRUB, a kernel panic, or a login prompt? Panic or hang → hard power cycle → GRUB **Advanced options → 7.0.0-30-generic**. Record it; the new kernel is then a finding, not a pass | owner |
| Booted, but docker / containers not up | `sudo systemctl start docker`; `cd /srv/supabase/stack && docker compose up -d --wait`. **G3 = fail** (manual action) | owner (sudo) / engineer |
| serve missing | `tailscale serve --bg --https=443 http://127.0.0.1:8000` (`lucario` is operator, no sudo). G3 = fail | engineer |
| db does not reach healthy | `docker compose logs db`; if PGDATA is damaged, restore from the base + WAL taken in A per [backup README §B](../../../deploy/lucashome/backup/README.md) (07 §5.1) | engineer, after your approval |
| Realtime not healthy | it reconnects on its own within seconds after a db restart (incident 2026-10-11); if not, `docker compose restart realtime`. G3 = fail | engineer |

Downtime estimate: nominal 2–5 min, typical window 60–90 min including checks; worst case with a bad kernel ≈ 30 min at the console.

## Part H — hardening (each step separately approvable; none needs a reboot)

### H0. Read-only inspection with sudo (owner, 5 min) — do first

```
ls$ sudo ufw status verbose
ls$ sudo iptables -S | head -n 60 ; sudo nft list ruleset | head -n 80
ls$ sudo sshd -T | grep -E '^(port|listenaddress|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
ls$ systemctl is-enabled ssh.socket ssh.service
ls$ sudo ss -tlnp ; sudo ss -ulnp
```

Paste the output to the engineer (no secrets in it). It answers the audit's open items: effective firewall, effective `PasswordAuthentication`, and who owns 41917/tcp. Do not paste `/etc/playit/playit.toml` (it holds the agent secret).

### H1. Firewall: ufw default-deny incoming

**First, the owner answers which public services stay and from where.** Today, bound to all interfaces (audit §4):

| Port | Service | Question for you | Engineer's suggestion |
|---|---|---|---|
| 22/tcp | sshd | From tailnet only, or also from the home LAN (10.10.124.0/24)? | tailnet + LAN (LAN = second way in if Tailscale breaks) |
| 80/tcp | nginx placeholder page | Needed at all? | drop (or stop nginx; ollama's 11435 proxy is loopback) |
| 3000/tcp | open-webui | Who uses it, and from where? | tailnet only |
| 3100/tcp | house-app | Public access goes through `househub` Funnel (outbound). Is direct LAN/WAN access to 3100 needed? | tailnet only |
| 25565/tcp, 19132/udp | Minecraft | Do players come in via your router's port forward, via playit (outbound tunnel, no inbound rule needed), or both? | keep only what is actually used |
| 41641/udp | Tailscale WireGuard | — | **allow**: it helps direct (non-DERP) paths, which the audit found missing |
| 8000 | Supabase gateway | already loopback-only | nothing to do |

**Docker caveat (important):** ports published by Docker (3000, 3100, 25565, 19132) are DNAT-ed in the `FORWARD` path, and Docker's own rules sit ahead of ufw's. **ufw does not filter them.** To really close one you must change that container's port binding (for example `127.0.0.1:3000:8080`, or the tailnet IP), or add rules to the `DOCKER-USER` chain. Rebinding means recreating the container (open-webui and `postgres` are plain `docker run` containers with no compose file). That is your project's change; list what you want and the engineer will draft it.

Commands, in this order. Keep the SSH session open throughout; you are connected over the tailnet, which is allowed before ufw is enabled:

```
ls$ sudo ufw default deny incoming
ls$ sudo ufw default allow outgoing
ls$ sudo ufw allow in on tailscale0 comment 'tailnet'
ls$ sudo ufw allow 41641/udp comment 'tailscale direct'
ls$ sudo ufw allow from 10.10.124.0/24 to any port 22 proto tcp comment 'LAN ssh'      # only if you said yes
ls$ # one line per service you keep, e.g. sudo ufw allow 25565/tcp comment 'minecraft'
ls$ sudo ufw show added          # review before enabling
ls$ sudo ufw enable              # sets ENABLED=yes; applies now and at boot
ls$ sudo ufw status numbered
```

Verify: a **new** `ssh lucashome true` from the Mac works; the probe from Part B returns non-`000`; minecraft/house still reachable the way you expect. **Revert:** `sudo ufw disable` (rules stay on file, nothing filtered); `sudo ufw reset` removes the rules. **Risk:** low with this order; the tailscale0 allow is what keeps you in.

### H2. sshd: keys only, no root login

Safe order. Nothing in it can lock you out, because session A stays open and is not affected by a reload:

1. Session A: `ssh lucashome`, then `sudo -v`. **Leave it open until step 7 passes.**
2. From a second Mac terminal, prove key login: `ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no lucashome true && echo KEY-OK`.
3. Make sure you know `lucario`'s local console password (the fallback if SSH is ever broken).
4. In session A:
   ```
   ls$ printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/10-hardening.conf
   ls$ sudo sshd -t && echo SYNTAX-OK
   ls$ sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '   # no / no / no
   ```
   `10-` sorts before `50-cloud-init.conf`, and sshd keeps the **first** value it reads, so this file wins over cloud-init's `PasswordAuthentication yes`.
5. `sudo systemctl reload ssh`. A reload, not a restart, so existing sessions stay.
6. New terminal: `ssh lucashome true` → works.
7. New terminal: `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password lucashome true` → `Permission denied (publickey)`.

**Revert:** `sudo rm /etc/ssh/sshd_config.d/10-hardening.conf && sudo systemctl reload ssh`. The Mac-tier pull keys ([MAC-TIER.md](../../../deploy/lucashome/backup/MAC-TIER.md)) are key-based and unaffected.

### H2b. Why not `ListenAddress 100.74.43.4`

sshd (or `ssh.socket`, if H0 shows socket activation) can start before `tailscaled` has the tailnet address. The bind then fails and **SSH is down after the next reboot**, with only the console left. It also removes LAN SSH as a fallback. H1 gives the same exposure reduction (22 reachable from tailnet + LAN only) without that boot-order trap. If you still want it, it needs `net.ipv4.ip_nonlocal_bind=1` or an `After=tailscaled.service` override, plus a reboot test with you at the console.

### H3. fail2ban

With H1 (22 from tailnet + LAN only) and H2 (keys only), there is nothing for fail2ban to throttle. Recommend skipping it. If 22 stays open to the internet: `sudo apt install fail2ban` (Ubuntu enables the `sshd` jail by default), add `ignoreip = 127.0.0.1/8 100.64.0.0/10` in `/etc/fail2ban/jail.d/local.conf`, then `sudo systemctl restart fail2ban`. Revert: `sudo apt remove fail2ban`.

### H4. Docker `daemon.json`: live-restore + default log limits

```
ls$ printf '{\n  "live-restore": true,\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "20m", "max-file": "5" }\n}\n' | sudo tee /etc/docker/daemon.json
ls$ sudo dockerd --validate --config-file /etc/docker/daemon.json     # "configuration OK"
ls$ sudo systemctl reload docker                                       # live-restore is reloadable; no container restarts
ls$ docker info --format '{{.LiveRestoreEnabled}}'                     # true
```

Effect: containers keep running when `dockerd` restarts. That matters because unattended upgrades of `docker.io` restart it. The log defaults apply only to containers **created after** the next daemon start. The Supabase containers already have 20 MB × 5 from the override. minecraft, open-webui, house-*, and postgres keep unbounded logs until you recreate them (your projects; optional). Check their size first with `sudo du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail`. **Revert:** `sudo rm /etc/docker/daemon.json && sudo systemctl reload docker`. **Risk:** a malformed file stops docker from starting at the next boot, which is why `--validate` runs first.

### H5. Memory limits for the other tenants (owner decision)

Check first: `docker stats --no-stream minecraft open-webui`. The limit must be above current use, or the kernel will reclaim/OOM inside the container.

```
ls$ docker update --memory 5g --memory-swap 6g minecraft         # 4 GiB heap (-Xmx4G) + JVM overhead
ls$ docker update --memory 1536m --memory-swap 2g open-webui     # ~0.5 GiB at the audit
ls$ docker inspect --format '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}' minecraft open-webui
```

Live, no restart, `docker` group (no sudo). It persists across container restarts but **not across recreation**, so also add `mem_limit: 5g` / `memswap_limit: 6g` to `/srv/minecraft`'s compose file (your file). ollama (systemd, can grow by many GiB when a model loads; audit capacity table): `sudo systemctl edit ollama` → `[Service]` `MemoryMax=6G` and `Environment=OLLAMA_MAX_LOADED_MODELS=1`, then `sudo systemctl restart ollama`. Your decision; it caps model size. **Revert:** `docker update --memory 14g --memory-swap -1 <name>`; `sudo systemctl revert ollama`.

### H6. Tailscale ACL policy (owner, admin console → Access controls)

1. **Save the current policy first.** Copy it into the password manager or a file. It is the revert. Note any `nodeAttrs` (e.g. Funnel for `househub`) and keep them unchanged.
2. **List every flow you rely on today**, because anything not listed is denied after the change. For example: Mac → `lucashome` 22/443/3000; Mac → `cyfro-staging`; `househub` (Funnel, inbound from the internet; not an ACL flow, but keep its node attribute); `cyfro-staging` → `lucashome:443` (planned monitoring probe, [09](../09-monitoring-alerting.md) layer B); the shared-in `cyfrosec-server` (its access is governed by the sharing tailnet's policy). **Answer this list before the engineer finalises the policy.**
3. Draft (to adjust after step 2):

```hujson
{
  "groups":    { "group:pos-admins": ["waiyanpaing183@gmail.com" /*, "<second admin login>" */] },
  "tagOwners": { "tag:till": ["group:pos-admins"] },
  "hosts":     { "lucashome": "100.74.43.4" },
  "acls": [
    { "action": "accept", "src": ["tag:till"],          "dst": ["lucashome:443"] },
    { "action": "accept", "src": ["group:pos-admins"],  "dst": ["lucashome:22,443"] },
    // + one line per flow kept from step 2 (e.g. your devices to cyfro-staging, lucashome:3000)
  ],
  "tests": [
    { "src": "tag:till", "accept": ["lucashome:443"], "deny": ["lucashome:22", "lucashome:3000", "lucashome:25565"] },
    { "src": "waiyanpaing183@gmail.com", "accept": ["lucashome:22", "lucashome:443"] }
  ]
  // "nodeAttrs": keep exactly what the saved policy has
}
```

The console refuses to save a policy whose `tests` fail, so the till restriction is checked at save time. Tills cannot reach each other or any other node. Verify after saving: `ssh lucashome true` and the Part B probe still work from the Mac; `househub` is still public. Keep a copy of the final policy in git (no secrets in it) once you approve the file. **Revert:** paste the saved policy back.

### H6s. Studio admin-only (Tailscale ACLs cannot restrict by URL path)

ACLs work on IP:port. Studio (`/`) and the API (`/auth`, `/rest`, …) share `lucashome:443`, so a till allowed to reach the API can also reach Studio's basic-auth prompt. Options:

| Option | What | Change | Recommendation |
|---|---|---|---|
| a | Accept: Studio behind basic auth, reachable by every allowed device | none | not once tills join |
| b | Move Studio to its own port: remove the Studio route from the gateway on 443, `tailscale serve --bg --https=8443 http://127.0.0.1:<studio-port>`, ACL `group:pos-admins → lucashome:8443` | stack config (`volumes/api`) + serve; needs its own approval and test | **before tills join**, if you use Studio regularly |
| c | Stop Studio when not in use: `cd /srv/supabase/stack && docker compose stop studio`; start it only for admin work | none permanent; `unless-stopped` keeps it stopped across reboots. A later `docker compose up -d` starts it again | **now**, simplest. Check in the same step that the gateway still serves the API with Studio stopped |
| d | Gateway rule on Tailscale identity headers (`tailscale serve` adds `Tailscale-User-Login` for user devices; tagged tills send none) | Envoy RBAC on a header | possible, more complex; not proposed |

### H7. Second tailnet admin (owner, 10 min)

Admin console → Users → Invite user → role **Admin**. Use a second account you control, or a trusted person. Free Personal plan: up to 3 users. Verify: the invitee signs in and sees the Machines page. Revert: remove the user. This also guards against losing access to the single owner login (audit risk 10).

### H8. Key expiry (owner, 5 min)

Admin console → Machines → `lucashome` → … → **Disable key expiry** (today it expires 2027-03-15). Tills: joining with a **tagged** auth key ([electron-1.0.16-canary.md](electron-1.0.16-canary.md) §R10) disables expiry automatically. Verify (read-only): `tailscale status --json | jq '.Self.KeyExpiry'` → `null`. Revert: enable it again in the console.

### H9. NVMe SMART (owner, 10 min)

```
ls$ sudo apt install -y smartmontools nvme-cli
ls$ sudo smartctl -H -A /dev/nvme0          # overall-health, Percentage Used, Available Spare, Media Errors, Unsafe Shutdowns
ls$ sudo nvme smart-log /dev/nvme0
```

Record the values in `lucashome-selfhost/status.md`. Unsafe Shutdowns should reflect the past crashes. Optional, for the [09](../09-monitoring-alerting.md) collector: `echo 'lucario ALL=(root) NOPASSWD: /usr/sbin/nvme smart-log /dev/nvme0' | sudo tee /etc/sudoers.d/90-lucario-smart && sudo chmod 440 /etc/sudoers.d/90-lucario-smart && sudo visudo -cf /etc/sudoers.d/90-lucario-smart`. Revert: `sudo rm` the file; `sudo apt remove smartmontools nvme-cli`.

### H10. Keep the container runtime out of unattended upgrades (optional)

Unattended upgrades are on (audit §2). An automatic `docker.io`/`containerd`/`runc` upgrade restarts `dockerd`, and without H4 that restarts every container. Either rely on H4, or add `/etc/apt/apt.conf.d/51unattended-upgrades-local` with `Unattended-Upgrade::Package-Blacklist { "docker.io"; "containerd"; "runc"; };` and upgrade those by hand in a window. Revert: delete the file. Kernel updates keep installing automatically and keep needing a manual reboot. Plan one window per month; [09](../09-monitoring-alerting.md) warns after 7 days of `reboot-required`.

## Risks

| Risk | Mitigation |
|---|---|
| New kernel 7.0.0-38 crashes or hangs (history of amdgpu/i2c crashes) | owner at the console; 7.0.0-30 in GRUB; record as a finding |
| Containers come back but in the wrong order (db after auth/realtime) | compose healthchecks + `unless-stopped` retries; C4 checks health, not just `Up` |
| ufw locks out SSH | tailscale0 allowed before `enable`; session A open; `ufw disable` from the console |
| ufw gives a false sense of safety for Docker ports | Docker caveat in H1; rebinding is a separate owner decision |
| ACL change breaks an unlisted flow (house app, work node) | step 2 inventory + saved old policy + `tests` |
| Memory limit too low kills Minecraft | check `docker stats` first; heap 4 G → limit 5 G |
| Window overruns | Part C can be completed later; only B causes downtime |

## Approvals and sudo summary

| Step | Approval | Sudo |
|---|---|---|
| A (backup scripts + read-only) | yes (runs on `lucashome`) | no |
| B reboot | yes | **yes** |
| C checks | covered by W | no (C12+ writes QA rows: separate yes) |
| F4 / F5 | separate yes each | F4 yes; F5 physical |
| H0 | yes | **yes** (read-only) |
| H1, H2, H3, H4, H9, H10 | separate yes each | **yes** |
| H5 minecraft/open-webui | yes | no; ollama **yes** |
| H6, H7, H8 | owner acts in the admin console | n/a |
| H6s option c | yes (stack change) | no |
