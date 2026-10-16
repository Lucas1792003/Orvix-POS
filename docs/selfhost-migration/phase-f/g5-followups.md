# Phase F · G5 follow-ups: validated desktop uploads (084), abandoned-upload sweep, Studio isolation

Date: 2026-10-16. Branch `feature/selfhost-supabase-migration`, local only
(not pushed). **Nothing is deployed.** Migration 084 is prepared, not
applied; the sweep is not scheduled; the Studio change is not applied. Server
access was read-only (counts only, no object names).

Follows [migration-083-g5.md](migration-083-g5.md) §9: residual risk 1
(desktop uploads are not byte-validated) and 2 (abandoned phone uploads stay
public), and checklist item A6d (Studio on the shared origin).

| File | Change |
|---|---|
| `src/lib/productImageStorage.ts` | desktop upload = validated session flow; returns only the server-derived URL (`trustedProductImageUrl`) |
| `src/lib/productImageBucket.ts` (new) | bucket constant (breaks the import cycle with `productImagePhoneUpload.ts`) |
| `src/components/forms/ProductImageInput.tsx` | calls the new flow with the shop; no client-side org/path |
| `supabase/migrations/084_product_images_validated_writes_only.sql` (new) | drops staff INSERT/UPDATE storage policies; readiness + safety guards. sha256 `5a1371009cd96147147f7422f9be6742ceed50c09211eba85664b5c4b8782874` |
| `deploy/lucashome/backup/sweep-abandoned-uploads.{sh,sql}` (new) | abandoned-upload cleanup (dry run by default) |
| `deploy/lucashome/backup/sweep-protected-objects.sha256` (new) | allow-list: sha256 of the 574 migrated object names (no names) |
| `deploy/lucashome/backup/deploy.sh` | also copies the two sweep data files (not run) |
| `supabase/tests/phase-d/sql/t21_*.sql` (new), `run.sh`, `01_test_schema.sql` (`test.m084()`), `t09`, `t14`, `t19` | 084 + sweep tests; older storage assertions version-aware |
| `supabase/tests/functions/phone_upload_token_test.ts` | 4 desktop-flow tests |
| `src/lib/productImageStorage.test.ts` | rewritten for the new flow |
| `tools/security-audit/suites/{storage,seed,main}.ts`, `sweep.ts` (new), `coverage/static-map.json` | desktop flow + 084 cases on the real stack; sweep run for real; gate requires `sweep:abandoned-uploads` |
| `e2e/g-desktop-upload.e2e.ts` (new) | prepared Electron cases, skipped until deployed |
| `docs/selfhost-migration/phase-f/studio-isolation.md` (new), `deploy/lucashome/studio-isolation/*`, `deploy/lucashome/tests/envoy-studio-isolation-test.sh` | Studio isolation plan + prepared config (§3) |

## 1. Desktop uploads through the validated flow

### 1.1 Design

The desktop now uses the phone's flow, acting as its own "phone". No new
server code is needed: the server pieces already exist and already decide
everything.

1. `create_product_image_upload_session(p_shop_id, p_product_id)` with the
   staff JWT. The server checks the permission (`product:create|update`), the
   organization of the shop and product (068 `app_require_org`), the 081
   per-user session limit, and mints `org/<caller org>/temp/<session>`. The
   client sends no org and no path. The logo uses `p_product_id = 'brand'`
   (unknown ids are a no-op in `app_require_org`, as for the phone QR).
2. `phone-upload-token {token}`: same checks as for a phone (hash lookup,
   PENDING, unexpired, creator active in the org, path re-derived, product and
   shop in the org, 081 rate-limit claim). Signs that one path with the
   service role, `upsert` false.
3. Signed PUT. storage-api applies 083's declared-type and size limits.
4. `phone-upload-token {token, action:"complete"}`: reads the bytes back,
   `imageCheck.ts` (magic number, ≤ 100 KB, no HTML/SVG markup). A refused
   object is deleted (422 `invalid_image`). A valid one is completed by the
   080 RPC as service role, which stores and returns the URL derived from
   `app_config`.
5. The client accepts the answer only when it is COMPLETED, for the path the
   server minted, and its URL is exactly
   `<http(s) origin>/storage/v1/object/public/product-images/<that path>`, with
   no query, fragment or credentials (`trustedProductImageUrl`). That URL is
   what the form saves in `products.image_url` / `business_profile.logo_url`.
   If any step fails, the session is cancelled (best effort), so its object,
   if any, becomes a sweep candidate (§2).

