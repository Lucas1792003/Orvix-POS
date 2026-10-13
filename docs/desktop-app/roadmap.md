# Desktop app — roadmap

Release checklist and proposal for the items below (2026-10-13, not yet approved): [`../selfhost-migration/next-phase/electron-1.0.16-canary.md`](../selfhost-migration/next-phase/electron-1.0.16-canary.md). It records three findings that change this plan: the rollback build must come from the v1.0.15 code (the 1.0.16 client always sends `p_idempotency_key`, which hosted lacks); the local Dexie DB is version 2 on 1.0.16 and version 1 on 1.0.15; rollback tier B needs re-planning.

**Consolidated order of work (2026-10-13):** [`../selfhost-migration/next-phase/release-checklist.md`](../selfhost-migration/next-phase/release-checklist.md). Tested compatibility, rollback and emergency procedure: [`../selfhost-migration/phase-g/release-compatibility.md`](../selfhost-migration/phase-g/release-compatibility.md). Deployment guards before the first push: [`../selfhost-migration/phase-g/deployment-automation-audit.md`](../selfhost-migration/phase-g/deployment-automation-audit.md). Correction to the above: v1.0.15 does **not** hit a VersionError on the 1.0.16 database (Dexie 4 reopens it); it instead deletes every pending outbox entry on its first online load, so the rollback build needs the A8 fix + a pending-queue guard, and pushing the branch already triggers a Vercel Preview.

- [x] **2026-10-12** Branch with idempotency, offline queue, offline auth, realtime reconciliation, login/setup hardening, org-isolation compatibility; E2E 25/25.
- [ ] Owner approves push + PR of `feature/selfhost-supabase-migration` (via `Lucas1792003`, no direct push to `main`).
- [ ] Bump to 1.0.16; build Windows + macOS with `build:electron` (host-pinned); prepare a `v1.0.17-rollback` build pointing at hosted.
- [ ] Publish 1.0.16 as a GitHub **pre-release** (owner approval) → install on one canary till → overnight validation.
- [ ] Promote to full release → tills auto-update → first trading day watched (gates G11–G13).
- [ ] Decide on code signing.
