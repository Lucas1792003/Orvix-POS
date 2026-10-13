# Phase F: self-hosted WireGuard as a $0 Tailscale replacement (feasibility)

Status: **research and read-only inspection, 2026-10-13. Nothing was changed.** No install, no `tailscale up/set/down`, no firewall, router or sshd change, no `sudo`, no commit. Server facts come from `ssh -o BatchMode=yes lucashome '<cmd>' </dev/null` run as `lucario`, plus one coordinator-verified LAN fact (§1.3). Public addresses are masked (first octet only).

Why this file exists: [`free-tier-compliance.md`](free-tier-compliance.md) found that Tailscale Personal is "only suitable for non-commercial use", and it listed plain WireGuard + DuckDNS as the leanest compliant $0 alternative. This file tests that suggestion against the real server network, the Myanmar network environment and the app's HTTPS constraints (backend host pin, migration 080).

Related: [`host-hardening-staged.md`](host-hardening-staged.md) (ufw/Docker/Tailscale stages), [`host-reboot-hardening.md`](host-reboot-hardening.md) (reboot checklist), [`../phase-g/migration-080.md`](../phase-g/migration-080.md) (`app_config` https origin).

> Not legal advice. Statements about Myanmar law are quoted from the cited sources; the owner decides.

---

## 0. Verdict in one paragraph

**Plain WireGuard with lucashome as the hub does not work on this network as it stands, and is a poor fit for Myanmar even if it did.** The server sits behind at least **two layers of private NAT that the owner probably does not control**, with no UPnP/NAT-PMP/PCP, no global IPv6, and wireless client isolation on the home router. So no UDP port can be opened to it without the upstream network operator. On the store side, Myanmar has run Chinese-built DPI (Geedge) since 30 May 2024 that blocks VPNs. Its detection features (UDP payload length, first-packet byte patterns) are exactly what identifies a WireGuard handshake. On top of that, police have searched phones for VPN apps on the street. Raw WireGuard has no TCP/443 fallback. **Recommendation:** don't build WireGuard. Make the backend reachable over **ordinary HTTPS through an outbound-only tunnel** (Cloudflare Tunnel on a domain the shop already pays for, so $0 extra). Keep the tills offline-first, and keep Tailscale only as a temporary, non-production path until the new origin is proven (§7). If no domain exists or will be paid for, there is no fully compliant $0 remote option from this house. The fallback is then LAN-only per store, or paying for Tailscale Standard.

---

## 1. Server network facts (read-only, 2026-10-13 ≈ 11:10 UTC)

### 1.1 Raw observations

| Item | Value | Source |
|---|---|---|
| Uplink | **Wi-Fi only**, `wlp2s0`, `10.10.124.245/24`, DHCP, **lease 360 s** | `ip -4 addr` |
| Default gateway | `10.10.124.1`, MAC OUI `74:4d:28` (**MikroTik** / Routerboard) | `ip route`, `ip neigh` |
| Other DHCP-pushed route | a /32 host route to a public NIST time server, pushed by DHCP option 121 | `ip route` |
| IPv6 | **link-local only** on `wlp2s0` (no global address, no v6 default route); only the tailnet `fd7a:…` ULA | `ip -6 addr`, `ip -6 route` |
| `tailscale netcheck` UDP | `true` | netcheck |
| Public IPv4 as seen by DERP | **present**: `192.x.x.x` (first octet only; **not** in 192.168.0.0/16, **not** in 100.64.0.0/10) | netcheck |
| IPv6 as seen by DERP | `no, but OS has support` | netcheck |
| MappingVariesByDestIP | `false` (endpoint-independent mapping; good for hole punching) | netcheck |
| PortMapping (UPnP / NAT-PMP / PCP) | **empty: none offered** by the gateway | netcheck |
| Nearest DERP | **Toronto** (10.6 ms); Chicago 21 ms, NYC 22 ms; Singapore did not answer, Hong Kong 203 ms | netcheck |
| Path to the internet | hop 1 `10.10.124.1` (private), hop 2 `172.16.126.1` (**private**), hop 3 `10.0.150.140` (**private**), hop 4 `192.x` (public), hop 5 `206.x` (public); PMTU 1500 | `tracepath -n 1.1.1.1` (masked) |
| Tailscale path today | lucashome is on relay `tor`. The Mac → lucashome link is `relay "tor"`, **not direct** | `tailscale status` (peer IPs stripped) |
| Kernel WireGuard | module present (`wireguard.ko`, 1.0.0, kernel 7.0.0-30); `wg`/`wg-quick` **not installed** | `modinfo`, `which` |
| Firewall | ufw `ENABLED=no` (see hardening doc F1) | earlier audit |

