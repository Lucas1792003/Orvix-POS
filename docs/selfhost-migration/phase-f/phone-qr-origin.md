# Phone-upload QR origin for the packaged Electron app

Status: **implemented in the repo, not deployed** (2026-10-13). Nothing was
changed on lucashome. The server steps in §6 need owner approval and are
for the coordinator.

Related: [`../phase-g/phone-upload-jit.md`](../phase-g/phone-upload-jit.md)
(just-in-time token, `phone-upload-token`), [`rate-limiting.md`](rate-limiting.md)
(081), [`../phase-g/migration-080.md`](../phase-g/migration-080.md) (trusted
completion URL), [`remote-access-architecture.md`](remote-access-architecture.md)
C8 / §5.4.

## 1. Problem

`createPhoneProductImageUploadSession` built the QR from
`window.location.origin` (`src/lib/productImagePhoneUpload.ts:107` before this
change). The packaged Electron app loads `dist/index.html` with `loadFile`
(`electron/main.cjs:127`), so the renderer origin is `file://` (reported as
`"null"` by some APIs). The QR therefore encoded `file:///phone-upload/...`,
which no phone can open. Phone upload from a till was broken in every
packaged build. That made it a release blocker, whatever remote-access
option is chosen.

## 2. Decision: option (a), the phone page served by an Edge Function on the API origin

The tills already know one https origin that every phone on the tailnet can
reach: the backend, `VITE_SUPABASE_URL`. That is the tailnet-only
`tailscale serve` origin, pinned at build time by
`VITE_SUPABASE_EXPECTED_HOST`. A small function, `phone-upload-page`, serves a
self-contained phone page there:

```
QR = https://<api origin>/functions/v1/phone-upload-page#<session token>
```

### What was measured (read-only on lucashome, plus a local container)

| Question | Answer | How |
|---|---|---|
| Does the gateway route `/functions/v1/*` with no key check? | Yes. Envoy `functions-v1-all`: prefix rewrite to `functions:9000`, basic_auth disabled, RBAC allow-all, no response-header or body rewriting | `volumes/api/envoy/lds.template.yaml` (read) |
| Does the self-hosted edge runtime return `text/html` unmodified? | Yes. `supabase/edge-runtime:v1.76.2` (the lucashome image) returned `200 text/html; charset=utf-8` with our CSP header and the full body. The hosted platform's text/plain rewrite does not happen here | local container, real function, upstream router copy |
| Can a phone's browser navigation reach a function today? | **No.** The upstream main router (`volumes/functions/main/index.ts`) enforces one global `VERIFY_JWT` (`FUNCTIONS_VERIFY_JWT=true` on lucashome) on every non-OPTIONS request. A navigation has no `Authorization` header, so it gets `401 UNAUTHORIZED_NO_AUTH_HEADER` | `GET /functions/v1/phone-upload-token` without auth on lucashome → 401 (harmless GET, nothing ran); same 401 for `phone-upload-page` with the unpatched router locally |

So option (a) needs **one small server change** besides the new function
directory: a router allow-list that lets `GET`/`HEAD` to exactly
`/phone-upload-page` skip the JWT gate. It is
[`deploy/lucashome/functions-main-public-page.patch`](../../../deploy/lucashome/functions-main-public-page.patch)
(+14 lines, 1 changed line). That gate only checks for the **public** anon
key, so skipping it for one static page gives nobody anything new. Every
other function, and every other method on this one, keeps the gate.
Verified locally with `VERIFY_JWT=true`:

| Request (patched router) | Result |
|---|---|
| `GET /phone-upload-page`, no auth | 200 `text/html`, CSP with nonce |
| `HEAD /phone-upload-page`, `GET /phone-upload-page/`, `GET /phone-upload-page?token=x` | 200 `text/html` (query ignored, not reflected) |
| `GET /phone-upload-page/<anything>`, no auth | 401 (gate still applies) |
| `POST /phone-upload-page`, no auth / with anon bearer | 401 / 405 |
| `GET` or `POST /phone-upload-token`, no auth | 401 (unchanged) |
| `POST /phone-upload-token {token:"short"}` with anon bearer | 404 `invalid` (unchanged) |

### Options compared