The function's `Authorization` header is never trusted. The desktop sends
its user JWT, the phone sends the anon key, and both are handled the same way
(Deno test). Only the session token in the body selects anything.

Why not a new `image-upload` function: it would duplicate `imageCheck.ts`,
the org checks and the completion. The session path is already the
caller-scoped, server-derived object. Reusing it keeps one validator and one
code path, and adds no new route, router allow-list entry or Envoy change.

Costs:
- desktop images now live at `org/<org>/temp/<session>` like phone images;
  existing `products/` objects keep working;
- 081 limits now cover desktop uploads too (120 sessions per user per hour;
  per-session burst 5 / 10 s; per-org 60 tokens per minute). One upload uses
  one session and one token, so normal catalog work stays far below them;
- the per-upload request count goes from 1 to 4.

### 1.2 Migration 084 (prepared, NOT applied)

`084_product_images_validated_writes_only.sql`:

- `DROP POLICY IF EXISTS product_images_insert, product_images_update` on
  `storage.objects`. `product_images_read` (listing, download signing) and
  `product_images_delete` (cleanup by the org) stay as they are. Public URL
  reads are unchanged.
- Afterwards no API role can INSERT, UPDATE, upsert, move, or mint a signed
  upload URL (`createSignedUploadUrl` runs the INSERT check) on
  product-images. The only writer is a signed URL minted by
  `phone-upload-token` with the service role.
- `app_storage_can_write_path` is kept for rollback and gets the `084:`
  comment marker.

Guards (each aborts the whole transaction, with counts only, never names):

| Guard | Why |
|---|---|
| storage schema and bucket present | as 083 |
| 083 applied (the RPC carries its `083:` comment) | the validated completion must exist first |
| RLS **enabled** on `storage.objects` | without RLS, dropping policies would allow writes |
| **readiness**: no product-images object at a direct-upload path (`(org/<org>/)products/<id>/<file>`) **with an uploader (owner)** created in the last 14 days | the footprint of a till still on an old build; the 574 migrated objects have no owner, and the validated flow writes only `temp/` paths. Override after confirming every till: `SET phf.g5_084_force = 'on'` / `PGOPTIONS='-c phf.g5_084_force=on'` |
| after the drop: no INSERT/UPDATE/ALL policy on `storage.objects` names product-images or lacks a bucket restriction; read + delete present | nothing else can admit a write |
| whole-row fingerprint of `storage.objects` before = after | no object row changes |

Idempotent: re-running is a no-op success (tested).

Production now (read-only, 2026-10-16): schema 082, 581 product-images
objects (574 migrated + 7 under `org/<org>/temp/`), **0** owner-stamped
direct uploads (none in the last 14 days either), policies
read/insert/update/delete. So today the readiness guard would pass. It
catches only an old till that is actively uploading; it cannot prove that an
idle old till is gone. The operator still has to confirm the till builds
(§4).

Rollback: re-run the `product_images_insert` / `product_images_update`
blocks of 078 (or the whole 078 file, which is idempotent). No data changes.

### 1.3 Impact on old clients (why the order matters)

| Client | Before 084 | After 084 |
|---|---|---|
| this build (validated flow) | works | works |
| builds with direct upload (all current tills) | works, unvalidated | **desktop image + logo upload fail (403)** |
| pre-JIT builds whose desktop signs the phone URL | works | **phone QR upload fails too** (signing needs the INSERT policy) |
| JIT phone page (`phone-upload-page`) | works | works (service-role signing) |
| image display, existing URLs | works | works |

## 2. Abandoned-upload cleanup

### 2.1 What is removed

`deploy/lucashome/backup/sweep-abandoned-uploads.sh` (Bash + stdlib Python,
like the other backup jobs). The candidate query is
`sweep-abandoned-uploads.sql`. It runs in a `BEGIN TRANSACTION READ ONLY`
(proven: an injected write is refused). An object is a candidate only when
**all** of these hold:

1. bucket `product-images`, name exactly `org/<org>/temp/pimg-<32 hex>`
   (the server-minted layout since 079);
2. a session row with `storage_path` = the name, id = the last segment, and
   a creator whose org = the org segment;
3. never completed: status ≠ COMPLETED, `completed_at` and `public_url`
   NULL; EXPIRED, CANCELED, or PENDING past `expires_at` (such a session can
   never complete: the RPC refuses it, so there is no race with completion);
4. the session was created, the session expired, and the object was created
   all more than the grace period ago (default 24 h, minimum 1 h; sessions
   live 10 min).

