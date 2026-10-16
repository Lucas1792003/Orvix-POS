# Organization-isolation security audit (backend)

**Date:** 2026-10-16 · **Scope:** server-side ORGANIZATION and SHOP isolation of
the whole API surface (PostgREST tables/views, RPCs, storage, phone upload, Edge
Functions) at migration **081 (= production)** and **082 (prepared, NOT
deployed)**. · **Method:** an automated, repeatable audit against a disposable,
isolated Supabase-shaped stack on `127.0.0.1` (synthetic data only), plus a
read-only schema-parity proof against production. · **Harness:**
[`tools/security-audit/`](../../../tools/security-audit/) (`run.sh`). · **Status
of the fix:** migration **082** is prepared in the repo and **not applied
anywhere**; this audit shows it closes every gap found at 081.

Nothing was created, changed, or deleted on the live server. The only live
access was read-only catalog introspection (schema parity), run inside a
`default_transaction_read_only` session.

## 1. Headline

- **Schema parity: PASS.** A normalised fingerprint of the public + storage
  schemas (columns, constraints, indexes, RLS flags, policies, table/function
  grants, function-body md5, triggers, views, bucket visibility, the Realtime
  publication, and the migration list ≥ 062) is **byte-identical** between
  production and the disposable 081 build — **1870/1870 lines match, 0
  differences**. The audit therefore tests the real production schema. (One
  non-schema observation, reported not failed: production's `product-images`
  bucket carries no `allowed_mime_types`; a fresh install via migration 016 adds
  `image/webp,image/jpeg`. This is a storage-api upload-validation attribute,
  stricter on a fresh install, not an isolation fact.)
- **Coverage gate: PASS at 081 and 082 — 119/119 required items mapped, 0 hard
  gaps.** Every org-scoped table/view (30), API-callable function (69),
  service-role-only SECURITY DEFINER function (9), storage policy (4) and Edge
  Function (6) has at least one mapped test. The gate fails automatically if a
  new object appears without a test.
- **At 081 the organization boundary holds for the entire data/RPC/storage/
  function surface** — 390 assertions pass, 0 fail — **except one class:** the
  older admin "link any auth account" path (`create_app_user` with an arbitrary
  `p_auth_id`, and direct `users` INSERT/UPDATE of `auth_id`). That is **4
  expected GAPs, severity critical.**
- **At 082 all 4 gaps close** (395 pass, 0 fail, 0 gaps) and every other area
  still passes. Deploying 082 is the recommended fix.

## 2. Environment

Disposable stack, every container/network/volume prefixed `phf-iso-`, every port
on `127.0.0.1`, random per-run secrets (mode 0600, redacted from all logs),
torn down on exit (trap, also on failure). Same image versions as production:

| Service | Image |
|---|---|
| Postgres | `supabase/postgres:17.6.1.136` |
| GoTrue | `supabase/gotrue:v2.196.0` (`DISABLE_SIGNUP=true`, TOTP on — production settings) |
| PostgREST | `postgrest/postgrest:v14.17` |
| storage-api | `supabase/storage-api:v1.74.0` (file backend, disposable volume) |
| edge-runtime | `supabase/edge-runtime:v1.76.2` (`VERIFY_JWT=true`, upstream router `564eab8a` + the deployment's public-page router patch, supplied via env) |
| gateway | `node:24-slim` (routes `/auth` `/rest` `/storage` `/functions`) |

The schema is built exactly as the phase-d harness builds it: restore
`BASELINE_SQL` (scrubbed production schema snapshot) as `supabase_admin`, replay
`016_product_images_storage.sql`, then every migration `> 061` and `<=
--max-migration`. GoTrue and storage-api create the real `auth`/`storage`
objects first (no shims), so `auth.jwt()`, `auth.uid()`, MFA and storage RLS
behave as in production. `api.resend.com` is pinned to `127.0.0.1` in the
functions container, so no email can leave the machine.

**The world under test:** two synthetic orgs **A** and **B** (each: ADMIN with a
verified TOTP factor tested at **aal1 and aal2**, MANAGER ×2, CASHIER, BUYER, a
deactivated user — real GoTrue accounts, real password + TOTP logins), an
attacker org **C** (ADMIN without TOTP → emailed-code path, tested with and
without a consumed code), an **orphan** auth account, a **platform admin**, and
**anon**. Each org seeded with shops, products, units, prices/levels, inventory,
a supplier, purchase orders, sales, shifts, refund/void requests, transfers, a
supplier payment, audit rows, upload sessions and synthetic storage objects —
business records made through the keyed RPCs. Org B carries unique **canary**
tokens in names/emails/notes; every captured refusal and response (202 bodies at
081) is scanned for them.

## 3. Inventory (from the live catalog of the DB under test)

| Item | 081 |
|---|--:|
| Tables/views total | 37 |
| — org-scoped | 30 |
| — global/reference | (shared by design, each RLS-checked) |
| — internal (no anon/auth grant) | 5 (`admin_login_codes`, `app_config`, `idempotency_keys`, `phone_upload_org_rate`, `platform_admins`) |
| Storage objects/buckets | 2 (`storage.objects`, `storage.buckets`; bucket `product-images`, public) |
| Functions (public+storage, non-extension) | 99 |
| — anon-executable | 3 (`app_setup_needed`, `get_product_image_upload_session_by_token`, `complete_product_image_upload_session`) |
| — authenticated-executable (non-trigger) | 69 |
| — SECURITY DEFINER | 64 |
| RLS policies (public+storage) | 62 (incl. 4 storage policies) |
| Edge Functions deployed | 6 (`admin-2fa`, `email-sales-report`, `phone-upload-token`, `phone-upload-page`, `platform-console`, `staff-admin`) |
| Realtime publication | `public.inventory` only |

Full, machine-readable inventory and classification: each run's
`m081/inventory.json`.

## 4. Coverage matrix

The gate (`coverage/gate.mjs`) derives the required set from the live catalog
(not a hand list), maps each item to the `covers[]` tags the suites record, and
**fails if any org-scoped table, API-callable function, SECURITY DEFINER
function, storage policy or Edge Function is unmapped.**

**Result: PASS at 081 and 082 — 119/119 mapped, 0 hard gaps.**

| Category | required | mapped |
|---|--:|--:|
| org-scoped tables/views | 30 | 30 |
| storage policies | 4 | 4 |
| API-callable functions | 69 | 69 |
| SECURITY DEFINER (service-role-only) | 9 | 9 |
| Edge Functions (+ signup surface) | 6 (+1) | 7 |

The complete item → test-id matrix (markdown) and its machine-readable form are
regenerated into each run's `m0NN/coverage.{md,json}`.

## 5. Results per area (PASS / FAIL / GAP)

| Area | What it proves | 081 | 082 |
|---|---|---|---|
| tables | every org-scoped table: cross-org read (plain, FK filters, `or=`, `count=exact`, embedded joins) returns none of B; INSERT aimed at B and UPDATE/DELETE of B's rows have no effect; per-role positives | 212 / 0 / 0 | 212 / 0 / 0 |
| rpcs | every authenticated mutating RPC with B's ids → refused; a before/after digest of all of B's tables unchanged; idempotency-key org binding (074) | 36 / 0 / 0 | 36 / 0 / 0 |
| storage | A cannot list/overwrite/delete/move/sign B's objects; signed-URL path binding; public read documented | 18 / 0 / 0 | 18 / 0 / 0 |
| phone | create-session cross-org refused; by-token returns only the 8 allowed fields; completion path binding (079/080); per-org rate counters (081) | 10 / 0 / 0 | 10 / 0 / 0 |
| functions | staff-admin (shop/org tampering, role/aal/code gates, ADMIN-escalation, replay, compensation), platform-console, admin-2fa, email-sales-report derive org server-side; signup disabled (422) | 28 / 0 / 0 | 28 / 0 / 0 |
| authlink | older `create_app_user` / direct-`auth_id` linking path | 1 / 0 / **4 GAP** | 6 / 0 / 0 |
| authz | authorization-boundary matrix across 9 personas; anon surface | 49 / 0 / 0 | 49 / 0 / 0 |
| helpers | SECURITY DEFINER context helpers report caller-only; owner-scoped upload fns; bootstrap/rbac view/phone page; service-role-only grants | 34 / 0 / 0 | 34 / 0 / 0 |
| errors | no org-B canary leaked in any captured refusal/response (202 scanned) | 1 / 0 / 0 | 1 / 0 / 0 |
| **Total** | | **390 / 0 / 4** | **395 / 0 / 0** |

Positive controls are included throughout (each role still reads and operates on
its own org; staff-admin positive create + replay; `create_supplier` lands in
the caller's org; A can sign its own storage path; etc.).

### Public sign-up (req 12)

- Disposable GoTrue (`DISABLE_SIGNUP=true`, production setting):
  `/auth/v1/signup` → **422 `signup_disabled`** (asserted in `functions`).
- Live, read-only: production still has `DISABLE_SIGNUP=true`
  (`grep -c '^DISABLE_SIGNUP=true$' .env` = 1, verified 2026-10-13) and an
  unauthenticated signup probe with a fake `@qa.invalid` address returns 422
  (writes nothing). Re-confirm with an anchored grep for that one key; do not
  print other `.env` values.

## 6. Gaps

All four are the **same expected class** the prepared migration 082 targets.
Reproduced by the `authlink` suite; each is PASS at 082.

| # | Object | Gap | Severity | Status |
|---|---|---|---|---|
| G1 | `create_app_user(p_auth_id)` | An ADMIN (or a user granted `user:create`) can pass **an orphan sign-up account's** `auth_id` and link it into a new staff row in their org. | **critical** | 081 GAP → 082 PASS |
| G2 | `create_app_user(p_auth_id)` | Same, passing **a platform admin's** login `auth_id` — binds a privileged login to an ordinary org user. | **critical** | 081 GAP → 082 PASS |
| G3 | `users` INSERT (direct, PostgREST) | `authenticated` holds table INSERT (065 hosted parity); no column guard on `auth_id`, so a client INSERT can set `auth_id` directly, bypassing the RPC. | **critical** | 081 GAP → 082 PASS |
| G4 | `users` UPDATE (direct, PostgREST) | Same for UPDATE: a client can repoint an existing user's `auth_id` (e.g. at a platform admin's account). | **critical** | 081 GAP → 082 PASS |

Note: linking **another org's already-linked** account (e.g. org B's ADMIN)
fails even at 081 — its `auth_id` is already taken (`users_auth_id_unique`) — so
that specific case is already closed; the orphan/platform-admin/unlinked cases
are the live exposure.

