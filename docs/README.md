# Shwe Phala POS Documentation

Shwe Phala POS is a multi-shop POS + inventory system. React 19 +
TypeScript + Vite on top of **Supabase Auth + PostgreSQL**. RLS is on;
critical operational writes go through `SECURITY DEFINER` RPCs;
business data lives in Supabase, not localStorage. Admin sign-in adds a
second factor (authenticator app or emailed code), the UI is fully
English/Myanmar, the business brand (name + logo) is admin-editable, and
the complete app supports System / Light / Dark themes. The latest published
desktop release is **v1.0.15** (2026-08-26, points at hosted Supabase); the
backend is being moved to a self-hosted Supabase stack on `lucashome`
(**2026-10-16:** server at schema 085, 1.0.16 not built, no real sales yet;
remaining blockers in the
[production-readiness checklist](./selfhost-migration/phase-f/production-readiness-checklist.md);
**2026-10-19:** recovery migrations 086 and 087 are committed on branch `g1/batch-2a` and the v87 till client that
goes with 087 is implemented locally (uncommitted) — all verified only on disposable test stacks, nothing applied
to `lucashome`) — see
[Environments](#environments-ops-record) below and
[`selfhost-migration/`](./selfhost-migration/MIGRATION-PLAN.md). Document 10
covers the Windows updater history and stuck-installer recovery.

This folder holds two kinds of docs: **engineering reference** (the numbered
guides, `archive/`, `selfhost-migration/`) and the **ops record** (one folder
per environment, structured like `~/Projects/work/docs`).

## Quick Start

```bash
npm install
npm run dev
```

`.env.local`:

```bash
VITE_SUPABASE_URL=<your-project-url>
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

Full setup, env, Supabase, and deployment notes:
[07-setup-deployment.md](./07-setup-deployment.md).

## Documentation Map

| # | Doc | Read this when |
| --- | --- | --- |
| 01 | [Overview](./01-overview.md) | New to the project. |
| 02 | [Architecture](./02-architecture.md) | Building / reviewing app code, stores, error handling, routing. |
| 03 | [Database & Security](./03-database-security.md) | Touching SQL, RPCs, RLS, migrations, audit. |
| 04 | [Features & Workflows](./04-features-workflows.md) | Working on POS, shifts, inventory, purchases, transfers, refunds, suppliers, catalog, pricing. |
| 05 | [Roles & Permissions](./05-roles-permissions.md) | Adding gates, debugging "why can't role X do Y". |
| 06 | [UI, Printing & Hardware](./06-ui-printing-hardware.md) | Responsive layout, receipt + label printing, scanners, image upload + storage. |
| 07 | [Setup & Deployment](./07-setup-deployment.md) | Onboarding a new env / Vercel deploy / Supabase setup. |
| 08 | [Testing & QA](./08-testing-qa.md) | Verifying a change end-to-end before shipping. |
| 09 | [Roadmap & TODO](./09-roadmap-todo.md) | Picking up open work; tracking what's still outstanding. |
| 10 | [Offline-First & Desktop — Known Issues & TODO](./10-offline-desktop-known-issues.md) | Touching the sync outbox, local cache, or the Electron wrapper; before trusting offline mode in production. |
| — | [Self-host migration](./selfhost-migration/MIGRATION-PLAN.md) | The hosted → `lucashome` migration: audit, risk register, runbook, gates, per-phase evidence. |
| — | [Production-readiness checklist](./selfhost-migration/phase-f/production-readiness-checklist.md) | **Start here for what is left** before real trading on the self-hosted backend (owner/state/evidence per item). |
| — | Phase F design notes ([`selfhost-migration/phase-f/`](./selfhost-migration/phase-f/)) | Security: [org-isolation audit](./selfhost-migration/phase-f/org-isolation-security-audit.md), [082](./selfhost-migration/phase-f/migration-082.md), [083 (G5)](./selfhost-migration/phase-f/migration-083-g5.md), [085 (PNG)](./selfhost-migration/phase-f/migration-085-png.md), [G5 follow-ups / 084](./selfhost-migration/phase-f/g5-followups.md), [till readiness for 084](./selfhost-migration/phase-f/till-readiness-084.md), [staff creation](./selfhost-migration/phase-f/staff-creation.md), [phone QR origin](./selfhost-migration/phase-f/phone-qr-origin.md), [rate limiting](./selfhost-migration/phase-f/rate-limiting.md), [Studio isolation](./selfhost-migration/phase-f/studio-isolation.md). Backups: [disaster recovery assessment (2026-10-18)](./selfhost-migration/phase-g/disaster-recovery.md), [email tier](./selfhost-migration/phase-f/email-backup-design.md), [restore from email](./selfhost-migration/phase-f/restore-from-email.md), [owner setup](./selfhost-migration/phase-f/owner-setup-checklist.md), [owner key](./selfhost-migration/phase-f/owner-recovery-key.md). Host/access: [remote access](./selfhost-migration/phase-f/remote-access-architecture.md), [free-tier compliance](./selfhost-migration/phase-f/free-tier-compliance.md), [WireGuard](./selfhost-migration/phase-f/wireguard-feasibility.md), [staged hardening](./selfhost-migration/phase-f/host-hardening-staged.md), [reboot](./selfhost-migration/phase-f/host-reboot-hardening.md), [cost](./selfhost-migration/phase-f/cost-research.md), [Vercel/GitHub](./selfhost-migration/phase-f/vercel-github-controls.md). App/data: [app bug fixes](./selfhost-migration/phase-f/app-bugfixes.md), [Electron compatibility](./selfhost-migration/phase-f/electron-compatibility.md), [queue export](./selfhost-migration/phase-f/queue-export.md), [QA inventory](./selfhost-migration/phase-f/qa-data-inventory.md), [QA cleanup](./selfhost-migration/phase-f/qa-cleanup-manifest.md). |

| — | Phase G recovery (restore safety): [086 operation outcomes](./selfhost-migration/phase-g/migration-086.md), [087 recovery hold and rollback detection](./selfhost-migration/phase-g/migration-087.md), [v87 till client](./selfhost-migration/phase-g/v87-client.md), [disaster-recovery assessment](./selfhost-migration/phase-g/disaster-recovery.md) | Anything that touches restores, the operation ledger, recovery holds, the witness authority or how a till behaves during a server recovery. **None of it is applied to `lucashome` yet.** |

## Environments (ops record)

What is live where, how to reach it, what broke, what is open. Each folder has `README.md`, `status.md`, `access.md` (where applicable), `incidents.md`, `risks.md`, `roadmap.md`.

| Folder | Environment | Start with |
|---|---|---|
| [`lucashome-selfhost/`](lucashome-selfhost/) | Self-hosted Supabase on the home server `lucashome` (`https://lucashome.tail8a86e4.ts.net`, tailnet only). Target backend; schema **085** since 2026-10-16 (084 held back), 6 edge functions, sign-up off, 0 sales, backups on one disk | [`status.md`](lucashome-selfhost/status.md) |
| [`hosted-supabase/`](hosted-supabase/) | Hosted Supabase project `shwephala` (Free plan, Singapore). Original backend; frozen read-only fallback | [`status.md`](hosted-supabase/status.md) |
| [`desktop-app/`](desktop-app/) | The Electron POS app: builds, releases, which backend each build talks to, tills. Published v1.0.15 (hosted); 1.0.16 not built; canary pending | [`status.md`](desktop-app/status.md) |
| [`runbooks/`](runbooks/) | Reusable procedures (apply migrations, tests, QA cleanup, backups) — pointers to the scripts | [`runbooks/README.md`](runbooks/README.md) |

| File | Purpose |
|---|---|
| `status.md` | What is actually live right now, verified against the machine, not assumed |
| `access.md` | Hosts, accounts, URLs, where each secret lives. **Never a secret value** — names and locations only |
| `incidents.md` | What broke (or nearly broke), root cause, fix, lesson. Newest at the top |
| `risks.md` | Open exposure, known gaps, decisions waiting on the owner |
| `roadmap.md` | Planned and in-flight work, as checkboxes |

Note: these folders are committed with the repo (merged from a local-only `ops-docs/` on 2026-10-12). They contain host names, a tailnet IP and secret *locations*, never secret values; keep it that way.

## How to update the docs (the rule)

Same two-step routing as `~/Projects/work/docs`.

**Step 1 — folder by where the change actually happened:** the stack on `lucashome` → `lucashome-selfhost/`; the hosted project → `hosted-supabase/`; the app as shipped, a build, a release, a till → `desktop-app/`; a repeated procedure → `runbooks/`; how the code/schema works (reference that ships with the code) → the numbered guides or `selfhost-migration/`. Where it was **found** decides, not where it will be fixed; a change spanning two environments is written **once**, with a one-line pointer in the other.

**Step 2 — file by kind of change:** now live/applied/deployed → `status.md` (dated, with how verified); broke and fixed, or a near-miss → `incidents.md`; new exposure or decision waiting on the owner → `risks.md` (resolved = prefix `RESOLVED <date>`, keep it); planned/started/finished/dropped → `roadmap.md` (tick with date and evidence); host/account/URL/key location → `access.md` (never a value); repeated multi-step procedure → `runbooks/<name>.md` + a row in `runbooks/README.md`.

**Writing rules:** date every entry (`YYYY-MM-DD`, UTC) and name the commit/migration/version; record how a claim was checked; supersede rather than overwrite; one file per fact (pointers elsewhere); relative links with real paths; no secrets anywhere — keys live in `/srv/supabase/stack/.env` on `lucashome`, the macOS keychain, or the owner's password manager.

**Standing rules for this project (owner decisions):** every change on `lucashome`, every migration, every push/PR, every release and any action against hosted needs explicit owner approval; never push to `main` directly (feature branch + PR via `Lucas1792003`); no Claude co-author lines; hosted stays unchanged as fallback; production cron jobs and email stay disabled and `rotate-audit-log` is not re-enabled (2026-10-12).

## Code Layout (one-screen orientation)

- **`src/app/`** — layout, sidebar, routes, route guards.
- **`src/components/`** — reusable UI (`ui/`, `pos/`, `receipt/`,
  `sales/`, `shifts/`, `inventory/`, `products/`, `dashboard/`,
  `purchases/`, `suppliers/`, `barcodes/`).
- **`src/features/`** — domain helpers (e.g. `pos/barcodeLookup.ts`,
  `suppliers/debt.ts`, `suppliers/actions.ts`,
  `barcodes/labelTemplates.ts`).
- **`src/pages/`** — page compositions, incl. `SupplierDetailPage` at
  `/app/suppliers/:supplierId`.
- **`src/hooks/`** — `useTranslation`, `useViewportWidth`,
  `useDashboardInsights`, …
- **`src/stores/`** — Zustand stores; domain slices in `stores/data/`.
- **`src/lib/`** — Supabase client (`supabase.ts`), permission registry
  (`permissions.ts`), central error utility (`errors.ts`), formatting
  helpers.
- **`src/i18n/`** — `translations.ts` (English / Myanmar) used by
  `useTranslation`.
- **`supabase/`** — `schema.sql`, ordered `migrations/`, and Edge
  Functions in `functions/` (`email-sales-report`, `admin-2fa`,
  `phone-upload-token`, `phone-upload-page`, `platform-console`,
  `staff-admin`). `rotate-audit-log` and `weekly-sales-report` were removed
  on 2026-10-13.
- **`deploy/lucashome/`** — self-hosted stack config, migration apply,
  backups, router/Envoy helpers; **`tools/security-audit/`** — the
  org-isolation audit; **`e2e/`** — Electron end-to-end suite.

## Where Did The Old Docs Go?

The previous root contained 37+ markdown files including per-migration
test scripts and several overlapping flow docs. They have been moved
unchanged into [`archive/`](./archive/). The compact `01`–`09` docs
above summarize them.

If you need to look up a specific historical detail — a migration test
script, the old phase checklists, the long changelog — see the index:
[`archive/ARCHIVE_MAP.md`](./archive/ARCHIVE_MAP.md).

## Contributing Notes

- Pages stay thin; reusable UI in `src/components`, domain logic in
  `src/features/<feature>/`.
- Use `import type` for type-only imports; avoid re-export shims.
- Permissions come from `src/lib/permissions.ts`; never role-check by
  hand.
- Critical operational writes must go through RPCs and reconcile local
  state only after RPC success.
- Friendly user errors route through `src/lib/errors.ts` —
  `getErrorMessage(err)`. Never put raw Postgres text in a toast.
- For protected operational changes, add the migration first, document
  it in [03-database-security.md](./03-database-security.md), and add /
  refresh the relevant verification section in
  [08-testing-qa.md](./08-testing-qa.md).
