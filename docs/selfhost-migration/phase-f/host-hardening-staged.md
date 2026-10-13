# lucashome — staged host hardening (SSH, firewall, Docker networking, Tailscale)

Status: **audit + proposed procedure, 2026-10-13. Nothing in it has been executed.** Every stage below is marked **needs owner approval — not executed**.

The audit was read-only, run as `lucario` from the Mac with `ssh -o BatchMode=yes lucashome '<cmd>' </dev/null`: no `sudo`, and no change to the firewall, SSH, Tailscale, Docker, systemd or any file. No secret was read or printed. `.env*`, keys, `/etc/playit/playit.toml`, `TS_AUTHKEY` (environment variable name only) and `authorized_keys` (count and key type only) were checked without showing their contents.

Related documents:
- [`host-reboot-hardening.md`](host-reboot-hardening.md): the reboot checklist and the H-* change list. This file deepens H0, H-F1, H-F2, H-S1, H-T1, H-T2, H-D1 and H-U1 and adds dead-man timers. Where the two differ, this file is newer.
- [`../next-phase/reboot-and-hardening.md`](../next-phase/reboot-and-hardening.md): the long-form reasoning.

Cost: **$0**. Only Ubuntu packages and free Tailscale features are used.

**No stage needs a reboot.** sshd is reloaded, not restarted. ufw is enabled live. Docker is changed with `reload` or by recreating single containers. Tailscale changes are made in the admin console. The kernel reboot is a **separate approval** that follows [`host-reboot-hardening.md`](host-reboot-hardening.md). Hardening should be done either before that reboot, so the reboot also tests that hardening survives a boot, or after a successful G3. **Never do both in the same window.**

---

## 1. Audit findings (2026-10-13 ≈ 10:00 UTC)

Legend: **OK** · **GAP** · **ROOT?** = needs `sudo` to confirm (collected in Stage 0).

### 1.1 SSH

| # | Finding | State |
|---|---|---|
| SS1 | `openssh-server 1:10.2p1-2ubuntu3.6`. `ssh.socket` is enabled and active, with `ListenStream=0.0.0.0:22` and `[::]:22`, `Accept=no` (one long-running sshd, so `systemctl reload ssh` works). There is no `ssh.socket.d` drop-in | GAP (all interfaces) |
| SS2 | Active lines in `sshd_config`: `Include sshd_config.d/*.conf`, `KbdInteractiveAuthentication no`, `UsePAM yes`, `X11Forwarding yes`, `PrintMotd no`, `AcceptEnv …`, `Subsystem sftp`. There is no `PasswordAuthentication`, `PermitRootLogin`, `PubkeyAuthentication`, `AllowUsers`, `ListenAddress` or `Port` line, so the defaults apply: Port 22, pubkey on, root `prohibit-password` | — |
| SS3 | `sshd_config.d/50-cloud-init.conf` is 27 bytes, 0600 root, and **unreadable**. 27 bytes is exactly the length of `PasswordAuthentication yes\n`, so **password authentication is probably ON** | ROOT? |
| SS4 | `sshd -T` without root fails with `50-cloud-init.conf: Permission denied`. The effective config therefore needs `sudo sshd -T` | ROOT? |
| SS5 | `~lucario/.ssh/authorized_keys` is 0600 and holds **2 keys, both `ssh-ed25519`**, with no `from=` or `command=` options. `/root/.ssh` is unreadable | OK / ROOT? |
| SS6 | The only login user is `lucario` (uid 1000, bash). Its password is set (needed for sudo and the console) | — |
| SS7 | Logins in the last 14 days: **3281 `Accepted publickey` for lucario, all from the Mac's tailnet IP `100.114.x.x`**, and **0** `Failed password` or `Invalid user` lines. Nothing came from the LAN or the internet, which suggests the router does not forward 22. That is not proven. **Owner: check the router's port-forward and UPnP tables** | OK (evidence) |
| SS8 | fail2ban is **not installed** | — |
| SS9 | Tailscale SSH is **off** (`RunSSH=false`). The tailnet policy still has the default SSH rule (`check` action, members → own devices, nonroot + root), which is unused while RunSSH is false | OK |

### 1.2 Firewall

| # | Finding | State |
|---|---|---|
| F1 | `ufw.service` is enabled and active, but `/etc/ufw/ufw.conf` has **`ENABLED=no`**, so no ufw rules are loaded | GAP |
| F2 | `/etc/default/ufw` has `DEFAULT_INPUT_POLICY="DROP"`, `DEFAULT_FORWARD_POLICY="DROP"`, `IPV6=yes`, **`MANAGE_BUILTINS=no`**. That last setting matters: ufw does not flush Docker's or Tailscale's jumps in the built-in chains | OK |
| F3 | The `/etc/ufw/*.rules` files (before, after, user, v4 and v6) are 0640 root and unreadable. `user.rules` is 307 B, about the size of an empty file, so there are probably no user rules yet | ROOT? |
| F4 | `nftables.service` is disabled and inactive. `/etc/nftables.conf` is 243 B (the stock file) | OK |
| F5 | `iptables` → **`iptables-nft` (v1.8.11, nf_tables)** via alternatives. ufw, Docker (`Firewall Backend: iptables`) and tailscaled (`NetfilterMode=2` = on) all write into the same nf_tables backend through iptables-nft. No `iptables-persistent` | OK (consistent) |
| F6 | Reading `iptables -S`, `DOCKER-USER`, the nat table or `nft list ruleset` fails with `Permission denied (you must be root)` | ROOT? |
| F7 | sysctl: `ip_forward=1` (Docker), `ipv6 forwarding=0`, `rp_filter=2`, `accept_redirects=0`, `send_redirects=1`, `tcp_syncookies=1` | OK |
| F8 | IPv6 on the LAN: `wlp2s0` has **only a link-local** `fe80::` address (no global v6). The `[::]` listeners are reachable only from the same link | OK |

