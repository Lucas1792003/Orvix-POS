# Desktop app — risks

- **Client/server coupling.** v1.0.15 sends no idempotency key → every mutating call fails against lucashome (062+). The branch client needs migration 076 for `/setup`. Order: server migrations first, then the new build.
- **Unsigned installers.** Windows SmartScreen warnings on manual install; macOS ad-hoc signature (Squirrel.Mac auto-update expected not to work). Decision: buy signing certificates or accept.
- **Version not bumped** — still 1.0.15 on the branch; must be 1.0.16 before publishing, or tills will not see it as an update.
- **Canary mechanism unproven** — `electron-updater` ignoring GitHub pre-releases is assumed, not tested.
- **`npm run build` (web) still uses `.env.local` → hosted**; only `build:electron` is host-pinned. The Vercel web build (Hobby plan) still points at hosted; usage unknown.
- **Whole-repo lint** reports 24 pre-existing errors in `src/lib/zawgyi.ts` (untouched).
- **E2E duplicate-sale heuristic** can flag two legitimate sales < 2 s apart (seen once 2026-10-12); left strict on purpose.

## Found 2026-10-13 (next-phase proposals) — must be resolved before rollout
- **Planned rollback build cannot work as designed.** The branch client sends `p_idempotency_key` on every mutating RPC; hosted (schema 061) does not accept it, so "1.0.16 code pointed at hosted" fails on the first sale. Rollback must be the v1.0.15 code renumbered as a plain `1.0.17` (a suffix makes tills follow pre-releases). See [`../selfhost-migration/next-phase/electron-1.0.16-canary.md`](../selfhost-migration/next-phase/electron-1.0.16-canary.md).
- **Downgrade hits the till's local database version** (1.0.16 bumps Dexie schema; v1.0.15 cannot open it): needs a small code change in the rollback build or clearing app data; a till can only roll back with an empty sync queue.
- **"After real sales" rollback (tier B in `08-cutover-rollback.md`) is obsolete** — it assumed identical schemas on hosted and lucashome, untrue since 062. Re-plan before full rollout.
- **Merging to `main` deploys web builds**: `.github/workflows/deploy.yml` publishes GitHub Pages on push to `main` (no Supabase settings); if Vercel auto-deploys `main`, the new client goes live against hosted and fails. Decide before merging.
- **Phone upload fails after 60 s** with the current client — see [`../lucashome-selfhost/risks.md`](../lucashome-selfhost/risks.md).

## Found 2026-10-13 — repository visibility and deploy triggers (release blocker)
- **The GitHub repo `Lucas1792003/ShwePhaLa` is PUBLIC** (`gh api repos/...` → `visibility: public`, checked 2026-10-13). The local feature branch contains ~60 files naming the tailnet host, its IP, server paths, access procedures and the owner's email (ops docs, evidence, deploy tooling, live tests). **Do not push the branch while the repo is public**: either make the repo private first (owner, GitHub settings) or restructure the branch so ops/evidence material stays out of git. Public `main` today only carries the hosted project ref (also embedded in the shipped app).
- **Vercel auto-deploys every push**: `main` → public production domain built against hosted; other branches → previews. Merging would put the 1.0.16 client in front of hosted. Details and a safe push/PR/merge order: [`../selfhost-migration/phase-g/deployment-automation-audit.md`](../selfhost-migration/phase-g/deployment-automation-audit.md).
- **Rollback to v1.0.15 code deletes pending sales** on a till's first online load (known A8 bug, confirmed in Electron 2026-10-13); Dexie does not block the downgrade. Forward-fix only after the first real sale. See [`../selfhost-migration/phase-g/release-compatibility.md`](../selfhost-migration/phase-g/release-compatibility.md).
- The tailnet hostname will become public in any published 1.0.16 installer (the app must embed it); access remains tailnet-only.
