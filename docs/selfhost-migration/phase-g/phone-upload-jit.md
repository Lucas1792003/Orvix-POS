# Phone upload: just-in-time signed upload token (`phone-upload-token`)

**Status 2026-10-13: implemented and verified locally; NOT deployed.** The
Edge Function exists in this repo only. It was exercised in the real UI
(Electron desktop + iPhone-profile phone page) against the real lucashome
stack, with the function itself running in a disposable local
`supabase/edge-runtime:v1.76.2` container on the Mac (§6). Nothing on
lucashome was changed: no container, no config, no migration, no file under
`volumes/functions`. Nothing is committed. Deploying needs owner approval (§7).

Fixes the defect in [`../../lucashome-selfhost/risks.md`](../../lucashome-selfhost/risks.md)
("Phone-upload signed URLs live only 60 s"): with the token minted once when
the desktop shows the QR, any phone upload sent more than 60 s later failed
with `400 InvalidJWT "exp" claim timestamp check failed`.

## 1. Owner decisions this implements

| Decision | How |
|---|---|
| Keep storage's signed-upload lifetime at 60 s | `UPLOAD_SIGNED_URL_EXPIRATION_TIME` untouched (still unset → storage-api default 60 s) |
| Just-in-time issuance, not a 30-s refresh loop | The desktop's refresh loop (uncommitted prototype) is removed. The desktop only creates the session, shows the QR and polls status |
| QR valid for the whole session (10 min) | The QR carries only the session token; the phone asks for a signed token at the moment of upload, any time while the session is PENDING |
| Fresh token immediately before upload | `uploadPhoneProductImage()` calls the function, then uploads with that token in the same tick of work |
| Issued only for a valid PENDING, unexpired, uncancelled session, bound to org, product and exact path | §3 checks 1–6 |
| Refresh allowed while valid, refused after expiry/cancel | Each call re-checks the row; 410 once not PENDING |
| Retries never duplicate objects or completions | `upsert` never set (second write fails); "already uploaded" answer; 409 → completion; completion refusal for an already-COMPLETED session of the same path → success (§4) |
| Never expose service-role credentials to phone or desktop | The service key lives only in the function's env; responses carry `{token, path, expiresAt}` or `{alreadyUploaded, path}`; tested (§5) |

## 2. Flow

```
desktop (signed in)                  phone (anon key only)                    phone-upload-token (service role)        storage / db
 create_product_image_upload_session -> QR = /phone-upload/product-image/<session token>
 poll get_..._status every 2 s        open QR -> get_..._by_token (status only)
                                      pick photo -> compress
                                      POST /functions/v1/phone-upload-token {token} -> hash, row, checks ---------------> SELECT (RLS bypassed)
                                                                                    HEAD object? ----------------------> storage
                                                                                    POST object/upload/sign/<path> ---> signs 60 s JWT
                                      <- {token, path, expiresAt}
                                      PUT object/upload/sign/<path>?token=… (immediately) ----------------------------> object (upsert false)
                                      complete_product_image_upload_session(token, path, getPublicUrl(path), …) ------> COMPLETED
 poll sees COMPLETED -> shows image
```

## 3. The function (`supabase/functions/phone-upload-token/index.ts`)