| | (a) function page on the API origin **(chosen)** | (b) built SPA as static files via Envoy | (c) `VITE_PHONE_UPLOAD_ORIGIN` = some other https host serving the SPA |
|---|---|---|---|
| Server change | new dir in `volumes/functions/` + router patch (+14/−1 lines) + `docker compose restart functions` | new Envoy route + a static-file container or volume, Envoy restart, and a copy of the SPA build synced on **every release** | a second https host on the tailnet. That means a new `tailscale serve` port or path (Tailscale must stay as is) or a public host or domain (not allowed) |
| Gateway / Tailscale / compose | untouched | gateway changed | Tailscale or public DNS changed |
| Release coupling | none: the page ships with the server, the tills only carry the URL | the SPA copy on the server must match the tills' build and env | same as (b), on another host |
| Exposure | same origin, same tailnet, nothing new is public | same | new host |
| Later move to `pos.<domain>` (remote-access §5) | follows by itself: the page is wherever the API is | needs re-doing | needs re-doing |

Also rejected: uploading an HTML file into the public `product-images`
bucket. It would be a data change, the bucket is for images, and
storage-api's content-type handling would control how the page is served.

### Trade-off accepted

The page is a vanilla-JS twin of the React page (`client.js`) rather than
the SPA itself, so the logic exists twice. Mitigations:

- the wording is a copy of `translations.ts` `phoneUpload`, and a test fails
  on any difference;
- `client.js` is unit-tested with the same scenarios as
  `uploadPhoneProductImage` (expired token, network failure, 409,
  completion fallback, 429 wait / later / used-up, double tap, 410, 403);
- spec D runs the real page against the real stack.

The React page and its route stay for the web build.

## 3. Token placement: the URL fragment

The function page reads the session token from `location.hash`. Browsers
never send the fragment to the server, so the token stays out of three
places:

- **Logs**: Envoy's access log goes to stdout (`lds.template.yaml`
  `access_log`), and the edge-runtime log also never sees the token.
- **Referer**: the page also sends `Referrer-Policy: no-referrer` and
  `<meta name="referrer" content="no-referrer">`.
- **The function**: it cannot reflect what it never receives.

Compatibility:
- **Function page:** fragment only. The function returns **404** for any
  sub-path (`/phone-upload-page/<token>`), so a token in the path is never
  "supported" by accident.
- **SPA route `/phone-upload/product-image/:token`** (web build on https):
  unchanged, path token. A fragment would need router changes to the web
  page for no gain there: the web build is a static host and the path goes
  only to that host. The QR still carries no signed storage token. That
  token is issued just in time.

## 4. Configuration

No new variable. The phone origin **is** the backend origin.

| Build | Phone page | Rule |
|---|---|---|
| Electron, packaged (`file://`) or dev (`http://localhost` inside Electron) | `<origin of VITE_SUPABASE_URL>/functions/v1/phone-upload-page#<token>` | `VITE_SUPABASE_URL` must be `https://host[:port]` with no path. `http://localhost`/`127.0.0.1`/`[::1]` is accepted only in dev/test (`import.meta.env.DEV` or `MODE=test`) |
| Any renderer whose origin is not http(s) (`file://`, `"null"`, `app://…`, empty) | same as Electron | never uses the renderer origin |
| Web build on `https://…` | `<that origin>/phone-upload/product-image/<token>` (as before) | `http://` only for loopback in dev/test; anything else is refused |