### 1.3 Docker networking

Projects: `supabase` (10 containers), `house` (3), `minecraft` (1). `postgres` and `open-webui` are plain `docker run`. There is no `/etc/docker/daemon.json`, so the defaults apply: userland-proxy **on** (10 `docker-proxy` processes), iptables on, `live-restore=false`. dockerd runs with `-H fd:// --containerd=…` and no drop-ins.

| Container | Network | Published | Bind | State |
|---|---|---|---|---|
| supabase-envoy | supabase_default | 8000/tcp | **127.0.0.1** | OK (verified loopback-only) |
| supabase-db, -auth, -rest, -storage, -meta, -studio, -imgproxy, -edge-functions, realtime | supabase_default | — (expose only) | — | OK, **nothing from the Supabase stack is published beyond 127.0.0.1:8000** |
| postgres (`postgres:18`) | bridge | 5432/tcp | **127.0.0.1** | OK |
| house-app-1 | house_house | 3100→3000/tcp | **0.0.0.0** (v4 only) | GAP |
| house-postgres-1 | house_house | — | — | OK |
| house-tailscale-1 | house_house | — | userspace (`TS_USERSPACE` set, no devices, no caps) | OK |
| open-webui | bridge | 3000→8080/tcp | **0.0.0.0 + [::]** | GAP |
| minecraft | minecraft_default | 25565/tcp, 19132/udp | **0.0.0.0 + [::]** | GAP (intended for players?) |

- **No container uses host networking.** None is privileged, has `cap_add` or has devices. Networks: `bridge`, `host`, `none`, `house_house`, `minecraft_default`, `supabase_default`.
- **Docker bypasses ufw for IPv4.** Published v4 ports are DNATed in `nat PREROUTING` and pass through `FORWARD` (where `DOCKER-USER` runs first), never `INPUT`. So `ufw deny` does **not** close 3000, 3100, 25565 or 19132 over IPv4. The IPv6 `[::]` publishes go through the userland `docker-proxy`, which takes the **INPUT** path, so ufw *does* filter them (link-local only, see F8).
- **house Funnel does not use the 3100 publish.** `docker/tailscale-serve.json` proxies `https://househub…:443` (Funnel) and `:80` (tailnet) to `http://app:3000` over the `house_house` network. Rebinding 3100 to 127.0.0.1 therefore leaves the Funnel working.
- **open-webui → ollama is already broken.** open-webui has `OLLAMA_BASE_URL=http://host.docker.internal:11434` (`host-gateway`), but ollama listens on `127.0.0.1:11434` only. From inside the container the probe returns `000` (fail) today. This is a **pre-existing** fault and is not caused by any hardening. If the owner later fixes it by binding ollama to `172.17.0.1`, ufw will need `allow in on docker0 to any port 11434` (see Stage 3a).
- Logs: Supabase is capped at json-file 20 MB × 5. The other containers are unbounded (already H-D1).

### 1.4 Tailscale

| # | Finding | State |
|---|---|---|
| T1 | `tailscale 1.102.3` from the Tailscale apt repo (`pkgs.tailscale.com/stable/ubuntu resolute`). tailscaled has `--port=41641`, `FLAGS=""` | OK |
| T2 | Self: `lucashome.tail8a86e4.ts.net`, `100.74.43.4` / `fd7a:…:a835:2b05`, **`Tags=null`** (user-owned), **`KeyExpiry=2027-03-15T03:53:46Z`**, ExitNode/ExitNodeOption false, no routes, relay `tor` (DERP, no direct path) | GAP (expiry) |
| T3 | Prefs: `ShieldsUp=false` (required for serve), `RunSSH=false`, `RouteAll=false` (accept-routes off), no exit node, `CorpDNS=true`, `RunWebClient=false`, `NoStatefulFiltering=true`, `NetfilterMode=2`, `OperatorUser=lucario`, **`AutoUpdate.Apply=true`** (tailscaled may update and restart itself, a brief tailnet drop; serve persists) | OK / decide (Stage 4) |
| T4 | Serve: `https://lucashome.tail8a86e4.ts.net (tailnet only)` → `/ proxy http://127.0.0.1:8000`, TCP 443 only. **No Funnel on lucashome** (funnel status = the same, tailnet only) | OK |
| T5 | Funnel exists **only on househub** (the `house-tailscale-1` sidecar): `https://househub.tail8a86e4.ts.net (Funnel on)` → `app:3000`, plus `http://househub` on port 80 (tailnet only). Sidecar prefs: ShieldsUp false, RunSSH false, no tags | OK |
| T6 | Node capabilities include `funnel`, `https`, `…/funnel-ports?ports=443,8443,10000`, `is-admin`, `is-owner`, `ssh`, `tailnet-lock`, `default-auto-update`. The `funnel` attribute is granted to lucashome too, though unused | GAP (minor) |
| T7 | **The effective ACL can be read without admin.** `tailscale debug netmap \| jq .PacketFilterRules` shows the compiled packet filter **for this node**: **allow all ports from every tailnet IP** (100.64.0.0/10 and fd7a:115c:a1e0::/48, minus the shared-in `cyfrosec-server`). That is the **default allow-all policy**. The full policy file (groups, tests, nodeAttrs) is visible **only in the admin console** | GAP |
| T8 | Peers: `cyfro-staging` (linux, **work server**, has full access to lucashome under allow-all), `househub`, `Lucas` (Windows, offline, key expires **2026-10-28**), `Wai's MacBook Air` (expiry 2027-03-15), `cyfrosec-server` (shared in from another tailnet; it cannot initiate to lucashome) | GAP (cyfro-staging blast radius) |
| T9 | Stale serve listeners on old tailnet IPs `100.95.109.83:443` and `fd7a:…:a101:6dcc:443` (cleared by the reboot) | cosmetic |

