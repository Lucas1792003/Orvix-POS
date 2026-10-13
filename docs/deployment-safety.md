# Deployment safety

What in this repository can build or publish something, the guards that stop
an unintended deployment, the settings the repository owner must check in the
Vercel and GitHub dashboards, and the order in which to push, review, merge and
release.

Repository configuration is only half of the picture. Hosting and CI settings
live in the dashboards, and some of them apply before any file in the repo is
read. Do the dashboard checklist **before** pushing a branch.

## 1. What can deploy

| Path | Trigger | State in this repository |
|---|---|---|
| GitHub Pages (`.github/workflows/deploy.yml`) | push to `main` | **Removed.** No workflow files remain. GitHub Pages must also be turned off in the repository settings (§3.2): a Pages site configured to "Deploy from a branch" publishes without any workflow. |
| Vercel Git integration | every push to any branch (Preview) and to the production branch (Production), if the project is connected | **Disabled in repo config**: `vercel.json` sets `"git": { "deploymentEnabled": false }`. See §2 for the limits of that setting. |
| Vercel manual deploy (dashboard "Redeploy", Vercel CLI, deploy hooks) | a person or a hook URL | Not controlled by `vercel.json`'s `git` settings. The build guard (§2.2) still applies. |
| Desktop app releases (`electron-builder`, `publish.provider = github`) | someone running `electron-builder` with a GitHub token and publishing | Manual. Installed tills auto-update from the published GitHub releases, so publishing a release **is** a production deployment. |

## 2. Guards in the repository

### 2.1 `vercel.json` → `git.deploymentEnabled: false`

Documented by Vercel ([Git configuration](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled)):
with the value `false`, commits do not trigger automatic deployments, for all
branches. The value can also be an object of branch globs, e.g.
`{ "main": false, "internal-*": false }`; a branch matching several rules
deploys if any matching rule is `true`.

Limits, read before relying on it:

- **It is read from the commit being deployed.** A branch whose head commit
  does not contain this setting (for example any branch created from an older
  `main`, or an existing remote branch) still deploys automatically.
- **First push of a branch containing the change.** Vercel builds from the
  pushed commit, so the setting in that commit is the one evaluated; every
  commit on the publication branch contains it, so the first push is expected
  **not** to create a deployment. Vercel's documentation does not spell out
  this first-push case explicitly, so treat it as expected, not guaranteed:
  set the Ignored Build Step (§3.1) before the first push and check the
  project's Deployments list right after it.
- **After merge to `main` there are no automatic production deployments.**
  Web releases then need a deliberate deploy (dashboard or CLI). If automatic
  production deploys are wanted again later, use a per-branch object instead
  of `false`.
- **It does not cover** manual deploys, the CLI, deploy hooks, or the
  dashboard's Redeploy button, and it does not delete or unpublish existing
  deployments.
- Dashboard settings are separate: disconnecting the Git repository or the
  Ignored Build Step act independently of the file and are the owner's
  stronger controls.

### 2.2 Fail-closed production build (`vite.config.ts`)

Every `vite build` — `npm run build` (web) and `npm run build:electron`
(desktop), in any `--mode` — refuses to produce a bundle unless:

1. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set and the URL is a
   valid http(s) URL, and
2. `VITE_SUPABASE_EXPECTED_HOST` is set, and
3. the host (and port, if any) of `VITE_SUPABASE_URL` equals
   `VITE_SUPABASE_EXPECTED_HOST` exactly (case-insensitive).

No script or config file contains a default for the expected host; it comes
from the build environment. Consequence: a hosting project that only has
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` configured **fails the build**
instead of publishing. Do not add `VITE_SUPABASE_EXPECTED_HOST` to a hosting
environment until a deployment of that environment is intended and the URL
next to it has been reviewed.

The running app repeats the check at startup (`src/lib/backendConfig.ts`,
`src/lib/supabase.ts`) and shows the backend host in the login and sidebar
footers.

Check locally:

```sh
# passes the guard (dummy values)
VITE_SUPABASE_URL=https://example.invalid VITE_SUPABASE_ANON_KEY=dummy \
VITE_SUPABASE_EXPECTED_HOST=example.invalid npm run build