### 1.2 Interpretation

- **Public IPv4: present** (at the upstream edge). **CGNAT (RFC 6598 100.64/10): no.** But there are **two private hops (172.16/12, then 10/8) between the home router and the public edge**. The MikroTik's own WAN is most likely a private 172.16.126.x address, so the house is **double (or triple) NATed**. For inbound traffic that behaves like CGNAT: a port-forward on the home MikroTik is not enough, because each upstream NAT layer needs a matching forward.
- The 6-minute DHCP lease, the pushed NIST route and the MikroTik gateway together suggest a **managed or shared network** (building, campus or provider-managed Wi-Fi) rather than a consumer ISP router the owner administers. That is an inference, not proven.
- No UPnP/NAT-PMP/PCP and no global IPv6 remove the two automatic ways around it.
- Location, inferred only from DERP latency: **north-eastern North America (Toronto region)**. No geolocation lookup was made. The stores are in Myanmar, so every till ↔ server packet crosses an international path through Myanmar's national filtering.

### 1.3 Coordinator-verified fact: wireless client isolation

The owner's Mac and the server are behind the **same** home router (identical gateway MAC, same /24). Yet the Mac **cannot reach the server over the LAN**: ARP for the server stays incomplete, and ping, TCP 22 and TCP 3000 time out. The router/AP therefore **isolates Wi-Fi clients**, and even Mac → server Tailscale traffic falls back to a DERP relay.

Consequences:
1. **A WAN port-forward to an isolated Wi-Fi client usually still works** (client isolation filters client↔client L2 traffic, not router↔client), but this is device-specific on MikroTik/managed APs and **must be verified**, not assumed.
2. **Hairpin / NAT loopback:** an on-LAN client using the public name would hairpin through the router and then be dropped by isolation. Any on-LAN WireGuard client (or a phone on home Wi-Fi) needs split DNS or must use a different path.
3. The "LAN SSH fallback" in [`host-hardening-staged.md`](host-hardening-staged.md) (`ssh lucario@10.10.124.245` from a LAN device, ufw rule `allow from 10.10.124.0/24 to any port 22`) **does not work today**, because no LAN device can reach the server. The console is the only non-tailnet fallback. That doc's lock-out mitigations should be re-read with this in mind.
4. **Prerequisite for any self-hosted endpoint:** move the server to **wired Ethernet** (already H-W1), or have client isolation disabled for it, or give it its own VLAN/SSID without isolation.

### 1.4 How the owner checks the router (no tools)

1. Open the home router's admin page (often `http://10.10.124.1` for this MikroTik; WebFig/WinBox). If you cannot log in, the network is managed by someone else (landlord/building/ISP). Ask them about points 2–4.
2. Find the **WAN/Internet IP** (MikroTik: IP → Addresses on the WAN interface, or Quick Set "Address Acquisition").
   - If it starts with `10.`, `172.16–31.` or `192.168.`, the router is behind another NAT (expected here: `172.16.126.x`). Port-forwarding at home alone will not work.
   - If it starts with `100.64–100.127.`, it is ISP CGNAT.
   - If it matches what a "what is my IP" site shows on the same Wi-Fi, it is a real public IP and a forward is possible.