Kept and reported, never deleted: abandoned-shaped objects that a
`products.image_url`, `business_profile.logo_url` or session `public_url`
points at (`kept_referenced`, for manual review).

### 2.2 How existing data is protected (three independent layers)

1. **Path pattern.** All 574 migrated objects are `temp/<id>` (573) or
   `products/<id>/…` (1); the 17 historical orphans are among them. None
   matches `^org/…/temp/pimg-<32 hex>$`, and the query requires a session
   row, which orphans by definition do not have.
2. **References.** Anything referenced by a product, a logo, or a completed
   session is never a delete candidate.
3. **Allow-list file.** `sweep-protected-objects.sha256`: the sha256 of each
   of the 574 object **names**, generated read-only from the migration's
   storage manifest (`--make-allow-list <manifest> <out>`; manifest sha256 in
   the file header). No names in git. The script refuses to run if the file
   is missing, malformed, or its line count differs from its `# count:`
   header. Any matching name is skipped (`kept_allow_listed`).

Further safety:
- the query runs twice (before deciding, right before deleting), and only
  names that are `delete` both times are removed;
- `--max-delete` (default 500): a larger set aborts the whole run with
  nothing deleted;
- deletion goes through storage-api (`DELETE /storage/v1/object/product-images`
  with `prefixes`, service role, batches of 50), so the row and the file go
  together. Afterwards it checks that none of the names is still present;
- the service key is read from `stack/.env` by its exact name and sent to
  curl through `-K -` on stdin (not in argv). It is never printed;
- output is counts only: candidates, delete, bytes, by status,
  kept_referenced, kept_allow_listed. Names are never printed;
- a lock directory prevents overlapping runs. Session rows are kept as an
  audit trail.

### 2.3 Usage (not scheduled)

```sh
ls$ /srv/supabase/backup/bin/sweep-abandoned-uploads.sh                    # dry run: counts only
ls$ /srv/supabase/backup/bin/sweep-abandoned-uploads.sh --apply            # delete (owner approval)
ls$ … --grace-hours 48 --max-delete 100                                     # tighter
```

Production today (read-only): one product-images object belongs to a
session that never completed. A dry run on the server would show whether it
is past the grace period.

### 2.4 Tests