# fails: host mismatch
VITE_SUPABASE_URL=https://example.invalid VITE_SUPABASE_ANON_KEY=dummy \
VITE_SUPABASE_EXPECTED_HOST=other.invalid npm run build

# fails: no pin
VITE_SUPABASE_URL=https://example.invalid VITE_SUPABASE_ANON_KEY=dummy npm run build
```

A local `.env.local` is read by `vite build` too; unset or rename it when
running these checks. See [`.env.example`](../.env.example).

### 2.3 Tests that touch a live stack need explicit configuration

The live (`src/live/`) and Electron end-to-end (`e2e/`) suites run only when
their URL variables are set, refuse any `*.supabase.co` URL, and require the
ssh host and compose directory of the stack under test
(`LIVE_SSH_HOST`/`LIVE_STACK_DIR`, `E2E_SSH_HOST`/`E2E_STACK_DIR`) with no
defaults.

## 3. Owner checklist (dashboards)

Do these in the dashboards **before** pushing the branch. None of them can be
done from the repository.

### 3.1 Vercel (project settings)

- [ ] **Git**: confirm which repository is connected. If the web build is not
      being deployed at the moment, disconnecting the Git repository is the
      strongest control.
- [ ] **Build and Deployment → Ignored Build Step**: set "Don't build
      anything" (or a custom command that exits 0) while automatic deploys
      are not wanted. Note: per Vercel's docs this cancels the build after it
      starts and still counts toward deployment quotas.
- [ ] **Environments → Production branch**: confirm it is `main`.
- [ ] **Preview deployments**: confirm whether previews are wanted at all;
      enable Deployment Protection (Vercel Authentication) on previews.
- [ ] **Environment Variables**, per environment (Production, Preview,
      Development): check what `VITE_SUPABASE_URL` points at in each, that no
      service-role key is in any `VITE_*` variable, and that
      `VITE_SUPABASE_EXPECTED_HOST` is **absent** unless a deployment of that
      environment is intended (§2.2).
- [ ] **Deploy hooks**: list them; delete any that are not needed.
- [ ] **Security → Git Fork Protection**: on.
- [ ] After the first push: open Deployments and confirm nothing was created
      for the pushed branch.

### 3.2 GitHub (repository settings)

- [ ] **Pages**: unpublish the site and set the source to none. Removing the
      workflow does not take down an already-published Pages site.
- [ ] **Actions**: confirm no other workflow runs on push (this branch has
      none); consider restricting Actions permissions.
- [ ] **Branch protection / rulesets on `main`**: require a pull request,
      block force pushes and deletions.
- [ ] **Releases**: decide who may publish; tills auto-update from published
      releases. Keep release tokens out of the repository.
- [ ] **Secrets and variables**: review; nothing in this repository needs a
      repository secret.

## 4. Safe order: push → PR → merge → release

1. Owner completes §3 (at minimum: Vercel Ignored Build Step or Git
   disconnected, GitHub Pages off).
2. Push the publication branch from the owner's account.
3. Verify: no Vercel deployment for the branch, no GitHub Actions run.
4. Open the pull request; review the full diff and every commit (not only the
   final tree) for private material.
5. Merge. Verify again that nothing deployed (the merge commit carries the
   same `vercel.json`).
6. Database migrations are applied to a backend separately and only with the
   owner's approval; the application expects the server migrations first.
7. Web deploy (if wanted): set the environment's three `VITE_*` variables
   (§2.2), then deploy deliberately and check the backend host in the login
   footer.
8. Desktop release: build with the three variables set in the build shell,
   publish as a GitHub **pre-release** first, validate on one till, then
   promote.
