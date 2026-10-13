# Phase F: remote-access architecture for two shops (recommendation)

Status: **research and recommendation, 2026-10-13. Nothing was changed.** No sign-ups, no billing, no server access, no router, DNS, Tailscale or Cloudflare change, no commit. Vendor facts come from official pages fetched on **2026-10-13** (see Sources). Anything not confirmed on an official page is marked **(unverified)**.

Builds on, and does not repeat:
- [`wireguard-feasibility.md`](wireguard-feasibility.md): server network facts (double/triple NAT, no UPnP/IPv6, Wi-Fi client isolation), Myanmar DPI and power, why self-hosted WireGuard/Headscale/NetBird fail here.
- [`free-tier-compliance.md`](free-tier-compliance.md) and [`cost-research.md`](cost-research.md): Tailscale Personal is non-commercial; the domain question.
- [`host-hardening-staged.md`](host-hardening-staged.md) §3A: recovery paths and Gate R.
- [`email-sender-options.md`](email-sender-options.md): email without a domain (a bought domain would also unlock Resend with a verified domain).
- [`../phase-g/migration-080.md`](../phase-g/migration-080.md) and [`../phase-g/release-compatibility.md`](../phase-g/release-compatibility.md): the trusted https origin row and the desktop host pin.

> Not legal advice. Statements about Myanmar law are quoted from the cited sources. The owner decides, and should ask a Myanmar lawyer if in doubt.

---

## 0. Answer in one paragraph