### 1.5 Listening sockets (`ss -tlnup`, no sudo; owner via `ss -e` uid)

| Bind | Proto/port | Owner | Reachable from | Notes |
|---|---|---|---|---|
| 0.0.0.0, [::] | tcp 22 | sshd (`ssh.socket`) | LAN, tailnet, WAN if forwarded | Stage 2 + 3a |
| 0.0.0.0, [::] | tcp 80 | nginx `default` site | LAN (WAN if forwarded) | serves **only `index.nginx-debian.html`**, so it can be closed |
| 0.0.0.0, [::] | tcp 3000 | docker-proxy → open-webui | LAN | ufw can't block v4 (Stage 3b/3c) |
| 0.0.0.0 | tcp 3100 | docker-proxy → house-app | LAN | Funnel doesn't need it (Stage 3c) |
| 0.0.0.0, [::] | tcp 25565, udp 19132 | docker-proxy → minecraft | LAN (+ playit tunnel) | owner decides LAN play |
| 0.0.0.0, [::] | udp 41641 | tailscaled | anywhere | keep (direct WireGuard) |
| 0.0.0.0 / * | udp 41201, 56474, 42038, 43263 | **uid 982 = `playit`** | outbound tunnel sockets | outbound + replies: conntrack ESTABLISHED |
| 100.74.43.4, fd7a…2b05 | tcp 443 | tailscaled serve | tailnet | keep |
| 100.74.43.4 / fd7a | tcp 59508 / 63375 | tailscaled (peerapi) | tailnet | keep |
| 100.95.109.83, fd7a…a101:6dcc | tcp 443 | tailscaled (stale) | — | T9 |
| 127.0.0.1 | 8000, 5432, 11434 (ollama), 11435 (nginx→ollama), 41917 (root, unknown, probably containerd/tailscaled local API), 323 (chrony) | — | loopback | OK |
| 127.0.0.53/54 | 53 | systemd-resolved | loopback | OK |
| 10.10.124.245%wlp2s0 | udp 68 | systemd-networkd DHCP | LAN | ufw before.rules allows DHCP |

Baseline health (2026-10-13, from the host): nginx :80 → 200, ollama :11434 → 200, nginx→ollama :11435 → 200, open-webui `/health` → 200, house `/api/health` :3100 → 200, `postgres:18` `pg_isready` OK, minecraft `mc-health` OK, open-webui→ollama **FAIL (pre-existing)**. From the Mac: `https://househub.tail8a86e4.ts.net/api/health` → 200.

### 1.6 What still needs root (Stage 0 collects it)

1. Effective sshd config (`sshd -T`) and the content of `50-cloud-init.conf`.
2. `/root/.ssh/authorized_keys` presence and count.
3. `ufw status verbose` and the content of `/etc/ufw/user*.rules` and `after*.rules`.
4. `iptables -S` (filter: INPUT/FORWARD/DOCKER-USER/ts-input/ts-forward), `iptables -t nat -S`, `ip6tables -S`, `nft list ruleset` summary.
5. `ss -tlnpu` with process names (confirm 41917).
6. **Router** port-forward and UPnP tables (owner, router UI). These decide whether anything here is internet-exposed.
7. Tailscale policy file (admin console → Access controls). Owner only.

---

## 2. Top risks

1. **Password SSH probably on, on every interface** (SS3, SS1), with no firewall (F1). Exposure today depends only on the router.
2. **Docker-published ports bypass ufw** (§1.3). Enabling ufw alone gives a **false sense of safety** for 3000, 3100, 25565 and 19132.
3. **Tailnet allow-all** (T7): every tailnet device, including the work server `cyfro-staging`, can reach every port on lucashome (SSH, open-webui, Studio via the gateway). The future tills and phones must not inherit this.
4. **Node key expiry 2027-03-15** (T2): lucashome drops off the tailnet, and the POS backend with it, until someone re-authenticates at the console.
5. **Lock-out while hardening.** sshd and ufw changes are made over the very path they protect. This is mitigated by dead-man timers, a second open session and the console fallback.
6. Unattended `docker.io`/`containerd` security updates restart every container (`live-restore=false`), and Tailscale auto-update restarts tailscaled.

---

## 3. Ground rules for every stage

- **Who:** the owner runs the commands. `sudo` needs `lucario`'s password, so use an interactive `ssh -t lucashome` (not BatchMode) or the local console. The engineer watches from the Mac.
- **Two sessions:** keep **session A** (an SSH session with `sudo -v` done) open for the whole stage. Make every test in a **new** session B. Never close A until verification passes and the dead-man timer is cancelled.
- **Console fallback:** the owner can reach the laptop's keyboard during Stages 2 and 3.
- **Dead-man pattern:** schedule the rollback **before** the change with `systemd-run --on-active=… --unit=<name>`. That creates `<name>.timer` + `<name>.service`, which run as root and survive a dropped SSH session. Cancel with `sudo systemctl stop <name>.timer` **only after** verification. Check with `systemctl list-timers '<name>*'`. If the timer fires, the rollback runs on its own. Afterwards `sudo systemctl reset-failed <name>.service` (cosmetic) clears it.
- **Timing:** avoid :15 (hourly dump), 02:30 (base backup), Sunday 03:30 and :00/:30 (status). Use hh:35–hh:55.
- **Service check:** the reusable **`SVC-CHECK`** block below must match the baseline after every stage.

### SVC-CHECK (run from the Mac; read-only)

