# Organization-isolation security audit

A repeatable, automated audit that proves one organization (and its shops) in
the Shwe Pha Lar POS cannot read, write, or act on another organization's data
through any API surface — PostgREST tables/views, RPCs, storage, the phone
upload flow, and the Edge Functions. It runs against a **disposable, isolated
stack on 127.0.0.1 only** (synthetic data), at migration **081** (= production)
and again at **082** (the prepared, not-yet-deployed fix), and it proves the
disposable schema is **identical to production** at 081 (read-only parity).

Nothing here ever creates, changes, or deletes anything on the live server.
The only live access is read-only schema introspection for the parity check.

## Run

```sh
# both levels (081 then 082), no live access:
tools/security-audit/run.sh

# add the read-only live schema-parity proof (needs SSH to the server):
PHF_ISO_PARITY_SSH=<ssh-host> tools/security-audit/run.sh --parity

# a single level, keep the stack up for debugging:
tools/security-audit/run.sh --max-migration 081 --keep

# just bring the disposable stack up (dev loop):
tools/security-audit/run.sh --max-migration 081 --stack-only
```

Results land under `tools/security-audit/results/<timestamp>/` (git-ignored):
`SUMMARY.md`, and per level `m081/`, `m082/` with `results.json`,
`coverage.json`, `coverage.md`, `inventory.json`, logs, and (with `--parity`)
`parity-081.md`. A trimmed `SUMMARY.md` is committed under
`docs/selfhost-migration/phase-f/` as the audit report.

### Options

| Option | Meaning |
|---|---|
| `--max-migration NNN` | audit only at this level (repeatable; default `081` then `082`) |
| `--parity` | also take the read-only live fingerprint and diff it against the disposable 081 schema |
| `--keep` | leave the stack running for inspection (secrets in the run's temp dir, never printed) |
| `--stack-only` | build the stack and exit (implies `--keep`) |

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `BASELINE_SQL` | `~/shwephala-migration/20261011T2347Z/schema.scrubbed.sql` | scrubbed production schema snapshot (same default the phase-d harness uses) |
| `PHF_ISO_PARITY_SSH` | — | SSH host for the read-only live parity read (no host name is baked into the repo) |
| `PHF_ISO_PARITY_STACK` | `/srv/supabase/stack` | server stack dir |
| `PHF_ISO_PARITY_DBSVC` | `db` | compose service name of Postgres on the server |

## Prerequisites

- Docker (29 tested) with the public images pullable:
  `supabase/postgres:17.6.1.136`, `supabase/gotrue:v2.196.0`,
  `postgrest/postgrest:v14.17`, `supabase/storage-api:v1.74.0`,
  `supabase/edge-runtime:v1.76.2`, `node:24-slim`.
- Host `psql`, `jq`, `node`, `openssl`, `curl`.
- `npm ci` run once in the repo root (the suites import `@supabase/supabase-js`
  via `tsx` and reuse `src/test/hostedGuard.ts`).
- The scrubbed baseline schema snapshot at `BASELINE_SQL`.

## What it builds

A Supabase-shaped stack, every container/network/volume prefixed `phf-iso-`,
all ports on `127.0.0.1`, torn down on exit (trap, also on failure):

```
phf-iso-db       supabase/postgres:17.6.1.136   (baseline + migrations 062..NNN)
phf-iso-auth     supabase/gotrue:v2.196.0       (DISABLE_SIGNUP=true, TOTP on)
phf-iso-rest     postgrest/postgrest:v14.17
phf-iso-storage  supabase/storage-api:v1.74.0   (file backend, disposable volume)
phf-iso-fn       supabase/edge-runtime:v1.76.2  (VERIFY_JWT=true, upstream router + public-page patch)
phf-iso-gw       node:24-slim                   (tiny gateway: /auth /rest /storage /functions)
```

The schema is built exactly as the phase-d harness builds it: prep shim check,
restore `BASELINE_SQL` as `supabase_admin`, replay `016_product_images_storage`,
then every migration `> 061` and `<= --max-migration`. GoTrue and storage-api
create the real `auth`/`storage` objects first (no shims), so `auth.jwt()`,
`auth.uid()`, MFA and storage RLS behave as in production. `api.resend.com` is
pinned to `127.0.0.1` in the functions container, so no email can leave.

## The world under test

Two synthetic orgs **A** and **B** (each: ADMIN with a verified TOTP factor →
tested at aal1 and aal2, MANAGER ×2, CASHIER, BUYER, a deactivated user; real
GoTrue accounts and real password/TOTP logins), an attacker org **C** (ADMIN
without TOTP → emailed-code path, with and without a consumed code), an orphan
auth account, a platform admin, and anon. Each org is seeded with shops,
products, units, prices/levels, inventory, a supplier, purchase orders, sales,
shifts, refund/void requests, transfers, a supplier payment, audit log rows,
upload sessions and synthetic storage objects (org-scoped, legacy `temp/` and
`products/`, brand logo) — business records made through the keyed RPCs. Org B
is seeded with unique **canary** tokens in names/emails/notes so any leak of B
into another org's response is detectable.

## Areas (→ requirements)

| Suite | Proves |
|---|---|
| `tables.ts` | every org-scoped table/view: cross-org read (plain, FK filters, `or=`, `count=exact`, embedded joins) returns none of B; INSERT aimed at B, UPDATE/DELETE of B's rows have no effect; positives per role |
| `rpcs.ts` | every authenticated mutating RPC with B's ids → refused, and a before/after digest of all of B's tables is unchanged; idempotency-key org binding (074) |
| `storage.ts` | A cannot list/overwrite/delete/move/sign B's objects; signed-URL path binding; public reads documented |
| `phone.ts` | create-session cross-org refused; by-token returns only the 8 allowed fields; completion path binding (079/080); per-org rate counters (081) |
| `functions.ts` | staff-admin (shop/org tampering, role/aal/code gates, escalation, replay, compensation), platform-console **retired** (G0-2: must not execute for any persona), admin-2fa, email-sales-report derive org server-side; GoTrue signup disabled (422) |
| `authlink.ts` | the older `create_app_user`/direct-`auth_id` linking path — **expected GAP at 081**, closed at 082 |
| `authz.ts` | authorization-boundary matrix across 9 personas; the anon surface |
| `helpers.ts` | SECURITY DEFINER context helpers report caller-only; owner-scoped upload fns; bootstrap/rbac view/phone page; service-role-only definer grants |
| `coverage/gate.mjs` | FAILS if any org-scoped table, API-callable function, SECURITY DEFINER function, storage policy, or Edge Function has no mapped test |

## Safety

Loopback only; `phf-iso-*` names; random per-run secrets written only to the
run's temp dir (mode 0600) and redacted from all logs; `@qa.invalid` emails
only; no host names in the code (supplied via env); the hosted-backend guard
(`src/test/hostedGuard.ts`) refuses any `*.supabase.co`. The live parity read
runs inside a `default_transaction_read_only` session and only reads the
catalog.
