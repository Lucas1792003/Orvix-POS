# Phase G: price levels for new orgs (077), upload security (078–079), anonymous-function audit

**Status 2026-10-12: prepared, not applied.** Nothing here has been run
against the self-hosted stack, the hosted project or any real database. Every database
result comes from the disposable harness (`supabase/tests/phase-d/run.sh`,
throwaway container, synthetic data). Production facts are taken read-only
from the snapshot (`~/shwephala-migration/<ts>/`). The storage-api
facts come from the `supabase/storage-api:v1.74.0` image, which was pulled and
read locally, and from `node_modules/@supabase/storage-js` 2.106.1. Nothing is
committed.

| # | Defect | Fix | Files |
|---|---|---|---|
| 1 | Checkout in a console-created org fails with "No active price level available" | Seed the 030 default levels for every new org (AFTER INSERT trigger) and backfill orgs that have zero levels | `077_new_org_price_levels.sql` |
| 2a | Storage INSERT is not path-scoped, so a user can write into another org's product folder | Org-scoped paths `org/<org>/…` and path-based storage policies | `078_storage_org_paths.sql`, `079_…` (session path), `src/lib/productImageStorage.ts`, `ProductImageInput.tsx` |
| 2b | 574 migrated objects have `owner_id` NULL, so under 071 no org can manage them | Authorize by path → server-side facts (session row, product id, own logo), with a fallback to 071's uploader rule | `078` |
| 2c | A signed upload token outlives its session | Issuing the token is gated by a live session; completion is refused after expiry or cancel. Residual risk documented in §2c (stateless JWT, no revocation) | `078`, `079`, deploy recommendation |
| 2d | `attach_product_image_upload_session_token` runs UPDATE and then RAISE, so the UPDATE is rolled back | Same one-hunk fix as 075 | `079` |
| 2e | New, found during the audit: completion accepts any URL that contains the bucket path | The URL must end with the session's own object path | `079` |
| 3 | Anon EXECUTE grew from 2 to 3 (`app_setup_needed`) | Audited. All three are needed; no grant removed (§3) | `t15_anon_audit.sql` |

Tests: `supabase/tests/phase-d/sql/t13_new_org_price_levels.sql` (+ `_b`),
`t14_upload_security.sql`, `t15_anon_audit.sql`, plus one 077 check in
`t12_bootstrap_check.sql`. `run.sh` gates them as follows: t13 runs when
migrations ≥ 077 and re-applies 077 between part A and part B. t14 and t15 run
when migrations ≥ 079. A run capped at 076 is byte-for-byte the previous run.

---

## 1. Price levels for new organizations (077)

### How price levels work (investigated)

- **030** created `price_levels` (`id, code, name, is_default, is_active, sort_order`). It seeded three rows once, globally:
  - `plv-retail` (`retail` / Retail, `is_default`, sort 10)
  - `plv-wholesale` (sort 20)
  - `plv-special` (sort 30)
- 030 also created `product_unit_prices (product_unit_id, price_level_id → price_levels ON DELETE RESTRICT, shop_id NULL = global, price_mmk)` and backfilled Retail rows from `product_units.sale_price_mmk`.
- `complete_sale` resolves a line price in this order:
  1. the requested level (`price_level_id` in the cart line, or the default level when absent): shop override first, then the global row;
  2. if that finds nothing, fall back to the default level's price (`retail_fallback_shop` / `_global`);
  3. then `product_units.sale_price_mmk` (`legacy_sale_price`).
- **If no level resolves at all, it raises `No active price level available`.** The POS sends no `price_level_id` for the default level, so every ordinary sale needs an active default level in the caller's org.
- `sale_items` stores a snapshot (`price_level_id`, name, source). It has no FK to `price_levels`.
- **068** made `price_levels` per-org:
  - `org_id NOT NULL` with an FK to `organizations` (NO ACTION);
  - per-org unique indexes `price_levels_code_normalized_per_org (org_id, lower(btrim(code)))` and `price_levels_one_active_default_per_org`;
  - a fill-from-caller trigger;
  - `enforce_same_org_refs()` on `product_unit_prices`.