```sh
ssh -o BatchMode=yes lucashome '
docker ps --format "{{.Names}} {{.Status}}" | sort
systemctl is-active docker tailscaled nginx ollama playit ssh.socket
curl -s -o /dev/null -m5 -w "nginx80 %{http_code}\n"      http://127.0.0.1/
curl -s -o /dev/null -m5 -w "ollama %{http_code}\n"       http://127.0.0.1:11434/api/version
curl -s -o /dev/null -m5 -w "ollama-nginx %{http_code}\n" http://127.0.0.1:11435/api/version
curl -s -o /dev/null -m5 -w "open-webui %{http_code}\n"   http://127.0.0.1:3000/health
curl -s -o /dev/null -m5 -w "house %{http_code}\n"        http://127.0.0.1:3100/api/health
docker exec postgres pg_isready -q && echo "postgres18 ready"
docker exec minecraft mc-health >/dev/null 2>&1 && echo "minecraft ok"
docker exec house-tailscale-1 tailscale funnel status 2>/dev/null | grep -c "Funnel on"
tailscale serve status | head -2
cd /srv/supabase/stack && docker compose ps --format "{{.Health}}" | sort | uniq -c
' </dev/null
curl -s -o /dev/null -m8 -w "lucashome serve %{http_code}\n" https://lucashome.tail8a86e4.ts.net/auth/v1/health   # expect 401
curl -s -o /dev/null -m8 -w "househub %{http_code}\n"        https://househub.tail8a86e4.ts.net/api/health        # expect 200
```

Expected: 16 containers Up; 6× `active`; 200 / 200 / 200 / 200 / 200; `postgres18 ready`; `minecraft ok`; Funnel count `1`; serve shows `(tailnet only)`; Supabase `10 healthy`; Mac 401 and 200. If 3100 is rebound (Stage 3c), the `house` curl still works because it goes to 127.0.0.1.

External checks the owner does by hand:
- **Funnel from the internet:** a phone on **mobile data, with Tailscale off**, opens `https://househub.tail8a86e4.ts.net/api/health` → 200.
- **Minecraft via playit:** join with a client using the playit address (or `nc -vz <playit-host> <port>` from off-LAN).
- **LAN:** from another LAN device (phone/laptop on the home Wi-Fi, Tailscale off): `nc -vz 10.10.124.245 22` and the ports below.

---

## 3A. Recovery paths — verified 2026-10-13 (read-only, engineer) and the gate before ANY live change