- **Harness t21 sweep:** 15 session fixtures, plus an object without a
  session and one in another bucket, run through the real query file. The
  result is exactly 4 `delete` (EXPIRED, CANCELED, stale PENDING, both orgs)
  and 2 `referenced` (product image, other org's logo). Never listed:
  completed, live, inside the grace period (by session or object age),
  wrong org segment, legacy `temp/`, bad id, sub-path, no session. Read-only
  proven.
- **Audit stack, area `sweep` (real storage-api, real script):** 12 PASS. It
  refuses a missing or malformed allow-list and a grace below 1 h. The dry
  run reports delete=3, kept_referenced=1, kept_allow_listed=1 and deletes
  nothing. The committed 574-name list is accepted. `--max-delete 2` refuses
  as a whole. `--apply` deletes exactly the 3 (rows gone, public URL no longer
  200). Completed, recent, referenced and allow-listed objects are still
  served, and every other object (seeded legacy/brand/org objects) is
  unchanged by name+id digest. No name or key appears in any output, session
  rows are kept, and a second run deletes 0.

### 2.5 Scheduling later

After the owner approves: deploy with `backup/deploy.sh`, take one dry run
and review it, run `--apply` once by hand, then add for example
`40 3 * * * /srv/supabase/backup/bin/sweep-abandoned-uploads.sh --apply >>/srv/supabase/backups/logs/cron.log 2>&1`
to `crontab.lucario`. Not added now.

## 3. Studio isolation

See [studio-isolation.md](studio-isolation.md). In short:
- Studio, `/api/mcp`, `/mcp` and `/pg/` are removed from the shared Envoy
  listener and replaced by a final plain-404 route. Without that route an
  unmatched path would still get a 401 password prompt.
- Studio is published on `127.0.0.1:54323` only and reached with `ssh -L`.
  Stopping it when unused is optional.
- Prepared files are in `deploy/lucashome/studio-isolation/`. The local Envoy
  v1.39.1 test passed 58/58.
- **Gate S:** this must be applied and verified before any public exposure
  (Cloudflare Tunnel, Funnel).

## 4. Rollout order and approvals needed

| Step | What | Approval |
|---|---|---|
| 0 | 083 + the two functions deployed and verified ([migration-083-g5.md §7](migration-083-g5.md)) | in progress (coordinator) |
| 1 | Ship this client build (validated desktop flow) to **every** till and the web build. Verify one desktop upload per till: `org/<org>/temp/<session>` object, session COMPLETED, `products.image_url` = derived URL. e2e spec G (`G-desktop-validated`, `G-desktop-polyglot`) | owner |
| 2 | Prove every till: register + one desktop test upload per till, then `deploy/lucashome/verify-till-readiness.sh` must say **GO** ([till-readiness-084.md](till-readiness-084.md)); it includes 084's 14-day predicate | owner |
| 3 | Pre-check (read-only): the readiness predicate of 084 → `0`. Dry run `apply-migrations.sh --from 084 --to 084 --dry-run`, then apply | owner |
| 4 | Verify: 2 storage policies; a direct upload with a staff JWT → 403; the validated flow still works; audit `--max-migration 084`; e2e `G-084-direct-refused` | — |
| S1 | Deploy the sweep files (`backup/deploy.sh`), dry run, review counts | owner |
| S2 | First `--apply` by hand; then optionally the cron line (§2.5) | owner |
| T | Studio isolation ([studio-isolation.md §7](studio-isolation.md)); **before** any public exposure | owner |

Steps 1–4 are strictly ordered. S and T are independent of 084 and of each
other. S can run as soon as the files are deployed (before or after 083).

Web build note: the Vercel web build still points at the hosted project. If
it is ever rebuilt from this branch while still pointing at hosted, desktop
image upload there needs `phone-upload-token` with the completion action on
hosted. That is out of scope here; it does not affect the tills.

## 5. Test evidence (local / disposable only)

| Suite | Result |
|---|---|
| `npx tsc -b` | clean |
| `npx vitest run --exclude '.claude/**'` | **958 passed**, 63 skipped (baseline 943 + 15) |
| Deno functions `supabase/tests/functions/run.sh` | **81 passed**, 0 failed (baseline 77 + 4 desktop-flow) |
| phase-d harness (all migrations incl. 084, idempotent double apply) | **710 assertions, 0 failed**, 0 findings (baseline 672 + 38: t21 084 state/writes/flow 15, guard cycles 16, sweep 7) |
| security audit `tools/security-audit/run.sh --max-migration 084` | **exit 0; coverage gate PASS 118/118** (2 storage policies at 084 + `sweep:abandoned-uploads`); 458 PASS / 0 FAIL / 0 GAP (storage 51, phone 27, sweep 12, tables 212, rpcs 36, functions 28, authlink 6, authz 49, helpers 35, errors 1). The two 083 low GAPs (desktop polyglot) are now PASS |
| same audit at `--max-migration 083` (the client change before 084) | exit 0; gate 120/120; 446 PASS / 0 FAIL / 2 GAP = the two known low 083 desktop GAPs (closed at 084); desktop validated flow and sweep PASS |
| `npx tsc -p e2e/tsconfig.json` | clean (spec G type-checks; not run: needs the deployment) |
| Envoy Studio isolation test | 58/58 (studio-isolation.md §8) |

Harness t21 guard cycles on populated data:
1. 078 re-applied (production's pre-084 state) plus one recent owner-stamped
   direct upload: 084 aborts with `1 product-images object(s) were uploaded
   directly … in the last 14 days`, naming nothing, and changes nothing.
2. With `phf.g5_084_force=on` it applies and says so.
3. Ownerless migrated objects and 30-day-old uploads do not block.
4. 083 missing aborts; RLS off aborts.
5. Final apply and a re-run succeed; objects are unchanged throughout.

Older tests now branch on `test.m084()`. Under 084: staff direct writes and
desktop signing are refused (t14, t19), the UPDATE probes expect 0 rows, and
the policy count is 2 (t09, t14).

## 6. Residual risks

1. **`products.image_url` is still free text** for catalog editors (table
   RLS). A staff member can point it at any URL, but can no longer place
   bytes on the public origin. Low.
2. **Readiness guard is heuristic:** it sees only active old tills (§1.2).
   Mitigation: the per-till proof in step 2 ([till-readiness-084.md](till-readiness-084.md)).
3. **Abandoned objects live up to grace + schedule interval** (24 h + cron
   period) before the sweep removes them. They are served as `image/*`, with
   nosniff if the optional 083 Envoy rule is applied. Low.
4. **Referenced abandoned objects are kept** (a staff member could point a
   product at a never-completed upload). They are reported as
   `kept_referenced` for manual review.
