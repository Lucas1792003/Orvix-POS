# Phase F · Per-till readiness proof before migration 084

Date: 2026-10-16. Branch `feature/selfhost-supabase-migration`, local only.
**Nothing deployed, no migration added, no server change.** The server was
inspected read-only (counts, versions, states; no names, no e-mails).

Migration 084 ([g5-followups.md](g5-followups.md) §1.2) removes the staff
INSERT/UPDATE storage policies on `product-images`. Any till still on a build
that uploads directly then loses desktop image upload (403), and pre-JIT builds
lose the phone QR flow too. 084 has its own readiness guard, but it only sees
owner-stamped direct uploads of the **last 14 days**: it catches an old till
that is actively uploading, not an idle one. This document adds a per-till
proof, so step 2 of the rollout order (g5-followups.md §4) can rest on
evidence instead of memory.

| File | Purpose |
|---|---|
| `deploy/lucashome/verify-till-readiness.sh` | read-only report: per-user and per-till table, GO / NO-GO / INSUFFICIENT EVIDENCE for 084, with the reasons |
| `deploy/lucashome/tests/verify-till-readiness-test.sh` | disposable Postgres + synthetic access logs: 7 cases, 39 checks |
| `docs/selfhost-migration/phase-f/till-register.csv` | the owner's till register (private repo; template, no rows yet) |
| `deploy/lucashome/envoy_access_log_client_info.py` | **prepared, not applied**: adds `x-client-info` to the Envoy access-log line |

## 1. What identifies a till today

| Identifier | Where it comes from | Server sees it? | Use |
|---|---|---|---|
| **till id** `till-<10 hex>` | `src/lib/tillId.ts`, created on first use, kept in the app profile's `localStorage` (`pos-till-id`); survives restarts and sign-outs; a reinstall that wipes the profile makes a new one | **no** (by design: "never sent to the server") | the register key |
| logged-in user | `public.users.id` (linked to `auth.users` by `auth_id`) | yes: `created_by` of upload sessions, `owner` of storage objects | links server evidence to a till via the register |
| build | Electron user agent `…retails-shop/<version> Chrome/… Electron/…` (app name + `package.json` version, Electron default); from 1.0.16 also `X-Client-Info: shwephala-pos/<version> (validated-uploads; …)` (`src/lib/clientInfo.ts` of the 1.0.16 client work) | user agent: **yes, logged** by Envoy today. `X-Client-Info`: sent, **not logged** | version + capability per request |
| Electron install | per-user install directory on Windows; no stable id | no | — |

A till id is not tied to a user: several staff may sign in on one till. The
server can attribute an upload to a **user and a moment**, never to a till.
The register closes that gap: the owner records which user made the test
upload on which till, and when.

**Reading the till id on the device** (in order of preference):
1. the version line of 1.0.16 (login page / sidebar: version, backend,
   "validated uploads: yes"). **Request to the 1.0.16 client work:** add the
   till id to that line (or to an About panel). It stays UI-only: not in the
   header, not in any request.
2. the queue-export file name: `pending-queue-<till id>-<UTC>.spqx`
   ([queue-export.md](queue-export.md)). Only offered while the queue holds
   entries, so it fits the canary's offline step (canary checklist §5.3).
3. last resort: DevTools → Application → Local Storage → `pos-till-id`.

## 2. The till register

`docs/selfhost-migration/phase-f/till-register.csv` (private repo). One row per
till that is, or was, in use:

| Column | Content |
|---|---|
| `till_id` | from §1 |
| `label` | owner's name for it, e.g. "Shop A counter" |
| `shop_id` | the shop it serves |
| `user_ref` | the pseudonym the script prints for the user who made the test upload (`u-<10 hex>` = sha256 of `users.id`). Never the user id or e-mail: ids can embed an e-mail address |
| `updated_utc` | when 1.0.16 was installed |
| `test_utc` | when the test upload was made (§5); the script accepts a desktop-validated upload by that user within ±30 min |
| `retired` | `yes` for a till that is gone (wiped, sold, replaced): ignored, but keep the row |

Lines starting with `#` are comments. The file is copied to the server only
for a run (`~/till-readiness/`), never kept in the stack directory.

## 3. Evidence on the server (read-only)

### 3.1 Database (one `BEGIN TRANSACTION READ ONLY`)

| Signal | Meaning | Old-client footprint? |
|---|---|---|
| 084's own predicate, verbatim: `product-images` object at `(org/<org>/)products/<id>/<file>` with `owner`/`owner_id` set, created in the window | a staff JWT wrote the object directly (pre-G5 desktop) | **yes**: 084 would abort |
| object at `org/<org>/temp/<session>` **with** an owner | a staff JWT signed the session's upload URL (`createSignedUploadUrl`): pre-JIT desktop phone flow. The validated flow signs with the service role, so its objects have **no** owner | **yes**, and 084's guard does not see it |
| the same, per uploader (`owner` → `users.auth_id`) | which user still runs an old build | per-user row |
| upload sessions of the window: creator, shop, status, times, `md5(storage_path)` | joined with the log (§3.2) to find who uploaded the bytes | — |
| 083 applied (`083:` comment), 084 applied (policies gone / `084:` comment) | preconditions | — |
| `users`: role, shop, active, can-upload (ADMIN/MANAGER or a `product:create/update` grant; approximation), last sign-in | who must be proven | — |