**Primary: Cloudflare Tunnel (`cloudflared`, outbound-only from the home server) on a cheap domain the family buys, about US$10.46/yr for a `.com` at Cloudflare Registrar (third-party price tracker; Cloudflare shows the price at checkout).** Tills and phones then make ordinary HTTPS requests to `https://pos.<domain>`. No VPN app on any till or phone, and it works behind this house's NAT with no router change. Supabase auth + RLS + the 081 rate limits stay the primary control. The tunnel publishes only the API paths, never Studio. Cloudflare's free WAF adds an allow-list and one rate rule. Cloudflare Access is **not** put in front of the API at launch, because it would break the phone page and complicate realtime websockets. **Fallback: Tailscale Standard at $8/user/month** (about $192/yr for 2 users), which keeps today's design but keeps a VPN client on every till. **The one cost that can't honestly be avoided is the domain** (or Tailscale's fee). No $0 option is both terms-compliant and production-grade from this house. A card or PayPal account is needed for either. Keep `tailscale serve` running untouched until the new path has been proven from both shops.

---

## 1. Fixed constraints (from earlier docs and the coordinator, 2026-10-13)

| # | Constraint | Consequence for the design |
|---|---|---|
| C1 | **No family-owned domain.** RDAP/WHOIS say "No match" for `shwephalar.com`, `shwephala.com`, `shwepha-lar.com` and `shwephalar.net`. | Every option that needs a zone on Cloudflare means **buying** a domain. "No domain" is the baseline. |
| C2 | Server = home laptop in north-east North America (DERP Toronto), on Wi-Fi with client isolation, behind 2–3 private NAT layers on a probably managed MikroTik network. No UPnP/NAT-PMP, no public IPv6. | **No inbound port is possible.** Only **outbound-initiated** transports work: Tailscale DERP, Cloudflare Tunnel, ngrok-style relays, or moving the backend. |
| C3 | Tills use Tailscale + `tailscale serve` (`*.ts.net`) today, but **no till uses lucashome yet**. Shipped v1.0.15 still talks to hosted Supabase. | Changing the transport now costs one config row and the **already planned** 1.0.16 release. After 1.0.16 ships pinned to `ts.net`, a later change needs another release and an overlap period. |
| C4 | Tailscale Personal: "only suitable for non-commercial use" [TS-P]. | Production use by a shop breaches the plan terms. |
| C5 | Myanmar: DPI-based VPN blocking since 30 May 2024. The Cybersecurity Law has been in force since 30 July 2025. Frequent power cuts. | Prefer plain HTTPS with no VPN client. Tills stay offline-first (12 h writes / 24 h reads). |
| C6 | 080: `app_config.supabase_public_url` is **one row**, CHECK `^https://<lower-case host>[:port]$` (or http localhost for dev). | The new origin must be **https with a publicly trusted certificate**, and there is one trusted origin at a time. |
| C7 | The Electron build pins one host: `build:electron` sets `VITE_SUPABASE_EXPECTED_HOST=lucashome.tail8a86e4.ts.net` (`package.json`), and `backendConfig.ts` refuses others. | A new host means **a new desktop release**. |
| C8 | The phone page is an https web page. Its QR is built from `window.location.origin` (`src/lib/productImagePhoneUpload.ts`). The Electron renderer loads `file://…/dist/index.html` (`electron/main.cjs:127`). | Inherited gap, true for **every** option: a till's QR is only usable when there is an https **web** origin that serves the SPA's `/phone-upload/product-image/<token>` route, and the desktop knows that origin. See §5.4. |
| C9 | Found while reading for this doc: `deploy/lucashome/env.settings.md` has **`DISABLE_SIGNUP=false`** ("app creates staff via `auth.signUp`"). | Harmless on a tailnet. **On a public hostname, anyone can create GoTrue users.** This is a hardening prerequisite (§6, P4). |

---

## 2. Research findings per option (official sources, 2026-10-13)

### 2.1 Tailscale paid plans

- The current plans are **Personal $0** (up to 6 users, "only suitable for non-commercial use"), **Standard $8/user/month**, **Premium $18/user/month** and Enterprise [TS-P].
- "Personal Plus and Starter plans remain available to existing customers but are no longer offered to new signups" [TS-P]. **A new compliant sign-up today is Standard.**
- Billing is per **occupied seat**: "A user then occupies a vacant seat when they first log in to the admin console or when they first authenticate a device." User devices are "free and unlimited". Tagged resources are free up to 50, then $1/month each. Self-serve billing is monthly. There is a 14-day business trial [TS-FAQ].
- **Two seats** (owner + one family admin) = **$16/month = $192/yr**. Tills can be **tagged** devices (≤ 50 free) so that they don't take seats. Whether a card is required was **not stated** on the FAQ page (unverified). Paid SaaS normally needs one.
- **Funnel** (public HTTPS without a client) is "available for all plans", is "currently in beta", uses ports 443/8443/10000 only, has "non-configurable bandwidth limits", and only uses `*.ts.net` names [TS-FN]. On Personal, Funnel is still covered by the non-commercial terms.
- `ts.net` certificates are logged in public CT logs: "Do not enable the HTTPS feature if any of your machine names contain sensitive information" [TS-HTTPS].
- **Paying fixes the terms, not the Myanmar risk.** Every till (and any phone that talks to the API) still runs a VPN client (§4).

### 2.2 Cloudflare Tunnel + an owned domain

| Fact | Source |
|---|---|
| Tunnel is "Available on all plans" | [CF-TUN] (page updated 2026-09-11) |
| "outbound-only connection model … cloudflared initiates an outbound connection through your firewall"; you can "block all inbound traffic" | [CF-TUN-OV] |
| "Before you publish an application through your tunnel, you must add a website to Cloudflare." | [CF-TUN-REMOTE] |
| Full DNS setup is "the only one available for Free or Pro plans" and requires changing nameservers at the registrar. Subdomain setup is for Enterprise. | [CF-DNS] |
| Ingress rules match hostname and/or **path regex** ("Go `syntax` package"). "The last ingress rule must be a catch-all", typically `http_status:404`. | [CF-ING] |
| "WebSockets are supported on all Cloudflare plans." Cloudflare closes idle sockets; use a client heartbeat. | [CF-WS] |
| Registrar: "sells domains at cost: you pay the registry and ICANN list price with no markup". "All domains on Cloudflare Registrar use Cloudflare nameservers." Fees are non-refundable. | [CF-REG-FAQ] |
| `.com` at Cloudflare: **US$10.46** for registration, renewal and transfer, "stable since November 28, 2025". **(unverified: third-party tracker. Equals Verisign's $10.26 plus the $0.20 ICANN fee; confirm at checkout.)** | [DOMOFFER] |
| Registrar needs "a verified account email address". Payment is chosen at checkout. Accepted methods: "Visa, Mastercard, American Express, Discover, UnionPay", Apple Pay, Google Pay, Link, and **PayPal**. **A card or PayPal is needed to buy the domain**; no card is needed for the Free plan or Tunnel itself (unverified for Tunnel/Zero Trust sign-up). | [CF-REG-REG][CF-BILL] |
| Self-Serve Subscription Agreement (updated 2025-09-12): no clause limits the Free plan to non-commercial use. A free property must not "process or collect personal or business credit card information". | [CF-SSA] |
| Service-Specific Terms (updated 2026-09-28), CDN: Cloudflare may limit the CDN if used "to serve video or a disproportionate percentage of pictures, audio files, or other large files" without paid services. | [CF-SST] |
| WAF custom rules: **Free = 5 rules**. Rate limiting: **Free = 1 rule**, fields "Path, Verified Bot", characteristic "IP", period "10 s", timeout "10 s". | [CF-WAF-CR][CF-WAF-RL] |
| Access service tokens are sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, expire per configured duration (renewable by a year), with an alert a week before expiry. "you can use Access service tokens to allow access to applications without consuming seats." | [CF-ST][CF-SEAT] |
| Access policy actions: "Bypass does not enforce any Access security controls and requests are not logged"; "Service Auth" covers tokens and mTLS. | [CF-POL] |
| Zero Trust Free = **up to 50 users** **(unverified: third-party summaries; Cloudflare's plan page did not render on fetch)** | [CT-ZT] |

Terms reading for this shop (not legal advice): a family POS API on Cloudflare Free is within the agreement. The POS **does not collect card numbers** (a grep of `src/` and `supabase/migrations/` for card/CVV/Stripe fields found none, 2026-10-13), and it must keep it that way on this hostname. Product images are capped at 100 KB (080/016) and are a tiny share of traffic, so the CDN "disproportionate pictures" clause is not a concern at this scale.

### 2.3 Cloudflare Quick Tunnels (TryCloudflare), no domain

All quoted from Cloudflare [CF-QT]: "Quick Tunnels are for testing and development." "Quick Tunnels have no uptime guarantee." "Each Quick Tunnel supports up to 200 in-flight requests. Additional requests return a `429`." "Quick Tunnels do not support Server-Sent Events (SSE)." "The hostname changes each time you create a Quick Tunnel." The page points production users to a named tunnel.

**Unsuitable.** Every `cloudflared` restart, reboot or Wi-Fi drop that restarts it gives a new random `*.trycloudflare.com` name. That breaks the Electron host pin (C7: a new release each time), the 080 row (C6) and every printed or open QR. It also contradicts the stated purpose.

### 2.4 Free subdomains and other $0 reverse tunnels

- **DuckDNS + Cloudflare Tunnel: no.** A tunnel needs a zone on Cloudflare (2.2). Free/Pro zones need a **full setup with a nameserver change at the registrar**, and subdomain setup is Enterprise-only [CF-DNS]. Nobody can change the nameservers of `duckdns.org`. DuckDNS offers A/AAAA/TXT records and CNAMEs *from* your own domain *to* DuckDNS [D-FAQ][D-SPEC]. The same applies to other free-subdomain services. Free whole-domain registries (EU.org) are slow, manual and of doubtful commercial eligibility ([`free-tier-compliance.md`](free-tier-compliance.md) §2).
- **Tailscale Funnel:** a public `*.ts.net` HTTPS endpoint with no client on the tills, so it removes the VPN-app problem. But on Personal it is still covered by the non-commercial terms, it is beta, and it has fixed bandwidth limits [TS-FN]. On Standard it is a legitimate **paid** variant of option 1 (see 3.1b).
- **ngrok Free:** one assigned dev domain (`*.ngrok-free.app`). Custom domains are paid. "1 GB / month" data out. Pricing page: "Up to 20k HTTP/S requests", "$5 of one-time included usage" with "No additional usage beyond credit", and an **"interstitial page on HTTP/S endpoints"** for browser traffic, which can be skipped with an `ngrok-skip-browser-warning` header or a non-browser User-Agent [NG-P][NG-LIM]. The ToS (updated 2026-03-02) has no non-commercial clause [NG-TOS]. **Unsuitable:** two shops' sync, realtime and images would exceed 20k requests and 1 GB a month, and the phone page is a browser, so it would hit the interstitial. Hobbyist is $10/month [NG-P], more than a domain.
- **Pinggy Free:** 60-minute tunnels and a random subdomain that changes on restart. A persistent or custom domain needs Pro (about $2.50–3/month) **(unverified: third-party summaries; pinggy.io/pricing returned 404)** [PG].
- **localhost.run Free:** "Domain names change after a few hours", with request caps and speed limits. A custom domain costs $9/month billed annually **(unverified: search summary of localhost.run docs; direct fetch failed TLS)** [LHR].
- **playit.gg** (already on the host for Minecraft): commercial terms not found (see the WireGuard doc). Not evaluated further.

**Conclusion:** none of the $0 relays gives a stable, terms-compliant, production https origin. The ones that do charge more per year than a domain.

### 2.5 Free cloud VM (Oracle Cloud Always Free)

- **Card required:** "We use your contact information and credit/debit card information for account setup and identity verification." Prepaid, virtual and PIN debit cards are not accepted. There are periodic authorization holds **(Oracle FAQ via search snippet; direct fetch returned 403)** [OCI-FAQ].
- **Idle reclamation:** an Always Free instance is idle if, over 7 days, "CPU utilization for the 95th percentile is less than 20%", "Network utilization is less than 20%" and "Memory utilization is less than 20% (applies to A1 shapes only)". Idle Always Free instances "may be reclaimed". A1 = 2 OCPU / 12 GB total; not South Korea North [OCI-AF]. **A two-shop POS is idle almost all the time, so reclamation is a real risk.** The usual workaround (upgrading to Pay-As-You-Go) is not documented on that page as an exemption (unverified).
- **Commercial use:** Oracle presents Always Free as available "in all regions where commercial Oracle Cloud Infrastructure service is available" [OCI-FAQ]. No non-commercial clause was found, but the full terms were not read (unverified).
- **Trade-offs:** the business data leaves the family's hands (a US provider's VM); it's a second machine to patch; the database **moves** (or a replica plus failover is needed); and backups and restore must be re-proved. It does give a public IP, so HTTPS (Let's Encrypt) or a WireGuard hub become possible. A WireGuard hub still has the Myanmar DPI and VPN-app problems, so HTTPS would be the transport anyway. **It also still needs a domain** for a stable trusted https origin (a bare IP gets no public certificate; DuckDNS + DNS-01 is possible but fragile [`wireguard-feasibility.md`](wireguard-feasibility.md) §4).

### 2.6 Per-shop local server (LAN-only)

$0 and no internet dependency in the shop. But the app is **one organisation with two shops sharing one catalogue and inventory** (multi-shop console, stock transfers, org-wide users and price levels). With two independent servers:
- **Stock transfers** between shops can't be atomic. Each side only sees its own database.
- The **catalogue** (products, prices, barcodes, units, suppliers) diverges unless someone builds bidirectional sync with conflict rules.
- The **multi-shop console**, org-wide reports and the daily summary email see one shop only.
- **Idempotency keys, receipt numbering and auth users** are per database. Merging would need namespacing and a reconciliation job.
- Each shop needs hardware, UPS and backups. Power cuts hit the server too (8 h/day grid in Yangon from Jan 2025 [RFA-P, via the WireGuard doc]).
- HTTPS on a LAN needs a private CA on every phone, and 080 rejects plain http (C6).

Building multi-master sync is a project of its own (CRDT/outbox replication across 30+ RPCs). **Not viable short-term.** It is a resilience idea for later (a read-only local cache), not an access design.

---

## 3. Decision table

Prices are as of 2026-10-13. "MM" = Myanmar. For reachability, "plain HTTPS" means a normal TLS connection to a Cloudflare anycast IP that thousands of unrelated sites share.

| | **1. Tailscale Standard** (keep design) | **2. Cloudflare Tunnel + owned domain** | **3. Quick Tunnel (no domain)** | **4. Free relays** (ngrok/Pinggy/localhost.run; DuckDNS) | **5. Oracle Always Free VM** | **6. Per-shop LAN server** |
|---|---|---|---|---|---|---|
| **One-time cost** | $0 | $0 (first year of domain counts as recurring) | $0 | $0 | $0 (time: migration) | Hardware per shop (2× mini-PC + UPS), not priced |
| **Recurring cost** | **$8/user/mo** → 2 seats ≈ **$192/yr**; tills tagged (≤ 50 free) | **≈ $10.46/yr** `.com` at cost (unverified price); Tunnel/WAF/DNS $0 | $0 | $0 free; stable name = $30–120/yr (ngrok $10/mo, localhost.run $9/mo, Pinggy ≈ $3/mo) | $0 if not reclaimed; **plus a domain** for https | $0 (electricity) |
| **Card needed?** | Almost certainly (not stated) | **Yes, to buy the domain** (card, or PayPal) | No | Free: no/unknown. Paid: yes | **Yes** (identity check; no prepaid) | No |
| **Terms fit (family business)** | **Yes** (Standard is the business plan) | **Yes**: no non-commercial clause; don't collect card data; images tiny | **No**: "testing and development" | ngrok free: no clause, but limits too low and an interstitial; others: random names | Probably yes (not fully read) | Yes |
| **MM reachability (fixed + mobile, under DPI)** | **At risk**: WireGuard/UDP first, DERP over 443 as fallback; distinctive fingerprints; an unconfirmed report of Tailscale interference ([`wireguard-feasibility.md`](wireguard-feasibility.md) §3.1) | **Best available**: looks like ordinary web traffic, which "will survive where identified VPN protocols are slowed" [LAN-T]. Blocking all of Cloudflare has high collateral cost. **Not proven**: Russia has throttled Cloudflare-fronted sites to 16 KB since 2025-06-09 [CF-RU], so a state can do it | Same as 2 while it lasts | ngrok/relay domains are likely on abuse/block lists (unverified) | Plain HTTPS to an Oracle IP: likely fine (unverified) | No international path |
| **VPN software on tills/phones?** | **Yes**, on every till (and phones if they use the API directly) | **No** | No | No | No (if HTTPS) | No |
| **HTTPS origin (080, pin)** | `https://lucashome.tail8a86e4.ts.net` (as today) | `https://pos.<domain>`, edge certificate from Cloudflare | random, changes on restart → **fails** | random/changing, or paid stable | `https://pos.<domain>` (Let's Encrypt) | Private CA or http → **fails 080** |
| **Exposure** | **Tailnet only** (smallest). Today allow-all ACL (T7). | **Public API** behind Cloudflare. Origin has no open port. Path allow-list + WAF. Same posture as hosted Supabase before. | Public, uncontrolled | Public | Public IP, own firewall | LAN only |
| **Ops burden** | Low. Node key expiry, ACLs, client updates on each till | Low–medium: one daemon, DNS, yearly renewal, WAF rules, watch for 4xx/5xx | — | — | **High**: second host, DB move, patching, reclamation watch | High: 2 servers, sync, backups ×2 |
| **Failure modes** | Tailscale client broken or blocked at a shop; DPI on WireGuard/DERP; key expiry | Cloudflare outage; MM throttling of Cloudflare; domain lapses (auto-renew, card expiry); account lock; `cloudflared` down → 502/530 | Name change on every restart | Quota exhaustion, name changes | Reclamation; card expiry; region outage | Shop power cuts; sync divergence |
| **Migration effort** | None now; seats + tags + ACL tightening | Domain, tunnel, WAF, 080 row, **1.0.16 pinned to new host** (already planned), phone origin (§5.4) | — | — | DB move + backups + domain + release | Re-architecture |
| **Verdict** | **Fallback** | **Primary** | Reject | Reject | Reject (for now) | Reject (short-term) |

---

## 4. Legal and safety notes (Myanmar), facts only

- **Law.** Cybersecurity Law No. 1/2025, in force **30 July 2025** (Notification 113/2025). Tilleke & Gibbins: "The law does not restrict individuals or entities from using VPNs; it regulates VPN service providers." But "Establishing a VPN or providing VPN services without approval from the designated ministry" carries, for individuals, "imprisonment for 1–6 months, a fine of MMK 1–10 million … or both", and for companies "the minimum fine will be MMK 10 million" with confiscation. The responsible ministry "has not yet been appointed" [TG]. RFA headlined the law as aiming "to restrict use of VPNs" [RFA-L], and a local digest says it "criminalizes VPN use" [IIM]. **Sources disagree on whether users are covered.** Whether a shop's own Tailscale/WireGuard link to its own server counts as "establishing a VPN" is **unclear**.
- **Enforcement on the street.** From June 2024, phones were searched for VPN apps in Yangon, Mandalay and other regions, with reported fines of 300,000–3,000,000 kyats [RFA].
- **Blocking.** Major VPNs and Signal were blocked from June–July 2024 [FH-FOTN]. Nationwide DPI from Geedge has been in use since 30 May 2024 [AN]. The Cybersecurity Law "limited the operations of VPN providers" [FH-FOTN].
- **Design consequence.** Option 2 lets tills and phones make **plain HTTPS requests to a public hostname**, the same thing a browser does when opening a website. No VPN software is installed on any device in Myanmar, which removes the street-check exposure and the "is this establishing a VPN?" question for the shop side. The tunnel itself (`cloudflared`) runs on the server **in North America**, not in Myanmar. This is a design observation, not legal advice.
- Option 1, even when paid, keeps a VPN client on every till. **Price doesn't change that risk.**

---

## 5. Recommendation and staged migration

### 5.1 Recommendation

- **Primary:** Cloudflare Tunnel + a family-owned domain bought at Cloudflare Registrar (**≈ $10.46/yr**, card or PayPal), API at `https://pos.<domain>`.
- **Fallback:** Tailscale Standard (2 seats ≈ $192/yr, tills tagged) if (a) the shops' store probe (S3) shows Cloudflare is unreliable from Myanmar, or (b) the owner won't buy a domain.
- Fallback-of-fallback, if Cloudflare is ever throttled: Tailscale Funnel on Standard, at `*.ts.net` with no client on tills. That needs another pinned-host release and its beta bandwidth limits must be checked first.
- **Honest cost:** there is no compliant, stable $0 path from this house. The cheapest compliant option is **one domain ≈ $10–15/yr**. As a side benefit, the same domain allows Resend with a verified sender ([`free-tier-compliance.md`](free-tier-compliance.md) §2).
- **Do not** put Cloudflare Access in front of the API at launch, for three reasons:
  1. The phone page is a plain browser with no login or token, and it calls `/functions/v1/phone-upload-token`, the anon RPCs and a signed storage upload. These would need Bypass rules, and "Bypass does not enforce any Access security controls and requests are not logged" [CF-POL].
  2. Browser WebSockets (supabase-js realtime) can't send custom headers, so a service-token setup needs Electron-level header injection (`session.webRequest`, **unverified for WebSocket upgrades**) and a test.
  3. A service token baked into every till is a shared secret; a stolen till leaks it.
  
  Keep Access as an optional later layer, for example a Service Auth policy on the desktop-only paths once tested.

### 5.2 Target design (option 2)

```
till (Electron) / phone browser ── HTTPS ──► Cloudflare edge (pos.<domain>, WAF, 1 rate rule)
                                                 │  (outbound tunnel, initiated by the server)
                                     cloudflared on lucashome ──► http://127.0.0.1:8000 (Envoy)
```
Tunnel ingress, allow-list (illustrative, not applied):
```yaml
ingress:
  - hostname: pos.<domain>
    path: ^/(auth/v1|rest/v1|storage/v1|realtime/v1|functions/v1)/
    service: http://127.0.0.1:8000
  - hostname: app.<domain>          # only if the phone page is served from the house (§5.4)
    service: http://127.0.0.1:<static-port>
  - service: http_status:404        # everything else, incl. /, /project/*, /pg/*, Studio
```
WAF (Free: 5 custom rules, 1 rate rule) [CF-WAF-CR][CF-WAF-RL]:
- custom rule 1: block `pos.<domain>` requests whose path is not in the allow-list (a second layer behind the ingress);
- custom rule 2: block obvious scanners (e.g. `/.env`, `/wp-`);
- optional rule 3: country rule, e.g. challenge anything outside Myanmar plus the owner's country. This is the owner's choice: it blocks the owner when travelling. Whether the country field is available on Free is **unverified**;
- rate rule: `/auth/v1/token` and `/auth/v1/signup` at N requests per 10 s per IP. Shops share one NAT IP and Myanmar mobile is CGNAT, so set it generously; 081 and GoTrue limits remain the real control.

### 5.3 Prerequisites before any public exposure (gate P)

| # | Prerequisite | Where |
|---|---|---|
| P1 | **Gate R** done: console + sudo proven, a second SSH key, Tailscale node key expiry off, fresh verified backup | [`host-hardening-staged.md`](host-hardening-staged.md) §3A |
| P2 | Hardening Stages 0–3 done (key-only SSH, ufw, DOCKER-USER, rebind 3000/3100) | same doc §4 |
| P3 | **Studio, pg-meta and `/project/*` never routed**. Confirm the tunnel ingress catch-all is 404 and test from outside: `https://pos.<domain>/` → 404, `/project/default` → 404, `/pg/` → 404 | §5.2 |
| P4 | **Public signup closed**: `DISABLE_SIGNUP=true`, with staff creation moved to an admin-only Edge Function (`auth.admin.createUser`), as [`../phase-g/login-signup-fix.md`](../phase-g/login-signup-fix.md) already foresees. Or, at minimum, signup restricted so a public sign-up can't create usable accounts. Review GoTrue rate limits. Requires a code change and its own approval | env.settings.md, login-signup-fix.md |
| P5 | 081 rate limits live (done), 080 live (done), org-isolation suites green | [`rate-limiting.md`](rate-limiting.md) |
| P6 | Backups: local base backup + WAL OK; emailed weekly archive working ([`email-sender-options.md`](email-sender-options.md)); one restore tested | backup README |
| P7 | Tailnet ACL tightened (allow-all T7, `cyfro-staging` reach) | hardening Stage 1 |
| P8 | Server on Ethernet or isolation lifted (recommended, not required: the tunnel is outbound) | H-W1 |

### 5.4 Phone page origin (applies to every option)

The QR uses `window.location.origin`, and in Electron that is `file://`, so phone upload from a till already needs a separate https **web** origin (C8). Options, in order of preference:
- (a) Serve the built SPA from lucashome as static files at `https://app.<domain>`, through the same tunnel. $0 and the same domain. The desktop must then build its QR from a configured origin (e.g. a new `VITE_PHONE_UPLOAD_ORIGIN`). That is a **small code change** in `productImagePhoneUpload.ts`, shipped in the same release.
- (b) Serve it from `https://pos.<domain>` on non-API paths (adds `/phone-upload/*` and assets to the allow-list). One hostname, but mixes the static app with the API.
- (c) Vercel Hobby is **not** allowed for commercial use ([`cost-research.md`](cost-research.md) §3). GitHub Pages is not allowed for an online business. Cloudflare Pages Free terms were not checked (unverified).

The phone page's API calls go to `VITE_SUPABASE_URL` = `https://pos.<domain>`. 080 ignores the host the phone sends and derives the stored URL from `app_config` ([`../phase-g/migration-080.md`](../phase-g/migration-080.md) §2b-3), so a phone page on `app.<domain>` is fine.

### 5.5 Staged plan (Tailscale stays until proven). Each stage needs owner approval; none executed.

| Stage | Action | Proves | Rollback |
|---|---|---|---|
| **S0 Decide** | Owner picks the domain name, who owns the Cloudflare account (family email, 2FA, recovery codes offline), and the payment method; accepts public API exposure; decides on the country rule | go/no-go | — |
| **S1 Buy + zone** | Buy `<domain>` at Cloudflare Registrar with **auto-renew on**. Note that the registrant contact is visible to Cloudflare and redacted in WHOIS (standard; not re-verified). Add DNS only; no records yet | domain resolves on Cloudflare NS | domain simply unused (fees non-refundable) |
| **S2 Prereqs** | Gate P (§5.3) | host safe to expose | per hardening doc |
| **S3 Tunnel, dark** | Install `cloudflared` from Cloudflare's apt repo; create a **named** tunnel; ingress per §5.2; WAF rules. `tailscale serve` untouched | From the Mac: `https://pos.<domain>/auth/v1/health` → 401 JSON; `/` → 404. From **each shop**, on Wi-Fi and on mobile data, **with no VPN**: the same, recorded per ISP/time over ≥ 1 week including power-cut recoveries ([`wireguard-feasibility.md`](wireguard-feasibility.md) §8 checklist item 4). Realtime: the probe (`src/live/realtimeProbe.ts`) stays connected > 10 min through Cloudflare | `systemctl disable --now cloudflared`; delete the DNS record |
| **S4 Build** | Release branch: `build:electron` pin → `VITE_SUPABASE_EXPECTED_HOST=pos.<domain>`, `VITE_SUPABASE_URL=https://pos.<domain>`; phone origin config (§5.4). **Before 1.0.16 is ever published pinned to `ts.net`** if possible, so only one host change ever happens | build refuses any other host (release-compat §3.1) | don't publish |
| **S5 080 row** | In the same window as publishing the release: `UPDATE app_config SET value='https://pos.<domain>', updated_at=now() WHERE key='supabase_public_url'` (as `supabase_admin`, per [`../phase-g/migration-080.md`](../phase-g/migration-080.md) §5). It's a **single row**. Since no till uses lucashome yet, there is no dual-origin conflict. If `ts.net` tills already exist, flip the row when the new build ships: old `ts.net` phone pages still complete, because 080 ignores the client host, but they store `pos.<domain>` URLs. Those load for `ts.net` tills **only if** `pos.<domain>` is reachable from them, which it is (public). Audit query from 080 §5 with the new prefix | phone upload completes; stored URL starts `https://pos.<domain>/storage/v1/object/public/product-images/org/` | one `UPDATE` back to `https://lucashome.tail8a86e4.ts.net` |
| **S6 Canary** | Install the new build on **one till** in one shop (by hand, or electron-updater `stagingPercentage`, release-compat §7) | sales sync; outbox drains after a power cut; realtime stock updates; phone upload from the shop | stop selling, drain (Sync page 0 pending), reinstall the previous build; tunnel and Tailscale both still up |
| **S7 Dual-run ≥ 2 weeks** | Both paths live: `tailscale serve` (`ts.net`) and the tunnel (`pos.<domain>`), same backend. No new devices join the tailnet. Watch 4xx/5xx and 429s in Cloudflare analytics, sync lag and DERP usage | replacement proven in both shops | stay on Tailscale (then go to the fallback: Standard) |
| **S8 Retire** | Remove tills/phones from the tailnet. Tailscale stays only for the owner's admin SSH. Whether that is personal use is the owner's call; otherwise one Standard seat. Optionally `tailscale serve reset` for the POS route | compliant | `tailscale serve --bg --https=443 http://127.0.0.1:8000` restores it |

**Emergency procedure change.** [`../phase-g/release-compatibility.md`](../phase-g/release-compatibility.md) §8 step 4 says to rebuild a lost host "with the **same Tailscale hostname**". With option 2 that becomes "re-attach the **same named tunnel** (credentials file in the secrets bundle) or re-point `pos.<domain>` to a new tunnel". Pinned builds keep working without a release. Add the tunnel credentials to the offsite secrets bundle.

---

## 6. Owner decisions needed

1. **Buy a domain?** (≈ $10.46/yr `.com` at Cloudflare; card or PayPal.) Which name, and which family email owns the Cloudflare account. If no: fallback = Tailscale Standard (≈ $192/yr for 2 seats, card) **or** stay non-compliant.
2. **Accept a public API endpoint** (like hosted Supabase was), with the gate P prerequisites, including **closing public signup** (P4), which needs a code change.
3. **Country restriction** in the WAF (safer, but blocks the owner abroad)?
4. **Phone page hosting**: `app.<domain>` from the house (recommended) vs a path on `pos.<domain>`.
5. **Timing**: pin 1.0.16 directly to `pos.<domain>` (one host change ever) vs ship on `ts.net` first and change later (second release and an overlap period).
6. Whether to keep Tailscale for the owner's personal admin access after S8.

## 7. Open items / unverified

- The Cloudflare `.com` price is from a third-party tracker; confirm at checkout.
- The Zero Trust Free 50-user limit is from third-party summaries.
- **Cloudflare reachability from Myanmar ISPs is not proven.** No source found reports Myanmar blocking Cloudflare wholesale; the only documented wholesale Cloudflare throttling is Russia [CF-RU]. Search results attributing a "16 KB curtain" to Myanmar could not be confirmed and appear to conflate it with Russia. **S3 store probe is the test.**
- Card requirement for Tailscale Standard is not stated on the FAQ page.
- Oracle FAQ text is via search snippet (403 on fetch).
- Pinggy and localhost.run facts come from search summaries.
- Electron `webRequest` header injection for WebSocket upgrades is untested.
- The realtime-js heartbeat interval vs Cloudflare's idle WebSocket timeout (not published for non-Enterprise [CF-WS]) is untested. The S3 realtime probe covers it.

---

## Sources (all retrieved 2026-10-13)

- TS-P https://tailscale.com/pricing · TS-FAQ https://tailscale.com/kb/1251/pricing-faq · TS-FN https://tailscale.com/kb/1223/funnel · TS-HTTPS https://tailscale.com/kb/1153/enabling-https
- CF-TUN https://developers.cloudflare.com/tunnel/ · CF-TUN-OV https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/ · CF-TUN-REMOTE https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/ · CF-ING https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/ · CF-QT https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- CF-DNS https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/ · CF-WS https://developers.cloudflare.com/network/websockets/
- CF-REG https://www.cloudflare.com/products/registrar/ · CF-REG-FAQ https://developers.cloudflare.com/registrar/faq/ · CF-REG-REG https://developers.cloudflare.com/registrar/get-started/register-domain/ · CF-BILL https://developers.cloudflare.com/billing/get-started/create-billing-profile/
- DOMOFFER https://domainoffer.net/tld/com/cloudflare (third-party price tracker; unverified)
- CF-SSA https://www.cloudflare.com/terms/ (Self-Serve Subscription Agreement, updated 2025-09-12) · CF-SST https://www.cloudflare.com/service-specific-terms-application-services/ (updated 2026-09-28)
- CF-WAF-CR https://developers.cloudflare.com/waf/custom-rules/ · CF-WAF-RL https://developers.cloudflare.com/waf/rate-limiting-rules/
- CF-ST https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/ · CF-SEAT https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/ · CF-POL https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ · CF-LIM https://developers.cloudflare.com/cloudflare-one/account-limits/
- CT-ZT https://costbench.com/software/business-vpn/cloudflare-zero-trust/free-plan/ (third-party; unverified)
- CF-RU https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/ (2025-06-26)
- NG-P https://ngrok.com/pricing · NG-LIM https://ngrok.com/docs/pricing-limits/free-plan-limits/ · NG-TOS https://ngrok.com/tos (updated 2026-03-02)
- PG https://pinggy.io/ ; https://freetier.co/directory/products/pinggy (third-party; unverified) · LHR https://localhost.run/docs/forever-free ; https://localhost.run/docs/custom-domains (search summary; unverified)
- D-FAQ https://www.duckdns.org/faqs.jsp · D-SPEC https://www.duckdns.org/spec.jsp
- OCI-AF https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm · OCI-FAQ https://www.oracle.com/uk/cloud/free/faq/ (403 on fetch; text from search snippet)
- TG https://www.tilleke.com/insights/myanmar-cybersecurity-law-takes-effect (2025-08-01) · RFA-L https://rfa.org/english/myanmar/2025/01/02/cybersecurity-law-vpn/ · IIM https://www.internetinmyanmar.com/digest/2025-01-04-myanmars-new-cyber-law-criminalizes-vpn-use-to-tighten-onlin/ · RFA https://www.rfa.org/english/news/myanmar/myanmar-internet-restrictions-vpn-ban-06132024163512.html (2024-06-13)
- FH-FOTN https://freedomhouse.org/country/myanmar/freedom-net/2025 (coverage 2024-06-01 to 2025-05-31) · AN https://www.accessnow.org/myanmar-vpn-ban/ · LAN-T https://corpus.lantern.io/findings/2025-jfm-silk-road-surveillance__shutdown-and-throttling/ (via the WireGuard doc)
- Local code facts: `package.json` (`build:electron`), `electron/main.cjs:127`, `src/lib/productImagePhoneUpload.ts`, `src/stores/data/inventoryRealtime.ts`, `supabase/functions/*`, `deploy/lucashome/env.settings.md` (`DISABLE_SIGNUP`), read 2026-10-13.

## Coordinator verification (2026-10-13)
- Confirmed in code: `createPhoneProductImageUploadSession` builds the QR from `window.location.origin` (src/lib/productImagePhoneUpload.ts:107). In the packaged Electron app that origin is `file://`, so a phone cannot open the QR link. Pre-existing; a **release blocker** for phone upload from tills regardless of the remote-access choice (needs a configured https phone-page origin).
- Confirmed on the server: `DISABLE_SIGNUP=false` in the stack env, and the Users page creates staff with client-side `supabase.auth.signUp` (src/pages/UsersPage.tsx:163). Signup can only be closed after staff creation moves to a server-side function (admin-only, org-scoped). Today any tailnet device with the anon key can create an auth user; such a user has no app row and RLS grants nothing, but it must be closed before any public endpoint.
