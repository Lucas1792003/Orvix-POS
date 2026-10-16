# Phase F: isolating Supabase Studio from the shared API origin

Status: **deploy-ready, rehearsed on the server, NOT applied** (2026-10-16).
The rehearsal staged the change into temporary files and ran a temporary
test gateway on `127.0.0.1:18002`. Every check passed, and the revert of the
staged copy is byte-identical to the live template. The live gateway, Studio
and the stack files were not touched (§7.2). The change is a controlled,
reversible script (`studio-isolation.sh` status / stage / validate / apply /
revert, §7), like the G5 header rule. Applying needs the owner's approval
(final runbook §7.3). Closes checklist item A6d once applied and verified.

Related: [`production-readiness-checklist.md`](production-readiness-checklist.md)
A6d / C4, [`remote-access-architecture.md`](remote-access-architecture.md) §5.3
gate P (P3), [`migration-083-g5.md`](migration-083-g5.md) §5 (same-origin
Studio risk), [`phone-qr-origin.md`](phone-qr-origin.md),
[`rate-limiting.md`](rate-limiting.md) §7, [`host-hardening-staged.md`](host-hardening-staged.md).

Placeholders: `<host>` is the server's SSH alias, `<host>.<tailnet-name>.ts.net`
its tailnet name.

## 1. Current state (read-only, 2026-10-16)

| Fact | Value | How |
|---|---|---|
| Gateway | compose service `api-gw`, container `supabase-envoy`, Envoy v1.39.1, published `127.0.0.1:8000` only | `docker ps --format '{{.Names}} {{.Ports}}'` |
| Studio | compose service `studio`, container `supabase-studio`, healthy, `3000/tcp` exposed on the Docker network only (not published) | same; `docker inspect` health |
| Tailnet origin | `https://<host>.<tailnet-name>.ts.net` (tailnet only) → `/` proxy `http://127.0.0.1:8000`. Funnel: no public entry | `tailscale serve status`, `tailscale funnel status` |
| Envoy template | `volumes/api/envoy/lds.template.yaml` sha256 **`a635a7aa…2190e571`** since 2026-10-16 06:37 UTC = upstream `self-hosted/v0.8.2` (`9d9a6d6e…73566c3d`, kept as `lds.template.yaml.pre-g5-headers`) **+ the G5 header rule** (reproduced byte-for-byte by `envoy_storage_headers.py apply` on upstream). The four Studio/pg routes are still the upstream block. Rate-limit rule not applied. Only `${…}` placeholders, no values (checked before copying) | `sha256sum`; `studio_isolation.py status` (read-only, `ssh … 'python3 -I - status <lds> <override>' < studio_isolation.py`) → `lds: upstream`, `override: upstream` |
| Routes to Studio | three routes on the one listener `supabase` (port 8000): `/api/mcp` → `studio` (RBAC deny), `/mcp` → `studio` (RBAC deny), and the **catch-all `/` → `studio`**, the only route that keeps basic auth on. `/pg/` → `meta` (pg-meta), service key required | `grep` of route names / prefixes / clusters only |
| Compose dependency | `api-gw` `depends_on: studio: condition: service_healthy` (upstream) | `docker compose config` |
| Host ports in use | `0.0.0.0:3000` (open-webui), `0.0.0.0:3100` (another app), `127.0.0.1:5432`, `127.0.0.1:8000`. `54323` is free | `ss -ltn` |
| Docker | server 29.1.3 (loopback-published ports are not reachable from the LAN since Docker 28) | `docker version` |

Probe of `http://127.0.0.1:8000` on the server, no credentials, no key:

| Path | Today |
|---|---|
| `/`, `/project/default`, `/api/platform/profile`, `/nonexistent` | `401`, `WWW-Authenticate: Basic` |
| `/api/mcp`, `/mcp` | `403` |
| `/pg/`, `/auth/v1/health`, `/rest/v1/` | `401` (no Basic challenge; apikey check) |
| `/storage/v1/version`, `/functions/v1/phone-upload-page` | `200` |

So every path that no API route matches lands on Studio and asks for the
dashboard password. Studio itself has no login in the self-hosted image: the
basic auth is the Envoy filter, fed from `DASHBOARD_USERNAME/PASSWORD`.

## 2. Threat