- **072** scoped both `complete_sale` lookups to `org_id = v_user.org_id`.
- Production data (snapshot): the single org `org-shwe-pha-lar` has exactly the three 030 rows (`plv-retail` default, `plv-wholesale`, `plv-special`, all active, sort 10/20/30).

### Root cause

Nothing creates levels for an organization created after 068. That covers the
console's `create_organization` (service_role inserts `organizations` and then
the ADMIN), and also 076's `bootstrap_first_admin` on a fresh install. In such
an org `v_default_level` is NULL, so every sale raises. The harness reproduces
this:

```
PASS t13/077 root cause: an org with no price level cannot complete a sale -- got: No active price level available
```

### Fix (077)

- **`app_seed_default_price_levels(org)`.**
  - SECURITY DEFINER.
  - Inserts the 030 set for one org: `retail`/Retail default 10, `wholesale`/Wholesale 20, `special`/Special 30, all active, with `org_id = org`.
  - Ids are `plv-<random hex>`. They are never derived from the org id, so they can never hit a PK conflict with another org's row.
  - Uses `ON CONFLICT (org_id, lower(btrim(code))) DO NOTHING` on the per-org unique index. It skips the default row if the org already has an active default (the other per-org unique index).
  - Re-runs and retries therefore insert nothing and never raise. It returns the number of rows inserted.
  - EXECUTE: service_role only. It takes an org id, and an authenticated user must not seed another org.
