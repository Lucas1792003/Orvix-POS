# Phase F: free-tier compliance for family-business use

Retrieved **2026-10-13** (all quotes below). Research only: no sign-ups, no billing, no code changes.
Extends [cost-research.md](cost-research.md), which covers quotas and sizes; this file covers only **whether the terms allow a family shop's POS on the free plan**.

Question per service: *can a family-run shop in Myanmar use this free plan for its POS at $0?*
Verdicts: **Yes** = terms allow it or only restrict things we don't do. **No** = the terms exclude it. **Unclear** = the terms are silent or ambiguous.

> Not legal advice. "Unclear" items are judgment calls for the owner.

---

## Summary table

| # | Service | Needed for | Free plan permits family-business use? | Risk | Compliant $0 alternative | Recommendation |
|---|---|---|---|---|---|---|
| 1 | **Tailscale Personal** | One tailnet for tills, phones and server; `tailscale serve` HTTPS on `*.ts.net` | **No.** "This is a free plan and is only suitable for non-commercial use of Tailscale." (FAQ and pricing [T1][T2]). For custom-domain sign-ups: "the Personal plan is not intended for commercial use." [T2]. A Gmail sign-up lands on Personal automatically, but that is account classification, not permission. | High (terms). Tailscale can't technically detect it, but this is a knowing breach of the plan terms. | (a) **LAN-only** if every till and phone is in the shop. (b) **Headscale** (BSD-3) on the home server. (c) **Plain WireGuard** plus DuckDNS. See section 1. | **Drop Tailscale for production.** Go LAN-first; add Headscale or WireGuard only if remote access is truly needed. |
| 2 | **Resend Free** | Daily summary email; weekly encrypted backup email | **Yes (with a domain).** The ToS and AUP make no personal/commercial distinction on Free. The AUP prohibits only spam, phishing, malware and similar. Nothing bans attachments, encrypted files or mailing yourself [R1][R2]. **But** without a verified domain, `resend.dev` "is only available for testing purposes and can only send emails to the email address associated with your Resend account" [R3]. | Medium. Free tier can be changed or ended without notice [R2]. Using `resend.dev` for production is outside its stated "testing" purpose. | If the shop has no domain: **SMTP2GO Free** also needs a verified domain or sender (see cost-research). DuckDNS can't host DKIM (section 2). Fallback: send from a dedicated *sender* Gmail via app password, accepting the credential trade-off. | Use Resend **only if the existing app domain stays paid**. Confirm with the owner who pays that renewal; it is the one recurring cost in the email path. |
| 3 | **Gmail (consumer)** | Backup recipient mailbox | **Yes.** Google's ToS explicitly covers "business users" (defined as "an individual or entity who is not a consumer") and sets liability terms for them [G1]. The Gmail Program Policies bar spam, malware and over-quota use but say nothing against business use or keeping backups [G2]. | Low. Business users get weaker liability terms (US$500 or 125% of fees) [G1]. Deleted after **2 years** of inactivity [G3]. Stops receiving when the 15 GB is full [G2]. | Outlook.com as a second recipient | **Keep.** Owner signs in at least yearly (reading an email counts as activity [G3]). |
| 4 | **GitHub Free** (public repo: Releases, Actions) | Installers and auto-update feed (Releases); CI builds (Actions) | **Yes.** The ToS doesn't bar business use of Free accounts. The only limit is "One person or legal entity may maintain no more than one free Account" [GH1]. Hosted Actions must relate to "the production, testing, deployment, or publication of the software project associated with the repository" [GH2], and building our own installers fits. **Pages is the exception**: it is "not intended for or allowed to be used as a free web hosting service to run your online business, e-commerce site …" [GH2]. | Low. Excessive-bandwidth clause [GH3] is irrelevant at a few tills. A **public** repo exposes the source: no secrets or customer data may go in it. | Self-host installers on the server (LAN) | **Keep** Releases and Actions. **Don't** host the POS web UI on Pages. Myanmar isn't on GitHub's trade-controls restricted list [GH4]. |
| 5 | **Supabase self-hosted** | Database, auth, storage, REST API | **Yes.** All components in the default `docker/docker-compose.yml` are under permissive licences (section 5) [S1]. No component is AGPL, BSL or source-available. Self-hosting has no service terms or fees. | Low (licence). Ops risk lies elsewhere: patching, backups. | — | **Keep.** Pin image tags. |
| 6 | **Electron / electron-builder** | Desktop till app and installers | **Yes.** Both are **MIT** (GitHub licence API) [L1]. | None | — | Keep. |
| 7a | **npm registry** | Build-time dependencies | **Yes.** "You are free to use npm Open Source for commercial projects … and for other business purposes." [N1] | None | — | Keep. |
| 7b | **Let's Encrypt** (via `tailscale serve` or ACME) | HTTPS certificates | Yes. Free certificates for any lawful use. Standard subscriber agreement, not re-fetched. | Low. Certificate-transparency logs reveal hostnames. | — | Keep (via DuckDNS DNS-01 if Tailscale is dropped). |
| 7c | **healthchecks.io Hobbyist** (optional) | Backup-job heartbeat | **Unclear.** The pricing page and ToS don't mention commercial use. Only hint: "Business plan free of charge for open-source projects and nonprofits" [H1]. The ToS lets them "terminate or suspend your account … for any reason whatsoever" [H2]. | Low (it's optional) | Self-hosted Healthchecks (BSD-3 open source; licence not re-verified) or the server's own cron mail | Optional. Self-monitoring by email is enough. |
| 7d | **DuckDNS** (only if WireGuard or Headscale) | Dynamic DNS for the home IP; ACME DNS-01 | **Unclear.** The FAQ and Terms don't mention commercial use; "We may terminate this agreement or suspend your account at any time with or without notice." [D1][D2] | Medium if remote access depends on it | Raw IP (if static), or the ISP's own DDNS | Use only as a convenience. LAN-first design keeps the shop running without it. |
| 7e | **ZeroTier Free** (evaluated, rejected) | Tailscale alternative | **No.** The Personal (Free) plan is "Personal, non-commercial use" only, with "10 devices, one network" [Z1]. | — | — | Don't use. |

