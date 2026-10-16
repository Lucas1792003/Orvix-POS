# Phase F · Gateway logging review (Envoy access log)

Status 2026-10-16: **review done; revised format prepared and tested
locally, NOT applied.** Server inspection was read-only: the template copy,
`docker inspect`, `docker logs` piped into a counter on the server. Only
counts, parameter names and a redacted line shape were printed. No token, IP
or user agent was shown or copied.

Related: [`till-readiness-084.md`](till-readiness-084.md) §3.3 (why the
access log matters, `reduce`), [`studio-isolation.md`](studio-isolation.md) §7
(the gateway recreate to bundle with), `deploy/lucashome/envoy_access_log_client_info.py`
(the earlier proposal, superseded here).

## 1. Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| **L1** | **Live: the access log records the full request path with its query string.** Signed-URL tokens (`?token=<JWT>`), the realtime `?apikey=<JWT>`, PostgREST filter values with personal data (`email=eq.…`, `email=ilike.…`) and other filter values are in `docker logs supabase-envoy` today | **Medium** | fix prepared (§5), not applied |
| L2 | The `Referer` header is logged (with any query string it carries); no referer with a query was seen in the window | Low | removed by the fix |
| L3 | Missing useful fields: duration, upstream cluster, response flags, `x-client-info` | Low (operability) | added by the fix |
| L4 | GoTrue (`supabase-auth`) logs e-mail addresses (`actor_username`, `user_email`): 3,360 occurrences in 24 h, all QA `@….invalid` addresses today; staff addresses after go-live | Low | upstream behaviour, accepted; bounded by rotation (§4) |
| L5 | `platform-console` edge function logs the creator's e-mail in "created organization … by <email>" | Low | proposal: log the user id instead (code change, not done here) |
| L6 | The history file for `reduce` has no rotation or retention yet (cron not installed) | Low | proposal §4.3 |

What is fine today: no `Authorization`, `apikey` or `Cookie` header, no
`Set-Cookie`, and no request or response body is logged by Envoy (format
review, confirmed by the local test). storage-api redacts its own `token=`
values (one distinct 8-letter placeholder across 748 occurrences, no JWT).
PostgREST and realtime logs contain no JWT, token, apikey or e-mail. Every
container has json-file rotation 20 MB × 5. The logs can be read only by
root and the `docker` group.

## 2. Current production format (read-only, 2026-10-16)

Template `volumes/api/envoy/lds.template.yaml` (sha `a635a7aa…`), listener
`supabase`, the only `access_log` (stdout):

```
%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT% - - [%START_TIME(%d/%b/%Y:%H:%M:%S %z)%] "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%" %RESPONSE_CODE% %BYTES_SENT% "%REQ(REFERER)%" "%REQ(USER-AGENT)%"
```

`:path` and `x-envoy-original-path` in Envoy include the query string. Shape
of `docker compose logs --tail 5 api-gw` (redacted on the server):

```
supabase-envoy  | <peer> - - [<time>] "GET /storage/v1/object/public/<object> HTTP/1.1" 200 30350 "-" "<user-agent>"
```

Measured over the container's whole log (06:38–09:46 UTC, 3 h 08 min, 20,809
access lines, most of it QA test traffic). Counts and parameter names only:

| Item | Count |
|---|---|
| lines with a query string | 11,326 |
| path contains a JWT | **291** |
| `token=` (signed upload URL `PUT /storage/v1/object/upload/sign/…?token=<JWT>`) | 202 |
| `apikey=` (`GET /realtime/v1/websocket?apikey=<anon JWT>&vsn=…`) | 89 |
| `email=eq.` / `email=ilike.` on `/rest/v1/users` | 9 / 18 |
| other filters: `auth_id=eq.` (users, admin_login_codes, platform_admins), `token_hash=eq.` (upload sessions; a sha256, not the token), `receipt_no=`, `storage_path=`, `image_url=`, `key=` (idempotency keys) | 962 `token_hash`, 136 `auth_id`, … |
| referer present / with a query / with a JWT | 5,880 / 0 / 0 |
| peer address | 100 % `172.20.0.1` (Docker bridge gateway) |

