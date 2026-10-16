# Phase D database test harness

DB-level proof that migrations `062`–`066` deliver the idempotency contract
(`docs/selfhost-migration/phase-d/idempotency-contract.md`), close the
anon-EXECUTE finding (A7) and reproduce production grants — on a throwaway
container with **synthetic data only**. Nothing here connects to hosted
Supabase or to any real server.

## Run

```sh
BASELINE_SQL=/path/to/schema.scrubbed.sql ./supabase/tests/phase-d/run.sh
```

Requirements: Docker, host `psql` (`brew install libpq`), and the scrubbed
production schema snapshot. Environment:

| Variable | Default | Meaning |
|---|---|---|
| `BASELINE_SQL` | required, no default | path to the scrubbed schema-only dump to restore, e.g. `<workspace>/<ts>/schema.scrubbed.sql` (later: `supabase/baseline/schema-baseline.sql`) |
| `HOSTED_GRANTS_TXT` | `hosted-grants.txt` next to `BASELINE_SQL` | expected table-grant list for the `065` parity check |
| `SWEEP_SQL` | unset (t21 sweep checks skipped) | the deployment's read-only abandoned-upload candidate query (`sweep-abandoned-uploads.sql`, not in this repository) |
| `POS_TEST_IMAGE` | `supabase/postgres:17.6.1.136` | pulled if missing; falls back to `public.ecr.aws/supabase/postgres:17.6.1.159` |
| `POS_TEST_PORT` | `55432` | bound to 127.0.0.1 only |
| `POS_TEST_KEEP` | `0` | `1` leaves the container running for inspection (password printed) |
| `POS_TEST_MAX_MIGRATION` | all | apply migrations only up to this number. `067` reproduces the schema **before** the Phase G org-isolation fix (068-072): t09's cross-org assertions then print as `FINDING` and the run still passes |

Exit status is non-zero if any assertion fails or any step aborts; a summary
table of every assertion is printed at the end. Runtime is about two minutes.

Three result kinds: `PASS`, `FAIL` (harness failure) and `FINDING` (a Phase G
isolation gap recorded by `test.finding*`; tolerated only when
`POS_TEST_MAX_MIGRATION` is below 068, otherwise it fails the run).

## What it does

1. Starts `pos-test-db` (`--memory 1g`, random password, loopback only);
   `trap` removes it on exit, including on failure.
2. Prep as `supabase_admin`: creates a minimal `auth.users` if the image lacks
   it (this image ships it), ensures the `supabase_realtime` publication, a
   minimal `storage` shim (`buckets`, `objects`, `foldername()`; the image has
   no storage schema) and prints what `auth.uid()` reads
   (`request.jwt.claim.sub` in this image; hosted reads `request.jwt.claims`
   — the harness sets both).
3. Restores `BASELINE_SQL` as the superuser — deliberately, so the restore
   picks up `supabase_admin`'s default ACL and the migrations have to cope.
   Then replays `016_product_images_storage.sql` onto the storage shim (the
   dump excludes the storage schema) so `storage.objects` RLS matches
   production before 071 rewrites it.
4. Applies every migration numbered `> 061` (and `<= POS_TEST_MAX_MIGRATION`)
   as `postgres` (what `supabase db push` does), then applies them all a
   **second time** to prove idempotency.
5. Creates a `test` schema (assertion ledger, `expect_error`, `finding*`,
   `login`) and seeds: one org, two shops, ADMIN + 2 managers + 3 cashiers
   (each linked to a synthetic `auth.users` row), 3 products with units/prices
   and stock, a supplier, a RECEIVED PO with outstanding balance, an APPROVED
   PO, a DRAFT PO, and one sale in the other shop. Catalog rows are inserted
   with the ADMIN's JWT claims set so 068's fill-from-caller triggers resolve
   the org.
6. Runs the SQL test files. API callers are simulated with
   `SET ROLE anon|authenticated|service_role` plus
   `set_config('request.jwt.claim.sub' / 'request.jwt.claims', …)`.
7. Prints the summary and tears the container down.

## What each test proves