---

## 1. Tailscale: detail and alternatives

**Current plans (2026)** [T1][T3]: Personal (free, up to 6 users), Standard $8/user/mo, Premium $18/user/mo, Enterprise. Personal Plus was **retired** 2026-04-08 ("Starter becomes Standard"). There is **no** small-business, family or side-business allowance anywhere.
- Free-plan exceptions apply only to open source: "Your GitHub organization can use Tailscale for free if you're using it for an open source project which has an OSI license." Non-profits get 50% off [T4]. Neither applies to a shop.
- ToS §2.1: Services are provided "solely for your own personal use or internal business purposes (as applicable depending on your Plan)" [T5]. The plan therefore decides what is allowed, and Personal = non-commercial.
- **Correction to a web-search summary seen during this research:** a search-engine summary claimed "the free Personal plan can be used for small business purposes". The official FAQ text [T2] says the opposite. Disregard that summary.
- **Myanmar:** Tailscale ToS §12.1 requires users to comply with sanctions law and to not be on any sanctions list [T5]. No Tailscale page found lists Myanmar as unavailable. US Burma sanctions are list-based, targeting the military and named entities, not a full embargo. A private family shop is not affected unless it deals with listed parties. (The OFAC program page returned 404 on fetch, so this is unverified from OFAC directly.)

### Compliant $0 alternatives