1. **Shared origin.** The API, the phone page (`/functions/v1/phone-upload-page`)
   and Studio share `https://<host>.<tailnet-name>.ts.net`. A browser that
   has entered the dashboard password caches it for that origin and sends it
   on later requests. Any script that ever runs on that origin (a public
   object rendered as a document, a future bug in the phone page or in a
   function response) can then call Studio's API, which runs SQL as
   `postgres` through pg-meta. That is full database control from one XSS.
   083 and the optional header rule shrink the script channel; they do not
   remove Studio from the origin.
2. **Public exposure.** The recommended remote-access path is a Cloudflare
   Tunnel to `127.0.0.1:8000`; the fallback-of-fallback is Tailscale Funnel,
   which publishes the whole port. Either would put Studio on the internet
   behind one SHA-1 basic-auth password with no rate limit. The tunnel
   ingress allow-list (gate P3) is one layer; it does not cover Funnel, a
   mis-typed ingress rule, or the tailnet itself (allow-all ACL, T7).
3. **Tailnet reach.** Today every tailnet device, including tills and
   phones once they join, gets the Studio password prompt.

## 3. Options compared

| | (a) Studio on a loopback port, SSH tunnel | (b) Separate `tailscale serve` port / hostname | (c) Remove the Studio routes from the shared listener | (d) Stop Studio when not needed |
|---|---|---|---|---|
| What | compose publishes Studio on `127.0.0.1:54323` only; operator uses `ssh -L` | e.g. `tailscale serve --https=8443 http://127.0.0.1:54323`, or a second node name | replace `/`, `/api/mcp`, `/mcp` (and `/pg/`) with a plain 404 route | `docker compose stop studio`, or a compose profile |
| Origin separation | yes (`http://127.0.0.1:54323` on the Mac) | port: different origin, same host name and cookies-by-host; second hostname: needs a second node | removes Studio from the API origin | none while running |
| Reach | only someone with SSH to the server | every tailnet device (ACL allow-all today) | — | — |
| Public-exposure safe | yes | no for Funnel on that port; a tunnel would not route it | yes, independent of the tunnel config | only while stopped |
| Cost | one compose line; SSH already used | another serve entry to keep off Funnel; a second hostname means a second tailnet device | one Envoy patch, tested | api-gw `depends_on` must be reset; Studio start takes ~20 s |
| Alone enough? | no: Studio is still on the API origin until (c) | no | no: operator loses Studio until (a) | no |

## 4. Decision

**(c) + (a), with (d) optional later.**

- Envoy: the three Studio routes and `/pg/` are replaced by one last route,
  `phf-not-found`, a direct `404` with basic auth disabled and RBAC
  allow-all. Every unmatched path now answers `404 not found`, with no
  password prompt, and nothing reaches Studio or pg-meta through the
  gateway. The 404 route is required: with the routes merely deleted, an
  unmatched request would still go through the basic-auth filter (`401
  Basic`) and the global RBAC filter (`403`).
- `/pg/` is removed too. The app never calls it (no `/pg/` in `src/`,
  `electron/` or `supabase/functions/`), and Studio talks to pg-meta
  directly (`STUDIO_PG_META_URL=http://meta:8080` in upstream compose).
  Its only guard today is the service-role key.
- Compose: Studio is published on `127.0.0.1:54323` and reached from the Mac
  with an SSH local forward. Loopback plus SSH replaces the basic auth.
- (b) is rejected: it keeps Studio on the tailnet, behind the same password,
  under the allow-all ACL.

Residual risk of (a): while the tunnel is open, Studio is reachable at
`http://127.0.0.1:54323` on the Mac without a password, by any local process
and, in principle, by a web page making requests to localhost. Open the
tunnel only while using Studio, in the foreground, and close it after
(§6.3). A second loopback Envoy listener with basic auth in front of Studio
would add a password; not proposed, because the gain over a short-lived
tunnel is small and it adds a second listener to maintain.

## 5. Prepared files (not applied)