| Path | State today | How checked |
|---|---|---|
| SSH over Tailscale from the Mac | **works** — the only working remote path; relayed via DERP (no direct path) | `ssh lucashome` BatchMode; `tailscale status` shows `relay "tor"` |
| Authorized keys | **one** key only (the Mac's ed25519), listed **twice** in `authorized_keys`; no second device or offline key | `ssh-keygen -lf` fingerprints on both sides match |
| SSH over the home LAN | **does not work**: the Mac and the server share the router (same gateway MAC) but the Mac cannot even ARP the server; ping/22/3000 time out → Wi-Fi **client isolation** on the router/AP | `arp`, `ping`, `nc` from the Mac (2026-10-13) |
| Password login | the account has a password set (`passwd -S` = P) and sshd very likely allows passwords (§1.1) | read-only |
| sudo | user is in `sudo`; sudo needs the account password (`sudo -n` → authentication required) | read-only |
| Physical console | laptop keyboard/screen at home — **not verified by the engineer** | owner |
| Tailscale SSH | off | `tailscale status --json` |

Consequences:
- Every "LAN device" check and the "LAN ssh" ufw rule below are **moot** until client isolation is removed for the server (Ethernet, or the router's isolation setting). Do not count LAN SSH as a fallback.
- If Tailscale on the server breaks (key expiry, logout, bad policy), the **only** way back in is the physical console.
- If the Mac is lost after Stage 2 (key-only), there is **no** key left → console only.

**Gate R (must all be YES before Stage 1, 2 or 3; owner + engineer):**
1. Owner logs in at the **physical console** with the account password and runs `sudo -v` successfully (proves console + sudo password). Record date.
2. A **second authorized key** from another device the owner controls (e.g. a Windows PC or a hardware key), added by the owner, tested with `ssh -o IdentitiesOnly=yes -i <that key> lucario@<tailnet name> true`; the duplicate line removed. Fingerprints recorded in `access.md` (fingerprints only).
3. Tailscale node key expiry **disabled** for the server in the admin console (Stage 1 first item) and confirmed (`tailscale status --json` → `KeyExpiry` absent).
4. Fresh verified base backup + LSN (backup-status OK) on the day.
5. Owner present at the console for Stage 2 and Stage 3 (dead-man timers cover a lost session, the console covers a lost network).
6. Optional but recommended: Ethernet for the server, or client isolation off for it — gives a real LAN path and a direct Tailscale path.

## 4. Stages

### Stage 0 — read-only sudo inspection · **needs owner approval — not executed**

**Purpose:** close every ROOT? item in §1.6. It changes nothing, so no rollback is needed.

```sh
ssh -t lucashome            # interactive; owner types the sudo password
sudo -v
sudo sshd -T | grep -E '^(port|listenaddress|addressfamily|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|authenticationmethods|allowusers|allowgroups|usepam|x11forwarding|maxauthtries|permitemptypasswords) '
sudo cat /etc/ssh/sshd_config.d/50-cloud-init.conf          # expected: PasswordAuthentication yes (not a secret)
sudo sh -c 'ls -la /root/.ssh 2>&1; test -f /root/.ssh/authorized_keys && grep -cvE "^\s*(#|$)" /root/.ssh/authorized_keys'   # count only
sudo ufw status verbose
sudo cat /etc/ufw/user.rules /etc/ufw/user6.rules | grep -E '^-A|^### tuple' || echo "no user rules"
sudo grep -nE 'DOCKER|^\*|^:|COMMIT' /etc/ufw/after.rules /etc/ufw/after6.rules
sudo iptables -S INPUT;  sudo iptables -S FORWARD
sudo iptables -S DOCKER-USER; sudo iptables -S ts-input; sudo iptables -S ts-forward
sudo iptables -t nat -S | grep -E 'DNAT|DOCKER' | head -30
sudo ip6tables -S | head -40
sudo nft list tables; sudo nft list ruleset | wc -l
sudo ss -tlnpu
```

Paste the output to the engineer. It holds no secrets: sshd -T prints no keys, and rules hold no passwords. Also, **owner in the router UI:** list the port forwards, the DMZ setting and the UPnP leases that point at 10.10.124.245.

**Decision outputs:** Is password auth on? Is DOCKER-USER empty? Are there any ufw user rules? Any router forwards? These choose the options in Stage 3.

---

### Stage 1 — Tailscale admin console · **needs owner approval — not executed**

**Purpose:** remove the 2027-03-15 cliff and replace allow-all with least privilege before any till or phone joins. Nothing changes on the host, and no daemon restarts.

**1a. Disable key expiry for lucashome** (owner, console): Machines → `lucashome` → ⋯ → **Disable key expiry**.
- Verify (Mac): `ssh -o BatchMode=yes lucashome 'tailscale status --json | jq .Self.KeyExpiry' </dev/null` → `null` (it may take ~1 min to propagate).
- Rollback: Machines → lucashome → ⋯ → Enable key expiry.
- Optional, same screen: also disable key expiry for **househub** (2027-03-27), because the Funnel dies when it expires. Remove or renew the offline **`Lucas`** Windows node (expires 2026-10-28) if it is no longer used.

**1b. ACL policy (proposal, for the owner to paste into Access controls)**

Before editing, **copy the current policy** into a local file (`~/tailnet-policy-backup-YYYYMMDD.hujson`). That copy is the rollback. Proposal, using `grants` syntax:

```jsonc
{
  "groups": {
    "group:owner": ["waiyanpaing183@gmail.com"]
  },
  "tagOwners": {
    "tag:till":  ["autogroup:admin"],   // POS tills (desktop app) — join with a tagged, pre-approved auth key
    "tag:phone": ["autogroup:admin"],   // phones used for phone-upload, if they join the tailnet
    "tag:work":  ["autogroup:admin"]    // optional: put cyfro-staging here to cut its access to home boxes
  },
  "hosts": {
    "lucashome": "100.74.43.4",
    "househub":  "100.123.108.123"
  },
  "grants": [
    // Owner's own (untagged) devices: everything, as today.
    { "src": ["group:owner"], "dst": ["*"], "ip": ["*"] },
    // Tills and phones: only the HTTPS serve on lucashome.
    { "src": ["tag:till", "tag:phone"], "dst": ["lucashome"], "ip": ["tcp:443"] }
    // tag:work gets no grant -> cannot reach lucashome or househub.
  ],
  "ssh": [
    // Keep the default rule (unused while RunSSH=false; OpenSSH is the SSH path).
    { "action": "check", "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"] }
  ],
  "nodeAttrs": [
    // COPY THE EXISTING nodeAttrs block (the one granting "funnel") unchanged,
    // otherwise the househub Funnel stops. Do not add funnel for lucashome.
  ],
  "tests": [
    { "src": "tag:till",  "accept": ["lucashome:443"], "deny": ["lucashome:22", "lucashome:3000", "lucashome:8000", "househub:443"] },
    { "src": "tag:phone", "accept": ["lucashome:443"], "deny": ["lucashome:22", "househub:443"] },
    { "src": "waiyanpaing183@gmail.com", "accept": ["lucashome:22", "lucashome:443", "househub:443"] }
  ]
}
```

Notes:
- Untagged devices belong to their user, so `group:owner` covers the Mac, `Lucas` and `cyfro-staging` while it stays untagged. Tagging cyfro-staging with `tag:work` cuts it off from home. That is an **owner decision**: confirm first that nothing on cyfro-staging needs lucashome (none known).
- **Do not tag lucashome or househub in this stage.** Tagging changes node ownership and capabilities (for example `is-owner`), and the funnel nodeAttr may target the user.
- **Testing:** the `tests` block runs on every save, and the console **refuses to save** a policy whose tests fail. Also use Access controls → *Preview rules* for `lucashome`. There is no `tailscale debug` command that dry-runs a policy file.
- **On-node verification after saving** (read-only, from the Mac):
  `ssh -o BatchMode=yes lucashome 'tailscale debug netmap | jq -c .PacketFilterRules' </dev/null` → the src set for `*` ports now lists only the owner's device IPs, plus a 443-only rule for tag:till/phone once such devices exist. Then run `ssh lucashome true` (new session) and **SVC-CHECK**.
- **Dead-man:** the console has no timer. The safety net is that the owner grant keeps the Mac path, that the tests block the save, and that the backup file restores the old policy in one paste. If the Mac loses access anyway, use the console (the LAN SSH path does not work today: client isolation, §3A). The policy itself can always be edited from any browser.
- **Rollback:** Access controls → paste the backup → Save.

---

### Stage 2 — SSH key-only, `AllowUsers lucario`, no root · **needs owner approval — not executed**

**Prerequisites:** Stage 0 done. Both `authorized_keys` keys identified. The owner has a key that works from a LAN device, or accepts console-only as the non-tailnet fallback.

**Purpose:** remove password and keyboard-interactive login and root login, and allow only `lucario`. The change is a drop-in that sorts **before** `50-cloud-init.conf`: sshd uses the **first** value it reads, so `10-` wins over `PasswordAuthentication yes` in `50-`. Nothing touches `ssh.socket`, the listen addresses or the port. The change is a **reload, not a restart**, so existing sessions stay up.

```sh
# Session A (keep open the whole stage)
ssh -t lucashome
sudo -v

# 0. Prove key login works in a NEW session B first (from the Mac, another terminal):
#    ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no lucashome 'echo key-ok'

# 1. Dead-man FIRST: in 10 min, remove the drop-in and reload (runs as root, survives a dropped session)
sudo systemd-run --on-active=10min --unit=sshd-rollback \
  /bin/sh -c 'rm -f /etc/ssh/sshd_config.d/10-hardening.conf && systemctl reload ssh'
systemctl list-timers 'sshd-rollback*'

# 2. Drop-in
sudo tee /etc/ssh/sshd_config.d/10-hardening.conf >/dev/null <<'EOF'
# lucashome hardening (Stage 2) — delete this file + `systemctl reload ssh` to revert
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers lucario
X11Forwarding no
MaxAuthTries 4
EOF
sudo chmod 0644 /etc/ssh/sshd_config.d/10-hardening.conf

# 3. Validate; if this fails, do NOT reload — delete the file instead
sudo sshd -t && echo SYNTAX-OK
sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|authenticationmethods|allowusers|x11forwarding|port|listenaddress) '
#   expect: passwordauthentication no, kbdinteractiveauthentication no, permitrootlogin no,
#           pubkeyauthentication yes, authenticationmethods publickey, allowusers lucario,
#           x11forwarding no, port 22, listenaddress [::]:22 / 0.0.0.0:22 (unchanged)

# 4. Reload (not restart)
sudo systemctl reload ssh && systemctl is-active ssh ssh.socket
```

**Verify** (each one in a **new** session; keep A open):

| From | Command | Expect |
|---|---|---|
| Mac (tailnet) | `ssh -o BatchMode=yes lucashome 'echo ok'` | `ok` |
| Mac | `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive lucashome true` | `Permission denied (publickey).` |
| Mac | `ssh -o BatchMode=yes root@100.74.43.4 true` | `Permission denied` |
| LAN device | `ssh lucario@10.10.124.245 'echo lan-ok'` (with its key) | `lan-ok` — **skip today**: LAN path blocked by client isolation (§3A) |
| host | `journalctl -u ssh --since -10min --no-pager \| tail` | no errors |
| Mac | **SVC-CHECK** | baseline |

**Commit:** cancel the dead-man **only after** all the checks pass: `sudo systemctl stop sshd-rollback.timer && systemctl list-timers 'sshd-rollback*'` (should be gone).

**Rollback** (any time): `sudo rm -f /etc/ssh/sshd_config.d/10-hardening.conf && sudo sshd -t && sudo systemctl reload ssh`. If you are locked out entirely, wait ≤ 10 min for the timer, or use the console.

**Not done, by design:** no `ListenAddress` on the tailnet IP. `ssh.socket` binds before tailscaled, so after a reboot sshd would not listen on 100.74.43.4 and SSH would be lost. Interface restriction is done by ufw in Stage 3a.

---

### Stage 3 — firewall · **needs owner approval — not executed**

Split into **3a** (ufw for host-process ports), **3b** (DOCKER-USER for Docker-published v4 ports) and **3c** (rebind Docker ports, per service, owner's projects). Each sub-stage has its own dead-man. Do them in separate windows or at least verify each one fully before the next.

#### 3a. ufw: default deny incoming

**Purpose:** close 22 and 80 to everything except the tailnet and the LAN, and keep Tailscale's direct path. Host-process ports only (sshd, nginx, tailscaled). Docker v4 publishes are **not** affected (3b handles those); Docker v6 `[::]` publishes **are** affected (docker-proxy is on the INPUT path).

```sh
ssh -t lucashome      # session A, keep open
sudo -v
sudo cp -a /etc/ufw /root/ufw-backup-$(date +%Y%m%d%H%M)

# 1. Dead-man FIRST (10 min): disable ufw again
sudo systemd-run --on-active=10min --unit=ufw-rollback /usr/sbin/ufw --force disable
systemctl list-timers 'ufw-rollback*'

# 2. Rules (added while ufw is still inactive — nothing is enforced yet)
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw default deny routed                       # matches DEFAULT_FORWARD_POLICY=DROP; Docker's own FORWARD accepts come first
sudo ufw allow in on tailscale0 comment 'tailnet (ACL is enforced by Tailscale)'
sudo ufw allow 41641/udp comment 'tailscale direct wireguard'
sudo ufw allow from 10.10.124.0/24 to any port 22 proto tcp comment 'LAN ssh (fallback path)'
# nginx :80 serves only the Debian default page -> leave closed. If the owner wants it on the LAN:
#   sudo ufw allow from 10.10.124.0/24 to any port 80 proto tcp comment 'LAN http'
# Docker v6 link-local publishes (only if LAN players/clients use IPv6 link-local; normally not needed):
#   sudo ufw allow from fe80::/10 to any port 25565 proto tcp ; sudo ufw allow from fe80::/10 to any port 19132 proto udp
# Only if open-webui->ollama is later fixed by binding ollama to 172.17.0.1:
#   sudo ufw allow in on docker0 to any port 11434 proto tcp comment 'open-webui -> ollama'
sudo ufw show added

# 3. Enable (--force skips the interactive "may disrupt ssh" prompt; our session is on tailscale0 = allowed,
#    and established connections are kept by ufw's before.rules)
sudo ufw --force enable
sudo ufw status verbose
sudo iptables -S INPUT | head; sudo iptables -S FORWARD | head   # Docker/ts jumps still first (MANAGE_BUILTINS=no)
```

**Verify** (new sessions, within the 10 min):

| From | Command | Expect |
|---|---|---|
| Mac (tailnet) | `ssh -o BatchMode=yes lucashome 'echo ok'` | `ok` |
| Mac | `curl -s -o /dev/null -w '%{http_code}\n' https://lucashome.tail8a86e4.ts.net/auth/v1/health` | `401` |
| Mac | `nc -vz -w3 100.74.43.4 80` | succeeds (tailnet allowed; still fine) |
| LAN device | `nc -vz -w3 10.10.124.245 22` | open |
| LAN device | `nc -vz -w3 10.10.124.245 80` | **timeout** (closed) |
| LAN device | `nc -vz -w3 10.10.124.245 3000` / `3100` / `25565` | **still open** (v4 Docker bypass; expected until 3b/3c) |
| host | `tailscale status --self; tailscale netcheck \| head -5` | Running; UDP true |
| host | `docker exec open-webui curl -s -m3 -o /dev/null -w '%{http_code}' https://pypi.org` | `200` (container egress OK) |
| host | `sudo grep -c 'UFW BLOCK' /var/log/ufw.log` (or `journalctl -k --since -10min \| grep -c 'UFW BLOCK'`) | look for unexpected blocks from 172.16/12 or tailscale0 |
| Mac | **SVC-CHECK** + phone-on-mobile-data Funnel check + Minecraft via playit | baseline |

**Commit:** `sudo systemctl stop ufw-rollback.timer`. ufw stays enabled across reboots (`ENABLED=yes`). Re-run SVC-CHECK after the next reboot.

**Rollback:** `sudo ufw --force disable` (rules are kept for later), or for a full reset `sudo ufw --force reset` (the backup is in `/root/ufw-backup-*`).

#### 3b. DOCKER-USER: stop non-LAN traffic to Docker-published ports

**Purpose:** make Docker's v4 publishes obey policy without recreating containers. Rule: **NEW connections arriving on `wlp2s0` from outside `10.10.124.0/24` are dropped** before reaching any container. That covers a router port forward, DMZ or UPnP. LAN devices keep access (players, open-webui on the LAN). Container egress is unaffected (replies are ESTABLISHED). Persisted through ufw's `after.rules`, so the rule exists before dockerd starts at boot and Docker reuses the chain.

```sh
ssh -t lucashome      # session A
sudo -v
sudo cp -a /etc/ufw/after.rules /root/after.rules.pre-docker-user

# 1. Dead-man FIRST (10 min): restore after.rules, flush the chain, reload ufw
sudo systemd-run --on-active=10min --unit=dockeruser-rollback /bin/sh -c \
  'cp -a /root/after.rules.pre-docker-user /etc/ufw/after.rules; iptables -F DOCKER-USER; ufw reload'
systemctl list-timers 'dockeruser-rollback*'

# 2. Append a filter block to the END of /etc/ufw/after.rules (after its final COMMIT)
sudo tee -a /etc/ufw/after.rules >/dev/null <<'EOF'

# BEGIN lucashome DOCKER-USER (Stage 3b) — Docker-published ports: LAN + tailnet only
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i wlp2s0 -s 10.10.124.0/24 -j RETURN
-A DOCKER-USER -i wlp2s0 -m conntrack --ctstate NEW -j DROP
-A DOCKER-USER -j RETURN
COMMIT
# END lucashome DOCKER-USER
EOF
# Optional per-port LAN restriction, e.g. open-webui not even on the LAN (insert before the LAN RETURN):
#   -A DOCKER-USER -i wlp2s0 -p tcp -m conntrack --ctorigdstport 3000 --ctstate NEW -j DROP

# 3. Apply
sudo ufw reload
sudo iptables -S DOCKER-USER
sudo iptables -S FORWARD | head -5      # -j DOCKER-USER must be the first jump
```

**Verify:** LAN device → `nc -vz 10.10.124.245 3000`, `3100`, `25565` and `nc -vzu 10.10.124.245 19132` stay **open** (LAN allowed). Minecraft via **playit** works: playit connects to the server through the host itself, not via `wlp2s0` from a non-LAN IP. Funnel works (phone on mobile data). **SVC-CHECK.** WAN test only if Stage 0 found a router forward: phone on mobile data → `<public-ip>:<port>` → **timeout**.
Do **not** restart Docker in this stage. Whether the rules survive a boot (ufw creates the chain, then dockerd reuses it) is proven at the next approved reboot: add `sudo iptables -S DOCKER-USER` to that reboot's V-checks.

**Commit:** `sudo systemctl stop dockeruser-rollback.timer`.
**Rollback:** `sudo cp -a /root/after.rules.pre-docker-user /etc/ufw/after.rules && sudo iptables -F DOCKER-USER && sudo ufw reload`.

#### 3c. Rebind Docker publishes (per service; owner's projects; each recreates one container)

**Purpose:** the strongest fix. A port bound to `127.0.0.1` cannot be reached from outside regardless of firewall state. **Never bind to the tailnet IP** (`100.74.43.4:…`): at boot dockerd can start before tailscale0 has its IP, and the container then fails with `cannot assign requested address`.

| Service | Current | Proposal | Impact | Commands |
|---|---|---|---|---|
| house-app | `0.0.0.0:3100` | `127.0.0.1:3100` | none for Funnel (sidecar → `app:3000`); LAN access to :3100 ends (use househub URL) | in `/home/lucario/personal/House/docker-compose.yml` set `ports: ["127.0.0.1:3100:3000"]`; `cd /home/lucario/personal/House && docker compose -f docker-compose.yml -f compose.tailscale.yml up -d app` (recreates **only** app; ~5–10 s outage) |
| open-webui | `0.0.0.0:3000`, `[::]:3000` | `127.0.0.1:3000` + tailnet access via `tailscale serve --bg --https=8443 http://127.0.0.1:3000` (Stage-level approval: it is a serve change) or an SSH tunnel | LAN browser access ends | record the current run config: `docker inspect open-webui --format '{{json .Mounts}} {{.Config.Image}}'`; `docker stop open-webui && docker rename open-webui open-webui-old`; `docker run -d --name open-webui --restart unless-stopped -p 127.0.0.1:3000:8080 --add-host host.docker.internal:host-gateway -v <same volume>:/app/backend/data <same env> ghcr.io/open-webui/open-webui:main` (**use the image ID already present**, no pull); verify, then `docker rm open-webui-old` |
| minecraft | `0.0.0.0/[::]:25565, 19132` | keep (LAN play) + 3b, **or** `127.0.0.1` if only playit is used | LAN players must use the playit address | edit `/srv/minecraft/docker-compose.yml` ports → `docker compose up -d` in `/srv/minecraft`; first `docker exec minecraft rcon-cli save-all` |
| postgres:18 | `127.0.0.1:5432` | keep | — | — |
| supabase-envoy | `127.0.0.1:8000` | **keep (must stay loopback)** | — | — |

**Dead-man:** not timer-based, because these are container recreations and lock-out is impossible (SSH and the tailnet are untouched). Rollback = revert the compose line and `docker compose up -d <svc>`, or for open-webui `docker rm -f open-webui && docker rename open-webui-old open-webui && docker start open-webui`.
**Verify:** `ss -Htln | grep -E ':(3000|3100|25565) '` shows the new binds; SVC-CHECK; LAN `nc` to the rebound port → refused.

---

### Stage 4 — updates, Docker resilience, optional fail2ban · **needs owner approval — not executed**

**4a. Docker `live-restore`** (dockerd restarts from updates no longer stop containers):
```sh
printf '{ "live-restore": true, "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }\n' > /tmp/daemon.json.new
sudo dockerd --validate --config-file /tmp/daemon.json.new && echo valid      # only continue on "valid"
sudo install -m 0644 -o root -g root /tmp/daemon.json.new /etc/docker/daemon.json
sudo systemctl reload docker        # SIGHUP: live-restore applies now; log defaults apply to new containers after the next daemon start
docker info --format '{{.LiveRestoreEnabled}}'   # true
```
Do **not** set `userland-proxy` or `iptables` here, because both need a daemon restart. Verify with SVC-CHECK. Rollback: `sudo rm /etc/docker/daemon.json && sudo systemctl reload docker`.

**4b. Keep the Docker runtime out of unattended upgrades** (security updates still come in for everything else). Pick one:
- Blacklist, which affects unattended-upgrades only:
  `printf 'Unattended-Upgrade::Package-Blacklist { "docker.io"; "containerd"; "runc"; "docker-compose-v2"; };\n' | sudo tee /etc/apt/apt.conf.d/51unattended-upgrades-local`
  Verify: `sudo unattended-upgrade --dry-run --debug 2>&1 | grep -iE 'blacklist|docker'`. Rollback: `sudo rm` the file.
- Or a hold, which also blocks a manual `apt upgrade`:
  `sudo apt-mark hold docker.io containerd runc`. Verify: `apt-mark showhold`. Rollback: `sudo apt-mark unhold …`.

Either way, plan a monthly manual window for the Docker runtime, openssh (currently 3.7 in `-updates`, not auto-installed) and the kernel, using the reboot checklist.

**4c. Tailscale auto-update** (`AutoUpdate.Apply=true`). Keep it on: security fixes are worth it, and serve persists across a tailscaled restart. Alternatively, to control timing, the owner runs `tailscale set --auto-update=false` and updates by hand in the monthly window. That is an owner decision; this audit made no `set`.

**4d. fail2ban (optional, low value after Stages 2 and 3a).** With SSH key-only and reachable only from the tailnet and LAN, brute force is already ineffective. If wanted anyway:
`sudo apt install -y fail2ban` (Ubuntu's `jail.d/defaults-debian.conf` enables the `sshd` jail), then add `/etc/fail2ban/jail.d/local.conf`:
```
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10 fd7a:115c:a1e0::/48 10.10.124.0/24
backend = systemd
```
`sudo systemctl restart fail2ban` (fail2ban only) and `sudo fail2ban-client status sshd`. Rollback: `sudo apt purge fail2ban`. The ignoreip covers the tailnet and LAN, so fail2ban can never ban the owner's own path.

---

## 5. Order and approvals summary

| Stage | Change | Lock-out risk | Dead-man | Restart/reboot | Approval |
|---|---|---|---|---|---|
| 0 | read-only sudo inspection + router check | none | n/a | none | needs owner approval — not executed |
| 1a | disable key expiry (lucashome, optionally househub) | none | n/a (console toggle) | none | needs owner approval — not executed |
| 1b | tailnet ACL grants + tests | low (owner grant + tests) | backup policy paste | none | needs owner approval — not executed |
| 2 | sshd drop-in: key-only, AllowUsers, no root | medium | `sshd-rollback` timer, 10 min | `reload ssh` only | needs owner approval — not executed |
| 3a | ufw deny incoming + tailnet/LAN-ssh/41641 allows | medium | `ufw-rollback` timer, 10 min | none | needs owner approval — not executed |
| 3b | DOCKER-USER via ufw after.rules | low | `dockeruser-rollback` timer, 10 min | `ufw reload` only | needs owner approval — not executed |
| 3c | rebind house 3100 / open-webui 3000 (/ minecraft) to 127.0.0.1 | none | manual revert | recreate one container each | needs owner approval per service — not executed |
| 4 | live-restore, UU blacklist/hold, Tailscale auto-update choice, optional fail2ban | none | file delete | `reload docker` only | needs owner approval — not executed |

The **reboot** is not part of any stage. It is approved separately under [`host-reboot-hardening.md`](host-reboot-hardening.md). After that reboot, add these checks: `sudo ufw status` (active), `sudo iptables -S DOCKER-USER` (rules present), `sudo sshd -T | grep passwordauthentication` (`no`), plus SVC-CHECK.
