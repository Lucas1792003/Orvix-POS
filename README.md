# Orvix POS — Retail POS & Inventory System

A multi-shop Point of Sale and inventory management system for small retail
businesses (alcohol, drinks, FMCG). Built on **Supabase** (Auth + PostgreSQL)
with row-level security and `SECURITY DEFINER` RPCs for all critical writes —
business data lives in the database, not the browser.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite 7
- **Backend**: Supabase — PostgreSQL, Auth, Row Level Security, Postgres RPCs (`SECURITY DEFINER`), Edge Functions (Deno)
- **State**: Zustand 5 (modular data store mirroring the DB; UI prefs persisted to localStorage)
- **Styling**: Tailwind CSS 3
- **Charts**: Recharts 3
- **Forms**: React Hook Form + Zod
- **Routing**: React Router DOM 7
- **Barcodes / QR**: jsbarcode, qrcode.react
- **i18n**: custom translation system (English + Myanmar)
- **Tests**: Vitest

## Getting Started

### Prerequisites
- Node.js 18+
- A Supabase project (free tier is fine)

### 1. Install
```bash
npm install
```

### 2. Configure environment
Create `.env.local` in the project root:
```bash
VITE_SUPABASE_URL=<your-project-url>
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```
> The anon key is safe to expose in the client bundle — data is protected by
> Row Level Security. Never put the **service-role** key here.

### 3. Set up the database
Apply the SQL in [`supabase/`](supabase/) to your project (Supabase Dashboard
→ SQL Editor, or the Supabase CLI):
- `supabase/baseline/` + `supabase/migrations/*.sql` — the schema is reproduced from the baseline followed by the later migrations in order (see [supabase/baseline/README.md](supabase/baseline/README.md)). `supabase/schema.sql` is a historical pre-`050` snapshot and cannot rebuild the current schema.
- `supabase/functions/email-sales-report` — optional Edge Function for the admin "Email today's CSV" feature (see [docs/07-setup-deployment.md](docs/07-setup-deployment.md))

Seeding is done with `npm run seed:service-role` (`scripts/seed/seedServiceRole.ts`).

### 4. Run
```bash
npm run dev       # start the dev server
npm run build     # type-check + production build (tsc -b && vite build)
npm run preview   # preview the production build
npm run test      # run the Vitest suite
npm run lint      # ESLint
```

## Authentication

Real **Supabase Auth** (email + password) — there are no demo-password
bypasses or magic email patterns.

- **First-time setup:** signing in against an **empty `users` table** creates
  the first **ADMIN** account, linked to its auth identity.
- **After that:** staff accounts are created by an admin in *Users*, then
  linked to a Supabase Auth user on first sign-in (by `auth_id`, falling back
  to email). Orphan auth accounts are rejected.
- The login form disables credential autofill (shared-till friendly) and
  supports show/hide password.

## Roles & Permissions

Granular RBAC. Each role has default permissions; admins can grant/revoke
per user. Enforced in **both** the UI and the database (RLS + RPC checks).

| Role | Scope |
|------|-------|
| **ADMIN** | Everything, all shops, all settings. Lands on the Dashboard. |
| **MANAGER** | Assigned shop: POS, shifts, approvals, shop reports, receiving |
| **CASHIER** | POS, own shift, raise (not approve) refund/void requests |
| **BUYER** | Catalog + suppliers + create/view purchase orders |

Full matrix: [docs/05-roles-permissions.md](docs/05-roles-permissions.md).

## Features

### Point of Sale
- Product grid with category filter, search, and per-unit selling (Piece / pack / etc.)
- Price levels (Retail / Wholesale / Special), tier pricing, open-price + non-stock items
- Real-time stock guards; `F3` inline 80mm receipt print, `F4` barcode mode
- Atomic checkout via the `complete_sale` RPC (validates auth, shift, stock, prices in one transaction)

### Sales & Receipts
- Sales history with search/date/status/cashier filters
- **Sales Voucher** detail page (itemized grid + live receipt preview)
- Refund / void request → manager approval flow; receipt reprint logging
- CSV export and an admin per-shop "Email today's CSV" report (Edge Function + Resend)

### Inventory & Stock
- Base-unit inventory with multi-tier display ("8 Case 22 Can")
- Movement ledger (sale, purchase, transfer, adjustment, damage)
- Inter-shop transfers with an approval workflow
- Purchase orders, suppliers, supplier payments / debt tracking