| File | Purpose |
|---|---|
| [`deploy/lucashome/studio-isolation/studio-isolation.sh`](../../../deploy/lucashome/studio-isolation/studio-isolation.sh) | **the server procedure**: `status` (read-only), `stage` (edited copies to `~/studio-isolation/stage/`), `validate` (envoy `--mode validate` + temporary test gateway + `verify`), `verify` (read-only HTTP checks, §7.1), `apply --yes`, `revert --yes` |
| [`deploy/lucashome/studio-isolation/studio_isolation.py`](../../../deploy/lucashome/studio-isolation/studio_isolation.py) | the edit itself, status / apply / revert, for the template **and** the compose override. Replaces the upstream four-route block (sha256 pinned `f121d31b…`) by `phf-not-found`; adds / removes exactly 4 lines in the override's `studio:` block. Idempotent; unknown state refuses and writes nothing; prints structure only |
| [`deploy/lucashome/studio-isolation/upstream-studio-routes.yaml`](../../../deploy/lucashome/studio-isolation/upstream-studio-routes.yaml) | the verbatim upstream block that `revert` puts back (placeholders only) |
| [`deploy/lucashome/studio-isolation/lds-studio-isolation.patch`](../../../deploy/lucashome/studio-isolation/lds-studio-isolation.patch) | superseded by the script, kept for review: `apply` on upstream gives exactly its patched sha `95bd48a7…0064f8f`. Not used on the server any more (today's file is not upstream by sha) |
| [`deploy/lucashome/studio-isolation/compose-studio-loopback.yml`](../../../deploy/lucashome/studio-isolation/compose-studio-loopback.yml) | the `ports:` entry for the `studio` block of `docker-compose.override.yml` (required) |
| [`deploy/lucashome/studio-isolation/compose-studio-on-demand.yml`](../../../deploy/lucashome/studio-isolation/compose-studio-on-demand.yml) | optional (d): `profiles: [studio]` + `api-gw.depends_on: !reset {}` |
| [`deploy/lucashome/tests/envoy-studio-isolation-test.sh`](../../../deploy/lucashome/tests/envoy-studio-isolation-test.sh) | local proof of the route change, §8 |
| [`deploy/lucashome/tests/studio-isolation-tool-test.sh`](../../../deploy/lucashome/tests/studio-isolation-tool-test.sh) | local proof of the script: shas, idempotency, order independence, compose, Envoy run + `verify`, §8.1 |

### 5.1 Envoy change

In the route list of listener `supabase`, the four routes after
`realtime-v1-ws-protected` (`pg-protected`, `/api/mcp`, `/mcp`, `/`) become:

```yaml
                      - name: phf-not-found
                        match:
                          prefix: /
                        direct_response:
                          status: 404
                          body:
                            inline_string: "not found\n"
                        typed_per_filter_config:
                          envoy.filters.http.basic_auth:
                            '@type': >-
                              type.googleapis.com/envoy.config.route.v3.FilterConfig
                            disabled: true
                          envoy.filters.http.rbac:
                            '@type': >-
                              type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBACPerRoute
                            rbac:
                              rules:
                                action: ALLOW
                                policies:
                                  allow_all:
                                    permissions:
                                      - any: true
                                    principals:
                                      - any: true
```

The `studio` and `meta` clusters stay in `cds.yaml` unused; the basic-auth
filter and the `/pg/` entry in the global RBAC policy stay (harmless, and
the diff stays small). `DASHBOARD_*` stay in `.env` because the entrypoint
still reads them.

### 5.2 Compose change (merged into `docker-compose.override.yml` at apply time)

```yaml
  studio:
    mem_limit: 512m
    logging: *default-logging
    # phf-studio-loopback: Studio only on the server's loopback; reach it with
    #   ssh -N -L 127.0.0.1:54323:127.0.0.1:54323 <host>  (never 0.0.0.0 / a tailnet address)
    ports:
      - "127.0.0.1:54323:3000/tcp"
```

`studio_isolation.py` adds exactly these 4 lines at the end of the existing
`studio:` block (and `revert` removes exactly them); it refuses if the block
already has its own `ports:`.

Checked with `docker compose config` against upstream compose + the current
override: Studio gets `host_ip: 127.0.0.1, published: 54323, target: 3000`.
With the optional on-demand file, `api-gw` has no `depends_on` and the
default service list no longer contains `studio`; `--profile studio` adds it.

### 5.3 Ordering with the optional Envoy rules

- The 083 storage header rule inserts a route **before** `/storage/v1/`; the
  phone-upload rate limit inserts a route **before** `functions-v1-all`.
  Both also add a filter before `envoy.filters.http.router`. This change only
  touches the end of the route list. All three (and the prepared access-log
  field) can be applied in any order; `studio_isolation.py` anchors on the
  pinned upstream block, not on line numbers or the file sha, and the
  combined result is byte-identical in every order (§8.1). The server file
  already carries the header rule (sha `a635a7aa…`).
- `phf-not-found` must stay the **last** route. Any route added later goes
  above it, otherwise it is unreachable.
- After this change, the 083 rule's argument "no access to the origin's
  Studio session" no longer applies; its `nosniff`/sandbox/attachment
  protection of the API origin and the phone page still does. It stays
  optional.

### 5.4 Optional: Studio stopped when unused (d)

After §7 is proven, merge `compose-studio-on-demand.yml`. Studio then starts
only with `docker compose --profile studio up -d studio` and is stopped with
`docker compose --profile studio stop studio`. It saves about 0.5 GB of
memory limit and removes the target entirely between uses. Without the
`depends_on` reset, `docker compose up` would start Studio again (or wait on
it) because upstream api-gw waits for a healthy Studio.

## 6. Verification

### 6.1 Studio gone from the shared origin

From the Mac on the tailnet, and on the server against `http://127.0.0.1:8000`
(and later against `https://pos.<domain>` through the tunnel):

```
mac$ O=https://<host>.<tailnet-name>.ts.net
mac$ for p in / /project/default /project/default/editor /api/platform/profile \
       /api/platform/pg-meta/default/query /api/mcp /mcp /pg/ /favicon.ico; do
       printf '%-40s %s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$O$p")" \
         "$(curl -s -D - -o /dev/null "$O$p" | grep -ci '^www-authenticate')"; done
# want: every line "404 0"   (today: 401 1 / 403 0)
```

### 6.2 API, phone page, storage, functions unchanged

```
mac$ curl -s -o /dev/null -w '%{http_code}\n' "$O/auth/v1/health"          # 401 (no key), as today
mac$ curl -s -o /dev/null -w '%{http_code}\n' "$O/storage/v1/version"      # 200
mac$ curl -s -o /dev/null -w '%{http_code}\n' "$O/functions/v1/phone-upload-page"   # 200
ls$  ~/functions-router/functions-router.sh verify                         # must end "0 failed"
mac$ FUNCTIONS_URL=$O/functions/v1 FUNCTION_NAMES="<dirs>" deploy/lucashome/functions-router.sh verify
```

Plus one desktop-app login and one product list load against the backend,
and one phone upload by QR (realtime connects; sync page shows 0 pending).

### 6.3 Studio only through the SSH tunnel

```
ls$  ss -ltnH | awk '{print $4}' | grep ':54323$'          # only 127.0.0.1:54323
ls$  docker port supabase-studio                            # 3000/tcp -> 127.0.0.1:54323
ls$  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:54323/api/platform/profile   # 200
mac$ curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://<host>.<tailnet-name>.ts.net:54323/  # 000 (refused/timeout)
mac$ ssh -N -L 127.0.0.1:54323:127.0.0.1:54323 <host>      # foreground; Ctrl-C when done
mac$ open http://127.0.0.1:54323                            # Studio; check Table editor and SQL editor
```

Also: `tailscale serve status` unchanged, `tailscale funnel status` empty.
On the operator's browser, clear site data for the tailnet origin (drops
the cached basic-auth credentials; they no longer open anything anyway).

