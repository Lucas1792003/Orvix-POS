# lucashome — roadmap

Phases from [`../selfhost-migration/MIGRATION-PLAN.md`](../selfhost-migration/MIGRATION-PLAN.md); evidence under [`../selfhost-migration/evidence/`](../selfhost-migration/evidence/). **Since 2026-10-15 the single list of what remains before production is [`../selfhost-migration/phase-f/production-readiness-checklist.md`](../selfhost-migration/phase-f/production-readiness-checklist.md)**; this file records what was done on the server and points there for the rest.

## Done

- [x] **2026-10-11** Audit + 11 planning docs (G0).
- [x] **2026-10-11** Phase A — stack prepared from `self-hosted/v0.8.2`, secrets generated, override, images pulled.
- [x] **2026-10-11** Phase B — stack started, local + tailnet API checks, `tailscale serve` (G2). Evidence `G2/2026-10-11-phase-b.md`.
- [x] **2026-10-11** Phase C — local backups, WAL archiving, PITR drill; read-only hosted export; restore into lucashome (G4). Evidence `G4/`.
- [x] **2026-10-12** Phase D — migrations 062–066 applied; client idempotency/outbox/offline-auth; live suite 16/16. Evidence `G9/2026-10-12-phase-d*.md`.
- [x] **2026-10-12** Phase E — Electron E2E 24/24, failure injection, cron/email audit, Phase F proposal. Evidence `G9/2026-10-12-phase-e.md`.
- [x] **2026-10-12** Phase G — migrations 067–073 (org isolation) applied after independent review; live two-org suite 12/12; E2E 25/25; post-migration backup LSN `1/26000058`.
- [x] **2026-10-12** Offsite backup scripts deployed disabled.
- [x] **2026-10-12** Local branch `feature/selfhost-supabase-migration` created (8 commits then; 85 on top of `main` as of 2026-10-16 `0abe0ad`), not pushed.
- [x] **2026-10-13** Apply 074–076 (00:48 UTC, pre-LSN `1/41000000`).
- [x] **2026-10-13** Prepare 077 (new-org price levels) and 078–079 (upload security); harness 467/0.
- [x] **2026-10-13** Apply 077–079 (01:56 UTC) — see [`status.md`](status.md).
- [x] **2026-10-13** Signed-upload lifetime decided (keep 60 s) and solved by just-in-time tokens: `phone-upload-token` deployed + migration 080 applied (04:09 UTC) — evidence [G5](../selfhost-migration/evidence/G5/2026-10-13-080-and-phone-upload.md).
- [x] **2026-10-13** 17 orphan objects: owner decided preserve all — [`orphan-objects.md`](orphan-objects.md).
- [x] **2026-10-13** Full DR drill in a disposable environment (G6), 123/0 — [`G6/2026-10-13-dr-drill.md`](../selfhost-migration/evidence/G6/2026-10-13-dr-drill.md).
- [x] **2026-10-13** Migration 081 (phone-upload rate limits) applied 10:14 UTC + rate-limited function — [G7](../selfhost-migration/evidence/G7/2026-10-13-081-and-email-install.md).
- [x] **2026-10-13** `rotate-audit-log` and `weekly-sales-report` removed from the server (~11:40 UTC; commit `5d3d470`).
- [x] **2026-10-13** Email tier (Gmail API send-only transport, commit `1e12dc6`) installed **disabled** 18:46 UTC — [G8](../selfhost-migration/evidence/G8/2026-10-13-staff-qr-signup.md). Enabling it is still open (below).
- [x] **2026-10-13** QA cleanup executed 18:47 UTC per approved manifest (2 movements, 15 codes, 21 sessions) — [`qa-cleanup-manifest.md` §7](../selfhost-migration/phase-f/qa-cleanup-manifest.md).
- [x] **2026-10-13** Server-side staff creation: `staff-admin` deployed ~19:15 UTC; `phone-upload-page` + router allow-list ~21:30 UTC; `DISABLE_SIGNUP=true` ~21:35 UTC (G8; commits `170aaaa`, `c2f3565`, `afab6cc`, `2de8bcd`).
- [x] **2026-10-16** Org-isolation security audit (`tools/security-audit`, commit `9b62930`): G1–G4 at 081 — [`org-isolation-security-audit.md`](../selfhost-migration/phase-f/org-isolation-security-audit.md).
- [x] **2026-10-16** Migration 082 applied 05:31 UTC after the marker-writing `staff-admin` (commit `67f129b`; audit at 082 395/0/0) — [G9](../selfhost-migration/evidence/G9/2026-10-16-migration-082.md).
- [x] **2026-10-16** Migration 083 (G5) applied 06:37 UTC + validated phone completion + Envoy public-image headers 06:38 UTC (commit `29ad4cb`) — [G10](../selfhost-migration/evidence/G10/2026-10-16-migration-083-headers.md).
- [x] **2026-10-16** Migration 085 (PNG completion) applied 07:52 UTC after the `phone-upload-token` scoped-delete build 07:51 UTC (commits `1f599dc`, `d7f62f6`; audit modelled as 083+085 without 084, commit `0e79ea6`) — [`migration-085-png.md`](../selfhost-migration/phase-f/migration-085-png.md), G10 "Correction".
- [x] **2026-10-16** Abandoned-upload sweep dry run on the server: 0 candidates (not scheduled).