3. Check **UPnP** (IP → UPnP), **IPv6** (IPv6 → Addresses; is any global `2xxx:` address handed out?) and **client isolation** (Wireless → Access List / "Default Forward" unticked, or "Client to client forwarding" off on CAPsMAN).
4. Ask the upstream operator whether a **static public IPv4 or a UDP port-forward** is available, and at what price.

---

## 2. Plain WireGuard hub-and-spoke: requirements vs reality

| Requirement | What WireGuard needs | Status here |
|---|---|---|
| Reachable UDP port on the hub | one UDP port (for example 51820) forwarded from the public IP to the server, **or** a global IPv6 address with an inbound allow | **Fails.** Double NAT upstream, no UPnP/PCP, no global v6 (§1.2). Needs the upstream operator. |
| Stable name for the endpoint | static IP, or dynamic DNS: DuckDNS ($0; terms silent on commercial use and "may terminate … at any time" [D1][D2]) or the router's built-in DDNS | Possible, but useless without the forward. `duckdns.org` is on the Public Suffix List, so Let's Encrypt rate limits apply per subdomain (checked 2026-10-13 [PSL]). |
| Clients behind NAT/CGNAT | clients initiate; `PersistentKeepalive = 25` keeps NAT state open | Fine **if** the hub is reachable. Myanmar mobile/fixed lines are almost certainly CGNAT: MPT is listed with ~26.6k IPv4 addresses, Mytel ~16k and Ooredoo ~11k for millions of subscribers [IP2L]. That is an inference from address counts, so it is consistent with CGNAT but not proven. |
| MTU | WireGuard over IPv4 default 1420. Path PMTU from the server is 1500. Myanmar mobile paths are often lower | Start at `MTU = 1280` (what tailscale0 uses) to avoid fragmentation over unknown paths |
| Key distribution | one keypair per till and per phone, peer block on the hub, config/QR per device | Manual. Phones need the WireGuard app installed: a **legal/safety concern in Myanmar** (§3.3) |
| Revocation | delete the peer block on the hub and `wg syncconf` | Simple, but needs root on the hub for every change |
| IP plan | for example `10.66.0.1/24` hub, `.10–.49` tills, `.50–.99` phones; must not collide with the shop LANs, Docker 172.17–20/16, home 10.10.124/24, or tailnet 100.64/10 | Easy |
| Fallback when UDP is blocked | none built in. Options: wstunnel (WireGuard over WebSocket/TLS 443), udp2raw (fake TCP) [UR] | Both are **still server-side listeners**, so they need the same inbound reachability that is missing |
| Firewall on the hub | `ufw allow <port>/udp` + `allow in on wg0` to 443 only | Fits hardening Stage 3a, once the port exists |

**Conclusion:** the blocker is reachability, not WireGuard. Every hub-style option (plain WireGuard, wstunnel, Headscale, NetBird) needs **an inbound port on a public address**, and this house doesn't offer one.

---

## 3. Myanmar: connectivity, filtering, power, legal facts

### 3.1 VPN blocking and DPI

- **30 May 2024:** a nationwide VPN block was switched on using DPI from **Geedge Networks** (Tiangou Secure Gateway, "Cyber Narrator"). It was built with the domestic firm Mascots Group and controlled centrally from Naypyitaw, bypassing operators [AN][GV, 2024-06-28].
- **Sept 2025 Geedge leak** (≈500 GB): Justice For Myanmar's "Silk Road of Surveillance" (2025-09-09) names **13 Myanmar telecom providers** implementing it for ~33.4 M users. InterSecLab confirms export to Myanmar [BHRRC, 2025-09-09][CSN].
- Detection features documented in leak analyses include **"JA3/JA4 TLS fingerprints, SSL certificate issuer fields, UDP payload length, first-packet byte patterns"**, plus "rapid active detection and IP blacklisting of new proxy endpoints" (Nov 2025) [LAN].
- A WireGuard handshake initiation is a fixed **148-byte UDP packet starting `01 00 00 00`**, a textbook first-packet signature [KE]. *Inference:* plain WireGuard is trivially identifiable by this class of DPI. No source found confirms a WireGuard-specific block in Myanmar, but commercial VPNs (most of which use WireGuard or OpenVPN) and Psiphon were reported "highly limited" from June 2024 to March 2025 [LAN].
- Lantern's corpus notes Myanmar uses **selective throttling, not only full blocks**: "protocols that look indistinguishable from normal HTTPS will survive where identified VPN protocols are slowed" [LAN-T].
- **Tailscale specifically:** no authoritative 2024–2026 source found. A DEV Community post titled "How Myanmar Blocks Tailscale — and How to Beat It" exists (June, year not confirmed), but its content could not be retrieved, so treat it as an **unverified signal** that Tailscale is also interfered with. Tailscale's fallback is DERP relays over **HTTPS/443** [TS-FW]. That helps against UDP blocks, but its TLS fingerprint and `*.tailscale.com` names are distinctive, and the control plane moved to static IP ranges in July 2025, which makes IP blocking easy (search-result summary, unverified).

