# 10 · Go / No-Go Gates

A gate is **PASSED** only when its evidence file exists under
`docs/selfhost-migration/evidence/<gate>/` and the owner has initialled the row.
No gate may be passed on the strength of this document, a chat transcript, or
"it should work". Gates are sequential; a later gate cannot be opened while an
earlier one is open.

Current state (2026-10-11): **G0 in progress** — infrastructure and hosted
inventories done; owner decisions outstanding (see "Prerequisites the owner
must provide" at the end). **Nothing beyond G0 has started.**

| Gate | Pass criterion (all required) | Evidence | Stop / rollback if failed |
|---|---|---|---|
| **G0** Infrastructure & production inventory complete | [01](./01-infrastructure-audit.md) and [02](./02-production-dependencies.md) written from live read-only inspection; every UNKNOWN either resolved or accepted in [03](./03-risk-register.md); owner has answered the open decisions | this folder; owner note | — (nothing to roll back) |
| **G1** Architecture & security approved | Owner has read [04](./04-target-architecture.md) and the "Architecture concerns" section of [MIGRATION-PLAN.md](./MIGRATION-PLAN.md) and chosen **lucashome** over the alternatives, in writing; host hardening list (sshd keys-only, firewall confirmed, fail2ban or Tailscale-only SSH, reboot applied, container limits for existing tenants, Minecraft heap confirmed, ollama policy) agreed with dates; second Tailscale admin added; ACL policy drafted | signed note; ACL file in git | — |
| **G2** Empty self-hosted stack validated | Stack built from tag `self-hosted/v0.8.2` per [05 §2](./05-migration-runbook.md); all containers healthy; reachable only via Tailscale TLS; gateway on loopback; no 5432 published; TOTP enabled; SMTP test mail delivered; `pg_cron`/`pg_net` enabled; publication created; container memory limits set; log rotation set; `docker stats` baseline recorded; `tailscale serve` coexists with the stale 443 listener | `docker compose ps`, `ss -tlnp`, curl outputs, stats | `docker compose down` + delete `stack/` — host unchanged otherwise |
| **G3** Reboot & connectivity recovery | `lucashome` rebooted (pending kernel applied); every container, `tailscale serve`, and the TLS cert return with no manual action in ≤ 5 min; F3/F4/F5 from [06 §4](./06-rehearsal-test-plan.md) pass | `uptime`, probe logs | fix and repeat |
| **G4** Full rehearsal migration (R1) successful | R1.3–R1.7: export, scrub, restore; **row-count manifest matches for every table**; schema/function/policy diff explained line-by-line; sequences correct; storage md5 manifest matches | manifest + diff files | `reset.sh`, fix runbook, repeat |
| **G5** Auth, TOTP, RLS, RPC | R1.8 **admin logs in with the migrated TOTP factor** (not re-enrolled); cashier password login; `aal2` observed; R1.9 August checklist passes every line; QA accounts cleaned up | screenshots, checklist | if TOTP fails: decide re-enrolment procedure (admins re-enrol on cutover day via email path — requires Resend) and record it in 05 before continuing |
| **G6** Storage & Edge Functions | R1.10 Realtime, R1.11 storage (every image 200 + md5), R1.12 all five functions with masked emails, R1.13 cron runs succeed with internal URL | logs, Resend dashboard screenshots | fix and repeat |
| **G7** Repeated clean restore (R2) | Rehearsal 2 rebuilt from the runbook only, zero improvisation, same manifest, timed | R2 log with timings | fix runbook, repeat |
| **G8** Local & offsite backup restoration | WAL archiving continuous ≥ 7 days; base backup verified daily; **restore from R2 into a throwaway container** succeeds with counts; **PITR to a chosen timestamp** demonstrated; secrets bundle decrypted on the Mac; offsite usage < 8 GB; healthchecks pings green; deletion-protection decision recorded (bucket lock or Mac tier) | job logs, restore log | no cutover without this |
| **G9** Disaster-recovery / failure injection | F1–F19 executed on the rehearsal stack with results in the table; every "Required" item has a fix or an accepted risk; the host-loss drill (07 §5.3) rehearsed to a VM or the Mac | per-test logs | fix and repeat failed tests |
| **G10** Shop connectivity & latency accepted | [06 §5](./06-rehearsal-test-plan.md) tests from **each shop's real till**: direct/DERP status, p50/p95, scripted checkout time, 24 h packet loss, offline/reconnect cycle; owner accepts the measured numbers against the acceptance thresholds | CSVs, owner sign-off | if rejected: revisit architecture (alternatives in MIGRATION-PLAN) — **do not proceed with lucashome** |
| **G11** Final production snapshot verified | On cutover day: freeze confirmed; golden export taken; manifest; restore; **manifest match**; backups armed; smoke test | cutover log | abort (hosted unchanged) |
| **G12** Canary POS deployment | One till on v1.0.16 completes 3 real sales + refund + shift close with correct rows, receipts, stock; overnight validation with zero criticals | cutover log, queries | rollback tier A |
| **G13** Full production cutover accepted | All tills on v1.0.16; 3 consecutive trading days: zero duplicates, zero stuck outbox entries, backups green, p95 within acceptance, zero critical alerts | monitoring export, per-till version list | fix forward or rollback tier B (owner decision, same day) |
| **G14** 30-day window completed | 30 days of monitoring history; at least one weekly restore test passed each week; one unplanned incident (if any) handled within RTO; owner decides to pause/delete hosted; golden export archived permanently | monitoring export, decision note | hosted remains available as cold spare until this gate |

## Approval checkpoints (where the engineer stops and asks the owner)

1. **Before G1** — architecture choice and hardening list (this is the big one).
2. **Before G2** — permission to create `/srv/supabase/stack`, generate secrets, pull images, start containers, and run `sudo tailscale set --operator=lucario` + `tailscale serve` (first state change on the server).
3. **Before G3** — permission to reboot `lucashome` (affects Minecraft, house app, ollama, open-webui).
4. **Before G4** — permission to run the **read-only export** from hosted (first copy of production data leaves Supabase; it lands on the Mac and `lucashome` only).
5. **Before G8** — R2 token, `age` key, healthchecks account from the owner.
6. **Before G10** — installing Tailscale on shop tills (touches shop devices).
7. **Before G11** — the cutover date/time and the freeze.
8. **Before publishing any GitHub release** (pre-release or full) — standing rule.
9. **Before any rollback** — owner decision.
10. **Before G14 close** — pausing/deleting the hosted project.

## Prerequisites the owner must provide (missing today)

| # | Item | Needed for |
|---|---|---|
| O1 | Decision: proceed with `lucashome` vs alternatives (MIGRATION-PLAN §3), knowing that the hosted project is already on the Free plan and holds no sales yet | G1 |
| O2 | Confirmation of where the shops are and how many tills/shops (the audit found 1 shop referenced in docs; `shops` table count is in 02) | G10 planning |
| O3 | `sudo` on `lucashome` for: `tailscale set --operator=lucario` (once), reboot, firewall inspection/config, sshd hardening, optional `nvme-cli` install and sudo rules for monitoring | G1–G3 |
| O4 | Hosted DB password (for `psql` tier-B rollback test connection and for `supabase db dump` if the Management-API path is not used) — kept by the owner, entered interactively, never stored by the engineer | G4, G11 |
| O5 | Resend API key (existing) and a decision on sender address for the self-hosted SMTP | G2, G6 |
| O6 | Cloudflare R2 bucket + scoped API token; `age` recipient key generated on the Mac | G8 |
| O7 | healthchecks.io account (or chosen equivalent) and Telegram/email for alerts | G8, G9 |
| O8 | Tailscale: add a second admin account; agree ACL policy; approve installing Tailscale on tills; auth keys for tills | G1, G10 |
| O9 | Application changes approved (idempotency key etc., 02 §POS) — these are code changes to the app and migrations to the schema, with their own tests | G9, before G11 |
| O10 | Commit the uncommitted multi-tenant work (059–061, platform console) or decide to drop it — the production schema currently contains objects absent from git history | G4 (schema source of truth) |
| O11 | A Windows machine for RC testing and the canary till identity | G9, G12 |