## Next (each needs owner approval) — tracked in the readiness checklist

- [ ] Migration 084 — only after every till runs the validated-upload client (checklist A6e; [`g5-followups.md`](../selfhost-migration/phase-f/g5-followups.md)).
- [ ] Schedule the abandoned-upload sweep (A6e; g5-followups.md §2.5).
- [ ] Studio isolation off the shared origin (A6d; [`studio-isolation.md`](../selfhost-migration/phase-f/studio-isolation.md)).
- [ ] Owner TOTP login test (A8).
- [ ] Review the 7 unlinked auth accounts (A7).
- [ ] Version handshake decision (A9).
- [ ] Migration 086 (operation outcomes; committed 2026-10-17/18, verified on disposable stacks) — apply only with approval, after its own readiness gates ([`migration-086.md`](../selfhost-migration/phase-g/migration-086.md)).
- [ ] Migration 087 (recovery hold; committed `e170794` 2026-10-19, verified on disposable stacks only) — **not before** every till runs the v87 client and the witness authority runs on a second device; deployment window and preconditions in [`migration-087.md`](../selfhost-migration/phase-g/migration-087.md) "Deployment".
- [ ] Email tier enablement: owner key + Google setup → self-tests → restore from email → first archive → schedules (B3–B7; [`owner-setup-checklist.md`](../selfhost-migration/phase-f/owner-setup-checklist.md)).
- [ ] Remote-access decision for the two shops (C1–C3; [`remote-access-architecture.md`](../selfhost-migration/phase-f/remote-access-architecture.md)).
- [ ] Host hardening after Gate R, then the controlled reboot / G3 persistence test; restart `tailscaled` to clear the stale 443 listener (D1–D6; [`host-hardening-staged.md`](../selfhost-migration/phase-f/host-hardening-staged.md)).
- [ ] Push branch, open PR (via `Lucas1792003`) after the Vercel/GitHub controls (E5–E6).
- [ ] Tailscale (or the chosen path) on shop tills + real-device canary, release 1.0.16 → rollout (G11–G13), then 30-day window (G14) — see [`../desktop-app/roadmap.md`](../desktop-app/roadmap.md).
- [ ] Weekly sales report: reconsider after a verified sender + monitoring.

## Superseded

- [ ] ~~Phase F: enable offsite backups to R2 + Mac pull tier~~ — superseded 2026-10-13: owner chose **email** ([`email-backup-design.md`](../selfhost-migration/phase-f/email-backup-design.md)).
- Proposals of 2026-10-13 in [`../selfhost-migration/next-phase/`](../selfhost-migration/next-phase/) (reboot, offsite, TOTP test, canary) remain the long-form reasoning; their ordering is superseded by the readiness checklist.