### 3.2 Shutdowns and power

- Freedom on the Net 2025: Myanmar scores **9/100** (tied with China, worst). There are frequent **local shutdowns across 100+ townships** (Sagaing, Rakhine and others) [FOTN, 2025-11-13].
- **Power:** from **5 Jan 2025** Yangon received electricity **8 h/day on a rotating schedule** (two 4-hour blocks, three township groups). Residents report worse in practice. National output was ~2,200 MW of 7,000 MW installed [RFA-P, 2025-01-06][BNI].
- Implication: shop routers and ISP gear go dark for hours. The tills **must** stay offline-first (current window: 12 h writes / 24 h reads, per [`host-reboot-hardening.md`](host-reboot-hardening.md) §2). A tunnel that needs a manual reconnect after every power cut is a support burden.

### 3.3 Legal and safety facts (quoted, not advice)

- **Street phone searches** for VPN apps from June 2024 in Yangon, Mandalay, Sagaing, Bago, Ayeyarwady and Chin. Fines were reported at 300,000–400,000 kyats in some places and 1–3 million kyats in others. "Those who did not pay the money were taken to the police station." [RFA, 2024-06-13]
- **Cybersecurity Law No. 1/2025**, enacted 1 Jan 2025, **in force 30 July 2025** (Notification 113/2025). Tilleke & Gibbins: "The law does not restrict individuals or entities from using VPNs; it regulates VPN service providers." But **"establishing a VPN or providing VPN services without approval"** carries 1–6 months' imprisonment and/or MMK 1–10 M for individuals, and a minimum MMK 10 M for organisations [TG, 2025-08-01]. RFA's headline calls it a law that "aims to restrict use of VPNs" [RFA-L, 2025-01-02], and local digests describe it as criminalising VPN use [IIM]. **Sources disagree on scope.** Whether a shop running its own WireGuard/Tailscale link to its own server counts as "establishing a VPN" is **unclear**.
- **Practical reading for design:** a VPN client app on **staff phones** is the most exposed item (street checks). A design where phones and tills only make **ordinary HTTPS requests** avoids that whole class of risk.

### 3.4 Will WireGuard from the stores work reliably?

**Unlikely to be reliable, and not safe to rely on.** Plain WireGuard is the most fingerprintable option, has no 443 fallback, and the server can't accept inbound UDP anyway. Tailscale (DERP/443) degrades more gracefully, but is itself a likely DPI target and is non-compliant on Personal. **HTTPS to a mainstream CDN hostname is the transport most likely to keep working** [LAN-T], and it needs no VPN app.

---

## 4. HTTPS, the backend pin and migration 080