| Option | Licence / terms | Needs public endpoint? | Domain? | Trade-offs |
|---|---|---|---|---|
| **LAN-only** (tills and phones on shop Wi-Fi, server on the same LAN) | none | No | No | **Simplest, $0, fully compliant.** No remote access. HTTPS on LAN needs a self-signed cert or a private CA installed on each phone, or else serve the phone upload page over plain HTTP on the LAN. `<input type="file" capture>` works without HTTPS; `getUserMedia` camera needs a secure context. Owner-away access is impossible. |
| **Headscale** (self-hosted Tailscale control server; official Tailscale clients connect to it) | BSD-3-Clause [HS1]; scope "a single Tailscale network (tailnet), suitable for a personal use, or a small open-source organisation" [HS2]. A scope statement, not a licence restriction, so commercial use is allowed by BSD-3. | **Yes**: "A server with a public IP address for headscale"; TCP 443 mandatory, UDP 3478 if embedded DERP [HS3] | Practically yes, for TLS. A free DuckDNS subdomain plus Let's Encrypt DNS-01 works. | Needs a router port-forward and a non-CGNAT public IP. **Many Myanmar residential/mobile connections are CGNAT (unverified; check the shop ISP).** Otherwise a $0 VPS would be needed, and none is reliably free without a card. Must run your own DERP or use Tailscale's public DERP (DERP use by Headscale clients isn't covered by Tailscale's plan terms; prefer the embedded DERP). No `*.ts.net` certs: you need your own certs. |
| **NetBird self-hosted** | Client BSD-3; `management/`, `signal/`, `relay/` **AGPLv3** [NB1]. Self-use is fine; AGPL only matters if you modify and offer it to others. | **Yes**: "publicly accessible on TCP ports 80 and 443, and UDP port 3478" | **Yes**: "A public domain name that resolves to the VM's public IP" [NB2] | Heavier (1 CPU / 2 GB min, Docker, Traefik). Same CGNAT problem. More moving parts than Headscale. |
| **Plain WireGuard** (server as hub, tills and phones as peers) | GPLv2 kernel module and open-source tools; no service terms | **Yes**: one UDP port forwarded on the home router | No (an IP works); DuckDNS if the IP is dynamic | Leanest. Manual key and config per device; the WireGuard app on phones. Same CGNAT caveat. HTTPS for the upload page needs a cert: DuckDNS name plus DNS-01, pointed at the WireGuard IP. |
| **ZeroTier Free** | **Non-commercial only** [Z1] | — | — | Rejected. |

**Recommendation:** run **LAN-only** as the production baseline: it costs $0 and has no terms risk. If remote access is required later, add **WireGuard** (simplest) or **Headscale** (keeps Tailscale-style UX). First check that the shop's ISP gives a real public IPv4 (not CGNAT) and that the router can port-forward. If neither works, a paid Tailscale Standard plan or a VPS becomes the only option, and both break the $0 rule.

## 2. Resend: domain question

- Free plan: "100 emails a day", "3,000" per month, "3 domains" [R4]. No card stated.
- Without a domain, `onboarding@resend.dev` can send **only** to the Resend account's own address, and is "only available for testing purposes" [R3]. A technical workaround would be to open the Resend account *with the backup Gmail address* so backups go "to yourself". It would work, but it falls outside the stated purpose and leaves the daily summary unable to reach anyone else. **Not recommended.**
- **Free domains don't work for Resend:**
  - DuckDNS supports only A/AAAA and a single TXT record that "will apply to all sub-subdomains under your domain" [D3]. It can't publish separate SPF and DKIM (`resend._domainkey`) records.
  - EU.org gives free names "to users or non-profit organizations who cannot afford the fees" [E1]. It needs your own DNS hosting, has slow manual approval and no support, and its commercial eligibility is doubtful.
- **Action:** confirm whether the app's current Resend domain is owned and who pays renewal (about $10–15/yr). If it lapses, the fallback is sending from a dedicated *sender* Gmail via SMTP app password. That account must be separate from the receiving backup mailbox, so a server compromise can't delete backups.

## 3. Gmail: notes