## 7. Apply procedure (owner approval required; not executed)

Outside shop hours: recreating `api-gw` drops API connections for a few
seconds; tills retry from the outbox. Recreating the gateway also resets its
access log: run `verify-till-readiness.sh reduce >> …` first
([till-readiness-084.md](till-readiness-084.md) §3.3). Consider applying the
minimal access-log format in the same window
([gateway-logging-review.md](gateway-logging-review.md) §6). It replaces
the earlier `envoy_access_log_client_info.py` field and fixes the live
query-string finding L1. It goes into the live template **before**
`stage`, so the log resets only once. §7.3 has the full order.

```
mac$ scp -r deploy/lucashome/studio-isolation lucashome:~/
ls$  cd ~/studio-isolation
ls$  ./studio-isolation.sh status        # lds: upstream (sha a635a7aa), override: upstream; probe / -> 401|challenge=1
ls$  ./studio-isolation.sh stage         # writes stage/lds.template.yaml + stage/docker-compose.override.yml; stack untouched
ls$  ./studio-isolation.sh validate      # must end "0 failed"
```

`validate` checks the staged template with `api-gw --mode validate`, prints
the staged override's Studio port as compose resolves it (`127.0.0.1 54323
3000`), then starts a **temporary** gateway on the real compose network with
only the staged template, as was done for the header rule:

```
docker compose run --rm --no-deps -d --name phf-gw-test -p 127.0.0.1:18001:8000 \
  -v ~/studio-isolation/stage/lds.template.yaml:/etc/envoy/lds.template.yaml:ro api-gw