- **`organizations_seed_price_levels()`.** An AFTER INSERT trigger on `organizations` (SECURITY DEFINER, same shape as 068's business_profile seeder). It covers the console, the 076 bootstrap and plain SQL.
- **`price_levels.org_id` FK becomes ON DELETE CASCADE.** Without this, the console's rollback (`organizations.delete()` after a failed ADMIN insert) would fail on the seeded levels and leave an orphan org behind. CASCADE only removes that org's levels. A populated org still cannot be deleted, because `shops`, `products` and `users` FKs block it and `product_unit_prices` is RESTRICT. The FK is rebuilt only when it is not already CASCADE.
- **One-time backfill.** Every org with **zero** levels gets the set. Orgs that already have any level are not touched. In production this inserts 0 rows (one org with 3 levels).
- No cross-org references: only `price_levels` rows with `org_id = NEW.id` are written, and the 068 same-org triggers accept them. t13 also shows that org A still cannot point a price or a sale at org B's level.

### Tests (t13, harness)

- Console path for two QA orgs (service_role): each gets exactly the 030 set, with one active default and distinct ids.
- Re-seeding returns `0/0/0`.
- The existing orgs' levels are unchanged (count + md5 fingerprint).
- **Concurrency**, with two real sessions over dblink (installed in schema `test_dblink`):
  - same org id: the second session blocks on the PK, then fails with `duplicate key … organizations_pkey`, leaving one org with 3 levels;
  - two different orgs in overlapping transactions: each gets its own set.
- Checkout succeeds:
  - in qa1, priced through qa1's own Retail;
  - in qa2, through the default level and through qa2's Wholesale;
  - in the existing org, through its own `pl-retail`.
- Cross-org: `product_unit_prices` pointing at qa2's level is refused for authenticated and for service_role; a sale with qa2's level id is refused (`… is not active`); UPDATE touches 0 rows.
- Console rollback delete works and the seeded levels go with it. A populated org cannot be deleted.
- **Backfill:** run.sh re-applies 077 to the populated database: `INFO 077 backfill: 1 organization(s) without price levels, 3 level row(s) inserted`. Only the zero-level org got rows. Every other org's fingerprint is unchanged, the total went 19 → 22, and that org can now sell.
- The org created by `bootstrap_first_admin` (fresh install) also gets the set (`t12_bootstrap_check`).

## 2. Upload security (078, 079, client)

### 2a. Organization-scoped object paths

| Object | Before | After (new uploads) |
|---|---|---|
| desktop product image | `products/<productId>/<ts>.<ext>` | `org/<orgId>/products/<productId>/<ts>.<ext>` |
| business logo (Profile) | `products/brand/<ts>.<ext>` | `org/<orgId>/products/brand/<ts>.<ext>` |
| phone upload (QR session) | `temp/<sessionId>` (minted by the RPC) | `org/<orgId>/temp/<sessionId>` (minted by the RPC, 079) |

- **Client.**
  - `buildProductImagePath(orgId, productId, mime)` builds the new path.
  - `uploadProductImage(productId, image, orgId)` refuses with "Your organization could not be determined…" when the org is missing or not a single path segment. It never falls back to an org-less path.
  - `ProductImageInput` passes `useAuthStore.currentOrgId`.
  - The phone path needs no client change. Both the desktop modal and the phone page use the server's `storagePath`.

**Storage policies (078).** All four keep their names and stay `TO authenticated`:

| Policy | Rule |
|---|---|
| `product_images_read` (SELECT) | bucket ∧ *manageable* |
| `product_images_insert` (INSERT) | bucket ∧ permission ∧ `app_storage_can_write_path(name)` |
| `product_images_update` (UPDATE) | USING and WITH CHECK: bucket ∧ permission ∧ *manageable* (the CHECK uses the **new** name, so a move or rename into another org's prefix or product folder is refused) |
| `product_images_delete` (DELETE) | bucket ∧ permission ∧ *manageable* |

- *manageable* is `COALESCE(app_storage_object_in_my_org(name), app_storage_owner_in_org(owner_id, owner))`. The path decides when it resolves. Only unresolvable objects fall back to 071's uploader rule.
- *permission* is `product:create ∨ product:update`, unchanged since 016.

`app_storage_can_write_path(name)` allows:
- `org/<own org>/products/<productId>/<file>`, when `<productId>` is not a product of **another** org. A new, unsaved product has no row yet, because ProductFormPage uploads before the first save, and that is allowed.
- `org/<own org>/temp/<sessionId>`, when the caller's own session (`created_by` = caller) is PENDING, unexpired, and its `storage_path` is exactly this name.
- The same two shapes **without** the prefix (`products/…`, `temp/…`). This compatibility branch is for client builds made before this change. Electron builds update through `electron-updater` on their own schedule. Writing under another org's product id or session is still refused.
- Nothing else: empty, `.` and `..` segments, other prefixes, and wrong depths are all refused.

The SECURITY DEFINER helpers:
- `app_storage_object_org(name)` returns the org id. EXECUTE: service_role only, so authenticated callers cannot use it as an "which org owns this" oracle.
- `app_storage_object_in_my_org(name)` returns true / false / NULL and never the id.
- `app_storage_can_write_path(name)`.
- None of them is executable by anon.

### 2b. The 574 migrated objects (owner NULL)

Production facts, from the snapshot, read-only:
- 574 objects: 573 `temp/pimg-…` and 1 `products/prod-1779555606176/…`. `owner` and `owner_id` are NULL on all of them.
- 539 products. 533 have an `image_url`, all of the form `…/product-images/temp/<sessionId>`. Each of the 533 has a session row with that `storage_path`.
- 578 session rows, all with `storage_path = 'temp/' || id`.

**Decision: authorize by path, move nothing.** 078 resolves a legacy path to
an org only through server-side facts:

| Path | Resolved through |
|---|---|
| `temp/<sid>` | the session row with that id **and** `storage_path = name`, then the creator's `users.org_id` |
| `products/<pid>/…` | `products.org_id` |
| `products/brand/…` | the one org whose `business_profile.logo_url` ends with that path |

`products.image_url` is **not** trusted, because any catalog editor can point it
anywhere. No `storage.objects` row is updated: no owner backfill and no
rename. Public URL reads of a public bucket go through storage-api
`getPublicObject` → `asSuperUser()`, which bypasses RLS. Every existing
`image_url` therefore keeps resolving. t14 checks that every `image_url` and
`logo_url` still names an existing object.

Result for production (snapshot arithmetic; verify with the query in 078's header):
- **557 of 573** `temp/` objects resolve to the org. These include all 533 that products display.
- **16 `temp/` objects** have no session row, and the `products/prod-1779555606176/…` object's product does not exist. These **17 objects** are unreferenced orphans.
- With owner NULL, nobody can manage the 17 orphans except service_role or Studio. That is the same as today. Recommendation: review them, then delete them as service_role.
- Durability: the legacy mapping depends on the session rows. **Do not prune `product_image_upload_sessions` rows whose `storage_path` is still referenced by an `image_url`.** No job prunes them today.

Why not backfill `owner_id`: it would be a data migration of storage-api's own
table, made against a guess. It would also make the desktop user who created
the session the "owner", and that user may later be deactivated.
Authorizing by path stays correct for any admin of the org.

### 2c. Signed upload tokens: lifetime and revocation (precise)

What the code does, read from `supabase/storage-api:v1.74.0` `/app/dist` and storage-js 2.106.1:

- **Expiry is a global server setting.** `config.js`: `uploadSignedUrlExpirationTime: parseInt(getOptionalConfigFromEnv("UPLOAD_SIGNED_URL_EXPIRATION_TIME", "SIGNED_UPLOAD_URL_EXPIRATION_TIME") || "60")`. **The default is 60 seconds.**
- `http/routes/object/getSignedUploadURL.js` passes that value to `signUploadObjectUrl(objectName, urlPath, uploadSignedUrlExpirationTime, owner, {upsert})`. **There is no per-request `expiresIn`.**
- `storage-js` `createSignedUploadUrl(path, options?: { upsert })` posts `{}` and has no expiry parameter. Its docstring says "valid for 2 hours", which is the hosted platform's setting.
- `signUploadObjectUrl` first runs `uploader.canUpload()`. That is an INSERT into `storage.objects` **as the calling role, under RLS**, then rolled back (`testPermission`). After that it signs a JWT `{owner, url, upsert, scope: upload}` with the tenant's URL-signing key.
- `uploadSignedObject.js`: `verifyObjectSignature()` checks the signature, the scope, `payload.url === bucket/objectName` and `exp`. **Nothing else: no revocation list and no lookup.** The upload then runs through `request.storage.asSuperUser()` with `owner` taken from the token, so RLS is **not** evaluated for the phone's upload.
- With `upsert:false` (the app never sets it for phone uploads), a token can create **its one path once**. A second upload to an existing object fails, so a token cannot overwrite a completed photo.

**Consequences:**
- A token, once issued, cannot be revoked, short of rotating the JWT/URL-signing secret, which invalidates every token and session.
- Its lifetime is `UPLOAD_SIGNED_URL_EXPIRATION_TIME`. The deployment's compose override does not set it, and upstream `docker-compose.yml` v0.8.2 is not known to set it. **If it is unset on the self-hosted stack, tokens live 60 s**, so a phone upload made more than 60 s after the QR appears would fail with an expired-signature error. **This is unverified. The owner should check it read-only:**
  ```sh
  ssh <ssh-host> 'cd <stack-dir> && docker compose exec -T storage printenv UPLOAD_SIGNED_URL_EXPIRATION_TIME || echo unset'
  ```

**Bounded lifetime (design).** The token is minted when the desktop opens the QR
modal, immediately after the session is created with `expires_at = now() + 10
min`. Setting the storage env to the session TTL bounds the token by the
remaining session life:

```yaml
# the deployment's docker-compose.override.yml (proposal, NOT applied, not in the file)
  storage:
    environment:
      UPLOAD_SIGNED_URL_EXPIRATION_TIME: "600"   # = create_product_image_upload_session TTL (10 min)
```

If the self-hosted stack currently runs at 60 s, this proposal *widens* the window from 60 s to 600 s, while fixing the
likely functional break. Hosted ran at 7200 s. This is an owner decision. Keep
the value ≤ the session TTL in 019/070/079.

**What is enforced server-side (implemented):**
1. **Issuing:** the 078 INSERT rule runs inside `canUpload` as the desktop user. A token is issued only for an own, PENDING, unexpired session whose `storage_path` is exactly the path. Expired, cancelled, completed and foreign sessions get no token (t14).
2. `attach_…_token` refuses inactive sessions (unchanged message, 2d). `_by_token` hands the token out only while PENDING and unexpired, and persists EXPIRED (075).
3. **Completion:** refused after expiry or cancellation (075), and the URL must be the session's own object (079, 2e). An object uploaded late is never attached to a product.
4. The late object lives under `org/<org>/temp/<sid>`, so it resolves to the org and its ADMIN can list and delete it (t14).

**Residual risk (accepted, documented):**
- An already-issued token can still create its single object until the JWT `exp`, even after cancel or expiry. The object is an orphan: never completed and never referenced.
- Bounded by `UPLOAD_SIGNED_URL_EXPIRATION_TIME`.
- Blast radius: one ≤100 KB-claimed object at a fixed, unguessable path inside the session's own org prefix. The bucket's own size and mime limits from 016 still apply.
- A storage policy cannot close this, because the phone's upload bypasses RLS.
- Closing it fully would need storage-api to support revocation, or an Edge Function that issues the signed URL only when the phone presents a live session token (service role), with a short expiry. Neither is available or worth it here.

**Orphan cleanup (optional, service role):** `org/*/temp/*` objects whose session is not COMPLETED, and legacy `temp/*` objects with no session row. Delete them through the Storage API, not with SQL, because a SQL delete leaves the file in the backend.

### 2d. `attach_product_image_upload_session_token` (079 hunk 2)

The inactive/expired branch ran `UPDATE … SET status = CASE … 'EXPIRED' …,
signed_upload_token = NULL … RETURNING` and then `RAISE 'Upload link is no
longer active'`. The RAISE rolled the UPDATE back. 079 removes the dead UPDATE.
The message was already the common one and is unchanged. Expiry stays derived
from `expires_at`, and the non-raising readers (status poll, `_by_token`)
persist it. This is the same reasoning as 075.

t14 checks that a refused attach writes nothing (the row keeps its old token and is derivably expired), and that the body no longer contains the UPDATE.

### 2e. Completion bound to the session's own URL (079 hunk 3)

Before 079, `complete_…` only checked that `p_public_url` *contains*
`/storage/v1/object/public/product-images/`. A token holder could therefore make
the desktop store an arbitrary URL in `products.image_url`, such as an external
host or another org's object. Now the URL must end with that prefix followed
by the session's `storage_path`. The phone page sends
`getPublicUrl(storagePath)`, which always satisfies this. The live tests
(`src/live/phase-*.live.test.ts`) already build the URL the same way.

### 079: how it was generated

`gen079.py` (session scratchpad, not committed, same approach as gen070/072/075)
copies three bodies byte-for-byte and asserts that each diff is exactly one hunk.

<details><summary>generator output (the three hunks)</summary>

```
--- create: 1 hunk
@@ -23,0 +24,4 @@
+
+  -- 079: organization-scoped object path (078 storage policies:
+  -- org/<org>/temp/<session>). Minted here, never by the client.
+  v_storage_path := 'org/' || v_user.org_id || '/temp/' || v_session_id;
--- attach: 1 hunk
@@ -33,5 +33,4 @@
-    UPDATE product_image_upload_sessions
-       SET status = CASE WHEN status = 'PENDING' THEN 'EXPIRED' ELSE status END,
-           signed_upload_token = NULL
-     WHERE id = v_session.id
-     RETURNING * INTO v_session;
+    -- 079 (same fix as 075): no UPDATE here - the RAISE rolls back the whole
+    -- call, so the EXPIRED stamp / token clearing could never persist.
+    -- Expiry is derived from expires_at by every reader; the non-raising
+    -- readers (get_product_image_upload_session_status/_by_token) persist it.
--- complete: 1 hunk
@@ -53,0 +54,8 @@
+  -- 079: the URL handed to the desktop must be THIS session's object (a
+  -- token holder could otherwise substitute any URL containing the bucket
+  -- path, e.g. on another host). getPublicUrl(storagePath) always ends so.
+  IF right(p_public_url, length('/storage/v1/object/public/product-images/' || v_session.storage_path))
+     IS DISTINCT FROM '/storage/v1/object/public/product-images/' || v_session.storage_path THEN
+    RAISE EXCEPTION 'Uploaded image URL does not match this upload session';
+  END IF;
+
```
</details>

Sources: `create` from 070 (deployed), `attach` from the production snapshot
(unchanged since 019), `complete` from 075 (deployed). Signatures, return
shapes, SECURITY DEFINER, search_path and grants are unchanged.

## 3. Anonymous-function audit

anon can EXECUTE exactly these three (t15, also t01):

| Function | Why anon | What it reveals | Decision |
|---|---|---|---|
| `app_setup_needed()` | `/setup` must decide **before any sign-in** whether to show the form. `bootstrapFirstAdmin()` signs in and **signs up** only after the server says the install is empty. The login page uses it to show the "first-time setup" link | One boolean: whether `public.users` is empty. On a populated install (production) it is always `false`. The body reads only `users` (t15 checks the source) | **Keep anon** |
| `get_product_image_upload_session_by_token(token)` | The phone has no session | For a valid token: `sessionId, storagePath, publicUrl, bytes, mimeType, uploadToken, expiresAt, status`. Since 079, `storagePath` contains the org id. Nothing else: no shop, product, creator, org name or business data (t15). For anything else: `Invalid upload link` | **Keep** |
| `complete_product_image_upload_session(…)` | The phone has no session | The same 8 fields. Writes only that one session, only while PENDING and unexpired, only for the session's own path and URL | **Keep** |

**Why `app_setup_needed` stays anon.** If it moved behind `authenticated`, `/setup`
could only ask *after* signing in. On a fresh install the operator has no
account yet, so the page would have to call `auth.signUp()` first, and then
learn that setup is not needed. On a populated install every visit to
`/setup` would then create an orphan GoTrue account. That reintroduces the
Phase E finding that 067 fixed (`login-signup-fix.md`). The login page's
pre-sign-in call is only a UX hint, but dropping it would not reduce exposure
while `/setup` needs the grant. The bit it reveals carries no capability: on an
empty install, anyone who can sign up can call `bootstrap_first_admin()`
directly, with or without the hint. That RPC is not anon-executable, takes an
install-wide lock and re-checks emptiness itself. No migration or client change
was made for the audit.

**What an unauthenticated caller can do (t15, harness, populated install):**

| Question | Result |
|---|---|
| Discover organization info | anon reads **0 rows from all 34** public tables/views and `storage.objects` (3 are permission-denied, the rest are RLS-empty). `app_setup_needed()` answers `false` and nothing more |
| Trigger setup after initialization | `bootstrap_first_admin` → `permission denied` for anon. For a freshly signed-up account → `SETUP_ALREADY_COMPLETED`. Direct `INSERT organizations` / `users` is refused (RLS / grants) |
| Create privileged accounts | GoTrue signup is open on the self-hosted stack (`DISABLE_SIGNUP=false`, autoconfirm; the app creates staff through `auth.signUp`), so anyone with the public anon key can create an **auth** user. Such an account has `app_role/app_org_id/app_user_id` NULL and no permission. It reads 0 rows everywhere, cannot enrol itself as ADMIN (047 guard) or as CASHIER/MANAGER (020 rules / RLS), cannot create an org, `create_app_user`, `open_shift` or an upload session, and cannot write any storage object. Nothing is created |
| Access another org's upload session | The token is 128 hex chars from 4 × `gen_random_uuid()` (4 × 122 random bits). Only its SHA-256 is stored. Lookup is by hash equality. A random well-formed token, a short token, the stored hash or the session id all give `Invalid upload link`, and failed guesses change nothing. Guessing is infeasible |
| Read sensitive data | `product_image_upload_sessions` (signed tokens), `idempotency_keys`, `admin_login_codes`, `platform_admins`, `users`: 0 rows or permission denied |

Noted (not changed):
- The storage path, and therefore every public image URL, contains the org id. Console orgs use an opaque `org-<uuid hex>`. Production's id is `org-shwe-pha-lar`, a slug of the business name that is printed on receipts anyway. A public URL grants nothing. Use an opaque id for future orgs (the console already does).
- Open GoTrue signup lets anyone create auth users. They are inert, as shown above, but they are clutter. It is needed for staff creation today.

## 4. Results (real outputs)

Harness, all migrations (062–079, each applied twice):

```
applied 077_new_org_price_levels.sql
applied 078_storage_org_paths.sql
applied 079_upload_session_org_paths.sql
re-applied 077_new_org_price_levels.sql OK
re-applied 078_storage_org_paths.sql OK
re-applied 079_upload_session_org_paths.sql OK
...
==> re-applying 077 to the populated database (backfill must touch only the org with zero levels)
INFO 077 backfill: 1 organization(s) without price levels, 3 level row(s) inserted
...
PASS t12/077: the organization created by bootstrap_first_admin got the default price levels (Retail default)
assertions: 467  failed: 0  findings: 0 of 103 isolation checks  aborted steps: 0  migrations capped at: 999  image: supabase/postgres:17.6.1.136
RESULT: PASS
```

The new assertions are 96 lines in t13/t13b/t14/t15 plus 1 in t12 (467 − 371).
All PASS. Selected lines:

```
PASS t13/077 root cause: an org with no price level cannot complete a sale -- got: No active price level available
PASS t13/077: re-running the seed for an org that has its levels inserts nothing (no duplicates) -- reseed=0/0/0
PASS t13/077 concurrent: same org id from two sessions -> the second waits and fails, exactly one org with 3 levels -- c2 busy=1 err=ERROR:  duplicate key value violates unique constraint "organizations_pkey"
PASS t13/077: checkout in console-created org-qa1 succeeds, priced through ITS OWN Retail default
PASS t13/077 console rollback: DELETE of a just-created org succeeds and its seeded levels go with it (FK CASCADE) -- levels before=3 deleted orgs=1
PASS t13/077 backfill: every org that already had levels is unchanged (count + checksum) -- orgs=org-alpha,org-beta,org-qa-c1,org-qa-c2,org-qa-same,org-qa1,org-qa2,org-test,org-two
PASS t13/077 backfill: exactly 3 rows were added in total -- before=19 after=22
PASS t14/078 legacy: org-test ADMIN lists its own owner-less legacy objects (temp session, product folder, logo)
PASS t14/078 legacy: nothing was moved or renamed - the bucket is still public and every products.image_url / logo_url still names an existing object
PASS t14/078: org-test ADMIN cannot create objects in org-two's PRODUCT folder (own prefix or legacy layout)
PASS t14/078: org-two ADMIN cannot MOVE its object into org-test's prefix (UPDATE ... SET name, WITH CHECK) -- got: new row violates row-level security policy for table "objects"
PASS t14/078: an expired or cancelled session's path cannot be signed (no new storage upload token)
PASS t14/079: completion with a URL of another host / object is rejected -- got: Uploaded image URL does not match this upload session
PASS t14/079: active session end to end - attach, by-token (upload token + same path), upload, complete, desktop poll
PASS t14/079: completion after expiry is refused even though the object was written -- got: Upload link is no longer active
PASS t15: anon executes exactly app_setup_needed + the two token-scoped phone RPCs -- app_setup_needed,complete_product_image_upload_session,get_product_image_upload_session_by_token
PASS t15 anon: reads ZERO rows from every public table/view and storage.objects (organizations, users, shops, business_profile, catalog, sessions, keys ...) -- relations=34 permission-denied=3 leaks=none
PASS t15 signup account: reads ZERO rows from every public table/view and storage.objects -- leaks=none
PASS t15 anon: a valid by-token response carries only the 8 upload fields - no shop, product, creator, org name or business data -- storagePath=org/org-test/temp/pimg-e7306691a7bd446aaec80ee126f0328c
```

Harness, capped at 076 (the deployed schema; t13–t15 skipped). The assertion
names are identical to the run made before this work (diffed):

```
==> skipping t13_new_org_price_levels (migrations capped at 076 < 077)
==> skipping t14_upload_security / t15_anon_audit (migrations capped at 076 < 079)
assertions: 371  failed: 0  findings: 0 of 103 isolation checks  aborted steps: 0  migrations capped at: 076  image: supabase/postgres:17.6.1.136
RESULT: PASS
```

Partial applies, to check that each file stands alone: cap 077 gave 396 / 0 PASS, and cap 078 gave 396 / 0 PASS (078 without 079, with legacy `temp/` session paths).

Client:
- `npx tsc -b` exit 0.
- `npx eslint` on the touched files exit 0.
- `npm test`: 72 files passed / 3 skipped, **744 passed** / 32 skipped. That is 741 + 3 new `productImageStorage` tests. The extra skipped file (`src/live/phase-g2.live.test.ts`, 4 tests) is an untracked live suite that appeared during this session and is not part of this change.

Other harness edits:
- `02_seed.sql`, `t09`, `t11`: drop 077's auto-seeded levels for orgs that stand for pre-077 orgs, because they build their own RETAIL default. These are guarded no-ops before 077.
- `t01`: function inventory +2 (077) / +3 (078); the service_role-only helpers are added to the "authenticated cannot execute" list. All conditional.
- `t12`: completion URLs are built from each session's `storagePath`, as the phone does, because 079 requires it.
- `README.md`: rows for t12–t15.
- `src/live/phase-d.live.test.ts` accepts `temp/<id>` or `org/<org>/temp/<id>` and reads the session's own `storage_path` for its cleanup check.

## 5. Apply order, compatibility, command

**Order:** 077, 078, 079. They are independent. Each is idempotent and safe to
re-run. Apply them in one window and one transaction:

```sh
<deployment>/apply-migrations.sh --from 077 --to 079 --dry-run
<deployment>/apply-migrations.sh --from 077 --to 079      # after owner approval only
```

Then run the VERIFICATION queries in each file header, in particular:
- 077: every org has levels and exactly one default; the production org's fingerprint is unchanged.
- 078: `SELECT public.app_storage_object_org(name) AS org, count(*) FROM storage.objects WHERE bucket_id='product-images' GROUP BY 1;` should give 557 for the org and 17 NULL, if the snapshot still matches.
- Live smoke test as the ADMIN: desktop image upload, phone QR upload (after the §2c env check), logo upload, deleting an old product image.
- First sale in a console-created QA org.

**Client and server compatibility:**

| Combination | Behaviour |
|---|---|
| 077 alone | Transparent. New orgs can sell. Existing orgs unchanged |
| 078 + **old** client (web or Electron) | Desktop uploads (`products/<own or unsaved id>/…`) and logo uploads keep working (legacy branch). Writing into another org's product folder is now refused |
| **new** client (`org/…` paths) without 078 | Works. 071's INSERT is permission-only and reads go by uploader |
| 079 + any client | Works. The session path comes from the server. 079 without 078 also works (071 INSERT is permission-only) |
| old phone page + 079 | Works. It sends `getPublicUrl(storagePath)`, which matches the new URL rule |
| Future: legacy INSERT branch removed | Only after every till runs the `org/` build. Old desktop uploads would then fail closed. Follow-up: in `app_storage_can_write_path`, make the `ELSE v_rel := v_parts;` branch `RETURN false`, so only `org/` paths can be written. Not prepared as a migration |

**Which build ships with which migration:** the web build and Electron release
containing the `productImageStorage.ts` change can ship before or after 078.
Neither order breaks uploads. The isolation gain against *tampered* clients
comes from 078 alone. The `org/` layout matters for future cleanup and for
removing the legacy branch. Ship the client in the same release train.

**Rollback:**
- **079:** re-run 070's `create_…`, 019's `attach_…` and 075.
- **078:** re-run 071. The helpers may stay. `org/…` objects keep working under the uploader rule.
- **077:** drop the trigger and the two functions (header). The FK may stay CASCADE. The seeded rows are ordinary levels; leave them.

None of the three needs a data rollback. No storage object was touched.

## 6. Files

- `supabase/migrations/077_new_org_price_levels.sql`
- `supabase/migrations/078_storage_org_paths.sql`
- `supabase/migrations/079_upload_session_org_paths.sql` (generated)
- `src/lib/productImageStorage.ts` (+ test), `src/components/forms/ProductImageInput.tsx`, `src/live/phase-d.live.test.ts`
- `supabase/tests/phase-d/sql/t13_new_org_price_levels.sql`, `t13_new_org_price_levels_b.sql`, `t14_upload_security.sql`, `t15_anon_audit.sql`. Edited: `02_seed.sql`, `t01`, `t09`, `t11`, `t12_remaining_fixes.sql`, `t12_bootstrap_check.sql`, `run.sh`, `README.md`
- Generator (scratchpad, not in the repo): `gen079.py` + `hdr079.sql`; inputs are the snapshot, 070 and 075