- Google ToS: "To use our services on behalf of an organization: an authorized representative of that organization must agree to these terms". The terms define business users and give them separate liability caps [G1]. So business use of a consumer account is contemplated, not banned.
- Gmail Program Policies: "Don't use Gmail to distribute spam or unsolicited commercial mail."; "Do not transmit malware …"; "we may prohibit the sending or receiving of messages if you exceed your storage quota." [G2]. Nothing prohibits storing encrypted backups.
- Inactivity: "An inactive Google Account is an account that has not been used within a 2-year period." "Reading or sending an email" counts as activity [G3].

## 5. Supabase self-hosted component licences

From the default `docker/docker-compose.yml` on `master` [S1]. Licences are from the GitHub licence API, retrieved 2026-10-13.

| Service | Image | Licence |
|---|---|---|
| studio | supabase/studio | Apache-2.0 (supabase/supabase monorepo) |
| api-gw | envoyproxy/envoy | Apache-2.0 (Kong, in the optional `docker-compose.kong.yml`: Apache-2.0) |
| auth | supabase/gotrue | MIT |
| rest | postgrest/postgrest | MIT |
| realtime | supabase/realtime | Apache-2.0 |
| storage | supabase/storage-api | Apache-2.0 |
| imgproxy | darthsim/imgproxy | Apache-2.0 (OSS edition; imgproxy Pro is separate and not used) |
| meta | supabase/postgres-meta | Apache-2.0 |
| functions | supabase/edge-runtime | MIT |
| db | supabase/postgres | PostgreSQL licence |
| supavisor | supabase/supavisor | Apache-2.0 |
| (optional `docker-compose.logs.yml`) analytics / vector | logflare / vector | Apache-2.0 / MPL-2.0 |

All are permissive or weak-copyleft (MPL-2.0 applies file-level, only if you modify Vector's files). Commercial self-hosting at $0 is allowed.

---

## Sources (all retrieved 2026-10-13)

- T1 https://tailscale.com/pricing
- T2 https://tailscale.com/kb/1251/pricing-faq ; https://tailscale.com/pricing/faq
- T3 https://tailscale.com/blog/pricing-v4
- T4 https://tailscale.com/kb/1154/free-plans-discounts
- T5 https://tailscale.com/terms (§2.1, §2.3, §12.1)
- HS1 https://github.com/juanfont/headscale (licence) · HS2 https://headscale.net/stable/ · HS3 https://headscale.net/stable/setup/requirements/
- NB1 https://github.com/netbirdio/netbird (README licence note) · NB2 https://docs.netbird.io/selfhosted/selfhosted-quickstart
- Z1 https://www.zerotier.com/pricing/ ; ZeroTierOne repo `LICENSE.txt` (core MPL, `nonfree/` source-available)
- D1 https://www.duckdns.org/faqs.jsp · D2 https://www.duckdns.org/tac.jsp · D3 https://www.duckdns.org/spec.jsp
- E1 https://nic.eu.org/
- R1 https://resend.com/legal/acceptable-use · R2 https://resend.com/legal/terms-of-service · R3 https://resend.com/docs/knowledge-base/403-error-resend-dev-domain · R4 https://resend.com/pricing
- G1 https://policies.google.com/terms · G2 https://support.google.com/mail/answer/16734397 (Gmail Program Policies) · G3 https://support.google.com/accounts/answer/12418290
- GH1 https://docs.github.com/en/site-policy/github-terms/github-terms-of-service · GH2 https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features · GH3 https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies · GH4 https://docs.github.com/en/site-policy/other-site-policies/github-and-trade-controls
- S1 https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml ; licences via `api.github.com/repos/<repo>/license`
- L1 https://github.com/electron/electron ; https://github.com/electron-userland/electron-builder (MIT via GitHub licence API)
- N1 https://docs.npmjs.com/policies/open-source-terms
- H1 https://healthchecks.io/pricing/ · H2 https://healthchecks.io/terms/