```

and runs `verify --base http://127.0.0.1:18001 --gateway-only` against it
(real auth, PostgREST, storage and functions behind it). It refuses if port
18001 or the container name is taken, and removes the container afterwards.
Production traffic is not touched.

After a passing `validate`:

```
ls$  ./studio-isolation.sh apply --yes
```

`apply` re-derives the edit from the live files and refuses if they changed
since `stage`. Then: backups `lds.template.yaml.pre-studio-isolation.<UTC>`
and `docker-compose.override.yml.pre-studio-isolation.<UTC>`, install, `docker
compose config --quiet`, `up -d studio` (port 127.0.0.1:54323), `up -d
--force-recreate api-gw` (single-file bind mount: the new file is a new inode,
a plain restart would keep the old one), wait for the gateway, `status`
(lds: isolated, override: isolated), and the full `verify` (§7.1, including
the Studio loopback checks). Then from the Mac:

```
mac$ O=https://<host>.<tailnet-name>.ts.net
mac$ for p in / /project/default /api/mcp /pg/; do curl -s -o /dev/null -w "$p %{http_code}\n" "$O$p"; done   # all 404
mac$ ssh -N -L 127.0.0.1:54323:127.0.0.1:54323 lucashome     # foreground; Ctrl-C when done
mac$ open http://127.0.0.1:54323                              # Studio; Table editor + SQL editor work
```

Plus one desktop-app login, a product list load and one phone upload by QR
(§6.2).