Request: `POST {"token": "<QR session token>"}` with the anon key (the phone
page's normal supabase client; `supabase.functions.invoke`).

Checks, in order. Every refusal happens before storage is called:

1. Token is a string of 32–512 chars (the RPCs' floor is 32), else **404 `invalid`**.
2. `sha256(utf8(token))` as lower-case hex, the same digest as
   `product_image_upload_token_hash()` (019). The Deno test pins the value the
   lucashome database returns for a fixed token. The row is looked up by
   `token_hash` with the service role. No row → **404 `invalid`** (the same
   generic answer as a malformed token).
3. `status <> 'PENDING'` → **410 `inactive`** with that status (EXPIRED /
   CANCELED / COMPLETED). The phone may already read this status through
   `_by_token`.
4. `expires_at <= now` → the row is stamped EXPIRED by calling
   `get_product_image_upload_session_by_token` (the existing non-raising path
   that the phone page and the desktop poll already use; it re-checks against
   the database clock). Then **410 `inactive`/EXPIRED**.
5. Organization: the creator's `users.org_id` (the creator must exist and be
   active). The path is **re-derived** as `org/<org>/temp/<session id>` and
   must equal the stored `storage_path`. Client input is never used as a
   path: extra body fields are ignored (tested). Legacy `temp/<id>` sessions
   (pre-079) are refused; they are all long expired.
6. The session's `product_id` / `shop_id`, when set, must still belong to that
   org. If the product was moved, deleted, or the shop belongs elsewhere →
   **403 `refused`**.
7. `HEAD /storage/v1/object/product-images/<path>` (service role). If the
   object exists → **200 `{alreadyUploaded: true, path}`** and no token.
   Storage creates the object row only after a complete transfer, so an
   existing object is a finished upload (a lost response, or a double tap
   that won). The phone goes straight to completion.
8. `POST /storage/v1/object/upload/sign/product-images/<path>` with the service
   role and no `x-upsert` → **200 `{token, path, expiresAt}`**. `expiresAt` is
   the JWT's `exp`. The signed URL itself is not returned: on lucashome it is
   built from `SUPABASE_URL=http://api-gw:8000`, the internal host.

Infrastructure errors → **503 `unavailable`** with a fixed message. No
database or storage detail is passed through. Logs carry only status codes
and messages, never tokens or keys. `Cache-Control: no-store`.

**No state is written** when issuing. `signed_upload_token` is neither set
nor read. A refresh is just another call.

### verify_jwt: how the gateway and runtime treat the call

- Gateway (envoy `functions-v1-all`): `/functions/v1/*` → `functions:9000`
  with a prefix rewrite. No key check at the gateway (basic_auth disabled,
  RBAC allow-all).
- Runtime (upstream `volumes/functions/main/index.ts`): **one global**
  `VERIFY_JWT` (from `FUNCTIONS_VERIFY_JWT`, currently `true` on lucashome).
  Self-hosted has no per-function `verify_jwt` (upstream TODO in the compose
  file). When it is true, every non-OPTIONS request needs
  `Authorization: Bearer <JWT>` that verifies with `JWT_SECRET` (HS256) or the
  JWKS.
- The phone's anon key is an HS256 JWT signed with `JWT_SECRET`, and
  `functions.invoke` sends it as the bearer when nobody is signed in. So the
  gate passes with **no change**. Probed read-only on lucashome 2026-10-13,
  against a non-existent function name so nothing ran:

  | Request | Result |
  |---|---|
  | no auth | 401 `UNAUTHORIZED_NO_AUTH_HEADER` |
  | `Bearer <anon key>` | passed the gate (500 "could not find an appropriate entrypoint": no such function) |
  | `Bearer abc.def.ghi` | 401 `UNAUTHORIZED_INVALID_JWT_FORMAT` |
  | OPTIONS, no auth | passed to the worker (CORS preflight works) |

- The function does **not** rely on that gate. It authenticates the caller only
  by the QR session token. Turning `VERIFY_JWT` off would not weaken it, and
  leaving it on only means callers need the public anon key.

### Rate limiting

Not implemented. A per-session counter needs a new column, which means a
migration, and that is out of scope here. In-memory counters are not
reliable: edge-runtime workers are recycled and the limit would be
per-worker. The cost of abuse is bounded:
- every token is for the session's single path;
- `upsert` is false, so extra tokens add no capability;
- issuing stops at expiry (≤ 10 min);
- a caller needs the 128-hex QR token.

If wanted later: add `product_image_upload_sessions.token_issued_count int` +
`last_token_at`, and do an atomic `UPDATE … SET token_issued_count =
token_issued_count + 1 WHERE id = … AND token_issued_count < 20 RETURNING`
before signing.

## 4. Client changes

- `src/lib/productImagePhoneUpload.ts`
  - `createPhoneProductImageUploadSession()` (desktop) creates the session and
    builds the QR, and nothing else. **No `createSignedUploadUrl`, no
    `attach_product_image_upload_session_token` call.** The prototype's
    `issueSignedUploadToken`, `SIGNED_UPLOAD_TOKEN_REFRESH_MS`,
    `getFreshPhoneUploadTarget` and `signedUploadTokenSecondsLeft` are removed.
  - `requestPhoneUploadTarget()` (phone) calls the function and maps the
    answers:
    - 200 → `{kind: "upload"}` or `{kind: "alreadyUploaded"}`;
    - 410 → `PhoneUploadInactiveError(status)`;
    - 404/403 → `PhoneUploadRefusedError`;
    - anything else → a retryable error.
  - `classifyStorageUploadError()` sorts storage failures into
    `expired_token` (InvalidJWT / exp), `duplicate` (409 or "already
    exists"), `network` (StorageUnknownError) and `other`.
  - `uploadPhoneProductImage()` runs the whole phone flow:
    - get a token, then PUT;
    - on `expired_token` or `network`, get **one** fresh token and try again. The
      server re-checks the session, and answers `alreadyUploaded` if the first
      transfer landed;
    - on `duplicate`, go to completion;
    - complete. If completion is refused, re-read `_by_token`: COMPLETED for the
      same path counts as success (a concurrent tap finished it); otherwise
      inactive → `PhoneUploadInactiveError`.
- `src/pages/PhoneProductImageUploadPage.tsx`
  - uses `uploadPhoneProductImage`;
  - an in-flight ref ignores a second pick while one is running;
  - clear end states: "This upload link has expired. Create a new QR code on
    the computer.", "This upload link was cancelled on the computer. Create a
    new QR code to upload.", or the refused message.
- `src/components/forms/ProductImagePhoneUploadModal.tsx`: the 30-s refresh
  effect is removed. The modal only creates the session and polls status.

`attach_product_image_upload_session_token` **stays on the server**:
- no migration;
- older Electron builds still call it until they auto-update, and it still
  works for them;
- the new flow never calls it, and the function ignores `signed_upload_token`.

`_by_token` still returns `uploadToken` (NULL for sessions created by new
builds). Removing the column or the RPC is a later cleanup migration, after
every till has updated.

**Mixed versions.** The phone page is served by whichever web build the QR
origin points at.
- An old phone page with a new desktop: the old page waits for an attached
  token that never comes, and then says "not ready".
- A new phone page with an old desktop: works. The new page ignores the
  attached token and asks the function.
- Deploy order: **function first, then the web build/app.**

Object owner: storage takes the object's owner from the token's `owner`
claim. A service-role-signed token has no `sub`, so new phone objects have
`owner`/`owner_id` NULL; before, it was the desktop user. 078 authorizes
`org/<org>/temp/<sid>` by path (session row → org), not by owner, so org
admins still manage these objects. Checked live: every test object is under
the QA org prefix, and cleanup used the path.

## 5. Security reasoning

- **What the phone can obtain:** a 60 s upload token for exactly
  `product-images/org/<its session's org>/temp/<its session id>`, only while
  that session is PENDING and unexpired, and only if its product/shop/creator
  are still in that org. That is the same capability the desktop used to hand
  out (078's INSERT rule for an own live session), with a shorter exposure:
  - before: a token sitting in the session row and readable via `_by_token`
    for its lifetime;
  - now: minted on request, never stored, handed only to the caller who
    presents the QR token.
- **What it cannot obtain:** another path (the path comes from the row); an
  overwrite (`upsert` false); a token after expiry or cancel (410); ids, names
  or keys (responses are whitelisted, tested). The only identifier returned is
  the object path, which `_by_token` already returns by design.
- **Wrong tokens:** a random token, a one-character-off token, the stored hash
  itself, or the session id all get the same 404 `invalid`. The hash is only
  ever compared server-side.
- **Service role:** the key exists only in the function's environment
  (functions container env on lucashome, already present for the other
  functions). The phone and desktop bundles contain only the anon key. Tests
  assert the key never appears in any response, including error paths.
- **Residual (unchanged, documented in upload-security-and-077.md §2c):** an
  issued token cannot be revoked. Within its 60 s it can still create its one
  object after a cancel. That object is never completed or attached. The
  window is now at most 60 s after the *last* request rather than 60 s after
  the QR was shown.
- **Completion** is still the 075/079 RPC: refused after expiry or cancel, and
  the URL must be this session's object. Completion does not check that the
  object exists (unchanged; the phone completes only after the PUT or the
  server's `alreadyUploaded`).

## 6. Verification

### Unit and hermetic tests

| Suite | Result |
|---|---|
| `bash supabase/tests/functions/run.sh` (Deno, no network) | **42 passed** (26 existing + 16 new in `phone_upload_token_test.ts`) |
| `npx vitest run` (`npm test`) | **768 passed**, 41 skipped (baseline 758; `productImagePhoneUpload.freshToken.test.ts` rewritten for the JIT flow: 24 tests replace the prototype's 14) |
| `npx tsc -b` | clean |
| eslint, touched files | clean, except one **pre-existing** `react-hooks/set-state-in-effect` error at `ProductImagePhoneUploadModal.tsx:64`, identical at HEAD and not touched by this change |

The Deno tests cover:
- valid → a token for exactly the session path, `upsert` false, keys
  `{expiresAt,path,token}`, no ids, names or keys in the body, nothing written
  to the row;
- refresh → a new token each time;
- wrong, short, missing, oversized, hash-as-token and session-id-as-token → the
  same 404, no storage call;
- expired → 410 and the row stamped EXPIRED via `_by_token`;
- CANCELED / COMPLETED / EXPIRED → 410, no write;
- product moved or deleted, shop in another org, creator deactivated, moved
  or deleted → 403;
- tampered or legacy `storage_path` → 403;
- client-supplied path, bucket or ids ignored;
- already uploaded → `{alreadyUploaded, path}` and no token;
- storage or DB failure → generic 503 without details;
- missing config → 503 before any call; CORS preflight; GET → 405.

The harness (`_harness.ts`) gained `MockStorage` (HEAD object, POST
upload/sign, service-key assertion) and registered-RPC support. Unregistered
RPCs still throw, so the existing tests are unchanged.

### Live UI (real timing, real lucashome stack, local function)

Run 2026-10-13. Command: `npx playwright test e2e/d-phone-upload.e2e.ts`.
Result: **10 passed (11.2 min)**, consistency gate PASS, hosted guard clean.
The QA tenant came from the normal global-setup seed and was removed with
`npm run e2e:cleanup` (`verify_clean` → CLEAN).

Setup:
- Desktop: the Electron app on the QA ADMIN, signed in with TOTP, on the product
  edit page. "Use phone camera" opens the QR modal.
- Phone: Chromium with the iPhone 13 profile. It opens the QR URL and picks a
  640×480 PNG; the page compresses it to a 2414 B WebP.
- The function: a local container. The phone's request for it was routed
  there with `page.route` + `route.fetch`.
- Everything else hit lucashome directly.

Times below are seconds after the QR was displayed.

| Case | Phone opened | File picked | Token issued | PUT | Token age at PUT | Completion | Session / storage | Desktop |
|---|---|---|---|---|---|---|---|---|
| 30 s | +0.8 | +30.0 | +30.4 | 200 at +30.5 | 108 ms | 200 ×1 | COMPLETED; 1 object (2414 B = `bytes`) | "Upload received", image 320×240 + form thumbnail |
| 65 s | +1.5 | +65.0 | +65.5 | 200 at +65.7 | 176 ms | 200 ×1 | COMPLETED; 1 object | same |
| 120 s | +0.7 | +120.0 | +120.5 | 200 at +120.8 | 300 ms | 200 ×1 | COMPLETED; 1 object | same |
| 300 s | +1.0 | +300.0 | +300.4 | 200 at +300.5 | 86 ms | 200 ×1 | COMPLETED; 1 object | same |
| stale token: token #1 held 66 s before the phone used it | | | #1, then #2 at +68.8 | #1: **400 `InvalidJWT "exp" claim timestamp check failed`**; #2: 200 | 66.3 s / fresh | 200 ×1 | COMPLETED; 1 object | same |

Each success row also asserted:
- the function's answer has keys `{expiresAt,path,token}`, with `path` = the
  session path, and no product, shop, user or org id or name, no QR token, no key;
- the desktop made no storage-sign request and no attach call;
- the session row is `COMPLETED|<path>|<public url>|<bytes>|completed_at set|signed_upload_token NULL`;
- exactly one object under the session path, whose `metadata.size` equals the
  completion's `bytes`;
- a public GET returns 200 with that size.

| Case | Phone UI | Function | Storage / completion | DB | Desktop |
|---|---|---|---|---|---|
| double tap (tap + picker, second tap, second pick while in flight) | "Photo uploaded…" | 1 call → token | 1 PUT (200), 1 completion (200) | COMPLETED, 1 object | image shown |
| race: 2 concurrent `uploadPhoneProductImage` calls through the page's own module | both → COMPLETED | 2 tokens | PUTs 200 + **400 `{"statusCode":"409","error":"Duplicate"…}`**; completions 200 + 400 (the second resolved as success via `_by_token`) | COMPLETED, **1 object** (34 B) | image shown |
| upload response lost after storage stored it (`route.fetch` then `abort`) | "Photo uploaded…" | token, then **`{alreadyUploaded, path}`** | 1 PUT (stored, response dropped), no second PUT, 1 completion | COMPLETED, 1 object | image shown |
| parent session expired (`expires_at` set in the past by the service role; desktop poll held) | "This upload link has expired. Create a new QR code on the computer." | **410** `inactive`/`EXPIRED`, no token | 0 PUTs, 0 completions | row **EXPIRED, stamped by the function** (the poll was held, and the phone page reads no session on this path); 0 objects | after releasing the poll: "Upload failed / expired" |
| cancelled (desktop "Close" → cancel RPC) | "This upload link was cancelled on the computer. Create a new QR code to upload." | **410** `inactive`/`CANCELED`, no token | 0 PUTs, 0 completions | CANCELED, 0 objects | modal closed |

Storage before and after:
- non-QA objects `574 objects, md5 a62ee56a272c8c8d52873d5f8a877e80` before
  and after. That is every column except `last_accessed_at`, across all buckets;
- the 17 orphans `17 orphans, md5 9bc58d3ba13b6feddddceb7615e62786` before
  and after;
- the 8 QA objects were removed through the service-role Storage API; QA
  objects left: 0;
- the on-disk file count is unchanged at 575.

An earlier subset run (30 s, 300 s, cancelled; 3 passed) gave the same
fingerprints. The service key was not found anywhere under `e2e/.results` or
in the run log. The local container was removed and `docker ps -a` shows
none left.

Note: during this work another session used its own QA tenant on lucashome.
This run waited until that tenant was gone (global-setup refuses to seed on
a stack that is not clean) instead of seeding next to it.

## 7. Deploying to lucashome (for owner approval; nothing done)

1. **File:** copy the directory, same as the other functions
   (deploy/lucashome/README.md "Edge functions"):
   ```sh
   rsync -a --delete --exclude .DS_Store supabase/functions/phone-upload-token/ \
     lucashome:/srv/supabase/stack/volumes/functions/phone-upload-token/
   ```
   Result: `/srv/supabase/stack/volumes/functions/phone-upload-token/index.ts`
   (owner `lucario`, mode 644 like its siblings).
2. **Restart: not needed.** `volumes/functions` is bind-mounted into the
   functions container, and the main router creates a worker from
   `/home/deno/functions/<name>` per request. Verified on the same image
   locally (v1.76.2): a function directory added while the runtime was running
   answered on the first request. An *edited* function kept serving the old
   code for a few seconds (a cached worker) and served the new code by +30 s.
   `docker compose restart functions` forces it at once, if ever needed.
3. **Env: nothing to add.** The functions container already has
   `SUPABASE_URL=http://api-gw:8000` and `SUPABASE_SERVICE_ROLE_KEY` (checked
   by name only); the other functions use the same two.
4. **verify_jwt: leave `FUNCTIONS_VERIFY_JWT=true`.** The anon key passes the
   router's gate (probe in §3). There is no per-function setting in
   self-hosted, and none is needed.
5. **No migration.** No storage or compose change. `UPLOAD_SIGNED_URL_EXPIRATION_TIME`
   stays unset (60 s).
6. **Order:** deploy the function **before** shipping the web build / Electron
   update that contains the new client. A new client without the function
   gets a 500 from the router ("could not find an appropriate entrypoint"),
   and the phone shows "Phone upload is temporarily unavailable".
7. **Smoke test after deploy** (no data written):
   `curl -s -X POST -H "Authorization: Bearer $ANON" -H 'content-type: application/json' -d '{"token":"short"}' https://lucashome.tail8a86e4.ts.net/functions/v1/phone-upload-token`
   → `404 {"error":"Invalid upload link.","code":"invalid"}`. Then run
   `npx playwright test e2e/d-phone-upload.e2e.ts` with the route to the
   local container removed, or keep it: it only routes when the URL matches.
8. **Rollback:** `rm -r volumes/functions/phone-upload-token` (and roll back
   the client). Old clients never call it.
9. Backups: `volumes/functions` is already in the secrets/offsite bundle
   (deploy/lucashome/backup), so nothing changes there.

## 8. Files

| File | Change |
|---|---|
| `supabase/functions/phone-upload-token/index.ts` | new: the function |
| `supabase/tests/functions/phone_upload_token_test.ts` | new: 16 hermetic tests |
| `supabase/tests/functions/_harness.ts` | `MockStorage`, registered RPCs, `storage` trace kind |
| `src/lib/productImagePhoneUpload.ts` | JIT client (see §4); prototype refresh/attach helpers removed |
| `src/lib/productImagePhoneUpload.freshToken.test.ts` | rewritten for the JIT flow |
| `src/pages/PhoneProductImageUploadPage.tsx` | JIT upload, in-flight guard, expired/cancelled states |
| `src/components/forms/ProductImagePhoneUploadModal.tsx` | refresh loop removed; session + QR + poll only |
| `e2e/d-phone-upload.e2e.ts` | new: live UI spec |
| `e2e/helpers/edgeRuntime.ts` | new: local edge-runtime container helper |
| `e2e/helpers/terminal.ts` | `Terminal.launchPhone()` (iPhone 13 profile) |
| `e2e/README.md` | spec + helper listed |