| Constraint | Where | What breaks if we leave `*.ts.net` |
|---|---|---|
| Electron build is pinned to one host | `package.json` `build:electron` sets `VITE_SUPABASE_EXPECTED_HOST=lucashome.tail8a86e4.ts.net`; `src/lib/backendConfig.ts` refuses any other host | Any new origin (WireGuard IP, DuckDNS name, Cloudflare hostname) needs a **new desktop release** with the new pin. Old builds keep using `ts.net` until they update (hence the dual-stack period, §7) |
| `app_config.supabase_public_url` must be **https** | `080_upload_completion_trusted_url.sql` CHECK `^https://<host>[:port]$` (lower-case, digits allowed) | **`http://…` is rejected by the CHECK.** Plain HTTP inside WireGuard would need a schema change to 080 (weakening a security fix). `https://10.66.0.1` would pass the regex, but no public CA issues certificates for private IPs. There is only **one row**, so only **one** trusted origin at a time: a dual-origin period needs either both clients to use the same origin or a migration that allows two |
| Phone page origin | QR is built from `window.location.origin` (`src/lib/productImagePhoneUpload.ts`); 02-production-dependencies notes it works only in the web build | The phone page and the API it calls must both be **https and trusted by the phone**. An https page calling an `http://` API is blocked as mixed content |
| Phone camera | page uses `<input type="file" capture="environment">` (`src/pages/PhoneProductImageUploadPage.tsx:223`), no `getUserMedia` | `<input capture>` works over plain http; `getUserMedia` would not |
| Other secure-context APIs | `crypto.randomUUID()` in `src/lib/id.ts` and `src/stores/data/idempotentRpc.ts`; `crypto.subtle` in queue export | **`crypto.randomUUID` and `crypto.subtle` are undefined on insecure http origins.** Plain HTTP for any web build would need an audit of these paths |
| Chrome Local Network Access | from Chrome 138 (opt-in, rolling out), public → private-IP requests need a permission prompt [CLNA] | A DuckDNS name that resolves to a private WireGuard IP is a "local" target. Some routers also block public names that resolve to private IPs (DNS-rebind protection) |

**$0 HTTPS options without Tailscale:**
1. **Private CA** on tills and phones: workable on Windows/macOS tills, **painful on phones** (iOS needs profile install plus manual "full trust"; Android user CAs aren't trusted by apps and need extra steps in Chrome). Not recommended.
2. **Let's Encrypt via DuckDNS DNS-01:** works without inbound ports. `certbot-dns-duckdns` sets the single `_acme-challenge` TXT through the DuckDNS API [CB-D]. DuckDNS allows one TXT per domain, shared by sub-subdomains [D3], so use one certbot run per name. The A record can point at the WireGuard IP (the DuckDNS spec doesn't forbid private IPs [D3]; untested). This gives a trusted https origin that fits 080 and the pin, **but only matters if the WireGuard tunnel exists.**
3. **Cloudflare Tunnel hostname:** Cloudflare terminates TLS with a public certificate, so the origin is `https://pos.<domain>`. It fits 080 and the pin. **Requires a domain on Cloudflare DNS** [CF-T].
4. Plain HTTP inside the tunnel: blocked by 080's CHECK, by mixed content and by `crypto.randomUUID`. **Rejected.**

---

## 5. Alternatives at $0 compared