Afterwards, in the repo: copy the server's new override back
(`scp lucashome:/srv/supabase/stack/docker-compose.override.yml deploy/lucashome/`;
the repo copy and the server copy were the same `f3d56b05…` on 2026-10-16, so
the result is the tool's edit only), commit; update
`deploy/lucashome/README.md` (deployed state); checklist A6d → DONE with the
evidence; add `./studio-isolation.sh status` to the post-upgrade checks. An
upstream `update.sh` may replace or merge `lds.template.yaml`: after any
upgrade, `status` must say `lds: isolated` and §6.1 must pass before traffic
is restored to a public origin. If an upgrade changed the upstream block,
`status` says `unknown` and `apply` refuses: re-derive the block, update
`upstream-studio-routes.yaml` and its pinned sha, re-run the tests.

### 7.1 What `verify` checks

| Group | Checks | Expected after apply |
|---|---|---|
| Studio gone from the shared origin | GET `/`, `/project/default`, `/project/default/editor`, `/api/platform/profile`, `/api/platform/pg-meta/default/query`, `/api/mcp`, `/mcp`, `/pg/`, `/pg/tables`, `/favicon.ico`, `/_next/…`, `/nonexistent`; POST pg-meta query; `..` from `/rest/v1/` | `404`, no `WWW-Authenticate` |
| API unchanged | `/auth/v1/health` without key → 401, no challenge; `/rest/v1/` without key → 401; `/storage/v1/version` → 200; `/functions/v1/phone-upload-page` → 200; `/functions/v1/phone-upload-token` routed | as today |
| Public image | one product's public image URL from the DB (path never printed) → 200, `image/*`; when the template carries the G5 rule: `nosniff` + CSP `sandbox` | unchanged |
| Signed URL | service key read by exact name from `.env`, sent with `curl -K -` (never printed); sign that object for 60 s → download 200 | unchanged |
| Studio on loopback (skipped with `--gateway-only`) | `docker port supabase-studio` = `127.0.0.1:54323`; listener bound to 127.0.0.1 only; Studio answers there | new |

### 7.2 Server rehearsal (2026-10-16 ≈ 10:30 UTC, evidence)

This was a controlled rehearsal on `lucashome` against the **current**
server files. The tooling was copied to a temporary `~/phf-si-rehearsal/`
(`studio_isolation.py`, `upstream-studio-routes.yaml`, `studio-isolation.sh`;
sha prefixes `0bc22e37`, `2ff007ad`, `0ea90cba`, equal to the repo). The
directory was removed afterwards. Nothing in `/srv/supabase/stack` was
written. The only container started was the temporary gateway below. The
output showed only status codes, non-secret header values, states and sha
prefixes. The anon and service keys were read by exact name from `.env` and
passed to curl on stdin (`-K -`), and never printed.

| Step | Result |
|---|---|
| Preflight | live template `a635a7aa`, override `f3d56b05` (= repo); port 18002 free; no `phf-*` container; `supabase-envoy` up 4 h healthy (`127.0.0.1:8000`), `supabase-studio` up 4 days healthy (`3000/tcp`, not published) |
| Stage | `studio_isolation.py apply` live → `stage/`: `lds: upstream (route block lines 566-695)` → `isolated`, 130 lines replaced by 30, staged sha **`948476f9`**; override `upstream` → `isolated` (+4 lines, staged sha `35fc5129`). Diff: lds −112/+12 lines, override −0/+4. Access-log line untouched. Secret-looking values: none (the only regex hit is a docs path in an override comment) |
| Compose (staged override) | `docker compose config` → studio ports `[(127.0.0.1, 54323, 3000)]`, api-gw `[(127.0.0.1, 8000)]` |
| Test gateway | `docker compose run --rm --no-deps -d --name phf-gw-test2 -p 127.0.0.1:18002:8000 -v ~/phf-si-rehearsal/stage/lds.template.yaml:/etc/envoy/lds.template.yaml:ro api-gw`: answered after 2 s. Rendered config inside: 0 `cluster: studio`, 1 `phf-not-found`. Envoy only starts with a valid config, so this also validates the staged template |
| Studio / pg-meta paths (14) | live `401` + Basic challenge (`/api/mcp`, `/mcp` `403`; `/pg/…` `401` without challenge) → test **`404`, no challenge** for all 14 (`/`, `/project/default`, `…/editor`, `/api/platform/profile`, pg-meta query GET + POST, `/api/mcp`, `/mcp`, `/pg/`, `/pg/tables`, `/favicon.ico`, `/_next/…`, `/nonexistent`, `..` from `/rest/v1/`) |
| POS API, no credentials (16) | **identical** live vs test: auth health/settings 401, `/rest/v1/` and a table 401, graphql 401, storage version 200 (GET + HEAD), bucket list 400, sign without auth 400, phone page 200, phone-upload-token GET/POST 401, staff-admin 401, realtime tenants 403, websocket 401, CORS preflight 200 |
| POS API, anon key (6) | **identical**: auth health/settings 200, `products` / `business_profile` select 200, bucket list 200, realtime tenants 403 |
| Phone page | live and test `200 text/html; charset=utf-8` |
| Public image | live and test `200 image/*`, `nosniff`, `default-src 'none'; sandbox`, `inline`, `max-age=31536000` (G5 rule intact) |
| Signed URL (60 s) | live and test: issued, download `200 image/*` |
| `studio-isolation.sh verify --gateway-only` | test gateway: **25 passed, 0 failed**. Same verify against the live gateway: 11 passed, 14 failed, exactly the 14 Studio lines (0 other failures), i.e. the checks bite |
| Teardown | `phf-gw-test2` removed, port 18002 not listening |
| Revert on the staged copy | `studio_isolation.py revert stage/…` → `lds: revert -> upstream: 30 lines replaced by 130`; **byte-identical to the live template (`a635a7aa`)** and to the live override (`f3d56b05`) |
| Live untouched | template `a635a7aa`, override `f3d56b05`; `supabase-envoy` and `supabase-studio`: same container id and start time as before; live `/` still `401` + Basic |

Probe summary: 22 API probes the same on both gateways, 14 Studio paths
isolated, 0 unexpected. The server rehearsal did not run
`studio-isolation.sh validate` itself, because that uses the name
`phf-gw-test` on port 18001. The rehearsal did the same steps by hand with
`phf-gw-test2` on 18002.

### 7.3 Final apply / revert runbook

**What the real apply changes beyond the rehearsal:** the two live files,
plus two container recreates.

| Change | Effect | Downtime |
|---|---|---|
| `docker-compose.override.yml`: `studio:` gets `ports: ["127.0.0.1:54323:3000/tcp"]` | `docker compose up -d studio` **recreates `supabase-studio`** with the loopback port (a published port can only change on a new container) | **Studio only**: from stop until healthy (health check every 5 s; expect ≈ 20–30 s). API, phone page and storage are not affected. `api-gw` has no `restart: true` on its `depends_on`, so it is not restarted |
| `lds.template.yaml`: Studio routes → `phf-not-found` | `docker compose up -d --force-recreate api-gw` (single-file bind mount: the new inode needs a new container). Compose first waits for Studio to be healthy (`depends_on: condition: service_healthy`) | **API: a few seconds** (the test gateway answered 2 s after start). Tills retry from the outbox. The gateway access log starts empty |

Window: outside shop hours, owner approval. Exact commands:

```
mac$ scp -r deploy/lucashome/studio-isolation lucashome:~/
mac$ scp deploy/lucashome/envoy_access_log_minimal.py lucashome:~/studio-isolation/            # optional, gateway-logging-review.md §6
ls$  ~/till-readiness/verify-till-readiness.sh reduce >> /srv/supabase/backups/logs/till-access-$(date -u +%Y%m%d).tsv   # keep the till history first
#    optional, same window: minimal access-log format into the live template (no recreate yet), gateway-logging-review.md §6
ls$  cd ~/studio-isolation
ls$  ./studio-isolation.sh status     # lds: upstream; override: upstream; live probe / -> 401|challenge=1
ls$  ./studio-isolation.sh stage      # stage/lds.template.yaml (sha 948476f9 if the template is still a635a7aa), stage/docker-compose.override.yml
ls$  ./studio-isolation.sh validate   # envoy --mode validate + temporary phf-gw-test on 127.0.0.1:18001 + verify; must end "0 failed"
ls$  ./studio-isolation.sh apply --yes
#    = backups *.pre-studio-isolation.<UTC> of both files; install; docker compose config --quiet;
#      docker compose up -d studio; docker compose up -d --force-recreate api-gw; wait for /storage/v1/version 200;
#      status (lds: isolated, override: isolated); full verify incl. Studio on 127.0.0.1:54323 -> must end "0 failed"
ls$  ss -ltnH | awk '{print $4}' | grep ':54323$'          # only 127.0.0.1:54323
```

Then from the Mac (§6): every Studio path on the tailnet origin `404 0`,
`functions-router.sh verify` `0 failed`, one desktop-app login, a product
list, one phone upload by QR, and the Studio admin access:

```
mac$ ssh -N -L 127.0.0.1:54323:127.0.0.1:54323 lucashome     # foreground; Ctrl-C when done
mac$ open http://127.0.0.1:54323                              # Studio (no password: loopback + SSH is the guard)
mac$ curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://<host>.<tailnet-name>.ts.net:54323/   # 000: not reachable from the tailnet
```

**Revert** (allowed only while no public origin exists, §9):

```
ls$  cd ~/studio-isolation && ./studio-isolation.sh revert --yes
#    = backups *.pre-studio-revert.<UTC>; studio_isolation.py revert on both files (other gateway rules kept);
#      docker compose config --quiet; up -d studio (recreated without the port: Studio down ≈ 20–30 s);
#      up -d --force-recreate api-gw (API: a few seconds); check / -> 401 Basic
ls$  sha256sum /srv/supabase/stack/volumes/api/envoy/lds.template.yaml | cut -c1-8   # a635a7aa when no other rule was applied meanwhile
```

The rehearsal showed `revert(stage(live))` = live, byte for byte, for both
files.

Afterwards in the repo: copy the server override back, update
`deploy/lucashome/README.md` (deployed state), checklist A6d → DONE with the
`apply` / `verify` output.

## 8. Local test evidence

`deploy/lucashome/tests/envoy-studio-isolation-test.sh` (Docker, Envoy
v1.39.1, `node:24-slim` stubs, containers `phf-studio-test-*`, loopback
ports only). It fetches the four upstream gateway files at the pinned commit
(checks the template sha = the server copy), applies the patch (checks the
patched sha), and runs them exactly as upstream compose does (entrypoint
renders the template; dummy keys and dummy dashboard credentials). Three
gateways side by side:

- **control** (unpatched = production): `/`, `/project/default`,
  `/api/platform/profile` → `401 Basic`; with credentials → Studio stub;
  `/api/mcp` → 403; `/pg/` → 401. Matches the live probe in §1.
- **patched**: 13 Studio/pg paths → `404`, no `WWW-Authenticate`; with
  dashboard credentials, with the service key, POST, HEAD, and `..` from
  `/rest/v1/` and `/functions/v1/` → 404; escaped slash → 400; Studio stub
  received no request. Auth (keyed and public routes), REST (header and
  query key, 401 without, openapi 403 for anon), GraphQL, storage,
  functions (phone page, phone-upload-token), realtime websocket and the
  blocked realtime tenants API route exactly as before.
- **optional** (patched + 083 header rule + rate limit inserted as their
  docs say): `/` and `/pg/` → 404; public storage gets `nosniff`, other
  storage routes do not; phone-upload-token routed and rate-limited (429 in
  a 40-request burst); phone page unaffected; Studio never reached.

Result 2026-10-16: **58 passed, 0 failed**.

### 8.1 The deploy-ready script

`deploy/lucashome/tests/studio-isolation-tool-test.sh` (Envoy v1.39.1,
`node:24-slim` stubs, containers `phf-si-tool-test-*`, loopback ports). Run
with `SERVER_LDS=<read-only copy of the server template>`: **49 passed, 0
failed** (2026-10-16).

- Inputs: upstream files at the pinned commit; the server template is
  re-derived (`envoy_storage_headers.py apply` on upstream = `a635a7aa…`), the
  read-only server copy is byte-identical to it, no secret-looking value.
- `apply` on upstream = the reviewed patch (`95bd48a7…`); `phf-not-found` is
  the last route; no `cluster: studio`, no `pg-protected`.
- Idempotent (apply twice; in place); `revert(apply(x)) = x` for upstream and
  for the server file (`a635a7aa…`); revert on upstream is a no-op.
- Order independence: header(studio(upstream)) = studio(header(upstream));
  with the prepared access-log field too (all orders give the same bytes).
- A changed upstream block (or a changed not-found block, for revert) is
  refused with nothing written; status `unknown`.
- Compose: the repo override (= server copy) is `upstream`; apply adds
  exactly 4 lines; idempotent; revert = original bytes; `docker compose
  config` of upstream compose + edited override gives Studio `127.0.0.1:54323
  → 3000` (api-gw stays on 127.0.0.1); the current override publishes nothing.
- Envoy: `--mode validate` passes for upstream+isolation, server+isolation,
  the final template (server + isolation + access-log field) and the current
  server template. `studio-isolation.sh verify --gateway-only` against the
  final template: 0 failed, header rule and signed URL checked, no key in the
  output, Studio stub never reached. The same `verify` against the current
  server template fails exactly on the Studio lines (the checks bite).
- The final template's access log ends with `"shwephala-pos/1.0.16
  (validated-uploads)"` (or `"-"`), and `verify-till-readiness.sh reduce`
  reads it as `desktop|1.0.16|yes`.

## 9. Rollback

```
ls$  cd ~/studio-isolation && ./studio-isolation.sh revert --yes
```

`revert` backs up the current files (`*.pre-studio-revert.<UTC>`), puts the
verbatim upstream route block back in place of `phf-not-found` and removes the
4 override lines (both with `studio_isolation.py revert`, so a header rule or
rate-limit rule applied in the meantime stays), recreates studio and api-gw,
and checks `/` → `401 Basic`. Manual alternative: copy the
`*.pre-studio-isolation.<UTC>` backups back (only if no other gateway rule was
applied after them), then `docker compose config --quiet && docker compose up
-d studio && docker compose up -d --force-recreate api-gw`. If the on-demand
blocks (§5.4) were merged, remove them first. Repo: copy the reverted override
back and commit.

Rollback restores today's exposure, so it is only allowed while no public
origin (tunnel, Funnel) exists.

## 10. Gate S: before any public exposure

Add to gate P ([`remote-access-architecture.md`](remote-access-architecture.md) §5.3)
and checklist C4. **No Cloudflare Tunnel (including stage S3 "tunnel, dark"),
no Tailscale Funnel, and no other public route to `127.0.0.1:8000` until:**

| # | Condition |
|---|---|
| S-1 | This change is applied: §6.1 shows `404 0` for every Studio/pg path on the tailnet origin and on `127.0.0.1:8000` |
| S-2 | §6.2 passes (`functions-router.sh verify` 0 failed, app login, phone upload) |
| S-3 | §6.3 passes: Studio only on `127.0.0.1:54323`, refused from the tailnet |
| S-4 | The same §6.1 probe is repeated against the public hostname before the first till uses it, independent of the tunnel's own ingress allow-list (P3 stays as a second layer) |
| S-5 | After any stack upgrade, S-1 is re-checked before the public origin carries traffic |

## 11. Items needing owner approval

1. Apply §7.3 (`studio-isolation.sh stage` → `validate` → `apply --yes`), outside shop hours (rehearsed §7.2). Recommended in the same gateway recreate: the minimal access-log format ([gateway-logging-review.md](gateway-logging-review.md) §6, fixes live finding L1; supersedes the x-client-info-only field of [till-readiness-084.md](till-readiness-084.md) §3.3).
2. Optional (d): Studio stopped by default, started on demand.
3. Record gate S in the remote-access plan and the checklist.
