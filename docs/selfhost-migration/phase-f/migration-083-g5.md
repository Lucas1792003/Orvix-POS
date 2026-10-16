# Phase F · Migration 083: product-image upload limits and content check (finding G5)

Date: 2026-10-16. Branch `feature/selfhost-supabase-migration`, local only
(not pushed). **Nothing is deployed.** No migration was applied, no function
was synced, and Envoy was not touched. All server access was read-only:
`storage.buckets` and `storage.objects` metadata (counts, sizes and types,
never names), the deployed function directory list, the Envoy template and
the storage container's `FILE_SIZE_LIMIT` (read by its exact name). Every
mutating test ran in a disposable environment on the Mac.

Finding: [org-isolation-security-audit.md §6 G5](org-isolation-security-audit.md#g5-coordinator-finding-2026-10-16--public-image-bucket-accepts-any-file-type-and-size).

| File | Change |
|---|---|
| `supabase/migrations/083_product_images_upload_limits.sql` | new (sha256 `350eeb12c40931de7b779d8775d0fff7eed70ba218857652460e4d7bcaa6973c`): bucket limits with a guard; completion RPC becomes service_role only |
| `supabase/functions/phone-upload-token/index.ts`, `imageCheck.ts` (new) | `{token, action:"complete"}`: reads the stored object back, checks its bytes, deletes it if refused, then completes with the service role |
| `supabase/functions/phone-upload-page/client.js` | completion goes through the function instead of the RPC |
| `src/lib/productImagePhoneUpload.ts` | the React twin does the same (`completeProductImageUploadSession`) |
| `deploy/lucashome/envoy-storage-public-headers.yaml` (new) | **optional, separate** gateway rule for `/storage/v1/object/public/` (§5) |
| `deploy/lucashome/tests/envoy-storage-headers-test.sh` (new) | runs that rule on Envoy v1.39.1 locally |
| `supabase/tests/phase-d/sql/t20_upload_limits{,_b,_c}.sql` (new), `run.sh`, `01_test_schema.sql`, `t01`, `t12`, `t14`, `t15`, `t16`, `t17`, `t18`, `t19` | t20 tests and the guard re-apply; older tests now simulate the phone's completion as service_role from 083 on (`test.completer()`) |
| `supabase/tests/functions/_harness.ts`, `phone_upload_token_test.ts`, `phone_upload_page_test.ts`, `image_check_test.ts` (new) | storage mock GET/DELETE; 13 new tests |
| `src/lib/phoneUploadPageClient.test.ts`, `src/lib/productImagePhoneUpload.test.ts` | 7 new tests |
| `tools/security-audit/suites/storage.ts`, `phone.ts` | G5 cases on the real storage-api: desktop path, signed URL path, and completion |
| `e2e/d-phone-upload.e2e.ts` | ledger counts completion calls to the function; D-g5-* cases skip unless schema ≥ 083 |

## 1. Measurements (production, read-only, 2026-10-16)

| What | Value |
|---|---|
| `product-images` bucket | `public = t`, `file_size_limit = NULL`, `allowed_mime_types = NULL` |
| storage-api server-wide limit | `FILE_SIZE_LIMIT=52428800` (50 MiB), storage-api v1.74.0, file backend |
| objects | **574**: 561 `image/webp`, 13 `image/jpeg`. None has missing metadata, none is over 100 KB, none is over 128 KB |
| object size | total 5,333,131 B; **max 40,735 B** (a JPEG); max WebP 24,084 B; avg 9,291 B; p99 30,350 B |
| paths | 560 `temp/<id>` webp, 13 `temp/<id>` jpeg, 1 `products/<id>/….webp` (all legacy, pre-078) |
| created | all 574 on 2026-10-12 (the hosted → self-host copy) |

What the clients produce: both upload paths re-encode on a `<canvas>`
(`compressProductImage.ts` on the desktop; the `client.js` / React twin on
the phone). They output WebP, or JPEG where WebP encoding is unavailable
(iOS Safari). The longest side is at most 320 px, and the result is
**≤ 102,400 B** (100 KB), checked again before upload. Neither client ever
uploads PNG or an original file. The 080 completion RPC refuses anything
over 100 KB or not WebP/JPEG.

**Limit chosen: `file_size_limit = 5242880` (5 MiB) and
`allowed_mime_types = {image/jpeg,image/png,image/webp}`.** 5 MiB is 51× the
clients' cap and 128× the largest existing object, so a future client change
(larger thumbnails) needs no migration. It is 10× below the server-wide 50
MiB that applies today. PNG is allowed at the bucket because it is a safe
raster type; the phone completion still accepts only WebP/JPEG.

Trade-off, needs a decision: migration 016 set **128 KB** and `{webp,jpeg}`
on a fresh install. 083 loosens a fresh install to 5 MiB and adds PNG, and
tightens production from unlimited. A tighter `131072` (128 KiB) would also
fit every existing object and every client output. It is a one-constant
change in 083 (`c_limit`) plus t20 and the audit fixtures. Recommendation:
5 MiB as briefed. Use 128 KiB if the owner prefers the tightest disk-use
bound.

## 2. Migration 083

1. A guard in a single DO block, so the transaction aborts on any failure:
   - the bucket must exist;
   - no existing object may break the new rules. These are counted by
     mimetype with the largest size and no names: missing metadata, missing
     or non-numeric size, size over the limit, or a type outside the list. A
     JSON object without a `mimetype` key also counts. The first harness run
     caught that an `= ANY` on NULL had let such an object slip through.
   - `storage.objects` is fingerprinted with count + md5 over the whole row,
     for every bucket, before and after the `UPDATE`. The two fingerprints
     must be equal;
   - afterwards the bucket must hold exactly the new values and still be
     public.
2. `UPDATE storage.buckets … WHERE id = 'product-images'`. It only runs when
   a value differs, so a re-run is a no-op.
3. `REVOKE ALL ON FUNCTION complete_product_image_upload_session(…) FROM
   PUBLIC, anon, authenticated`; `GRANT EXECUTE … TO service_role`; a
   `COMMENT` marker; and an assertion on the resulting grants. The body,
   signature, SECURITY DEFINER and return shape stay as in 080.

The migration is idempotent; the phase-d harness applies it twice and then
re-applies it twice more on populated data (§6). Rollback is in §8.

## 3. Content validation: what is checked where

storage-api compares only the **declared** Content-Type (the multipart part
type, or the request header) with `allowed_mime_types`. It never looks at
the bytes. Measured on the audit stack: HTML declared `image/jpeg` is
stored. The database cannot read object bytes either (file backend in the
storage container), so a SECURITY DEFINER check cannot do this.

### 3.1 Phone path: validated and enforced (implemented)

`phone-upload-token` gets a second action, `{token, action: "complete"}`. It
uses the same route, the same anon key and the same origin, so there is no
new Envoy route, router allow-list entry or function directory. It runs the
same checks as a token request: hash lookup, PENDING, not expired, creator
active in its organization, path re-derived as `org/<org>/temp/<id>`, and
product and shop in that organization. It does **not** take a rate-limit
claim. Then:

1. `GET /storage/v1/object/product-images/<path>` with the service role. If
   the object is missing: 409 `not_uploaded`.
2. It reads at most 102,401 bytes, then runs `imageCheck.ts`:
   - the declared type (what storage serves) is `image/jpeg` or `image/webp`;
   - the size is between 1 and 102,400 bytes;
   - the magic number matches the declared type: JPEG `FF D8 FF`, PNG
     `89 50 4E 47 0D 0A 1A 0A` + IHDR, WebP `RIFF….WEBP`;
   - the container is consistent. For WebP, the RIFF size + 8 must equal the
     object size, so nothing may trail the image, and the chunk must be
     `VP8 `, `VP8L` or `VP8X`;
   - **no markup start anywhere**, case-insensitive: `<script <html
     <!doctype <?xml <iframe <object <embed <body <head <meta <style <form
     <link javascript:`, and `<svg` followed by whitespace, `>` or `/`. This
     refuses the JPEG-header + HTML polyglot. Every marker is at least 5
     bytes, so a random 100 KB body matches with a probability around 1e-5.
     A deterministic test of 2,000 pseudo-random 100 KB bodies flags none.
     Canvas output carries no EXIF/XMP text.
3. If the check fails: `DELETE` the object (service role), answer 422
   `invalid_image`, and leave the session **PENDING**. The phone may upload
   another photo to the freed path. A failed delete is logged and the
   session is still never completed.
4. If it passes: `rpc complete_product_image_upload_session` with the service
   role, the server's path, and the measured bytes and type. The 080 checks
   all still run inside the RPC (path, object exists, type and size from
   metadata, trusted URL). The RPC's answer is returned unchanged, so the
   phone sees the same shape as before. A lost race returns 410 with the
   session's status, and the client's existing re-read treats COMPLETED as
   success.

**Enforced:** from 083, anon and authenticated cannot call the RPC, so every
completion passes this check. That includes an old page and a token holder
calling PostgREST directly.

Clients: `client.js` (the page served by the function, used by every
Electron till) and the React twin. The React twin's web build is on Vercel
and still points at hosted, so it is unaffected. Both now POST to the
function for completion.

### 3.2 What the bucket refuses on every path (declared type and size)

These are refused on staff direct uploads and signed upload URLs (both
tested; storage-api applies the same bucket checks to TUS, which the app
does not use and which was not exercised):
`text/html` (with or without a charset), `image/svg+xml`,
`application/octet-stream`, any other type, and anything over 5 MiB. The
audit stack proves this for the desktop raw and multipart uploads and for
the phone signed URL.

### 3.3 Desktop path: residual, documented follow-up (not implemented)

Staff upload directly with their JWT to `org/<org>/products/<id>/<ts>.<ext>`
(upsert true, storage policies 078), then save the public URL in
`products.image_url`. A byte check cannot be enforced here without changing
who may write:

- *Client-side magic-byte check*: bypassable, so not a control.
- *Validator function called before saving the URL*: bypassable by the same
  staff member, who can skip it or write `image_url` directly (an RLS update
  of their own product).
- **Minimal secure design (follow-up).** The desktop uses the phone flow
  itself: create a session, take a token just in time, PUT, complete through
  the function, and save the derived URL. Then a later migration removes the
  staff INSERT/UPDATE storage policies on `product-images`, so only signed
  URLs can write.

  Costs: the brand-logo path and the `products/<id>/` layout change to
  session paths; the 081 rate limits now apply to desktop uploads too;
  `products.image_url` rows keep working. Every till must be updated
  **before** the policy change, otherwise older builds can no longer upload
  images. That is not contained in this change, so it is left for later.

Residual risk: **low.** Only an authenticated member of the organization
with `product:update` can store HTML or polyglot bytes **declared as
image/jpeg/png/webp**, in their own organization's prefix. The object is
attributable through `owner_id`. It is served as `image/*` (measured), and
current browsers do not render an `image/*` response as HTML. The Envoy rule
in §5 makes that explicit (`nosniff` + `sandbox` CSP). The audit records this
as 2 GAP lines of severity low.

Also not covered: an attacker who never calls completion. A phone-token
holder (60 s token, 10 min session) can PUT a declared-image polyglot and
walk away. The object then stays under `org/<org>/temp/<session id>`, served
as `image/*`. Abandoned temp objects are not swept today. A sweep with the
same `imageCheck` (service role, list `temp/`, delete objects whose session
is not COMPLETED and older than the session TTL) is a cheap follow-up.

## 4. Is public read necessary?

Keep it public. The app stores public object URLs in `products.image_url`
(574 objects; 080 derives exactly this URL), and every surface renders them
with plain `<img src>`: POS grid, product forms, receipts and the desktop
preview. Moving to a private bucket means signed URLs at display time. That
changes the desktop, the offline cache (signed URLs expire, so the cache key
changes), every stored URL, and image caching, and it adds a sign call per
image. The benefit is small: thumbnails are not sensitive, and after 083 +
§3 + §5 the public route serves only image-typed content, without sniffing
or script. Org isolation does not depend on it: listing, writing and signing
stay org-scoped (audit area storage).

## 5. Serving-side hardening (optional, separate, NOT applied)

**Measured on the audit stack** (storage-api v1.74.0 directly, no gateway
rule): `GET /storage/v1/object/public/…` → `200`, `Content-Type` = the stored
metadata type (`image/jpeg`), and **no** `X-Content-Type-Options`, **no**
`Content-Disposition`, **no** `Content-Security-Policy`;
`Cache-Control: no-cache`. A declared-`image/jpeg` HTML body is served as
`image/jpeg` (audit check "served with its declared image type, never as
HTML").

**What the phone page's origin exposes.** The phone page, the API and Studio
all share one origin: Studio sits at `/` behind dashboard basic auth
([phone-qr-origin.md](phone-qr-origin.md)).

- The page itself holds only the public **anon key**. It has no session, no
  cookie and no user JWT.
- The session token stays in the URL fragment and is never stored. The only
  localStorage key is `pos-language`.
- Studio is reachable on the same origin. If a browser has cached Studio's
  basic-auth credentials, a script running on this origin could call
  Studio's API with them. That makes "active content served from this
  origin" serious for the **operator's** browser (not the shop staff's), and
  it is the main reason the content type must never be a document type.

After 083, the bucket accepts only image types, and the phone path checks
the bytes. The remaining channel is §3.3 (staff, declared image type), and
browsers do not execute it.

The rule (`deploy/lucashome/envoy-storage-public-headers.yaml`) is a route
placed before the generic `/storage/v1/` route. It covers only
`/storage/v1/object/public/` and copies that route's cluster, rewrite,
timeout, X-Forwarded-Prefix, basic_auth-off and RBAC allow-all settings. It
adds:

- `X-Content-Type-Options: nosniff` (overwrites any upstream value);
- `Content-Security-Policy: default-src 'none'; sandbox`, so a public object
  opened as a document runs nothing and gets an opaque origin, which means
  no access to the origin's Studio session;
- a per-route Lua filter with a unique name (`phf.storage_public_headers`;
  upstream's Lua filters all share the default name, and per-route config is
  looked up by name). For a 2xx with `image/jpeg|png|webp` it sets
  `Content-Disposition: inline`. Any other 2xx gets `attachment` +
  `Content-Type: application/octet-stream`. Error responses keep their JSON
  type.

`<img>` rendering is unaffected: CSP and sandbox apply to documents, and
inline is the default.

**Local proof** (`deploy/lucashome/tests/envoy-storage-headers-test.sh`,
Envoy v1.39.1 = production): **28/28 PASS**. Covered:

- public JPEG/PNG/WebP are `200` without apikey or basic auth, with the
  rewrite intact, inline, nosniff, CSP and Cache-Control passed through;
- HTML, SVG and octet-stream become attachment + octet-stream;
- upstream headers cannot weaken it: exactly one nosniff, one CSP and one
  Content-Disposition;
- HEAD gets the same headers;
- a missing object keeps 400 + JSON;
- the `sign` and `authenticated` routes are untouched;
- `public/../sign` normalises to the sign route;
- an escaped slash is rejected.

## 6. Test evidence

| Suite | Result |
|---|---|
| phase-d harness `supabase/tests/phase-d/run.sh` (all migrations, idempotent double apply) | **672 assertions, 0 failed**, 0 findings (baseline 647: +24 t20, +1 t19). t20: bucket values; other buckets untouched; grants; anon and org ADMIN get `permission denied`; the session row stays byte-identical; service_role (= the function) completes and the trusted URL is stored; a `text/html` object is refused by the RPC as a second line; existing `products.image_url` references still resolve. **Guard:** the bucket is reset to production's NULL/NULL with 4 violators (html, oversize, svg, no metadata). Re-applying 083 **aborts** with `083: 4 existing product-images object(s) violate the new limits: 1 x image/svg+xml (max 900 B), 1 x image/webp (max 5242881 B), 1 x text/html (max 300 B), 1 x <none> (max ? B) - nothing changed`, which names no object. Bucket and objects are unchanged (whole-row digest). With the violators removed, the re-apply succeeds and the object digest is unchanged |
| security audit `tools/security-audit/run.sh --max-migration 083` (real GoTrue / PostgREST / storage-api / edge-runtime) | **exit 0; coverage gate PASS 119/119**, 0 hard gaps. PASS: tables 212, rpcs 36, storage 32, phone 27, functions 28, authlink 6, authz 49, helpers 35, errors 1 (leak scan). 0 FAIL. **2 GAP (low)** = §3.3 desktop residual. New G5 cases: desktop JPEG/PNG/WebP (raw and multipart) accepted; html, html-multipart, svg, octet-stream, html;charset and >5 MiB refused with nothing stored. Phone signed URL: JPEG/WebP complete through the function and the token cannot overwrite (upsert false); html/svg/octet-stream/>5 MiB refused by storage, then completion refused with the session PENDING. `.jpg` with HTML, the JPEG+HTML polyglot and WebP bytes declared JPEG get 422, **object deleted**, session PENDING. anon and org ADMIN calling the RPC directly are refused. Existing image still resolves; serving headers recorded (§5) |
| Deno function tests `supabase/tests/functions/run.sh` | **77 passed, 0 failed** (baseline 64 + 9 completion + 4 imageCheck). Valid JPEG/WebP → RPC with server values and no claim. 12 refused contents (html, svg, octet-stream, `.jpg` HTML, SVG-as-JPEG, polyglot, `<SCRIPT>` mid-JPEG, WebP+trailing HTML, WebP-as-JPEG, PNG, >100 KB, empty) → 422, object deleted, RPC not called, PENDING. Also: recovery to a real photo; not uploaded → 409; completed/expired/foreign-org refused before storage is read; lost race → 410; RPC refusal → 422 / failure → 503 with no details; delete failure still not completed; unknown action → 400 |
| `npx vitest run --exclude '.claude/**'` | **943 passed**, 63 skipped (baseline 936 + 7) |
| `npx tsc -b` | clean |
| Envoy rule `deploy/lucashome/tests/envoy-storage-headers-test.sh` | 28/28 |
| e2e spec D | **not run** (production; needs 083 deployed). Prepared: the function's completion calls go to the `completes` ledger, so existing D cases keep their counts after the deploy. **D-g5-bucket**: bucket values, and anon RPC → permission denied. **D-g5-html-as-jpeg**: HTML and polyglot declared JPEG via the page's own code get PUT 200 → 422, object deleted, PENDING; then a real photo completes and is saved. **D-g5-declared-types**: html/svg/octet-stream PUTs refused, nothing stored. All three `test.skip` unless schema ≥ `083` |

The historic live suites (`src/live/phase-d|g|g2|g3|g4*.live.test.ts`,
skipped by default) assert the pre-083 contract: anon may call the
completion RPC. They will fail on those lines after 083. Update them if they
are ever re-run against a stack at 083.

## 7. Deploy procedure (owner approval needed for each step)

Preconditions: 082 is deployed and verified (the coordinator is doing this
now), and nobody is mid-upload (phone QR open).

1. **Read-only pre-check.** Same predicate as the guard, expecting `0`; also
   confirm the counts and the maximum size:
   ```sh
   ssh <host> "cd /srv/supabase/stack && docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' db psql -X -U postgres -At -c \"
     SELECT count(*) FILTER (WHERE metadata IS NULL OR NOT coalesce(metadata->>'mimetype' = ANY ('{image/jpeg,image/png,image/webp}'), false)
                                OR coalesce(metadata->>'size','') !~ '^[0-9]{1,18}\$'
                                OR CASE WHEN metadata->>'size' ~ '^[0-9]{1,18}\$' THEN (metadata->>'size')::bigint > 5242880 ELSE true END),
            count(*), max((metadata->>'size')::bigint)
       FROM storage.objects WHERE bucket_id = 'product-images'\"" </dev/null
   ```
   Expected output is `0|574|40735`, or more objects if uploads happened in
   the meantime.
2. **Dry run on a throwaway copy.** Take the newest logical backup (step 4
   makes a fresh one; for the dry run, use the latest nightly). Copy it to
   the Mac and restore it into a disposable `supabase/postgres:17.6.1.136`
   container on 127.0.0.1. Run
   `psql -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/083_product_images_upload_limits.sql`
   there, check the `NOTICE 083: … storage.objects unchanged (574)` line and
   the §2 verification queries, then delete the container. If the backup
   lacks the `storage` schema, the phase-d run in §6 (baseline schema +
   storage shim) is the dry run of record, and step 1 stands in for the
   data check.
3. **Functions (before the migration).**
   ```sh
   rsync -a --delete --exclude .DS_Store supabase/functions/phone-upload-token/ <host>:/srv/supabase/stack/volumes/functions/phone-upload-token/
   rsync -a --delete --exclude .DS_Store supabase/functions/phone-upload-page/  <host>:/srv/supabase/stack/volumes/functions/phone-upload-page/
   ssh <host> 'cd /srv/supabase/stack && docker compose restart functions' </dev/null
   ```
   Token first: it is backward compatible, because the new action is unused
   by the old page, and service_role already has EXECUTE on the RPC before
   083. Then the page.

   Smoke test:
   - `deploy/lucashome/functions-router.sh verify` with the anon key: every
     probe PASS, 0 failed;
   - `POST /functions/v1/phone-upload-token {"token":"short","action":"complete"}`
     gives 404 `invalid`;
   - one QA phone upload via the deployed page ends `COMPLETED`.

   Until 083 is applied, this already validates bytes for every phone using
   the new page. Old open pages keep calling the RPC directly, which is
   still allowed before 083.
4. **Migration.**
   `deploy/lucashome/apply-migrations.sh --from 083 --to 083 --dry-run`, then
   without `--dry-run`. The script runs the pre-flight checks, a fresh logical
   + base backup, records the LSN to `migration-checkpoints.txt`, applies in a
   single transaction (the guard aborts everything on violators), records the
   version, applies the default-ACL hardening, lists anon-executable
   functions (expected: `app_setup_needed`,
   `get_product_image_upload_session_by_token`), and takes a post backup.
5. **Verify.**
   - the §2 verification queries: bucket `t|5242880|{image/jpeg,image/png,image/webp}`,
     anon EXECUTE `f`;
   - `tools/security-audit/run.sh --max-migration 083` locally (the parity
     check against production should now show 083);
   - e2e spec D with `E2E_PHONE_FN=deployed E2E_PHONE_PAGE=deployed` (QA data
     only; runs D-g5-*).
6. **Optional, separate approval: the Envoy header rule.**
   1. Back up `volumes/api/envoy/lds.template.yaml`.
   2. Apply EDIT 1 and EDIT 2 from `deploy/lucashome/envoy-storage-public-headers.yaml`.
   3. Run `docker compose up -d --force-recreate api-gw`. The gateway is down
      for a few seconds.
   4. Verify with `curl -sI <origin>/storage/v1/object/public/product-images/<a known object>`.
      Expect `x-content-type-options: nosniff`, the CSP, and
      `content-disposition: inline`; the app's product images must still
      render. Rerun `functions-router.sh verify`.

   Rollback: restore the backup and recreate `api-gw`.

## 8. Rollback

- **Migration** (one statement each; no data was changed):
  ```sql
  UPDATE storage.buckets SET allowed_mime_types = NULL, file_size_limit = NULL WHERE id = 'product-images';
  GRANT EXECUTE ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) TO anon, authenticated;
  COMMENT ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) IS NULL;
  DELETE FROM supabase_migrations.schema_migrations WHERE version = '083';
  ```
  Restoring the bucket values is optional: the limits break no client. The
  grant is needed only if the functions are rolled back too.
- **Functions:** rsync the previous `index.ts` and `client.js` from git
  (`git show <prev>:supabase/functions/phone-upload-token/index.ts`; remove
  `imageCheck.ts`), then restart functions. Roll back the functions **only
  after** re-granting the RPC, because the old page calls the RPC directly.
- **PITR:** the LSN recorded in step 4, as for every migration.

## 9. Residual risks

1. **Desktop path byte check (low):** staff can store markup bytes declared
   as an image type (§3.3). These are served as `image/*`. The follow-up is
   to route desktop uploads through the validated session flow and then drop
   the staff write policies.
2. **Abandoned temp objects (low):** a phone-token holder can upload a
   declared-image polyglot and never complete. A sweep with `imageCheck` is
   the follow-up.
3. **Byte check is heuristic for markup (low):** a polyglot that avoids every
   marker (for example, no tag at all) is still only bytes served as
   `image/*` with nosniff (after §5). The magic number and the WebP size
   check stop "HTML with an image header" from being completed. The marker
   list stops HTML/SVG documents hidden after one.
4. **Same-origin Studio (medium if §5 is skipped):** the API origin also
   serves Studio behind basic auth. Without nosniff/sandbox, a future
   regression that served a document type from the public route would run
   script next to cached Studio credentials. The bucket allow-list prevents
   that today; §5 is defence in depth.
5. **5 MiB vs 128 KiB (decision):** a fresh install gets looser than 016
   (§1).

## 10. Items needing owner approval

1. The size limit: 5 MiB (recommended, as briefed), or 128 KiB.
2. Deploying the two functions (§7.3), then migration 083 (§7.4), in that
   order.
3. The optional Envoy header rule (§7.6), with a few seconds of gateway
   restart.
4. The follow-ups: the desktop validated-upload path with removal of the
   staff write policies, and the temp-object sweep.
