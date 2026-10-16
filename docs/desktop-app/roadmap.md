# Desktop app — roadmap

Release checklist and proposal for the items below (2026-10-13, not yet approved): [`../selfhost-migration/next-phase/electron-1.0.16-canary.md`](../selfhost-migration/next-phase/electron-1.0.16-canary.md). It records three findings that change this plan: the rollback build must come from the v1.0.15 code (the 1.0.16 client always sends `p_idempotency_key`, which hosted lacks); the local Dexie DB is version 2 on 1.0.16 and version 1 on 1.0.15; rollback tier B needs re-planning.

**Consolidated order of work (2026-10-13):** [`../selfhost-migration/next-phase/release-checklist.md`](../selfhost-migration/next-phase/release-checklist.md). Tested compatibility, rollback and emergency procedure: [`../selfhost-migration/phase-g/release-compatibility.md`](../selfhost-migration/phase-g/release-compatibility.md). Deployment guards before the first push: [`../selfhost-migration/phase-g/deployment-automation-audit.md`](../selfhost-migration/phase-g/deployment-automation-audit.md). Correction to the above: v1.0.15 does **not** hit a VersionError on the 1.0.16 database (Dexie 4 reopens it); it instead deletes every pending outbox entry on its first online load, so the rollback build needs the A8 fix + a pending-queue guard, and pushing the branch already triggers a Vercel Preview.

**Since 2026-10-15 the release items are tracked in [`../selfhost-migration/phase-f/production-readiness-checklist.md`](../selfhost-migration/phase-f/production-readiness-checklist.md) sections E–F** (it supersedes the ordering of release-checklist.md; that file keeps the mechanics).

- [x] **2026-10-12** Branch with idempotency, offline queue, offline auth, realtime reconciliation, login/setup hardening, org-isolation compatibility; E2E 25/25.
- [x] **2026-10-13** Encrypted Export Pending Transactions + queue recovery tool (commit `3c00aeb`, [`queue-export.md`](../selfhost-migration/phase-f/queue-export.md)); server-side staff creation and phone page on the API origin in the client (`170aaaa`, `c2f3565`).
- [x] **2026-10-14** Electron compatibility review at schema 081 (`556de34`, [`electron-compatibility.md`](../selfhost-migration/phase-f/electron-compatibility.md)).
- [x] **2026-10-15** Barcode-loss-on-save and upload-poll stall fixed (`3034889`, `664c371`); e2e made order-independent (`3da7ddb`); e2e 44/44 ×2 normal + ×1 reverse (`f8b1281`) — checklist E2/E3.
- [x] **2026-10-16** Desktop uploads through the validated session flow (`373682a`, merged `d490298`) — prerequisite for migration 084.
- [x] **2026-10-16** D300: confirm-before-cancel on the QR modal + close diagnostics (`e467d21`, merged `967a941`).
- [x] **2026-10-16** Sanitized publication branch `publish/selfhost-support` synced (16 commits, unpushed) — checklist E4. **Not re-synced since 04:30 UTC**; re-sync before any push.
- [ ] Vercel Git integration off, GitHub Pages workflow absent, branch protection (owner dashboards, E5).
- [ ] Updater guard: no install while sales are pending (decision, F3); version handshake (A9).
- [ ] Owner approves push + PR of `feature/selfhost-supabase-migration` (via `Lucas1792003`, no direct push to `main`).
- [ ] Bump to 1.0.16; build Windows + macOS with `build:electron` (host-pinned); prepare a `v1.0.17-rollback` build pointing at hosted.
- [ ] Publish 1.0.16 as a GitHub **pre-release** (owner approval) → install on one canary till → overnight validation. Real-device canary = one till per shop + one phone each, 8 checks (checklist F5); no real shop sales until F5 passes on both shops and the email backup tier is live (F6).
- [ ] After every till runs 1.0.16: migration 084 on the server ([`../lucashome-selfhost/roadmap.md`](../lucashome-selfhost/roadmap.md)).
- [ ] Promote to full release → tills auto-update → first trading day watched (gates G11–G13).
- [ ] Decide on code signing.
