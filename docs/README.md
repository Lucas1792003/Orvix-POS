# Shwe Phala POS Documentation

Shwe Phala POS is a multi-shop POS + inventory system. React 19 +
TypeScript + Vite on top of **Supabase Auth + PostgreSQL**. RLS is on;
critical operational writes go through `SECURITY DEFINER` RPCs;
business data lives in Supabase, not localStorage. Admin sign-in adds a
second factor (authenticator app or emailed code), the UI is fully
English/Myanmar, the business brand (name + logo) is admin-editable, and
the complete app supports System / Light / Dark themes. The latest published
desktop release is **v1.0.15**. The backend can run on hosted Supabase or on
a self-hosted Supabase stack; the self-host support work (multi-tenant
isolation, idempotent RPCs, offline authorization, upload security) is
documented under [`selfhost-migration/`](#self-host-support-design-notes)
below. Document 10 covers the Windows updater history and stuck-installer
recovery. Deployment safeguards (which builds can deploy, and the owner's
dashboard checklist) are in [deployment-safety.md](./deployment-safety.md).

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
| — | [Deployment safety](./deployment-safety.md) | Before connecting, changing or triggering any deployment (Vercel, GitHub Pages, releases). |

## Self-host support (design notes)

Engineering notes for the self-host support work. Operational records for
specific environments (hosts, access, backups, live evidence) are kept
outside this public repository.

| Doc | Topic |
|---|---|
| [phase-d/idempotency-contract.md](./selfhost-migration/phase-d/idempotency-contract.md) | Idempotency keys for mutating RPCs (062–063, 074) |
| [phase-d/offline-authorization.md](./selfhost-migration/phase-d/offline-authorization.md) | Offline authorization window design |
| [phase-d/migrations-reconciliation.md](./selfhost-migration/phase-d/migrations-reconciliation.md) | Reconciling the migration history with the production schema |
| [phase-e/offline-authorization-verification.md](./selfhost-migration/phase-e/offline-authorization-verification.md) | Offline authorization verified in the Electron app |
| [phase-e/e2e-results.md](./selfhost-migration/phase-e/e2e-results.md) | Electron end-to-end suite results |
| [phase-g/org-isolation-audit.md](./selfhost-migration/phase-g/org-isolation-audit.md) | Organization isolation (067–073) |
| [phase-g/login-signup-fix.md](./selfhost-migration/phase-g/login-signup-fix.md) | Login never creates accounts; `/setup` first-admin flow; fail-closed backend config |
| [phase-g/remaining-security-fixes.md](./selfhost-migration/phase-g/remaining-security-fixes.md) | Migrations 074–076 |
| [phase-g/upload-security-and-077.md](./selfhost-migration/phase-g/upload-security-and-077.md) | Upload security and new-org price levels (077–079) |
| [phase-g/phone-upload-jit.md](./selfhost-migration/phase-g/phone-upload-jit.md) | Just-in-time phone upload tokens (`phone-upload-token` function) |
| [phase-g/migration-080.md](./selfhost-migration/phase-g/migration-080.md) | Trusted upload completion URL (080) |
| [phase-g/realtime-reconciliation.md](./selfhost-migration/phase-g/realtime-reconciliation.md) | Realtime gap reconciliation |
| [phase-f/rate-limiting.md](./selfhost-migration/phase-f/rate-limiting.md) | Phone-upload rate limits (081, prepared) |
| [phase-f/queue-export.md](./selfhost-migration/phase-f/queue-export.md) | Encrypted Export Pending Transactions and the queue recovery tool |
| [phase-f/phone-qr-origin.md](./selfhost-migration/phase-f/phone-qr-origin.md) | Phone-upload QR for the packaged Electron app (`phone-upload-page` function) |
| [phase-f/staff-creation.md](./selfhost-migration/phase-f/staff-creation.md) | Server-side staff creation (`staff-admin` function); public sign-up off |
| [phase-f/migration-082.md](./selfhost-migration/phase-f/migration-082.md) | Close the "link any auth account" path (082, prepared) |
| [phase-f/electron-compatibility.md](./selfhost-migration/phase-f/electron-compatibility.md) | Electron client × backend compatibility at schema 081 |
| [phase-f/app-bugfixes.md](./selfhost-migration/phase-f/app-bugfixes.md) | Barcode-loss and QR status-polling fixes found by the e2e suite |
| [phase-f/org-isolation-security-audit.md](./selfhost-migration/phase-f/org-isolation-security-audit.md) | Organization-isolation security audit (`tools/security-audit`) |
| [phase-f/migration-083-g5.md](./selfhost-migration/phase-f/migration-083-g5.md) | Product-image upload limits and validated phone completion (083) |
| [phase-f/migration-085-png.md](./selfhost-migration/phase-f/migration-085-png.md) | PNG completion and scoped cleanup of refused uploads (085) |

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
  `phone-upload-token`, `phone-upload-page`, `staff-admin`,
  `platform-console`). `rotate-audit-log` and
  `weekly-sales-report` were removed on 2026-10-13.
- **`tools/security-audit/`** — the organization-isolation security audit;
  **`e2e/`** — Electron end-to-end suite.

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
