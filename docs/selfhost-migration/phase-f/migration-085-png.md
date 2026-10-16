# Migration 085: PNG completion, no refused uploads left behind

Status: **prepared, NOT deployed** (2026-10-16). Nothing in this change was
applied to any server. Production is at 083; 084 is prepared, not deployed.
085 does not depend on 084.

| Item | Value |
| --- | --- |
| Migration | `supabase/migrations/085_png_completion.sql` |
| sha256 | `53846c4b55e647473a1abb933a6d32ad7217febe313da8f8d663eed30e87fb4d` |
| Function | `supabase/functions/phone-upload-token/` (`index.ts`, `imageCheck.ts`) |
| Sweep (prepared, not scheduled) | `deploy/lucashome/backup/sweep-abandoned-uploads.{sh,sql}` |
| Completion body md5 before / after | `7c9c65a96a057189ee84ff850183b627` (080 = production, measured read-only 2026-10-16) / `dc822a6435c3e512acdc933c4a2995a8` |

## 1. Finding

Source: `evidence/G10/2026-10-16-migration-083-headers.md`, "Finding".
JPEG, PNG and WebP are meant to be supported, but the layers disagreed:

| Layer | Before | After |
| --- | --- | --- |
| Bucket `product-images` (083) | jpeg, png, webp; 5 MiB | unchanged |
| Envoy public header rule (083, deployed) | jpeg, png, webp | unchanged |
| `phone-upload-token` byte check (`imageCheck.ts` `COMPLETION_TYPES`) | jpeg, webp | **jpeg, png, webp** |
| `complete_product_image_upload_session` (075/079/080) | webp, jpeg | **webp, jpeg, png** (085) |
| `create_product_image_upload_session`, DB triggers, table CHECKs | no type rule (checked: only `status_check`; `storage.objects` has only storage-api's own triggers) | unchanged |
| Desktop picker (`ProductImageInput` `accept`) and `compressProductImage` `ALLOWED_IMAGE_TYPES` | jpeg, png, webp input; re-encoded to WebP/JPEG | unchanged |
| Phone page `client.js` `ALLOWED_TYPES` | jpeg, png, webp input; re-encoded to WebP/JPEG | unchanged |
| Desktop validated upload (`productImageStorage.ts`, G5 follow-up) | sends the compressed WebP/JPEG; no own list | unchanged (comments only) |

So no app produces PNG today; PNG reaches completion only from another
uploader holding a session token.

**Correction to the evidence note.** The deployed function (sha256 of
`index.ts` / `imageCheck.ts` on the server equals git `29ad4cb`) did **not**
accept PNG bytes: `COMPLETION_TYPES` was jpeg/webp, so a PNG got
`422 invalid_image` and the object **was** deleted. The live G5-2 failure came
from the test's follow-up step: it calls the RPC as service_role with
`p_mime_type = 'image/png'`, and the RPC checks the caller's type before it
looks for the object, so it answered "Unsupported uploaded image type"
instead of the expected "Uploaded image was not found in storage". The test
is now fixed (§4.4).

The **real** gap behind the note: when the **RPC** refused a completion
after the byte check passed (wrong type, size, object missing, completion URL
not configured), the function returned `422 completion_refused` and left the
object at `org/<org>/temp/<session>` with the session PENDING. Only the
prepared, unscheduled sweep would ever remove it.

## 2. Design

### 2.1 Migration 085 (database)

- `complete_product_image_upload_session`: the production 080 body with one
  change, made twice. The caller-value check and the stored-object check both
  become `NOT IN ('image/webp', 'image/jpeg', 'image/png')`. The size rule
  (1..102400 bytes, from the object's own metadata) is the same for every
  type and is not changed. Signature, return shape, SECURITY DEFINER,
  `search_path=public` and owner `postgres` are not changed.
- Grants are restated exactly as 083 left them: EXECUTE for `service_role`
  only.
- The COMMENT keeps its `083:` prefix, because 084's readiness guard and
  `test.m083()` look for it, and adds `085: accepts image/jpeg, image/png and
  image/webp, 1..102400 bytes.`
- Nothing else changes: no table, row, bucket or policy.
- Guards. Production applies migrations with `--single-transaction`, so any
  failed guard rolls back everything.
  - **Before:** the function exists; 083 is in place (`083:` comment, no
    anon/authenticated EXECUTE); the current body md5 is the 080 body or the
    085 body (a re-run). Any other body aborts with nothing changed. For the
    080 body, `md5(replace(<080 body>, two-type list, three-type list))` must
    equal the 085 md5, which proves the only change is the type list.
  - **Rows:** `product_image_upload_sessions` and `storage.objects` are
    fingerprinted (count plus md5 over every column of every row) before and
    after. They must be identical.
  - **After:** body md5, SECURITY DEFINER, owner, search_path, grants, and
    the comment pattern `083:%085:%`.
- Idempotent: a re-run recognises its own body.

### 2.2 Function `phone-upload-token` (refused objects never stay behind)

- `imageCheck.ts`: `COMPLETION_TYPES = jpeg, png, webp`. PNG is checked by
  its signature, the IHDR chunk, no markup, and at most 100 KB, the same as
  the other types.
- The refusal message is now "not a valid JPEG, PNG or WebP photo".
- New `discardRefusedObject()`. It runs on a byte-check refusal and on any
  RPC refusal that the 080 RPC raises only after it locked the row and
  confirmed PENDING and unexpired. Those refusals are a fixed allow-list of
  messages: path mismatch, size, type, URL checks, object not found, not
  configured. It deletes only when **all** of the following hold, each
  re-read with the service role right before the DELETE:
  1. **Exact session path.** The path is the server-derived
     `org/<creator org>/temp/<session id>`, already checked against the
     session row. Nothing from the request is used; extra body fields are
     ignored (tested).
  2. **Session still unfinished.** The session row (by id) is still
     `PENDING`, with `completed_at` and `public_url` NULL, and its
     `storage_path` equals that path.
  3. **Not referenced.** No `products.image_url`, no
     `business_profile.logo_url` and no `product_image_upload_sessions.public_url`
     contains the path. The check uses `ilike '*<path>*'`, which is
     deliberately broad and can only keep more. No *other* session row holds
     the same `storage_path`. If any check query fails, the object is kept.
  4. **Same object as validated.** It is re-read and must still be the one
     that was validated: same sha256 over the capped bytes, length, type,
     ETag and Last-Modified. A fresh upload after an earlier refusal freed
     the path, including a byte-identical one, is kept.
  5. **DELETE.** It targets exactly that path. Afterwards the session is
     re-read, and if it became COMPLETED in that window, an error is logged.
     This would need a configuration change between the checks and the
     DELETE.
- **Never deletes** on "Invalid upload link" or "Upload link is no longer
  active". The second one is the loser of a concurrent completion, or an
  expired or cancelled session; expired and cancelled objects are left to
  the sweep. It also never deletes on an unknown RPC failure (503), because
  the call may have committed.
- **Concurrency.** Two completions of one session: the RPC row lock lets
  exactly one complete. The other gets "no longer active" and returns 410
  with status COMPLETED, and nothing is deleted. A refusal racing a winner
  sees COMPLETED in step 2 and keeps the object.
- **Retries.** After a deletion, the next token request finds no object, so
  it signs a fresh token with upsert false instead of returning
  `alreadyUploaded`. The phone uploads again to the same path.
- **Lost responses.** The `alreadyUploaded` and lost-response flows are
  unchanged: an existing object leads straight to completion, and a repeated
  completion after success returns 410 COMPLETED with nothing deleted.
- **Bug found by the audit stack and fixed.** The capped read (limit + 1
  bytes) is now cut to exactly limit + 1 bytes. Before the fix, two reads of
  one oversized object could differ by their chunk boundaries, step 4 then
  saw a different object, and the 150 KB object was kept.

### 2.3 Abandoned uploads (phone closed before completing)

The prepared sweep (`sweep-abandoned-uploads.{sh,sql}`, NOT scheduled) was
reviewed against the same guarantees:

| Guarantee | Before | After |
| --- | --- | --- |
| Only `org/<org>/temp/pimg-<32 hex>` in `product-images` | yes (SQL regex + the script re-checks every name) | yes |
| Matching session row: id = name segment, creator in the name's org | yes | yes |
| Session not completed (status, `completed_at`, `public_url`), EXPIRED / CANCELED / PENDING past expiry | yes | yes |
| Session created, session expired and object created all older than the grace period (default 24 h) | yes | yes |
| Not referenced by products / logo / session URLs | yes ("referenced" = kept) | yes |
| Another session row holding the same path (`storage_path` is not unique) | **not checked** | **"referenced" (kept)** |
| A name "referenced" on any row is never deleted; each name at most once | not explicit | **enforced in the script's filter** |
| Protected 574-hash allow-list | yes (refuses to run without it; count checked) | yes |
| Read-only candidate query, two looks, deletion through storage-api, names never printed | yes | yes |

## 3. Supported-type consistency

The final state is JPEG, PNG and WebP everywhere: bucket, Envoy header rule,
byte check, completion RPC (085), and the client input lists. Both clients
still re-encode photos to WebP or JPEG.

## 4. Tests (all local, synthetic data only)

| Suite | Result |
| --- | --- |
| phase-d harness `supabase/tests/phase-d/run.sh` | **747 assertions, 0 failed**, RESULT PASS (baseline 710 + 37 t22) |
| harness `POS_TEST_MAX_MIGRATION=083` | **672, 0 failed**, PASS (t21/t22 skipped as gated) |
| Deno `supabase/tests/functions/run.sh` | **94 passed, 0 failed** (baseline 81 + 13) |
| `npx tsc -b`, `npx tsc -p e2e/tsconfig.json` | clean |
| `npx vitest run --exclude '.claude/**'` | **962 passed**, 66 skipped (baseline 961 + 1 fixture test) |
| `tools/security-audit/run.sh --max-migration 085 --max-migration 083` | exit 0: 085 466 PASS / 0 FAIL / 0 GAP; 083 454 PASS / 0 FAIL / 2 known low GAP (§4.3) |

### 4.1 Harness t22 (`t22_png_completion{,_b}.sql` + guard cycles in `run.sh`)

- **State.** Body md5 = 085; both type lists have three types and no
  two-type list is left; the size rule appears twice, unchanged;
  service_role-only EXECUTE (not anon, authenticated or PUBLIC); SECURITY
  DEFINER, owner, search_path and signature unchanged; comment `083:…085:`;
  bucket unchanged.
- **Behaviour (service_role).**
  - Completes: PNG 4321 B (type and size taken from the object, trusted
    URL), PNG of exactly 102400 B, JPEG, WebP.
  - Refused, with sessions left PENDING and untouched: PNG 102401 B, PNG
    0 B, a claimed 102401 B, claimed PNG stored as GIF or octet-stream, GIF,
    SVG, HTML.
  - Re-completion: "no longer active".
  - anon and authenticated: permission denied.
  - The desktop poll returns the PNG session.
- **Guards.**
  - A drifted body makes 085 abort, naming only md5s; the body is left in
    place.
  - Re-applying 080 (anon EXECUTE back) makes 085 abort with "083 is not
    applied".
  - Re-applying 083 and 078 recreates **production's exact 083 state**:
    080 body, 4 storage policies, no 084. 085 applies there and does not
    need 084.
  - 084 then applies **on top of 085**, and its `083:` comment guard still
    passes. 085 re-runs on 083+084 as a recognised no-op.
  - No session or object row changed across all runs (whole-row digests).
- The main loop also applies 062…085 twice (084 → 085 order) to prove
  idempotency.
- t21 sweep: a new fixture, an abandoned session whose path a second
  (completed) session also holds, is now "referenced". The exact verdict
  lists still match.

### 4.2 Deno (phone-upload-token)

- A valid PNG completes and is kept. PNG at exactly 100 KB completes; one
  byte more gets invalid_image and is deleted.
- **New function on a pre-085 schema:** a PNG gets 422 completion_refused
  and **is deleted**. The calls run in order: session re-read → reference
  checks → object re-read → one DELETE of exactly the session path.
- Each of 6 RPC refusals deletes only the session's object. Another org's
  object and another session's object survive. "Invalid link" and
  "no longer active" never delete; neither does a 503.
- A client-supplied path never reaches the DELETE.
- **Concurrent completions:** 2 and 5 in parallel give exactly one 200, the
  rest 410 COMPLETED, and nothing is deleted. A refusal racing a winner
  keeps the object.
- **Referenced paths are never deleted,** by the byte check or the RPC,
  across 4 kinds of reference.
- A replaced object, including a byte-identical re-upload (new
  ETag/Last-Modified), is kept. A failed reference query keeps the object.
- **Retry:** fresh token (upsert false), new photo completes. Lost-response
  flow: `alreadyUploaded`, then complete, then a repeat gets 410 and
  nothing is deleted.
- An oversized object read in different chunks is still recognised and
  deleted (the §2.2 fix).
- PNG cases added to the refused list: wrong magic both ways, no IHDR, HTML
  payload, more than 100 KB.

### 4.3 Security audit (real GoTrue / PostgREST / storage-api / edge-runtime)

New `phone` cases, all migration-aware (`suites/phone.ts`
`phonePngAndCleanup`):

- A valid PNG completes at ≥ 085. Below 085 it gets 422 completion_refused,
  the object is deleted, and the session stays PENDING.
- A PNG with an HTML payload and a 150 KB PNG get invalid_image and are
  deleted.
- An RPC refusal ("not configured": `app_config` row removed for one call,
  then restored) deletes the session's object. Org B's pending object
  survives. A retry gets a fresh token and completes a WebP.
- A refused object whose path a `products.image_url` names is kept.
- 4 concurrent completions give one 200 and three 410 COMPLETED, and the
  object is kept.

The existing JPEG/WebP, malicious-content, oversize, cross-org and sweep
cases are unchanged; the sweep suite runs the edited script for real.

First run: one FAIL, the 150 KB PNG kept. This is the chunk-boundary bug
fixed in §2.2. Re-run after the fix (`--max-migration 085 --max-migration 083`,
exit 0):

| Level | PASS | FAIL | GAP | Coverage gate |
| --- | --- | --- | --- | --- |
| 085 | 466 | 0 | 0 | 118/118 |
| 083 | 454 | 0 | 2 (the known low desktop gaps that 084 closes) | 120/120 |

`phone` is 35/35 at both levels and `sweep` 12/12. The real storage-api
returns a stable ETag/Last-Modified for the re-identification step.

### 4.4 Live suite and e2e (run by the coordinator against lucashome, QA data only)

- `src/live/phase-g4.live.test.ts`
  - **G5-1** adds PNG and a PNG of exactly 100 KB when 085 is applied. That
    is decided by its ledger row and `max(version) >= 085`, not
    `max(version)` alone, because 085 may land before 084.
  - **G5-2** keeps the PNG case only below 085, where it accepts either
    function build: the 083 build gives invalid_image, the 085 build gives
    completion_refused "Unsupported uploaded image type". The object must be
    gone either way, and the follow-up RPC check accepts that message
    (this is the 2026-10-16 failure).
  - Adds a PNG declared JPEG and a 150 KB PNG.
- `src/live/phoneCompletion.ts`: `isInvalidImage` accepts the 083 and 085
  wording; adds `isCompletionRefused` and `isPost085`.
- `src/live/imageFixtures.ts`: adds `pngOfSize(n)`, a real PNG padded with a
  private ancillary chunk with a valid CRC, which a test checks.
- e2e D and G accept both refusal wordings. G-084's gate is now "084
  actually applied" (ledger row and no `product_images_insert` policy)
  instead of `max(version) >= 084`.

## 5. Deploy order (function vs migration)

**Either order is safe. Recommended: function first, then 085.**

| State | JPEG / WebP | Valid PNG | Refused upload (bad bytes) | RPC refusal (e.g. not configured) |
| --- | --- | --- | --- | --- |
| Today (083 function + 083 DB) | complete | invalid_image, deleted | deleted | **object left behind** |
| New function + 083 DB (after step A) | complete | completion_refused, **deleted** | deleted | **deleted** |
| 083 function + 085 DB (if B came first) | complete | invalid_image, deleted (old byte check) | deleted | left behind (as today) |
| New function + 085 DB (after A and B) | complete | **complete** | deleted | deleted |

Why both orders are safe:

- The RPC stays service_role-only in every state. Whichever function build
  runs, the bytes are checked before any completion, and nothing is accepted
  that the bucket and the byte check would not accept.
- No state stores a PNG without completing or deleting it.
- Each part rolls back alone.

Why function first:

- The orphan cleanup works immediately on 083 and can be verified (smoke
  test) before the schema changes.
- 085 alone, with the old function, makes no visible difference, because
  the old byte check still refuses PNG.

085 vs 084: independent. 085 keeps the `083:` comment prefix that 084
checks, and the harness proves both 083 → 085 → 084 and 083 → 084 → 085.

## 6. Dry run (no production change)

1. **Read-only pre-check on production.** Expected result:
   `7c9c65a96a057189ee84ff850183b627|f|t|t` (the body md5, anon EXECUTE f,
   service_role EXECUTE t, comment starts with `083:`).
   ```sh
   ssh lucashome "docker exec -e PGOPTIONS='-c default_transaction_read_only=on' supabase-db psql -X -U postgres -At -c \"
     SELECT md5(prosrc), has_function_privilege('anon', oid, 'EXECUTE'), has_function_privilege('service_role', oid, 'EXECUTE'),
            obj_description(oid, 'pg_proc') LIKE '083:%'
       FROM pg_proc WHERE oid = 'public.complete_product_image_upload_session(text,text,text,integer,text)'::regprocedure\"" </dev/null
   ```
   Also check the ledger: `SELECT max(version) FROM supabase_migrations.schema_migrations` gives `083` (or `084`).
2. **Harness of record:**
   - run `bash supabase/tests/phase-d/run.sh`; expect `RESULT: PASS` with
     the `t22` guard lines;
   - run it again with `POS_TEST_MAX_MIGRATION=083`;
   - check the `085:` NOTICE lines.
3. **Optional: a restored copy of the newest nightly logical backup.**
   - restore it in a disposable `supabase/postgres:17.6.1.136` container on
     127.0.0.1;
   - run `psql -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/085_png_completion.sql`;
   - expect `NOTICE 085: current completion body is the 080 body` and the
     "sessions/objects unchanged" line;
   - delete the container.
4. **Script dry-run:** `deploy/lucashome/apply-migrations.sh --from 085 --to 085 --dry-run`.
   Check that the range lists only `085_png_completion.sql`, so 084 is not
   swept in by accident.
5. **Function dry run:** run the Deno suite and the audit stack
   (`--max-migration 083` shows the new function on the production schema).

## 7. Deploy steps (each step needs owner approval; not done)

A. **Function.**
   1. Back up the current server copy:
      `ssh lucashome 'cp -a /srv/supabase/stack/volumes/functions/phone-upload-token /srv/supabase/backups/phone-upload-token.pre085'`.
   2. Copy the new code:
      `rsync -a --delete --exclude .DS_Store supabase/functions/phone-upload-token/ lucashome:/srv/supabase/stack/volumes/functions/phone-upload-token/`.
   3. Restart the functions service:
      `ssh lucashome 'cd /srv/supabase/stack && docker compose restart functions'`.
   4. Smoke test:
      - `deploy/lucashome/functions-router.sh verify` reports all PASS;
      - `{"token":"short","action":"complete"}` returns 404 `invalid`;
      - one QA phone upload completes;
      - on 083, a QA PNG returns completion_refused and leaves 0 objects at
        its path.

   `phone-upload-page` is unchanged and not redeployed.
B. **Migration.**
   1. Dry run: `deploy/lucashome/apply-migrations.sh --from 085 --to 085 --dry-run`.
   2. Real run: the same command without `--dry-run`. This takes a backup,
      records the LSN, applies in a single transaction, records the
      version, and takes a post backup.
C. **Verify.**
   - The §6.1 query returns `dc822a6435c3e512acdc933c4a2995a8|f|t|t`.
   - The live suite phase-g4 (G5-1 now includes PNG) and e2e D/G pass.
   - `tools/security-audit/run.sh --max-migration 085` passes, with the
     parity check at the production level.

## 8. Rollback

- **Migration** (no data changed):
  1. Re-run 080's block "3/5 complete_product_image_upload_session" (the
     080 body).
  2. Then re-run 083's grant/comment block:
     `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role; COMMENT … '083: …'`.
  3. Delete the ledger row:
     `DELETE FROM supabase_migrations.schema_migrations WHERE version = '085'`.

  Sessions already completed as `image/png` stay COMPLETED; they are valid
  images.
- **Function:** restore `/srv/supabase/backups/phone-upload-token.pre085`
  (or `git show 29ad4cb:supabase/functions/phone-upload-token/{index,imageCheck}.ts`),
  then restart functions. The old build refuses PNG at the byte check, so it
  is safe with 085 too.
- **PITR:** the LSN recorded by `apply-migrations.sh`.

## 9. Residual risks

- **Window between the checks and the DELETE.** A completion could only
  commit in it if the RPC began to accept the very object it just refused,
  i.e. an operator changed `app_config` in that window. If that happens, an
  error is logged.
- **Expired or cancelled sessions with an object.** No completion runs for
  them, so they wait for the sweep, which is prepared but not scheduled
  (g5-followups.md §2.5).
- **Kept objects.** A refused object kept for safety (a reference, a failed
  check, a replaced object) is logged as `refused object NOT deleted`, and
  the sweep handles it once the session has expired.