| File | Proves |
|---|---|
| `t01_permissions_rls` | `anon` can execute exactly the two token-scoped phone-upload RPCs and nothing else (calls return `permission denied`); `authenticated` can execute everything except `complete_stock_transfer` (052) and the idem helpers; `service_role` everything; no overloads after 063; 30 RPCs carry `p_idempotency_key`; role `postgres`'s default function ACL has no anon/PUBLIC; `idempotency_keys` has RLS, no policies, no client grants; table grants equal `hosted-grants.txt` row for row (065); an authenticated session without claims gets `Not authenticated`; a missing key gets `IDEMPOTENCY_KEY_REQUIRED`; a CASHIER calling `approve_*`/`adjust_stock` gets the permission error from inside the RPC; the 055 expected-actor guard still fires; a cashier cannot read the other shop's inventory/sales/shifts/users and cannot write tables directly. |
| `t02_shift` | `open_shift` replay returns the identical response and the same shift id; a new key while a shift is open still hits the state guard; one shift, one audit row; the key row records actor + rpc; a second cashier gets a separate shift on the same shop. |
| `t03_sale_idempotency` | normal checkout (receipt number, totals, stock); same key twice → byte-identical jsonb; reordered item JSON + different `p_created_at` → still a replay; same key with a different payload or a different RPC → `IDEMPOTENCY_MISMATCH` and no second sale/movement/audit row; the stored response equals the first response; insufficient stock rolls the key back (no row, no sale, stock untouched) and a retry with the same key after a restock **executes**. |
| `t04_concurrency` | two sessions, same key: A holds its transaction open 3 s, B starts 1 s later and blocks on the advisory lock (B wall time ≥ 2 s), both get identical responses, exactly one sale, one movement, stock deducted once. |
| `t05_stock_supplier` | `adjust_stock`, `record_supplier_payment`, `pay_supplier_lump_sum`, `void_supplier_payment` each apply once under replay (quantities, `paid_mmk`, payment rows, audit rows counted in the DB). |
| `t06_po_transfer_records` | replay-safety of `create_purchase_order`, `receive_purchase_order` (APPROVED→RECEIVED once), the whole transfer chain `create → approve → dispatch → receive` (two managers, inventory moved once, 4 audit rows), `log_audit_event`, `cancel_purchase_order`, `log_receipt_reprint`, `create_supplier` (same server-minted id), `create_app_user` (no PK violation; `org_id` inherited — the 066 fix). |
| `t07_multi_terminal` | two cashiers with separate shifts, interleaved sales incl. a cart discount; a cashier cannot sell on the other's shift; inventory arithmetic exact; receipts unique and contiguous `0001..0007`; sale/item/movement counts. |
| `t08_consistency_close` | for every inventory row `initial + Σ movements = qty`; every movement `after − before = change`; the movement chain is gapless per product; every sale has items and an audit row; every committed key row has a stored response; `close_shift` replay returns the identical response, a new key on a closed shift hits the state guard, shift closed once; `prune_idempotency_keys()` removes nothing young. |
| `t09_org_isolation` | **Phase G** (`docs/selfhost-migration/phase-g/org-isolation-audit.md`). Seeds a second organization (2 shops, ADMIN/2 MANAGERs/CASHIER, catalog, inventory, supplier, 4 POs, 5 transfers, 3 refund requests, a supplier payment, storage objects) and, as org-A users, attempts: every cross-org read (29 tables + the `rbac_assignment_violations` view + `storage.objects`), direct cross-org UPDATE/INSERT/DELETE on catalog/shops/users/business_profile, the global-uniqueness collisions (supplier code, shop name, unit type, barcode, per-org default price level), the `addShop()` NOT NULL defect, and all 30 mutating RPCs against org-B shops/products/suppliers/orders/transfers/sales/shifts/requests/payments/users. Positive controls prove each org still sees and operates on its own data. Before 068 these are `FINDING`s; after 068-072 they `PASS`. |

