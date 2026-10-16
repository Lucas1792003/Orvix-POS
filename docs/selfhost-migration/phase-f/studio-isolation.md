# Phase F: isolating Supabase Studio from the shared API origin

Status: **prepared and tested locally, NOT applied** (2026-10-16). Nothing was
changed on the server. Read-only checks only. Applying needs the owner's
approval (§7). Closes checklist item A6d once applied and verified.

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
| Envoy template | `volumes/api/envoy/lds.template.yaml` is **byte-identical to upstream** `self-hosted/v0.8.2` (sha256 `9d9a6d6e…73566c3d`). Neither optional rule (083 headers, phone-upload rate limit) is applied | `sha256sum` on the server vs the file fetched at the pinned commit |
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
| [`deploy/lucashome/studio-isolation/lds-studio-isolation.patch`](../../../deploy/lucashome/studio-isolation/lds-studio-isolation.patch) | unified diff for `volumes/api/envoy/lds.template.yaml`, apply with `patch -p1` in `/srv/supabase/stack`. Pinned: upstream `9d9a6d6e…73566c3d` → patched `95bd48a7…0064f8f` |
| [`deploy/lucashome/studio-isolation/compose-studio-loopback.yml`](../../../deploy/lucashome/studio-isolation/compose-studio-loopback.yml) | the `ports:` entry for the `studio` block of `docker-compose.override.yml` (required) |
| [`deploy/lucashome/studio-isolation/compose-studio-on-demand.yml`](../../../deploy/lucashome/studio-isolation/compose-studio-on-demand.yml) | optional (d): `profiles: [studio]` + `api-gw.depends_on: !reset {}` |
| [`deploy/lucashome/tests/envoy-studio-isolation-test.sh`](../../../deploy/lucashome/tests/envoy-studio-isolation-test.sh) | local proof, §8 |

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
    ports:
      - "127.0.0.1:54323:3000/tcp"
```

Checked with `docker compose config` against upstream compose + the current
override: Studio gets `host_ip: 127.0.0.1, published: 54323, target: 3000`.
With the optional on-demand file, `api-gw` has no `depends_on` and the
default service list no longer contains `studio`; `--profile studio` adds it.

### 5.3 Ordering with the optional Envoy rules

- The 083 storage header rule inserts a route **before** `/storage/v1/`; the
  phone-upload rate limit inserts a route **before** `functions-v1-all`.
  Both also add a filter before `envoy.filters.http.router`. This patch only
  touches the end of the route list. All three can be applied in any order;
  the patch still applies (with an offset) after the other two, and the
  combined config is tested (§8). Only the patched-sha check in §7 step 2
  then differs; check with `grep` instead.
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
seconds; tills retry from the outbox.

```
mac$ ssh <host> 'mkdir -p ~/studio-isolation'
mac$ scp deploy/lucashome/studio-isolation/lds-studio-isolation.patch <host>:~/studio-isolation/
ls$  cd /srv/supabase/stack
ls$  sha256sum volumes/api/envoy/lds.template.yaml          # 9d9a6d6e… (or note the value if the optional rules are in)
ls$  cp -p volumes/api/envoy/lds.template.yaml volumes/api/envoy/lds.template.yaml.pre-studio-isolation.$(date -u +%Y%m%dT%H%M%SZ)
ls$  patch -p1 --dry-run < ~/studio-isolation/lds-studio-isolation.patch && patch -p1 < ~/studio-isolation/lds-studio-isolation.patch
ls$  sha256sum volumes/api/envoy/lds.template.yaml          # 95bd48a7… when started from upstream
ls$  grep -c 'cluster: studio' volumes/api/envoy/lds.template.yaml   # 0
mac$ # repo: add the ports entry (5.2) to deploy/lucashome/docker-compose.override.yml, commit
mac$ scp deploy/lucashome/docker-compose.override.yml <host>:/srv/supabase/stack/
ls$  docker compose config --quiet
ls$  docker compose up -d studio                            # recreated with 127.0.0.1:54323
ls$  docker compose up -d --force-recreate api-gw           # re-renders lds.yaml from the template
ls$  docker compose ps                                      # all healthy
```

`--force-recreate` matters: the template is a single-file bind mount, and
`patch` writes a new file (new inode). A plain `restart` would keep the old
file in the container.

Then §6. Afterwards: update `deploy/lucashome/README.md` (deployed state),
checklist A6d → DONE with the evidence file, and add the template sha to the
post-upgrade checks: an upstream `update.sh` may replace or merge
`lds.template.yaml`. After any upgrade, `grep -c 'cluster: studio'` must be
0 and §6.1 must pass before traffic is restored to the public origin.

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

## 9. Rollback

```
ls$  cd /srv/supabase/stack
ls$  cp -p volumes/api/envoy/lds.template.yaml.pre-studio-isolation.<UTC> volumes/api/envoy/lds.template.yaml
     # or: patch -R -p1 < ~/studio-isolation/lds-studio-isolation.patch
mac$ # repo: remove the ports entry (and the on-demand blocks if merged); scp the override
ls$  docker compose config --quiet && docker compose up -d studio && docker compose up -d --force-recreate api-gw
ls$  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/          # 401 again (Studio behind basic auth)
```

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

1. Apply §7 (Envoy patch + Studio loopback port), outside shop hours.
2. Optional (d): Studio stopped by default, started on demand.
3. Record gate S in the remote-access plan and the checklist.