The 574 migrated objects and every service-role write have no owner, so they
never count.

### 3.2 Gateway access log

Envoy (`supabase-envoy`) logs every request to stdout (`docker logs`, json-file
5 × 20 MB):
`<addr> - - [<time>] "<METHOD> <path> <proto>" <code> <bytes> "<referer>" "<user-agent>"`.
All requests arrive from `127.0.0.1` (Tailscale serve), so the address carries
no information; the **user agent does**. Checked 2026-10-16: 14,335 lines,
desktop UA `retails-shop/1.0.15 … Electron/…` (2,913), iPhone Safari, the
functions runtime (`Deno/… SupabaseEdgeRuntime`), tools.

The signed `PUT /storage/v1/object/upload/sign/product-images/<session path>`
is made by the device that holds the bytes. Joined on the session path (as an
md5, inside the script), it attributes each completed session:

| PUT user agent | Session counts as |
|---|---|
| Electron, version ≥ 1.0.16, capability not refused | **desktop-validated** (the proof) |
| Electron, older / `0.0.0-dev` / capability missing in `X-Client-Info` | desktop from an old build |
| mobile browser | phone (JIT page; validated, keeps working after 084) |
| not in the log | unattributed (log gap) |

Further log footprints, counted only for 2xx from an app or browser user
agent (never the functions runtime or tools): `POST|PUT
/storage/v1/object/product-images/…` (direct write) and `POST
/storage/v1/object/upload/sign/product-images/…` (staff signing).

The script never prints paths, query strings or referers (the phone page URL
carries its session token in the fragment; signed PUTs carry a token in the
query). Object paths are compared as md5 values inside the process only.

### 3.3 Limits and the two prepared additions

1. **The log resets when `api-gw` is recreated** (every gateway change). On
   2026-10-16 the coverage was 2.1 h (recreated 06:37 UTC for the header rule).
   The `reduce` mode writes the log as reduced records (time, client kind,
   version, capability, request class, status, md5 of the object path; no
   path, token, referer or address), for an hourly history file:
   ```
   # crontab of lucario (NOT installed; owner approval):
   5 * * * * $HOME/till-readiness/verify-till-readiness.sh reduce --since "$(date -u -d '1 hour ago' +\%Y-\%m-\%dT\%H:00:00Z)" --until "$(date -u +\%Y-\%m-\%dT\%H:00:00Z)" >> /srv/supabase/backups/logs/till-access.tsv 2>/dev/null
   ```
   and the report then takes `--access-log /srv/supabase/backups/logs/till-access.tsv`.
   Before the gateway is recreated, one manual `reduce >> …` keeps what the
   container held. The stdout access log is flushed periodically: a request
   shows up within seconds.