**Peer address.** Tailscale serve connects to `127.0.0.1:8000`, and
docker-proxy forwards that to the container from the bridge gateway. Envoy
therefore sees `172.20.0.1` for every request. `use_remote_address: true`
with no trusted hops means an incoming `X-Forwarded-For` is not trusted.
Tailnet client addresses never reach the log. The field carries no personal
data. It is kept because a different value would show that the gateway was
reached by another path.

### 2.1 Risk of the current format (L1)

- **What leaks.** Signed upload tokens let the holder write one object
  path, and they are short-lived (storage-api's default for signed upload
  URLs is 2 h). Signed download tokens let the holder read one object until
  `expiresIn`. The realtime `apikey` is the anon key: public by design, but
  still a credential. `/auth/v1/verify?token=…` (recovery or invite links)
  would be logged the same way if those flows are used. E-mail filter values
  are personal data (staff e-mails).
- **Who can read it today.** root and the `docker` group (`docker logs` /
  `docker compose logs`). The json files are under `/var/lib/docker/containers`
  (`0710 root`). Only `lucario` is in `docker`, and `lucario` already has
  sudo and can read `.env` (`0600`). On the host itself, the log adds little
  to what that account can already do.
- **The real exposure is copies.** `docker compose logs` output pasted into
  a ticket, a chat or a support bundle, copied to the Mac for analysis, or
  shipped later to a log service carries the tokens and e-mails with it.
  Logs survive until rotation (§4) or a container recreate.
- **Rating: Medium.** Credentials and personal data in logs (CWE-532). The
  tokens are short-lived and on a single-admin host, but it is live. The fix
  is a one-line format change.
- **Interim, until applied:** never paste raw gateway logs anywhere. Use
  `verify-till-readiness.sh reduce` (no path, token, referer or address) or
  counts. Recreating `api-gw` for the fix also discards the old container's
  log, and with it the logged tokens. Run `reduce` first (§6).

## 3. Field review (what a minimal line needs)

| Field | Needed for | Today | Proposed |
|---|---|---|---|
| time | ordering, till readiness window | yes | same (`START_TIME`, same format) |
| method | request class | yes | same |
| path **without** query | route, request class (`reduce` strips the query anyway) | **with** query | `%PATH(NQ:ORIG)%`: original path (before prefix rewrite, as today), query removed |
| status, bytes sent | errors, size | yes | same |
| duration | slow requests | no | `rt=%DURATION%` (ms) |
| upstream | which service answered | no | `up=%UPSTREAM_CLUSTER%` (`-` for direct responses) |
| response flags | timeouts, resets, no route | no | `rf=%RESPONSE_FLAGS%` |
| user agent | client kind / version (`reduce`) | yes, unbounded | `%REQ(USER-AGENT):256%` |
| `x-client-info` | app version + capability (till readiness) | no | `%REQ(X-CLIENT-INFO):160%` (no secret: `shwephala-pos/<v> (<caps>)`) |
| referer | nothing | yes | **removed** |
| peer address | topology signal (§2) | yes | same |
| Authorization / apikey / Cookie / Set-Cookie | — | not logged | not logged |
| request / response bodies | — | not logged | not logged |

The proposed line keeps the shape that `verify-till-readiness.sh` parses
(`reduce`), so that script needs no change. The second quoted field, where
the referer used to be, carries the metrics:

```
<peer> - - [<time>] "<METHOD> <path> <proto>" <status> <bytes> "rt=<ms> up=<cluster> rf=<flags>" "<user agent>" "<x-client-info>"
172.21.0.1 - - [16/Oct/2026:10:24:21 +0000] "GET /storage/v1/object/sign/product-images/org/o/a.jpg HTTP/1.1" 200 44 "rt=0 up=storage rf=-" "Mozilla/5.0 (…) retails-shop/1.0.16 Chrome/138.0 Electron/37.10.3 Safari/537.36" "shwephala-pos/1.0.16 (validated-uploads; idem-v1; outbox-origin-v1; update-guard-v1)"
```
(The second line is from the local test, §5.1. The object path is a test
name.)

What paths still carry: table and RPC names, storage object names (org
slug + generated file name), and ids in auth admin paths. None of these is a
credential. An object name is chosen by the app (`org/<org>/…/pimg-<uuid>`),
not by staff.