The rule lives in `src/lib/phoneUploadOrigin.ts` (`resolvePhoneUploadPage`).
It is resolved **before** the upload session is created. If it fails, the
QR modal shows the reason ("Phone upload is not available in this build: the
phone page needs a secure https address. …") instead of a QR, and no session
row is created.

**Build guard** (`vite.config.ts`): when `ELECTRON_BUILD=true`,
`assertElectronPhoneUploadOrigin` fails the build if `VITE_SUPABASE_URL` is
missing, not https, not a bare origin, or a loopback host. This sits next to
the existing host pin. Proven with placeholder env
(`VITE_SUPABASE_ANON_KEY=placeholder-anon-key`):

| `npm run build:electron` with | Result |
|---|---|
| no `VITE_SUPABASE_URL` | exit 1. The host-pin guard fires first ("VITE_SUPABASE_URL is not set"). `ELECTRON_BUILD=true vite build` without the pin → exit 1, "Electron build: … (VITE_SUPABASE_URL) is not set." |
| `http://<pinned host>` | exit 1, "Electron build: … uses "http:" (only https:// is allowed)." |
| `https://<pinned host>` | exit 0, built |

## 5. The function (`supabase/functions/phone-upload-page/`)

- `index.ts`: `GET`/`HEAD` on exactly `/phone-upload-page` (also the full
  `/functions/v1/…` form). Any other method returns 405 with
  `Allow: GET, HEAD`; any other path returns 404. The response is one HTML
  document with an inline script and style under a fresh per-response nonce.
  - CSP: `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…';
    img-src blob: data:; connect-src 'self'; base-uri 'none';
    form-action 'none'; frame-ancestors 'none'`.
  - Also sent: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
    `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, COOP
    same-origin.
  - No external resource, no CDN, no absolute URL. Nothing from the request
    is reflected.
- **Keys:** it embeds `SUPABASE_ANON_KEY` (public by design; the functions
  container already has it). It **refuses (503)** if that value is missing,
  equals `SUPABASE_SERVICE_ROLE_KEY`, is an `sb_secret_` key, or is a JWT
  whose role is not `anon`. The service-role key is never put in the page.
- `client.js`: the page logic, embedded with `Function.prototype.toString()`.
  It does exactly what the React page does, all same-origin with the anon
  key:
  1. `rpc/get_product_image_upload_session_by_token`;
  2. on pick, compress (same ladder, ≤ 100 KB, WebP or JPEG);
  3. `POST /functions/v1/phone-upload-token` just in time;
  4. multipart `PUT /storage/v1/object/upload/sign/product-images/<server path>?token=…`
     with `x-upsert: false`;
  5. `rpc/complete_product_image_upload_session` with
     `<origin>/storage/v1/object/public/product-images/<server path>`.

  Retry and limit behaviour matches the React page: one retry with a fresh
  token on an expired token or network failure, 409 counts as uploaded, and
  completion falls back to re-reading the session. On a 429 the page waits
  out `Retry-After` itself (≤ 60 s, at most 3 times, never past expiry);
  otherwise it shows the "about N min" or "create a new QR" message. It is
  bilingual EN/MY: it follows the stored `pos-language`, then the phone's
  language, and has a toggle.
- `messages.ts`: the EN/MY wording, identical to `translations.ts`
  `phoneUpload`, enforced by a test.
- **Unchanged:** the 60 s storage token (`UPLOAD_SIGNED_URL_EXPIRATION_TIME`
  unset), the 081 limits (the page calls the same function), the 079/080
  exact-path completion rules (the server derives the stored URL from
  `app_config`; the page's URL host is ignored), and the 10-minute session.

Security notes:
- **Same origin as the API and Studio.** Studio sits at `/` behind dashboard
  basic auth. The page holds no cookies or credentials and reflects no
  input, and the strict nonce CSP blocks injected script.
- **What a page visitor can do.** The anon key and the QR token already
  allow everything the page does.
- **`window.orvixPhoneUpload`** (formerly `shwePhaLaPhoneUpload`). It exposes the page's own upload entry
  point for the e2e race check. It grants nothing beyond what the page's own
  address bar already holds.

## 6. Deploy steps (coordinator; owner approval required; steps 1–3 applied 2026-10-13)

Order: **server first, then tills.** An old till's QR is already unusable
(`file://`), so deploying the server side changes nothing for existing
builds.

1. **Function directory**:
   ```sh
   rsync -a --delete --exclude .DS_Store supabase/functions/phone-upload-page/ \
     lucashome:/srv/supabase/stack/volumes/functions/phone-upload-page/
   ```
   The result is `index.ts`, `client.js` and `messages.ts`, owned by
   `lucario`, mode 644 like the siblings. No env to add:
   `SUPABASE_ANON_KEY` is already in the functions container (checked by
   name).
2. **Router allow-list** (upstream file, kept in `volumes/functions/main/`).
   Applied by hand on 2026-10-13 (backup `main/index.ts.pre-phone-page`).
   From 2026-10-14 the procedure is `deploy/lucashome/functions-router.sh`
   (pinned hashes, idempotent; see step 6). Copy the script and the patch to
   the same directory on the server, then:
   ```sh
   mac$ scp deploy/lucashome/functions-router.sh deploy/lucashome/functions-main-public-page.patch lucashome:~/functions-router/
   ls$  ~/functions-router/functions-router.sh status   # upstream | patched | unknown (exit 1)
   ls$  ~/functions-router/functions-router.sh apply    # upstream -> timestamped backup, patch --dry-run, patch, sha check
   ```
   Pinned sha256: upstream `self-hosted/v0.8.2` (commit `564eab8a`)
   `9b7978abd7fd4af39e4f407f8a956137aa99e6ffaeb2190a5e29c8e1787d2da6`;
   after the patch `d2901ffa9711a82117b0edde7b98cbd999ea5d61fa4536c74b307bb37cd111bc`.
   `apply` refuses any other file (step 6). `status` needs no copy:
   `ssh lucashome 'bash -s -- status' < deploy/lucashome/functions-router.sh`.

   Then `cd /srv/supabase/stack && docker compose restart functions`. The
   main service is loaded at start. All functions are unavailable for a few
   seconds: `admin-2fa`, `phone-upload-token`, the report cron, and the
   platform console.
3. **Smoke checks** (no data written; `$O` is the tailnet origin). The
   scripted form is `functions-router.sh verify` (step 6); the manual form:
   ```sh
   curl -sI "$O/functions/v1/phone-upload-page"   # 200, content-type: text/html; charset=utf-8, content-security-policy: default-src 'none'; …
   curl -s  "$O/functions/v1/phone-upload-page" | grep -c '<script nonce='   # 1
   curl -s -o /dev/null -w '%{http_code}\n' "$O/functions/v1/phone-upload-page/x"   # 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$O/functions/v1/phone-upload-page"   # 401
   curl -s -o /dev/null -w '%{http_code}\n' "$O/functions/v1/phone-upload-token"   # 401 (gate unchanged)
   curl -s -X POST -H "Authorization: Bearer $ANON" -H 'content-type: application/json' \
     -d '{"token":"short"}' "$O/functions/v1/phone-upload-token"   # 404 {"error":"Invalid upload link.","code":"invalid"}
   ```
   Check that the served page does not contain the service-role key
   (compare inside a script; never print it). On a phone on the tailnet,
   opening `$O/functions/v1/phone-upload-page` shows "Invalid upload link."
   because there is no fragment.
4. **E2E against the deployed page**:
   `E2E_PHONE_PAGE=deployed npx playwright test e2e/d-phone-upload.e2e.ts`,
   then `npm run e2e:cleanup` → `CLEAN`. Then switch the spec default
   (`PAGE_MODE` in `e2e/d-phone-upload.e2e.ts`) to `deployed`.
5. **Rollback**:
   ```sh
   ~/functions-router/functions-router.sh revert   # newest backup with the upstream sha; refuses an unknown router
   docker compose restart functions
   rm -r volumes/functions/phone-upload-page
   ```
   Tills built with this change then show a QR whose page answers 401 or
   500. Upload from those tills stops working; nothing else is affected.
6. **Upstream upgrades (2026-10-14).** Upstream `update.sh` treats
   `volumes/functions/main/index.ts` as a vendor file and **3-way merges** it
   (its `.gitignore` ignores `volumes/functions/**` except this file). After
   an upgrade the router is therefore one of: the new upstream file (allow-list
   dropped), a clean merge (allow-list kept, unknown hash), or a file with
   conflict markers (the functions container will not start). The checklist
   after **any** stack upgrade (also in `deploy/lucashome/README.md`):
   ```sh
   ls$ ~/functions-router/functions-router.sh status    # must say patched; exit 1 = unknown
   ls$ ~/functions-router/functions-router.sh apply     # only when status says upstream
   ls$ cd /srv/supabase/stack && docker compose restart functions
   ls$ ~/functions-router/functions-router.sh verify    # loopback gateway; exit 1 on any failed probe
   ```
   `verify` lists the function directories at run time (all except `main/`)
   and checks: the page answers GET/HEAD 200 `text/html` with
   `default-src 'none'`; POST and sub-paths of the page get the gate's 401;
   **every** other function gets 401 (with `sb-error-code`) for GET and POST
   without `Authorization`; OPTIONS still skips the gate; and path tricks
   (`/../`, `%2F..%2F`, `%2e%2e`, `//`, upper case) are blocked. Through the
   gateway, Envoy answers some tricks first (empty-body 400 for `%2F`, `//`
   merged to the page itself). With `SUPABASE_ANON_KEY` set it also checks
   that `phone-upload-token` returns the generic 404 for a bad token. The key
   goes to curl via `-K <(…)`, so it is never on a command line.

   When `status` says **unknown**, `apply` refuses and prints the re-derive
   steps: take the new pristine upstream file, re-apply the two hunks, regenerate
   the patch, update `UPSTREAM_REF/UPSTREAM_SHA/PATCHED_SHA`, then run
   `deploy/lucashome/tests/functions-router-test.sh` with
   `UPSTREAM_ROUTER=<new file>`. Until then the page answers 401. This is
   fail-closed: upload from the phone stops, and nothing else changes.

   **Mechanism chosen: patch the upstream file and pin both hashes.** The
   alternative was a full patched copy (`deploy/lucashome/functions-main/index.ts`)
   bind-mounted read-only over `main/index.ts` from the compose override. That
   survives an upgrade mechanically, but it fails *silently and open*:
   `update.sh` would keep updating the host file underneath the mount. The
   stack would run our old router, missing any upstream fix to JWT
   verification, until someone noticed the drift. The patch approach fails
   *visibly and closed*: the page 401s and `status` exits 1. It also adds no
   compose deviation and no nested single-file bind mount (a file mount keeps
   the old inode when the host file is replaced, which needs a container
   recreate, not a restart). It keeps the reviewed diff at 2 hunks. The cost
   is one manual step per upgrade that touches the router, and the checklist
   above covers it. `volumes/functions` is already in the backup bundle.

   Tests (local only): `deploy/lucashome/tests/functions-router-test.sh`.
   Part A covers the files: patch → pinned hash, idempotent `apply`,
   timestamped backup, refusal on a changed, merged or conflicted upstream,
   `revert`, and the legacy backup name. Part B runs the patched router in
   `supabase/edge-runtime:v1.76.2` with `VERIFY_JWT=true`, a throwaway HS256
   secret, an empty JWKS and **every** repo function mounted. It runs
   `verify` plus 18 extra path tricks straight at the router, so every trick
   meets the strict JWT gate. Controls: a valid dummy JWT passes the gate,
   and the unpatched router 401s the page. Result 2026-10-14: 63/63. Live
   (read-only) the same day: `status` = patched; `verify` through the tailnet
   origin with the anon-key probe passed 45/45.

### Release note

Tills need a **new Electron build** that includes this change. The build env
must set `VITE_SUPABASE_URL=https://<tailnet API origin>`. The `build:electron`
script already pins the host, and the guard now also requires https. Ship
it only after steps 1–3. Builds up to v1.0.15 (hosted) and any self-host
build without this change produce an unusable `file://` QR. The web build
(https) is unaffected.

## 7. Verification (2026-10-13)

| Check | Result |
|---|---|
| `npx tsc -b` | pass |
| `npx tsc -p e2e/tsconfig.json` | pass |
| `npx vitest run --exclude '.claude/**'` | 871 passed, 54 skipped (baseline 825; +46: origin rule, page client, session-before-origin) |
| `bash supabase/tests/functions/run.sh` | 41 passed (baseline 34; +7 `phone-upload-page`) |
| `npm run build:electron` guard | §4 table |
| Local edge-runtime v1.76.2, upstream router copy, `VERIFY_JWT=true` | §2 tables (patched and unpatched) |
| Spec D, live stack, `E2E_PHONE_PAGE=local` (page from this repo in a local container), `E2E_PHONE_FN=deployed`. No server change, QA data only | **12/12 passed** (11.7 min). Covers D30/65/120/300, stale token, double tap, race (through the page's own code), lost response, expired, cancelled, and 081 wait / used-up. In every case the desktop QR was asserted to encode `<stack origin>/functions/v1/phone-upload-page#<token>`, not the dev server. Non-QA storage was byte-identical, and `npm run e2e:cleanup` → `CLEAN`. An earlier full run failed once in D65 on the **desktop's** preview-image load (> 15 s over the tailnet; the image appeared just after). The phone side had completed. The re-run passed |

## 8. Files

| File | Role |
|---|---|
| `src/lib/phoneUploadOrigin.ts` (+ `.test.ts`) | origin rule, QR URL, Electron build guard |
| `src/lib/productImagePhoneUpload.ts` | `createPhoneProductImageUploadSession` resolves the page first; `currentPhoneUploadPage()` |
| `vite.config.ts` | Electron build guard |
| `supabase/functions/phone-upload-page/{index.ts,client.js,messages.ts}` | the function and page |
| `src/lib/phoneUploadPageClient.test.ts` | page logic (fake DOM) + wording parity |
| `supabase/tests/functions/phone_upload_page_test.ts` | hermetic Deno tests: HTML, CSP, keys, methods, paths, no reflection |
| `deploy/lucashome/functions-main-public-page.patch` | router allow-list |
| `deploy/lucashome/functions-router.sh` | `status` / `apply` / `revert` / `verify` with pinned upstream + patched sha256 (§6 step 6) |
| `deploy/lucashome/tests/functions-router-test.sh` | local file + edge-runtime tests for the script and the patch |
| `e2e/d-phone-upload.e2e.ts`, `e2e/helpers/edgeRuntime.ts` | QR asserted to encode the configured https page; `E2E_PHONE_PAGE=local|deployed` |