2. **`X-Client-Info` is not logged.** The 1.0.16 client sends
   `shwephala-pos/<version> (validated-uploads; idem-v1; …)` on every
   supabase-js request (global header, replaces supabase-js's default).
   `envoy_access_log_client_info.py apply` appends `"%REQ(X-CLIENT-INFO)%"` as
   a last field of the access-log format (missing header → `-`); status /
   apply / revert, idempotent, composes with the header rule, the Studio
   isolation and the rate limit in any order (tested, §6). Not applied. It is
   a gateway change like the others: validate with
   `docker compose run --rm --no-deps -v <new>:/etc/envoy/lds.template.yaml api-gw --mode validate`,
   back up, install, `docker compose up -d --force-recreate api-gw` (run
   `reduce` first, see 1). Until then the user agent alone gives the version;
   the capability is then inferred from the version (1.0.16 is the first
   build with the validated flow). The script reads both formats.

   Bundling: apply it in the **same** gateway recreate as the Studio isolation
   (studio-isolation.md §7), so the log resets only once.

No migration is needed for any of this.

## 4. The script

```
mac$ ssh lucashome 'mkdir -p ~/till-readiness'
mac$ scp deploy/lucashome/verify-till-readiness.sh docs/selfhost-migration/phase-f/till-register.csv lucashome:~/till-readiness/
ls$  ~/till-readiness/verify-till-readiness.sh --register ~/till-readiness/till-register.csv
     # options: --days 14 (DB window, = 084) --min-version 1.0.16 --min-log-hours 72
     #          --old-quiet-hours 72 --recent-minutes 60 --access-log <history> --no-docker-logs
# without copying (no register):
mac$ ssh lucashome 'bash -s -- report' < deploy/lucashome/verify-till-readiness.sh
```

Output: server state; DB footprints; log coverage; every app client seen
(kind, version, capability, requests, last seen; old ones marked); log
footprints; a per-user table (user ref, role, shop, active, can upload, last
sign-in, sessions, desktop-validated, desktop-old, phone, unattributed,
direct uploads, readiness READY / OLD CLIENT / unproven); the desktop-validated
uploads of the last 60 min (for the owner's test); the register with each
till PROVEN / not; the verdict. Exit 0 GO (or 084 already applied), 1 NO-GO,
2 INSUFFICIENT EVIDENCE, 3 error.

## 5. GO criteria

**NO-GO** if any of these holds:
1. 083 is not applied.
2. 084's predicate > 0 (direct staff upload in 14 days).
3. Owner-stamped session objects in 14 days (staff-signed uploads).
4. A direct-write or staff-signing request from an app/browser in the log.
5. An Electron build older than `--min-version` (or with `X-Client-Info`
   lacking `validated-uploads`) made **any** request within the last
   `--old-quiet-hours` (72 h). This catches an old till that is only selling.
6. A registered till's test upload came from an old build.

**INSUFFICIENT EVIDENCE** (no footprint, readiness not proven) if any of:
7. no register, or a non-retired till is not PROVEN;
8. log coverage < `--min-log-hours` (72 h; with the history file of §3.3);
9. an active user who may upload and signed in within 14 days has no
   desktop-validated upload and is not the user of a proven till.

**GO** = none of 1–9. Then apply 084 as g5-followups.md §4 step 3 says. The
`phf.g5_084_force` override is not needed after a GO (the guard passes).

Not covered (stated, accepted): a till that is switched off for the whole
window and comes back later on an old build. Mitigation: retire it in the
register, and an old build that comes back after 084 only loses image upload
(403); sales are unaffected.

## 6. Owner steps, per till

At each till, after installing 1.0.16 (canary checklist
[`../../desktop-app/canary-1.0.16-checklist.md`](../../desktop-app/canary-1.0.16-checklist.md) §1, §4.1, §7.2):

1. The version line shows **1.0.16**, the self-hosted backend, and
   **validated uploads: yes**. Photograph it.
2. Read the till id (§1) and fill a register row: `till_id`, `label`,
   `shop_id`, `updated_utc`.
3. Signed in as a user who may edit products, upload **one** product photo
   **from the desktop file picker** (not the phone QR) on the canary product.
   Note the UTC time in `test_utc`.
4. Engineer, within the next hour:
   `verify-till-readiness.sh --register …`. The upload appears under "recent
   desktop-validated uploads" with version 1.0.16 and `OK`; copy its user ref
   into `user_ref`. Re-run: the till shows **PROVEN**.
5. A till that will no longer be used: `retired=yes`.

When every till is PROVEN, no old build has been seen for 72 h, the log
covers ≥ 72 h, and no footprint exists: **GO**.

## 7. Production run (read-only, 2026-10-16 08:42 UTC)

```
server: schema 085; 083 applied: yes; 084 applied: no; staff write policies present: product_images_insert,product_images_update
db: 084 guard predicate (owner-stamped direct-path objects, 14 d): 0
db: owner-stamped objects at session paths (14 d, …): 0
log: 14335 access records, 2026-10-16 06:38 → 08:27 UTC (coverage 2.1 h; need 72 h)
   desktop  1.0.15    cap=-           2913  2026-10-16 08:27   <- OLD
log: old-client footprints (direct storage writes / staff-signed upload URLs): 0
per user: 3 users (ADMIN, MANAGER, CASHIER), 0 sessions in 14 d, 0 direct uploads, all "unproven"
till register: (none)
VERDICT: NO-GO for 084
  - an app build older than 1.0.16 (or without validated uploads) was active 0.2 h ago (< 72 h quiet)
  also missing: access-log coverage 2.1 h < 72 h; no till register
```

As expected: no till on 1.0.16 yet, no staff direct upload in 14 days. The
1.0.15 desktop traffic is the development/QA app (the branch's build is still
versioned 1.0.15; real tills still run 1.0.15 against hosted). It is reported
as OLD on purpose: until the version is bumped, the version string cannot
separate it from a real old till.

## 8. Tests (local, disposable)

`deploy/lucashome/tests/verify-till-readiness-test.sh` (postgres:17 container
`phf-till-test-db`, no published port; minimal `storage`/`auth`/`public`
schema with the real policy names and the 083 comment): **39 passed, 0 failed**.

| Case | Data | Result |
|---|---|---|
| old | owner-stamped `products/` object + Electron 1.0.15 direct write | NO-GO (guard, log footprint, user OLD CLIENT) |
| signed | staff-signed session object + staff `POST upload/sign` | NO-GO |
| oldver | all uploads validated, but a 1.0.15 till sold 3 h ago | NO-GO (old build active) |
| noreg | all validated, no register | INSUFFICIENT |
| short | all validated + register, 10 h of log | INSUFFICIENT (coverage) |
| go | 1.0.16 + `X-Client-Info`, 2 tills proven, a phone upload, a cancelled session, a retired till, a cashier, 96 h log | GO |
| m084 | 084 applied | exit 0, "ALREADY APPLIED" |

Also: no object path, token, referer, e-mail, name or user id in any output;
`reduce` output holds no path/token/referer and a report from it alone gives
the same GO; an injected write is refused by the read-only transaction.
The Envoy test in [studio-isolation.md](studio-isolation.md) §8 proves the
prepared access-log field on Envoy v1.39.1 and that `reduce` reads
`desktop|1.0.16|yes` from it.
