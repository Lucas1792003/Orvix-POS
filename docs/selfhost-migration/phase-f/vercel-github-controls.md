# Phase F — Vercel and GitHub deployment controls (owner dashboard steps)

Status: prepared 2026-10-13. Nothing in Vercel or GitHub was changed by the engineer. Sources: [deployment audit](../phase-g/deployment-automation-audit.md), Vercel docs (retrieved 2026-10-13): git configuration https://vercel.com/docs/project-configuration/git-configuration, project settings https://vercel.com/docs/project-configuration/project-settings, git settings https://vercel.com/docs/project-configuration/git-settings, Hobby plan https://vercel.com/docs/plans/hobby, fair use https://vercel.com/docs/limits/fair-use-guidelines.

## Why
- Vercel's GitHub App builds on every push: `main` → public Production (`shwe-pha-la.vercel.app`, bundle points at hosted), other branches → Preview. A repo workflow change does not control this integration.
- `vercel.json` `"git": {"deploymentEnabled": false}` on the publication branch stops automatic Production and Preview builds for any commit that carries it, but only once that commit is the one Vercel reads; the first push of a branch without it would still build. The dashboard step is the real control.
- **$0 rule:** Vercel Hobby is restricted to non-commercial personal use; a shop POS is commercial (financial gain / processing payment). Pro is $20/user/month. Recommendation: stop using Vercel for the POS (option A below), not upgrade.

## Option A (recommended) — disconnect the repository
1. Sign in to vercel.com with the account that owns the project (team shown in the audit).
2. Open the project **shwe-pha-la** → **Settings** → **Git**.
3. Note the **Production Branch** and the connected repository (screenshot for the record).
4. Under **Connected Git Repository** click **Disconnect** and confirm.
5. Settings → **Environment Variables**: record names × environments × backend *host only* (do not copy values). Optionally delete the hosted URL/anon key variables once the site is retired.
6. Decide the existing production site: leave the old (hosted) build serving until hosted is retired, or **Deployments → … → Delete** / delete the project (Settings → General → Delete Project). Deleting is irreversible; keep the old site if unsure.

## Option B — keep the project but build nothing
1. Project → **Settings** → **Build and Deployment** → **Ignored Build Step** → choose **"Don't build anything"** → Save.
2. Note: every push still creates a cancelled deployment that counts toward quotas, and the Hobby commercial-use restriction still applies to the live site.

## Verify (engineer, read-only, after the owner finishes and before any push)
```bash
gh api 'repos/Lucas1792003/ShwePhaLa/deployments?per_page=5' --jq '.[]|[.environment,.ref,.created_at]|@tsv'
```
After the first approved push: no new `Preview`/`Production` row for the pushed sha.

## GitHub Pages
- Workflow `.github/workflows/deploy.yml` is **absent** on `publish/selfhost-support` (deleted in its first commit; `git ls-tree` of `.github` on that branch is empty — verified 2026-10-13). It still exists on `main` and runs on every push to `main` until the publication branch is merged.
- Owner dashboard (optional, immediate): GitHub → repo → **Actions** → "Deploy to GitHub Pages" → **…** → **Disable workflow**; and **Settings → Pages** → unpublish. Pages also prohibits commercial transactions, so it is not a $0 substitute for Vercel.
- Recommended: **Settings → Rules → Rulesets** (or Branches) for `main`: require a pull request, block force-push and deletion.

## Do not
- Merge to `main`, push, or change any of these settings without a fresh owner go.