| Option | Licence / terms | Inbound port needed at the house? | Works from behind this double NAT + isolation? | Myanmar DPI resilience | VPN app on phones? | HTTPS origin | $0? | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Plain WireGuard** (hub = lucashome) | GPLv2, no service terms | **Yes, UDP** | **No** (needs upstream operator + Ethernet/isolation fix) | **Poor**: fixed handshake signature, no 443 fallback | **Yes** | DuckDNS + DNS-01 | Yes (+DuckDNS terms "unclear") | **Reject** for now |
| WireGuard + wstunnel/udp2raw on 443 | free software | **Yes, TCP 443** | No | Better (TLS/WebSocket), but WireGuard-in-TLS can still be fingerprinted | Yes (+ a second app) | as above | Yes | Reject (same reachability blocker) |
| **Headscale** + embedded DERP | BSD-3 | **Yes**: TCP 443, UDP 3478, "a server with a public IP" [HS3] | No | Same as Tailscale DERP (443) | Yes (Tailscale app) | no `ts.net` certs: own domain/DNS-01 | Yes | Reject here; viable only on a public host |
| **NetBird self-hosted** | client BSD-3, server AGPLv3 | **Yes**: 80/443/3478 + a public domain [NB2] | No | Similar | Yes | own domain | Yes (domain aside) | Reject |
| **ZeroTier Free** | **non-commercial** [Z1] | No | Yes | UDP; unknown | Yes | no | Terms fail | Reject |
| **Tailscale Personal (today)** | **non-commercial** | No (DERP) | Yes (already relayed via `tor`) | Moderate (DERP/443), likely targeted | Yes | `ts.net` + LE | Terms fail | Keep only as **temporary non-production** path |
| **Tailscale Standard** | commercial OK | No | Yes | Moderate | Yes | `ts.net` | **No** ($/user/month) | Paid fallback |
| **Tailscale free/discount programme** | open-source and non-profit only [T4] | — | — | — | — | — | — | **None for a family shop** (checked in compliance doc) |
| **Cloudflare Tunnel (named)** | free on all plans; needs a Cloudflare account and **a domain on Cloudflare DNS** [CF-T] | **No**: outbound-only from lucashome (works behind double NAT and isolation) | **Yes** | **Best available**: plain HTTPS to a mainstream CDN, no VPN app | **No** | `https://pos.<domain>` with a public certificate | **$0 only if a domain is already paid for** (the Resend domain question in the compliance doc) | **Recommended** if a domain exists |
| Cloudflare Quick Tunnel (`*.trycloudflare.com`) | "no uptime guarantee", testing only, 200 in-flight request cap, random name each start [CF-Q] | No | Yes | Good | No | random https name; breaks the pin and 080 on every restart | Yes | Testing only |
| **playit.gg** (already on the host for Minecraft) | free tier lists UDP tunnels; commercial-use terms **not found** [PG] | No | Yes | Its relay IPs are probably on block lists; WireGuard inside is still fingerprintable | Yes (if WireGuard) | — | Free tier | Not evaluated further; terms unknown |
| **LAN-only, server in the store** | none | No | n/a (server moves to Myanmar) | No international path for till ↔ server | No | private CA or http (http blocked by 080) | Yes (needs hardware in the store) | Compliant baseline. Loses owner-remote access; **one server per store** unless stores share a LAN; power cuts hit the server too |
| $0 public VPS as hub/relay | Oracle "Always Free" etc. need a card; not reliably free | — | Yes | depends on transport | depends | — | Borderline | Not pursued (compliance doc rule) |

---

## 6. Decision table

| Question | Answer |
|---|---|
| Can lucashome accept an inbound WireGuard UDP port today? | **No.** Double NAT upstream, no UPnP/PCP, no v6, Wi-Fi client isolation |
| Could it, with work? | Only if the upstream operator gives a forward or static public IP **and** the server moves to Ethernet (or isolation is lifted). Even then, Myanmar DPI makes plain WireGuard unreliable |
| Is there a compliant, outbound-only, HTTPS transport? | **Cloudflare Tunnel**, if a domain is on Cloudflare |
| Does it keep 080 and the backend pin workable? | **Yes**: a single new `https://` origin. One `app_config` update + one desktop release with the new `VITE_SUPABASE_EXPECTED_HOST` |
| Does it avoid VPN apps on staff phones (street-check risk)? | **Yes** |
| What does it add? | **Public exposure of the API** (same posture as the hosted Supabase the app used before, and the tills are on today). Needs hardening first: Studio/`pg-meta` must not be routed through the tunnel; 081 rate limits stay; the Envoy route allow-list is reviewed; ufw/DOCKER-USER stages done |
| If there is no domain? | No compliant $0 remote path from this house. Choose: **LAN-only per store** (compliant, $0, no remote) **or** pay (domain ≈ $10–15/yr, or Tailscale Standard) |

---

## 7. Recommended path and staged migration (Tailscale stays until proven)

Current state that makes this cheap: **no till talks to lucashome yet.** Published desktop v1.0.15 still points at hosted Supabase ([`host-reboot-hardening.md`](host-reboot-hardening.md) §2). Pick the transport **before** 1.0.16 pins a host.

Every stage needs owner approval; none has been executed.