### Catalog & Admin
- Products with dynamic categories, brands, sellable units, and per-unit prices
- Barcode management + printable barcode labels
- Phone photo upload via QR code (with live preview)
- Multi-shop management, user management, pricing, and an audit log

### Dashboard
- Net revenue, orders, AOV, profit/margin KPIs (date-ranged, shop-scoped)
- Revenue/Cost/Profit trend, Sales by Category, Top Products
- Inventory Intelligence (stock health, fast/slow movers, reorder hints)
- Low-stock alerts, pending approvals/receipts/transfers, supplier debt, recent activity

## Project Structure

```
src/
├── app/
│   ├── routes/            # AppRouter + RequireAuth / RequireRole guards
│   └── layout/            # Shell, sidebar, topbar
├── components/
│   ├── ui/                # Design system (Button, Modal, Badge, Input, Table…)
│   ├── pos/               # ProductFinder, CartPanel, PaymentModal, ReceiptPreview
│   ├── receipt/           # ReceiptDetail (voucher + printable receipt)
│   ├── sales/             # SalesTable, SaleVoucher, refund/void modals
│   ├── inventory/ shifts/ purchases/ products/ forms/ layout/
├── features/
│   ├── auth/ catalog/ pos/ inventory/ sales/ pricing/ shifts/ dashboard/
├── pages/                 # Route-level compositions
├── stores/
│   ├── authStore.ts       # Supabase session → current app user
│   ├── appStore.ts        # Selected shop (persisted)
│   ├── languageStore.ts   # i18n preference (persisted)
│   ├── toastStore.ts      # Notifications
│   └── data/              # Modular data store (loads from Supabase)
│       ├── index.ts       # Composition + row mappers + loadData
│       ├── types.ts  utils.ts
│       └── slices/        # shop, category, brand, unitType, priceLevel,
│                          # product, inventory, shift, sale, transfer,
│                          # purchase, pricing, audit
├── hooks/  i18n/  lib/  print/  types/
supabase/
├── baseline/              # schema baseline (see baseline/README.md)
├── migrations/            # RBAC, RPCs, units, pricing, fixes (ordered)
├── schema.sql             # historical pre-050 snapshot (not for rebuilds)
└── functions/             # Edge Functions (email-sales-report)
docs/                      # architecture, security, workflows, setup, QA…
```

## Routes

**App** (`/app`, auth + permission gated):
`dashboard` · `pos` · `sales` · `sales/:saleId` · `shifts` · `shifts/:shiftId`
· `inventory` · `transfers` · `purchases` · `approvals` · `reports` ·
`reports/profit` · `catalog` · `barcode-labels` · `suppliers` ·
`suppliers/:supplierId`

**Admin** (`/app/admin`):
`shops` · `users` · `products` (+ `products/new`, `products/:id/edit`) ·
`unit-types` · `barcodes` · `suppliers` · `pricing` · `reports` · `audit`

**Public:** `/login` · `/phone-upload/product-image/:token`

## Data & Persistence

- **Business data** (products, sales, inventory, shifts, …) lives in **Supabase**
  and is loaded into the in-memory Zustand store on startup. It is **not**
  cached in localStorage.
- **localStorage** holds only UI preferences:
  - `pos-app` — selected shop context
  - `pos-language` — language preference
- Auth state is the **Supabase session** (restored on load), not localStorage.

## Internationalization

English and Myanmar (Burmese), toggled from the sidebar — e.g. Dashboard
(ဒက်ရှ်ဘုတ်), Total Revenue (စုစုပေါင်းဝင်ငွေ), Low Stock (ကုန်ပစ္စည်းနည်းနေသည်).

## Documentation

See [`docs/`](docs/) for full documentation:

- [Overview](docs/01-overview.md)
- [Architecture](docs/02-architecture.md)
- [Database & Security](docs/03-database-security.md)
- [Features & Workflows](docs/04-features-workflows.md)
- [Roles & Permissions](docs/05-roles-permissions.md)
- [UI, Printing & Hardware](docs/06-ui-printing-hardware.md)
- [Setup & Deployment](docs/07-setup-deployment.md)
- [Testing & QA](docs/08-testing-qa.md)
- [Roadmap & TODO](docs/09-roadmap-todo.md)
- [Offline-First & Desktop — Known Issues & TODO](docs/10-offline-desktop-known-issues.md)

## License

Private — Shwe Pha La Co., Ltd.