| `t10_review` | Independent review of 067-072 (runs when migrations >= 069). An orphan auth account (no app user) cannot create an organization or enrol itself into any org; an org ADMIN cannot create organizations; explicit foreign `org_id` on INSERT and `UPDATE ... SET org_id` are rejected (catalog, shops, users); barcode `org_id` follows the product; catalog cross-references (brand, category, price level, shop, barcode unit, supplier_products) cannot span orgs, also for `service_role`; upload sessions for another org's shop/product are refused; `inventory` (the only Realtime table) is filtered by an org-aware policy both ways; a same-org idempotent replay returns the stored response while another org re-using the key is stopped by the guard. |
| `t11_second_org` | Platform-console path (runs when migrations >= 069): as `service_role` create two organizations and their first ADMINs (`FINDING` before 073: the 047 guard rejected it), one ADMIN per org, rollback delete of an empty org; both ADMINs build shops/products/units/price levels/stock through the app; isolation in both directions (reads, RPCs, direct UPDATE); an org ADMIN, an orphan auth account and `anon` cannot create organizations or foreign ADMINs. |
| `t12_remaining_fixes`, `t12_bootstrap_*` | 074-076 (runs when migrations >= 074 / 076; the bootstrap concurrency runs last because it empties `users`). See `docs/selfhost-migration/phase-g/remaining-security-fixes.md`. |
| `t13_new_org_price_levels` (+ `_b`) | 077 (runs when migrations >= 077): an org with no price level cannot sell (root cause); console-created orgs (service_role) get the 030 default set; re-seeding and a same-id / overlapping concurrent creation (two dblink sessions; dblink is installed in schema `test_dblink`) never duplicate; existing orgs unchanged (count + checksum); checkout works in the new orgs and the existing one; no cross-org price-level reference; console rollback delete works (FK CASCADE). run.sh then **re-applies 077** to the populated database and `_b` proves the one-time backfill seeded only the org with zero levels. |
| `t14_upload_security` | 078/079 (runs when migrations >= 079): org-prefixed and legacy object paths, cross-org INSERT/UPDATE/DELETE/move refused, owner-less legacy objects (574-style) managed by their org's admin only and still referenced by `products.image_url`, session paths `org/<org>/temp/<id>`, signing refused for expired / cancelled / completed / foreign sessions, attach fix, completion bound to the session's own URL, end-to-end phone flow at the SQL level. |
| `t15_anon_audit` | the anonymous surface (runs when migrations >= 079): exactly 3 anon functions; anon and a fresh signup account read 0 rows from every public table/view and `storage.objects`, cannot bootstrap, enrol or create orgs; token guessing / hash / session id never resolve; the by-token response carries only the 8 upload fields. |
| `t16_completion_url` | 080 (runs when migrations >= 080): completion stores a server-derived URL and requires the uploaded object. |
| `t17_rate_limits` (+ `_b`, and the t17 concurrency step in run.sh) | 081 (runs when migrations >= 081): `claim_phone_upload_token_issue` is service_role-only and SECURITY DEFINER, anon surface still 3 functions, `phone_upload_org_rate` has no API grants; per-session burst (5 / 10 s) with window reset, lifetime cap (20, then refused until expiry), per-org window (60 / 60 s) with reset and isolation, inactive/invalid tokens never counted, refusals write nothing; then parallel psql sessions: 40 claims queued behind a held row lock -> exactly 5, 70 claims over 14 sessions -> exactly 60, 6 creates at 118/120 -> exactly 2; per-user creation limit (120 / rolling hour, PT429). docs/selfhost-migration/phase-f/rate-limiting.md |
| `t18_auth_link` (+ `_b`, `t18_bootstrap`) | 082 (runs when migrations >= 082): `create_app_user` links only a fresh (≤ 15 min, never signed in) account marked `app_metadata {created_via: staff-admin, org_id: caller org}` with the same email, not linked anywhere, not a platform admin, not the caller; already-linked / other org / orphan / old signed-in / stale / platform-admin / wrong-email / own / missing accounts refused; TOTP caller on aal1 refused, aal2 OK; email-2FA ADMIN without a code consumed after the session's sign-in (or without `amr`) refused; cashier / manager / orphan / anon refused; direct `INSERT`/`UPDATE` of `users.auth_id` as authenticated refused (`AUTH_ID_READ_ONLY`), service_role still allowed; inventory unchanged (3 anon functions, 30 keyed RPCs). Then 082 is re-applied to the populated database and part B proves every users row is byte-identical. `t18_bootstrap` runs after the t12 bootstrap pair: first-time setup still links the operator's own account. Needs the `auth.mfa_factors` / `auth.jwt()` shims from `00_prep.sql`. docs/selfhost-migration/phase-f/migration-082.md |
| `t19_old_client_compat` | old client v1.0.15 against 081 (runs when migrations >= 081, after t17): the 30 keyed RPCs called with v1.0.15's exact argument names resolve (no PGRST202) and all raise `IDEMPOTENCY_KEY_REQUIRED`, nothing written anywhere; v1.0.15's direct table writes (no `org_id`) land in the caller's org, cross-org stale ids hit 0 rows or are refused, a cashier's and an orphan's old writes are refused (incl. the old first-time-setup `users` insert); the pre-079 phone flow (attach, legacy `temp/` and `products/<foreign>/` paths, client-supplied public URL) works only in the caller's org, legacy paths refused, the client URL never stored. docs/selfhost-migration/phase-f/electron-compatibility.md |

## Adding a test

Append a `tNN_*.sql` file under `sql/` and a `run_sql_test` line in `run.sh`.
Use `test.login(<auth uuid>)` then `SET ROLE authenticated`, `\gset` to
capture responses, `test.check(name, boolean, detail)` for assertions and
`test.expect_error(name, sql, expected_substring)` for failures; `RESET ROLE`
before DB-level counts. Finish with `test.logout()`.

For audit-style assertions that are expected to fail on an older schema use
`test.finding(name, boolean, detail)`, `test.finding_error(name, sql,
expected_substring)` (the statement must raise; success is the finding; a
*different* error is a harness FAIL so the demonstration stays unambiguous)
and `test.finding_succeeds(name, sql)`. `test.col_exists(table, column)`
helps write assertions that are meaningful on both schemas.
