# Desktop app — status

| Item | State | How verified |
|---|---|---|
| Latest **published** release | v1.0.15 (2026-08-26), points at **hosted** | `gh release view`, 2026-10-11 |
| Tills | not yet using the app for trading (pre-production); no Tailscale on tills | owner, 2026-10-12 |
| Code | branch `feature/selfhost-supabase-migration`, 8 local commits on top of `main` `ac2d663`, not pushed | `git log main..HEAD`, 2026-10-12 |
| Local builds (unpublished) | version still 1.0.15, built 2026-10-12 with `npm run build:electron` (host-pinned to `lucashome.tail8a86e4.ts.net`): macOS arm64 DMG + zip, Windows x64 NSIS installer in `release/` (git-ignored). Unsigned (macOS ad-hoc) | packaged-app smoke launch: boots packaged, shows "Backend: lucashome…", 0 hosted requests |
| Tests on the branch | `tsc -b` clean; 741 unit tests; Electron E2E 25/25 against lucashome; live two-org suite 12/12 | 2026-10-12 |
| Backend selection | build refuses to start or build when the URL host ≠ `VITE_SUPABASE_EXPECTED_HOST`; backend host shown on login page and sidebar | negative build test with the hosted URL, 2026-10-12 |
