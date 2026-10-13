# Deployment automation audit — what a push, PR, merge or release triggers

Status: **audit, 2026-10-13 (UTC)**. Read-only: repo files, read-only `gh api` GETs (authenticated as `Lucas1792003`, the repo owner), unauthenticated `curl` of the public web deployments. Nothing was changed in GitHub, Vercel or the repo's workflow files. Code changes below are **proposals only**.

Related: [release compatibility](release-compatibility.md) (why a new client against hosted must never ship) · [release checklist](../next-phase/release-checklist.md) · [canary R4](../next-phase/electron-1.0.16-canary.md#r4-push-pr-merge-as-lucas1792003-owner-approval-for-each).

## Summary

| Trigger | What runs today | Backend of the result | Public? |
|---|---|---|---|
| Push to any **non-main** branch (incl. `feature/selfhost-supabase-migration`) | **Vercel Preview deployment** (Vercel GitHub App) | Vercel *Preview* env vars — not visible to us; most likely hosted | Deployment URL behind Vercel Authentication (302 → `vercel.com/sso-api`) |
| Open / update a PR | Same Vercel Preview (per push); no GitHub Actions workflow runs on PRs | same | same |
| Push / merge to **`main`** | (1) **Vercel Production deployment** → `https://shwe-pha-la.vercel.app`; (2) **GitHub Actions "Deploy to GitHub Pages"** → `https://lucas1792003.github.io/ShwePhaLa/` | (1) **hosted** (`gzqiukxnzfdouwaotelx.supabase.co` is in today's bundle); (2) none (no env in CI) | **Both public** |
| Tag push | nothing | — | — |
| Desktop release | nothing automated; built and published by hand from the Mac (`electron-builder`, GitHub Releases) | whatever `VITE_SUPABASE_URL` the build machine has; `build:electron` pins lucashome | GitHub release assets are public |

**Merging the branch today would publish the 1.0.16 web client on the public Vercel production domain against hosted** — every sale/stock/payment call fails (`PGRST202`, [compatibility §3](release-compatibility.md#3-c-new-client--hosted--fails-closed-tested-no-hosted-contact)), while logins and catalogue table writes would reach hosted. **Pushing the branch** creates a Vercel Preview of the same client (not public, but it builds and runs against the Preview env). Both must be guarded before the first push.

## 1. GitHub Actions

Exactly one workflow: [`.github/workflows/deploy.yml`](../../../.github/workflows/deploy.yml) ("Deploy to GitHub Pages", id 280674259, state **active**).

| Item | Value |
|---|---|
| Triggers | `push` to `main` only. No `pull_request`, no tags, no `workflow_dispatch`, no schedule |
| Jobs | `build`: checkout → Node 20 → `npm ci` → `npm run build` (= `tsc -b && vite build`, **not** host-pinned) → upload `dist` as Pages artifact. `deploy`: `actions/deploy-pages@v4` to environment `github-pages` |
| Env / secrets | **none**: no `VITE_SUPABASE_*` in the workflow; repo has **0 Actions secrets, 0 variables** (`/actions/secrets`, `/actions/variables`) |
| Permissions | `contents: read`, `pages: write`, `id-token: write` |
| Environment | `github-pages`, deployment branch policy: `main` only, admins can bypass |
| History | ran successfully on each of the last 8 pushes to `main` (latest `ac2d663`, 2026-08-27) |
| Pages config | `build_type: workflow`, public, `https://lucas1792003.github.io/ShwePhaLa/` |
| What the live Pages site does | **Broken today**: `index.html` loads `/assets/index-….js` (404 at the domain root; the file exists only under `/ShwePhaLa/assets/`) and that bundle contains no backend URL. After a merge it would again be a no-env bundle → "The app cannot start" if it loaded at all. Harmless for data, but a public, pointless deployment of every `main` commit |

## 2. Vercel

No `.vercel/` directory, no Vercel CLI on the Mac (`vercel` not found), no repo webhooks (`/hooks` = `[]`). The connection is the **Vercel GitHub App**: deployments are created by `vercel[bot]` in GitHub environments `Production` (since 2026-05-21) and `Preview` (since 2026-06-15). [`vercel.json`](../../../vercel.json) only has the SPA rewrite.

| Finding | Evidence |
|---|---|
| Every push to `main` deploys to **Production** | 8/8 recent `main` pushes have a `Production` deployment by `vercel[bot]` ~15 s before the Pages deployment (`/deployments`) |
| Pushes to other branches create **Preview** deployments | `add-framer-motion` (`e8495bf`, `540c10b`, 2026-06-15) → `Preview` deployments |
| Production domain | `https://shwe-pha-la.vercel.app` (repo `homepage`), HTTP 200, public, serves `main` |
| Backend of production | its JS bundle contains `https://gzqiukxnzfdouwaotelx.supabase.co` (1 occurrence; host only checked, key not read) → Production env `VITE_SUPABASE_URL` = **hosted** |
| Deployment Protection | per-deployment URLs (`shwe-pha-<hash>-lucas-projects-b2b3c005.vercel.app`) answer **302 → vercel.com/sso-api** (Vercel Authentication); the 2026-06-15 preview URL answers 410 (removed). Previews are therefore **not public**, the production domain is |
| Build command | not set in `vercel.json` → Vercel default for Vite = `npm run build` (unpinned web build; with a hosted URL it builds fine — [compatibility §3.1](release-compatibility.md#3-c-new-client--hosted--fails-closed-tested-no-hosted-contact)) |
| Preview env vars, production branch setting, "Ignored Build Step", who uses the site | **UNKNOWN** — owner must look (§5) |

The hosted URL and anon key therefore live in **Vercel project environment variables** (Production, probably Preview) and in the deployed bundles; not in the repo (`.env.local` is git-ignored and was never read here) and not in GitHub secrets.

## 3. Other repo settings relevant to a release

| Setting | Value |
|---|---|
| Visibility | **public** repo; secret scanning + push protection enabled |
| Branch protection on `main` | **none** (`/branches/main/protection` → 404 "Branch not protected"), no rulesets. A `git push origin main` would deploy immediately |
| Merge methods | merge, squash, rebase all allowed; auto-merge off; branches not deleted on merge |
| Open PRs | none; branches: `main`, `add-framer-motion` |
| Releases | latest = **v1.0.15** (12 assets); v1.0.7–v1.0.11 drafts exist |
| `package.json` `build.publish` | `github` provider, `Lucas1792003/ShwePhaLa`. `electron:build*` scripts do **not** pass `--publish never`; with `GH_TOKEN` set, electron-builder may create a draft release itself ([canary R5](../next-phase/electron-1.0.16-canary.md#r5-build-mac-windows-x64--macos-arm64-never-published-from-here)) |

## 4. Proposed code changes (drafts — not applied; commit on the branch **before** the first push)

**4.1 Stop Vercel from building this branch and `main`** — Vercel reads `vercel.json` from the commit it is asked to deploy, so this takes effect on the very push that carries it:
```json
{
  "git": {
    "deploymentEnabled": {
      "main": false,
      "feature/selfhost-supabase-migration": false
    }
  },
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```
(Use `"deploymentEnabled": false` to stop all branches.) This is belt-and-braces: the owner should still pause or disconnect the project in the dashboard (§5 V1), because a dashboard "Redeploy" ignores the branch filter.

**4.2 Make the web build refuse an unpinned production build** — in `vite.config.ts`, for `command === "build"` and `mode === "production"`, throw unless `VITE_SUPABASE_EXPECTED_HOST` is set (the Electron build already sets it; a web host would have to set it as an env var naming the intended backend). Effect: Vercel/Pages builds fail instead of shipping a hosted-pointed or env-less bundle. (Today the only valid backend, lucashome, is tailnet-only, so a public web deployment has no working backend anyway; the owner decides whether the web app continues at all.)

**4.3 GitHub Pages workflow** — disable or make it manual. Minimal diff:
```yaml
on:
  workflow_dispatch:      # was: push: branches: [main]
```
or delete the file (the Pages site is broken and unused). Owner alternative without a commit: Actions → "Deploy to GitHub Pages" → "Disable workflow", and Settings → Pages → unpublish.

**4.4 Release builds** — add `"electron:release:win": "npm run build:electron && electron-builder --win --x64 --publish never"` (and `:mac`) so the documented command is the only one, and never export `GH_TOKEN` in the build shell.

## 5. Owner dashboard checks and actions (cannot be done from code or read-only API)

| # | Where | Action | Done when |
|---|---|---|---|
| V1 | Vercel → project (team `lucas-projects-b2b3c005`) → Settings → Git | Note **Production Branch** (expect `main`), "Ignored Build Step", and whether the GitHub repo is connected. Then either **Disconnect** the repo or set Ignored Build Step to `exit 0` (skip all builds) for the release period | screenshot / note |
| V2 | Vercel → Settings → Environment Variables | Record which environments (Production / Preview / Development) define `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` and which host each URL names (host only). Expect hosted for Production. Do not paste values anywhere | list of names × environments × host |
| V3 | Vercel → Settings → Deployment Protection | Confirm Vercel Authentication covers **Preview** (observed: per-deployment URLs redirect to SSO) and note whether "Protection Bypass for Automation" or shareable links exist | note |
| V4 | Vercel → Analytics / Logs | Does anyone use `shwe-pha-la.vercel.app`? Decide: keep it on hosted until G14 (old client, unchanged), or take it down | decision |
| G1 | GitHub → Actions → Deploy to GitHub Pages | Disable the workflow (or merge 4.3) | workflow state `disabled_manually` |
| G2 | GitHub → Settings → Pages | Unpublish (site is broken anyway) | Pages off |
| G3 | GitHub → Settings → Branches | Add a protection rule / ruleset for `main`: require a PR, block force-push and deletion (owner may allow admin bypass) | `/branches/main/protection` returns 200 |

## 6. Safe push → PR → merge → release procedure

Each step needs the owner's explicit approval at the time (standing rule); all git/GitHub actions as `Lucas1792003`; never `git push origin main`; no Claude co-author or "Generated with" lines.

| # | Step | Who | Gate / evidence |
|---|---|---|---|
| S1 | Owner completes V1–V4 and G1–G2 (at least: Vercel builds paused for `main` and the branch; Pages workflow disabled) | **owner (dashboards)** | V1/G1 notes |
| S2 | Commit the guards on the branch: 4.1 (`vercel.json`), 4.3 (Pages `workflow_dispatch`), optionally 4.2 and 4.4 | engineer (code) | diff reviewed by owner |
| S3 | `gh auth status` → active account `Lucas1792003` | engineer | output |
| S4 | **Push the branch** (`git push -u origin feature/selfhost-supabase-migration`) | engineer, after approval | — |
| S5 | Verify nothing deployed: `gh api 'repos/Lucas1792003/ShwePhaLa/deployments?per_page=5' --jq '.[]|[.environment,.ref,.created_at]|@tsv'` shows **no new Preview** for the branch sha; `gh api repos/Lucas1792003/ShwePhaLa/actions/runs?per_page=3` shows **no run** | engineer (read-only) | output in evidence |
| S6 | Open the PR (base `main`); PR body = migrations, gate results, release plan | engineer, after approval | PR URL; S5 check repeated after PR creation |
| S7 | (optional) G3 branch protection | **owner** | — |
| S8 | Merge (owner in the UI, or `gh pr merge --merge` after approval) | owner / engineer | — |
| S9 | Verify after merge: no new `Production` deployment for the merge sha; no Pages run; `curl -s https://shwe-pha-la.vercel.app/ …` still serves the **old** bundle (hosted, old client) | engineer (read-only) | output |
| S10 | Desktop release per [canary R5–R9](../next-phase/electron-1.0.16-canary.md): build from the merge commit with `build:electron` (pinned) and `--publish never`; asset grep (lucashome ≥ 1, hosted ref 0); publish as **pre-release**; `releases/latest` still v1.0.15 | engineer + owner approval | canary evidence |
| S11 | After G14 (hosted retired): decide the web app's future (take Vercel down, or re-point it at a reachable backend with 4.2's pin). Re-enable nothing automatically | owner | decision |

If S5 or S9 shows an unexpected deployment: owner deletes/disables it in Vercel immediately (Deployments → … → Delete, or promote the previous production deployment back with "Instant Rollback"); the engineer records which sha and backend it used.
