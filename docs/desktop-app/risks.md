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