| Stage | Action | Proves | Rollback |
|---|---|---|---|
| **S0 Decide** | Owner confirms (a) whether the app's existing domain is paid and can move DNS to Cloudflare (or add a subdomain delegation); (b) acceptance of public API exposure; (c) Myanmar store results from §8 | go/no-go | — |
| **S1 Prerequisites** | Server on **Ethernet** (or isolation lifted) (H-W1); hardening Stages 1–3 from [`host-hardening-staged.md`](host-hardening-staged.md); confirm Envoy does **not** route `/project/*`, Studio or pg-meta publicly | host safe to expose | per that doc |
| **S2 Tunnel, dark** | Install `cloudflared` (`apt` from Cloudflare's repo), create a **named** tunnel `pos.<domain>` → `http://127.0.0.1:8000`, outbound only. **No change to `tailscale serve`.** | tunnel up; `https://pos.<domain>/auth/v1/health` → 401 from the Mac and from a Myanmar phone **on mobile data with no VPN** | `systemctl disable --now cloudflared`; delete the DNS record |
| **S3 Store probe** | At each store: run the §8 checklist against `pos.<domain>` (browser only) for one week, across power cuts | Myanmar reachability over HTTPS | none needed |
| **S4 080 dual-origin decision** | `app_config` has **one** row, so pick **one**: either (a) flip `supabase_public_url` to `https://pos.<domain>` at the moment the new build ships (old `ts.net` phone pages still complete uploads, because 080 ignores the client's host and derives the stored URL from the server value), or (b) a reviewed migration that allows a second origin during the overlap | phone upload works on both builds | revert the row (one `UPDATE` by `service_role`) |
| **S5 Desktop 1.0.16 (or next)** | `build:electron` pin → `pos.<domain>`; staged rollout to one till first | till syncs via tunnel; outbox drains after a power cut | auto-update back to the previous build; `ts.net` path still alive |
| **S6 Dual-stack period (≥ 2 weeks)** | Tailscale `serve` stays on; **no tills or phones newly joined to the tailnet**; monitor tunnel uptime, store sync lag, 429s | replacement proven | stay on Tailscale |
| **S7 Retire** | Remove tills/phones from the tailnet; Tailscale remains for the owner's **personal** admin devices only (that is non-commercial personal use: owner decision); optionally `tailscale serve reset` for the POS route | compliant | `tailscale serve --bg --https=443 http://127.0.0.1:8000` restores it |

If S0 finds **no domain**: run **LAN-only** per [`free-tier-compliance.md`](free-tier-compliance.md) §1 for any store that can host its own server, or budget for a domain. Do **not** build plain WireGuard on this house network.

If the owner still wants WireGuard later (for example after moving the server to a host with a real public IP): use the §2 plan (hub `10.66.0.1/24`, `MTU 1280`, `PersistentKeepalive 25`, DuckDNS + DNS-01 cert for an https origin pointing at the WireGuard IP). Treat it as **till-only**: no VPN app on phones. Test from Myanmar first, and keep wstunnel on 443 ready as the fallback.

---

## 8. Store-side checklist (owner, per store; phone or laptop only)

Record the answers per store, per date.

1. **ISP and link type:** name (MPT, Atom, Ooredoo, Mytel, or a fibre ISP such as Frontiir/5BB/Global Net), fibre or mobile hotspot, router brand.
2. **CGNAT test:** open the router admin page and note its **WAN IP**. On the same Wi-Fi, open a "what is my IP" site. **Same** = public IP. **Different**, or WAN in `100.64–100.127.x.x` / `10.x` / `172.16–31.x` / `192.168.x` = CGNAT or double NAT. (Irrelevant for clients that initiate connections. Relevant only if the store would ever host the server.)
3. **Tailscale path today** (only on a till that is already on the tailnet): `tailscale status` → the line for `lucashome` shows `direct <ip:port>` or `relay "sin"/"hkg"/…`. Also `tailscale netcheck` → `UDP: true/false` and the nearest DERP. Note it at different times of day and after a power cut.
4. **HTTPS reachability (once S2 exists):** on the shop Wi-Fi **and** on mobile data, **no VPN**, open `https://pos.<domain>/auth/v1/health`. Expect a JSON 401 error page. Note the time to load.
5. **UDP/WireGuard test (only if a WireGuard endpoint is ever built):** WireGuard app → import the test config → check that "latest handshake" updates within 30 s. No handshake = UDP blocked or WireGuard fingerprinted.
6. **Power and outage log:** hours of grid power per day, and whether the router is on a UPS or generator. The tills must ride through the gaps (offline banner, outbox drains on return).
7. **Safety:** whether staff phones are ever checked. Prefer a design where phones need **no VPN app**.

---

## Sources (retrieved 2026-10-13 unless stated)

- AN https://www.accessnow.org/myanmar-vpn-ban/ · GV https://globalvoices.org/2024/06/28/war-on-citizens-how-the-juntas-vpn-ban-is-strangling-communication-in-myanmar/ (2024-06-28) · ISOC https://pulse.internetsociety.org/blog/how-juntas-vpn-ban-is-strangling-communication-in-myanmar
- RFA https://www.rfa.org/english/news/myanmar/myanmar-internet-restrictions-vpn-ban-06132024163512.html (2024-06-13)
- RFA-L https://rfa.org/english/myanmar/2025/01/02/cybersecurity-law-vpn/ (2025-01-02) · TG https://www.tilleke.com/insights/myanmar-cybersecurity-law-takes-effect (2025-08-01) · IIM https://www.internetinmyanmar.com/digest/2025-01-04-myanmars-new-cyber-law-criminalizes-vpn-use-to-tighten-onlin/
- BHRRC https://www.bhrrc.org/en/latest-news/myanmar-13-telecom-service-providers-partners-alleged-of-implementing-online-surveillance-technology-sold-by-geedge-network-to-the-junta-incl-cos-non-response/ (2025-09-09) · CSN https://cybersecuritynews.com/geedge-networks-leak-vpn-great-firewall/amp/
- LAN https://corpus.lantern.io/censors/mm/ · LAN-T https://corpus.lantern.io/findings/2025-jfm-silk-road-surveillance__shutdown-and-throttling/
- FOTN https://progressivevoicemyanmar.org/2025/11/13/myanmar-freedom-on-the-net-2025 (2025-11-13)
- RFA-P https://www.globalsecurity.org/wmd/library/news/myanmar/2025/myanmar-250106-rfa02.htm (2025-01-06) · BNI https://www.bnionline.net/en/node/108001
- KE https://keremerkan.net/posts/udp2raw-bypass-censoring-wireguard-protocol · UR (udp2raw/wstunnel: same post; github.com/erebe/wstunnel)
- IP2L https://www.ip2location.com/mm
- TS-FW https://tailscale.com/kb/1082/firewall-ports · T4 https://tailscale.com/kb/1154/free-plans-discounts
- HS3 https://headscale.net/stable/setup/requirements/ · NB2 https://docs.netbird.io/selfhosted/selfhosted-quickstart · Z1 https://www.zerotier.com/pricing/
- CF-T https://flaviocopes.com/cloudflare-tunnel/ (summary; confirm against developers.cloudflare.com before S2) · CF-Q https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- D1 https://www.duckdns.org/faqs.jsp · D2 https://www.duckdns.org/tac.jsp · D3 https://www.duckdns.org/spec.jsp · CB-D https://pypi.org/project/certbot-dns-duckdns · PSL https://publicsuffix.org/list/public_suffix_list.dat (`duckdns.org`, `ts.net`, `trycloudflare.com` present)
- CLNA https://developer.chrome.com/blog/local-network-access (2025-06-09)
- PG https://playit.gg/pricing

Open items: Cloudflare self-serve terms for this use were not re-read (check the CDN/large-content clause before S2; image traffic is tiny). The Tailscale-in-Myanmar DEV post was not retrievable. No source confirms a WireGuard-specific block in Myanmar (§3.1 is an inference from documented DPI features).