**Reproduction** (all as org A's ADMIN on an aal2 session, against the
disposable 081 stack):

1. G1/G2 — `rpc('create_app_user', { …, p_auth_id: <orphan or platform-admin
   authId>, p_shop_id: <A shop>, … })` → **200**, a new A user row linked to
   that foreign login.
2. G3 — `POST /rest/v1/users` with `{ …, auth_id: <orphan authId>, org_id: <A>
   }` → **201**, row created with that `auth_id`.
3. G4 — `PATCH /rest/v1/users?id=eq.<an A user>` with `{ auth_id:
   <platform-admin authId> }` → **200**, `auth_id` changed.

**Impact.** An org admin can bind a login account they do not own (an abandoned
sign-up, or a platform admin's account) to a staff row in their own
organization, or repoint an existing staff row's login. Depending on which
account is linked, this can grant that login app access it should not have, or
hand an attacker-chosen login the privileges of an existing user. It does **not**
by itself cross the org boundary for business data (every other area passes),
but it is an account-takeover / privilege-linking primitive.

**Proposed fix (not implemented here): deploy migration 082**
(`082_close_auth_id_linking.sql`, already prepared in the repo). This audit
proves 082 closes G1–G4: `create_app_user` links only a **fresh, same-email,
never-signed-in** account carrying the `{created_via: 'staff-admin', org_id:
caller-org}` app-metadata marker (writable only by the service role), with a
caller-assurance gate mirroring the admin login (TOTP → aal2, else a consumed
email code); and an AFTER trigger refuses any client INSERT/UPDATE that sets or
changes `auth_id` (`AUTH_ID_READ_ONLY`), while the service role and SECURITY
DEFINER RPCs stay trusted. Deploy 082 together with the staff-admin function
version that writes the marker (see
[`migration-082.md`](migration-082.md)). No other fix is required by this audit.

### G5 (coordinator finding, 2026-10-16) — public image bucket accepts any file type and size

| # | Object | Gap | Severity | Status |
|---|---|---|---|---|
| G5 | `storage.buckets` `product-images` (production) | Bucket is **public** with `allowed_mime_types = NULL` and `file_size_limit = NULL` (read-only check on production). A fresh install from migration 016 sets an image MIME allow-list, so production drifted (the parity check reports it as a non-schema note). Anyone who can write to an allowed path — org staff via the storage policies, or a phone holding a 60-second signed upload URL for its exact session path — can store **HTML/SVG/any type of any size**, which is then served publicly from the **same HTTPS origin** that now also serves the phone-upload page. | **medium** | open at 081 and 082; **fix prepared in 083** (not deployed): bucket limits + phone completion byte check, see [migration-083-g5.md](migration-083-g5.md); desktop byte check = documented low residual |

Evidence: production objects today are only images (561 `image/webp`, 13 `image/jpeg`); no abuse observed. Org isolation is not broken by this (paths stay org-scoped); the risk is same-origin hosting of attacker-chosen content (phishing / script on the backend origin; the phone page's only credential is the public anon key) and disk filling.

**Proposed fix (not implemented; needs approval):** a small migration (083 or folded into the next storage migration) setting `allowed_mime_types = '{image/jpeg,image/png,image/webp}'` and `file_size_limit` (e.g. 5 MB, above the client's resized uploads) on `product-images`, plus an audit assertion that an `text/html` / `image/svg+xml` / oversize upload is refused; optionally a gateway response header `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` on `/storage/v1/object/public/`. Verify the 574 existing objects are all within the new rules before applying (they are: webp/jpeg, ~5.3 MB total).

## 7. Evidence

Per-run artifacts under `tools/security-audit/results/<timestamp>/` (git-ignored
— too large to commit): `SUMMARY.md`, and per level `m081/`, `m082/` with
`results.json` (every assertion, id, covers, redacted detail), `coverage.{md,json}`,
`inventory.json`, `stack.log`, `suites.log`, and `parity-081.md`.

**Rerun:**

```sh
# full audit (081 then 082) + read-only live parity:
PHF_ISO_PARITY_SSH=<ssh-host> tools/security-audit/run.sh --parity
# a single level, keep the stack for inspection:
tools/security-audit/run.sh --max-migration 081 --keep
```

Prerequisites and safety: see
[`tools/security-audit/README.md`](../../../tools/security-audit/README.md).
