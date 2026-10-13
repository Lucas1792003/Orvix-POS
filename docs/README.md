# Shwe Phala POS Documentation

Shwe Phala POS is a multi-shop POS + inventory system. React 19 +
TypeScript + Vite on top of **Supabase Auth + PostgreSQL**. RLS is on;
critical operational writes go through `SECURITY DEFINER` RPCs;
business data lives in Supabase, not localStorage. Admin sign-in adds a
second factor (authenticator app or emailed code), the UI is fully
English/Myanmar, the business brand (name + logo) is admin-editable, and
the complete app supports System / Light / Dark themes. The latest published
desktop release is **v1.0.15** (2026-08-26, points at hosted Supabase); the
backend is being moved to a self-hosted Supabase stack on `lucashome` — see
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

## Environments (ops record)

What is live where, how to reach it, what broke, what is open. Each folder has `README.md`, `status.md`, `access.md` (where applicable), `incidents.md`, `risks.md`, `roadmap.md`.

| Folder | Environment | Start with |
|---|---|---|
| [`lucashome-selfhost/`](lucashome-selfhost/) | Self-hosted Supabase on the home server `lucashome` (`https://lucashome.tail8a86e4.ts.net`, tailnet only). Target backend; schema 073 since 2026-10-12 | [`status.md`](lucashome-selfhost/status.md) |
| [`hosted-supabase/`](hosted-supabase/) | Hosted Supabase project `shwephala` (Free plan, Singapore). Original backend; frozen read-only fallback | [`status.md`](hosted-supabase/status.md) |
| [`desktop-app/`](desktop-app/) | The Electron POS app: builds, releases, which backend each build talks to, tills | [`status.md`](desktop-app/status.md) |
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
  `phone-upload-token`, `platform-console`). `rotate-audit-log` and
  `weekly-sales-report` were removed on 2026-10-13.

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
