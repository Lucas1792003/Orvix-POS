# lucashome — roadmap

Phases from [`../selfhost-migration/MIGRATION-PLAN.md`](../selfhost-migration/MIGRATION-PLAN.md); evidence under [`../selfhost-migration/evidence/`](../selfhost-migration/evidence/).

## Done

- [x] **2026-10-11** Audit + 11 planning docs (G0).
- [x] **2026-10-11** Phase A — stack prepared from `self-hosted/v0.8.2`, secrets generated, override, images pulled.
- [x] **2026-10-11** Phase B — stack started, local + tailnet API checks, `tailscale serve` (G2). Evidence `G2/2026-10-11-phase-b.md`.
- [x] **2026-10-11** Phase C — local backups, WAL archiving, PITR drill; read-only hosted export; restore into lucashome (G4). Evidence `G4/`.
- [x] **2026-10-12** Phase D — migrations 062–066 applied; client idempotency/outbox/offline-auth; live suite 16/16. Evidence `G9/2026-10-12-phase-d*.md`.
- [x] **2026-10-12** Phase E — Electron E2E 24/24, failure injection, cron/email audit, Phase F proposal. Evidence `G9/2026-10-12-phase-e.md`.
- [x] **2026-10-12** Phase G — migrations 067–073 (org isolation) applied after independent review; live two-org suite 12/12; E2E 25/25; post-migration backup LSN `1/26000058`.
- [x] **2026-10-12** Offsite backup scripts deployed disabled.
- [x] **2026-10-12** Local branch `feature/selfhost-supabase-migration`, 8 commits (`4c7f2ca`…`66520ab`), not pushed.

## Next (each needs owner approval)

Decision-ready proposals for the open items below (written 2026-10-13, nothing executed): [reboot + G3 + hardening](../selfhost-migration/next-phase/reboot-and-hardening.md), [offsite backups](../selfhost-migration/next-phase/offsite-backup-enable.md), [owner TOTP test](../selfhost-migration/next-phase/owner-totp-test.md), [1.0.16 canary](../selfhost-migration/next-phase/electron-1.0.16-canary.md).

- [x] **2026-10-13** Apply 074–076 (00:48 UTC, pre-LSN `1/41000000`).
- [x] **2026-10-13** Prepare 077 (new-org price levels) and 078–079 (upload security); harness 467/0.
- [ ] Apply 077–079 (owner approval).
- [ ] Decide signed-upload URL lifetime (60 s today) and the 17 orphan objects.
- [ ] Owner TOTP login test.
- [ ] Push branch, open PR (via `Lucas1792003`).
- [ ] ~~Phase F: enable offsite backups to R2 + Mac pull tier~~ — superseded 2026-10-13: owner chose **email**. Email tier (weekly encrypted archive, secrets file, daily report) built + tested on synthetic data (194/0), **not deployed**: owner checklist in [`email-backup-design.md` §10](../selfhost-migration/phase-f/email-backup-design.md); restore runbook [`restore-from-email.md`](../selfhost-migration/phase-f/restore-from-email.md); audit [`email-audit.md`](../selfhost-migration/phase-f/email-audit.md).
- [x] **2026-10-13** Full DR drill in a disposable environment (G6): email archive path from live data (throwaway key, no mail), restore into a fresh stack, PITR around the 080 rollout; 123/0; live unchanged. `email-archive.sh --no-send` added (tests 210/0). Evidence [`G6/2026-10-13-dr-drill.md`](../selfhost-migration/evidence/G6/2026-10-13-dr-drill.md).
- [ ] Maintenance window: reboot (pending kernel), G3 persistence test, restart `tailscaled` to clear stale 443 listener.
- [ ] Host hardening: firewall, sshd keys-only/tailnet bind, Tailscale ACLs (tills → 443 only, Studio admin-only), second tailnet admin.
- [ ] Tailscale on shop tills + real-device latency tests (G10).
- [ ] Release 1.0.16 → canary till → rollout (G11–G13), then 30-day window (G14) — see [`../desktop-app/roadmap.md`](../desktop-app/roadmap.md).
- [ ] Weekly sales report: reconsider after a verified Resend sender domain + monitoring.