Review of the earlier proposal (`envoy_access_log_client_info.py`): its
field is fine (no secret, `-` when missing), but it leaves L1 and L2 in place
and the header unbounded. **Superseded** by `envoy_access_log_minimal.py`,
which contains the same field, truncated to 160 characters. The minimal tool
also accepts a template on which the old one was already applied.

## 4. Access control, rotation, retention

### 4.1 Access

| Log | Location / reader | Mode |
|---|---|---|
| container stdout (all services) | `/var/lib/docker/containers/<id>/<id>-json.log`; via `docker logs` | dir `/var/lib/docker` `0710 root:root`; CLI = root or `docker` group (`docker:x:108:lucario`, root-equivalent) |
| backup / cron logs | `/srv/supabase/backups/logs/` | dir `0700 lucario`; files `0600` (`cron.log` `0664` inside the `0700` dir) |
| `reduce` history (planned) | `/srv/supabase/backups/logs/till-access*.tsv` | `verify-till-readiness.sh` runs with `umask 077` → `0600` in a `0700` dir |

No change proposed. Keep `docker` group membership to the one admin account.

### 4.2 Rotation (verified)

`docker inspect` on all ten stack containers: `json-file`,
`max-size 20m`, `max-file 5` (from `x-logging` in the override). There is no
`/etc/docker/daemon.json`, so every service needs that override entry.
Today all of them have it. The cap is ≤ 100 MB per container. A container
recreate starts a new, empty log.

Volume: Envoy wrote 4.55 MB in 3 h 08 min of mostly QA traffic
(≈ 35 MB/day), so the cap holds about 3 days at that rate. Normal shop
traffic is lower, so the cap holds more days. Rotation is by size only:
docker json-file has no time limit.

### 4.3 Retention (proposal)

- **Container logs:** keep the size bound as the limit (≤ 100 MB per
  service, reset on every recreate). With the minimal format the gateway log
  holds no credential or e-mail, so a longer tail on quiet days is
  acceptable. GoTrue's e-mail addresses (L4) are bounded the same way.
- **`reduce` history (L6): 30 days.** Till readiness needs ≥ 72 h
  (`--min-log-hours`). 30 days covers a month of tills that are off for a
  while, and it stays inside the 14–30 day range. The records hold no path,
  token, referer or address: time, client kind/version/capability, request
  class, status and md5 of the object path. Proposed crontab of `lucario`
  (NOT installed, owner approval; replaces the single-file line in
  till-readiness-084.md §3.3):
  ```
  5 * * * *  $HOME/till-readiness/verify-till-readiness.sh reduce --since "$(date -u -d '1 hour ago' +\%Y-\%m-\%dT\%H:00:00Z)" --until "$(date -u +\%Y-\%m-\%dT\%H:00:00Z)" >> /srv/supabase/backups/logs/till-access-$(date -u -d '1 hour ago' +\%Y\%m\%d).tsv 2>/dev/null
  17 3 * * * find /srv/supabase/backups/logs -maxdepth 1 -name 'till-access-*.tsv' -mtime +30 -delete
  ```
  The report then takes the daily files (`--access-log` + the history
  list, which already accepts several files).

## 5. Revised proposal (prepared, not applied)

`deploy/lucashome/envoy_access_log_minimal.py` `status | apply | revert`:

- Finds the single access-log format string (an `inline_string` containing
  `%RESPONSE_CODE%`; the Studio isolation's 404 body is ignored) and
  recognises three exact states: `upstream`, `client-info` (old proposal)
  and `minimal`.
- `apply`: upstream or client-info → minimal. `revert` → the upstream line,
  byte-identical (sha `a635a7aa…` again on the server template). Idempotent.
  Anything else refuses and writes nothing. It prints states only.
- Composes with the G5 header rule and the Studio isolation in any order.
  It touches one line.

### 5.1 Local test evidence

`deploy/lucashome/tests/envoy-access-log-minimal-test.sh` (Envoy v1.39.1,
`node:24-slim` stubs, loopback ports, upstream entrypoint renders the
templates), run with `SERVER_LDS=<read-only copy of the server template>`:
**37 passed, 0 failed** (2026-10-16).

- Tool: server copy byte-identical to the derived `a635a7aa…`; apply changes
  exactly one line; idempotent; `revert(apply(server)) = server`;
  client-info → minimal gives the same bytes; a hand-edited format is
  refused; `studio(minimal(x)) = minimal(studio(x))`; `--mode validate`
  passes for minimal, minimal + Studio isolation, and the current server
  template.
- The same 9 requests went to a **control** gateway (today's template) and a
  **minimal** one. They carried a runtime-generated JWT as signed-URL
  `?token=`, upload-sign `?token=`, realtime `?apikey=`, `/auth/v1/verify?token=`,
  phone page `?token=` and inside a filter value, plus `email=eq.` /
  `email=ilike.` values, `Authorization`, `apikey`, `Cookie`, a referer
  with a query, request bodies, and a response `Set-Cookie` / body token.
  - control: logs the JWT (≥ 5 lines), both e-mail filter values and the
    referer query. This reproduces L1/L2. Headers, cookies and bodies are not
    logged.
  - minimal: **0** JWT, **0** `eyJ`, 0 e-mail values, 0 referer, 0
    header/cookie/body markers, **no `?` in any path**, no `token=` /
    `apikey=` / `email=` / `grant_type=`. Paths are kept, and every line
    has `rt=… up=… rf=…`. The upstream clusters seen were auth, functions,
    realtime, rest and storage. `x-client-info` was on all 9 lines.
  - `verify-till-readiness.sh reduce` reads all 9 minimal lines →
    `desktop|1.0.16|yes`, and classifies the signed PUT from the
    query-free path.

## 6. Apply runbook (owner approval; NOT executed)

Bundle with the Studio isolation so `api-gw` is recreated **once**. The
access-log edit goes into the live template first, with no recreate. The
running Envoy keeps its rendered config, because the template is only read
at start. The Studio isolation's `stage` then derives from that file, and
its `validate` tests the combined template on the temporary gateway. Its
`apply` does the single recreate.

```
mac$ scp deploy/lucashome/envoy_access_log_minimal.py lucashome:~/studio-isolation/
mac$ ssh lucashome 'mkdir -p ~/till-readiness' && scp deploy/lucashome/verify-till-readiness.sh lucashome:~/till-readiness/   # not on the server as of 2026-10-16
ls$  cd /srv/supabase/stack && L=volumes/api/envoy/lds.template.yaml
ls$  ~/till-readiness/verify-till-readiness.sh reduce >> /srv/supabase/backups/logs/till-access-$(date -u +%Y%m%d).tsv   # keep the till history (no tokens in it)
ls$  python3 -I ~/studio-isolation/envoy_access_log_minimal.py status $L          # upstream (1 format string(s))
ls$  cp -p $L $L.pre-access-log-minimal.$(date -u +%Y%m%dT%H%M%SZ)
ls$  python3 -I ~/studio-isolation/envoy_access_log_minimal.py apply $L $L.new && mv $L.new $L
ls$  python3 -I ~/studio-isolation/envoy_access_log_minimal.py status $L          # minimal
#    then studio-isolation.md §7: ./studio-isolation.sh stage → validate → apply --yes (one recreate)
ls$  sleep 5; docker logs --since 2m supabase-envoy 2>&1 | grep -c '?'            # 0 for request lines
ls$  docker logs --since 2m supabase-envoy 2>&1 | grep -cE 'eyJ[A-Za-z0-9_-]{10,}\.'   # 0
```

Alone (without the Studio isolation): the same install, then
`docker compose run --rm --no-deps -v $PWD/$L:/etc/envoy/lds.template.yaml:ro api-gw --mode validate`
and `docker compose up -d --force-recreate api-gw`. API connections drop for
a few seconds, and tills retry from the outbox.

Revert: `python3 -I envoy_access_log_minimal.py revert $L $L.new && mv $L.new $L`
(gives the template back byte for byte, header rule and Studio isolation
kept), then recreate `api-gw`.

## 7. Owner decisions

1. Apply §6 (recommended in the Studio isolation window). This closes L1–L3.
2. Install the `reduce` cron with 30-day retention (§4.3, L6).
3. Optional: change `platform-console` to log the user id instead of the
   e-mail (L5). L4 (GoTrue) is accepted as upstream behaviour.
