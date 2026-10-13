# Desktop app — risks

- **Client/server coupling.** v1.0.15 sends no idempotency key → every mutating call fails against lucashome (062+). The branch client needs migration 076 for `/setup`. Order: server migrations first, then the new build.
- **Unsigned installers.** Windows SmartScreen warnings on manual install; macOS ad-hoc signature (Squirrel.Mac auto-update expected not to work). Decision: buy signing certificates or accept.
- **Version not bumped** — still 1.0.15 on the branch; must be 1.0.16 before publishing, or tills will not see it as an update.
- **Canary mechanism unproven** — `electron-updater` ignoring GitHub pre-releases is assumed, not tested.
- **`npm run build` (web) still uses `.env.local` → hosted**; only `build:electron` is host-pinned. The Vercel web build (Hobby plan) still points at hosted; usage unknown.
- **Whole-repo lint** reports 24 pre-existing errors in `src/lib/zawgyi.ts` (untouched).
- **E2E duplicate-sale heuristic** can flag two legitimate sales < 2 s apart (seen once 2026-10-12); left strict on purpose.
