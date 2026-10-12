# 04 · Target Architecture — Self-hosted Supabase on `lucashome`

Status: **design, not deployed**. Nothing described here exists yet except the
read-only upstream clone at `/srv/supabase/upstream`.

Evidence tags: **V** verified by reading the pinned upstream files or official
docs · **I** inferred · **U** unverified until the empty-stack gate (G2).

## 1. Design principles

1. **Least customisation.** Run the upstream `docker-compose.yml` from a pinned
   release tag with every deviation isolated in one `docker-compose.override.yml`
   and the `.env`, so `update.sh` upgrades stay mechanical.
2. **Tailnet-only.** No public exposure. TLS terminates in Tailscale (`tailscale
   serve`), the gateway listens on loopback only, Postgres is never published.
3. **Everything stateful lives under `/srv/supabase/stack`** (800 GiB LV) so one
   directory plus one named volume is the entire backup set.
4. **Match hosted behaviour**, not upstream defaults, wherever the application
   depends on it (JWT expiry, autoconfirm, signup, `verify_jwt`, MFA).

## 2. Pinned versions

| Component | Hosted today (V) | Self-hosted pin (V, tag `self-hosted/v0.8.2`) | Direction |
|---|---|---|---|
| Upstream repo | n/a | `supabase/supabase` tag **`self-hosted/v0.8.2`** = commit `564eab8ad7840b13324f68b1bfac074ef8d51c21` (2026-09-23) | pin tag, **not** master `8617532a` currently cloned |
| Postgres | 17.6.1.121 (aarch64) | `supabase/postgres:17.6.1.136` (x86_64) | same major/minor, newer patch |
| GoTrue (auth) | v2.195.0 | `supabase/gotrue:v2.196.0` | +1 minor; GoTrue migrates `auth` schema forward on boot |
| PostgREST | v14.5 | `postgrest/postgrest:v14.17` | newer |
| Storage API | v1.71.0 | `supabase/storage-api:v1.74.0` | newer; migrates `storage` schema forward on boot |
| Realtime | U | `supabase/realtime:v2.134.10` | — |
| Edge runtime | U (hosted runtime) | `supabase/edge-runtime:v1.76.2` | — |
| Gateway | Kong (hosted) | **Envoy `v1.39.1`** (upstream default since 0.8.0; Kong overlay deprecated) | different gateway, same routes |
| Studio / pg-meta | n/a | `supabase/studio:2026.09.07-sha-7996410`, `supabase/postgres-meta:v0.99.0` | — |
| Supavisor pooler | hosted pooler | `supabase/supavisor:2.9.12` — **removed** (see deviations) | — |
| imgproxy | hosted | `darthsim/imgproxy:v3.31.4` | — |

All images in the base compose are exact tags (V). The only floating tags in the
upstream tree are in overlays we will not use (`s3`, `rustfs`, `caddy`).

Why not master: the clone on `lucashome` is `master` at 2026-10-09, after the
0.8.2 tag. `update.sh` and `upgrades.json` key off `.supabase-version`, which
must hold a release ref. The plan re-clones the tag; the current clone is deleted
(it holds no state).

## 3. Topology

```
Myanmar tills (Electron app, Tailscale client, tag:till)
        │  WireGuard (direct if NAT allows, else DERP relay)
        ▼
lucashome  tailscale0  100.74.43.4  —  tailscale serve :443  (TLS, cert for lucashome.tail8a86e4.ts.net)
        │  http://127.0.0.1:8000
        ▼
supabase-envoy (api-gw)  ── /auth/v1 ──▶ supabase-auth (GoTrue)
   loopback:8000 only    ── /rest/v1 ──▶ supabase-rest (PostgREST)
                         ── /realtime/v1 ──▶ realtime-dev.supabase-realtime
                         ── /storage/v1 ──▶ supabase-storage ──▶ ./volumes/storage (files) + imgproxy
                         ── /functions/v1 ──▶ supabase-edge-functions ──▶ ./volumes/functions/<name>
                         ── /pg ──▶ supabase-meta (service_role key only)
                         ── /  ──▶ supabase-studio (basic auth, tailnet only)
                                                      │
                                   supabase-db (Postgres 17, not published) ◀─ all services
                                   ./volumes/db/data + db-config (pgsodium key)
                                   pg_cron + pg_net ──▶ http://api-gw:8000/functions/v1/… (internal)
```

Eleven upstream containers minus Supavisor = **10 containers**.

## 4. Deviations from upstream (each with its reason)

All changes go in `.env` or `docker-compose.override.yml`; no vendor file is
edited. `COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml`.

| # | Deviation | Where | Why | Tag |
|---|---|---|---|---|
| D1 | Gateway port bound to loopback: `127.0.0.1:8000:8000` | override `api-gw.ports: !override` | Upstream binds `0.0.0.0` (compose `:91`). Only Tailscale serve may reach it | V |
| D2 | **Remove Supavisor** (`supavisor: !reset null`) | override | Upstream publishes `${POSTGRES_PORT}:5432` and `:6543` on all interfaces (`:536-538`); host 5432 is already taken by `postgres:18`. The app uses PostgREST only, never a direct DB connection. Admin access is `docker exec supabase-db psql`. Changing `POSTGRES_PORT` is not an alternative: it also changes `PGPORT` and every service DSN (`:515` and 8 DSNs) | V |
| D3 | `db-config` named volume → bind mount `./volumes/db/config` — **deferred to Phase F** (Phase A keeps the upstream named volume; a bind mount needs the image's postgres UID as owner, known only once a container runs). Phase F backs up the named volume explicitly | override `db.volumes` (later) | Holds the pgsodium root key; a named volume would be missed by a directory backup and is destroyed by `reset.sh` | V |
| D4 | Memory limits per container (`mem_limit`), e.g. db 2g, realtime 512m, storage 512m, functions 512m, studio 512m, auth 256m, rest 256m, meta 256m, imgproxy 256m, api-gw 256m | override | Host has no limits on any container; Postgres must not be the OOM victim of Minecraft or ollama. Exact numbers are tuned at G2 from `docker stats` | I |
| D5 | Per-service log rotation (`logging: driver json-file, max-size 20m, max-file 5`) | override | Host Docker has unbounded json-file logs; no `daemon.json` change needed | V |
| D6 | `FUNCTIONS_VERIFY_JWT=true` | `.env` | Hosted deploys all five functions with `verify_jwt: true` (V from `supabase functions list`); upstream default is `false` | V |
| D7 | Function secrets (e.g. `RESEND_API_KEY`) added under `functions.environment` and sourced from `.env` | override | Upstream has no secrets mechanism; `main/index.ts` forwards the whole container env to every function | V |
| D8 | `ENABLE_PHONE_SIGNUP=false`, `ENABLE_PHONE_AUTOCONFIRM=false` | `.env` | Upstream defaults both to `true` with no SMS provider; the app never uses phone auth | V |
| D9 | TOTP pinned explicitly: `MFA_TOTP_ENROLL_ENABLED=true`, `MFA_TOTP_VERIFY_ENABLED=true`, `MFA_MAX_ENROLLED_FACTORS=10` (uncomment compose `:211-215` via override `auth.environment`, not by editing the vendor file) | override + `.env` | Upstream default is already `true`/`true`/10, but the app's admin login depends on it; pin so an upstream default change cannot silently break login | V |
| D10 | SMTP via Resend's SMTP relay (`SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_USER=resend`, `SMTP_PASS=<API key>`) | `.env` | Upstream points at a dev mail container that does not exist outside the dev overlay. Hosted uses the built-in Supabase mailer (SMTP null, V) and the app sends 2FA codes through the `admin-2fa` function + Resend, not through GoTrue, so SMTP is **optional**; configured anyway so password recovery from Studio works. Resend free tier: 3,000/month, 100/day | V |
| D11 | `SUPABASE_PUBLIC_URL=https://lucashome.tail8a86e4.ts.net`, `API_EXTERNAL_URL=https://lucashome.tail8a86e4.ts.net/auth/v1` (must keep `/auth/v1`), `SITE_URL=https://lucashome.tail8a86e4.ts.net` | `.env` | Feeds `GOTRUE_JWT_ISSUER`, storage public URLs, `/pg` CORS | V |
| D12 | `JWT_EXPIRY`, `DISABLE_SIGNUP`, `ENABLE_EMAIL_AUTOCONFIRM` set to the **hosted** values | `.env` | Match current behaviour; values come from the hosted auth-config read in [02-production-dependencies.md](./02-production-dependencies.md) | V after 02 |
| D13 | `PGRST_DB_MAX_ROWS` set to the hosted value | `.env` | The app's 1000-row cache cap assumes the hosted `max_rows`; a different value changes `loadData()` behaviour | V after 02 |
| D14 | `pg_cron` enabled and two jobs re-created pointing at `http://api-gw:8000/functions/v1/<fn>` with the **new** service-role key | SQL after restore | Cron jobs are platform-maintained; dump may carry them with the **old** key (see 05). Internal URL avoids a Tailscale round trip from inside the box | V |
| D15 | `supabase_realtime` publication created and `inventory` added | SQL after restore | CLI schema dump comments out `CREATE PUBLICATION "supabase_realtime"`; upstream init does not create it; migration 058 needs it | V |
| D16 | `tailscale serve --bg --https=443 http://127.0.0.1:8000` (tailnet only, **never** `funnel`) | host, one-time, needs sudo once for operator | TLS with auto-renewing certs at zero cost; no reverse-proxy container, no ports 80/443 on the host | V (feature) / U (coexistence with the stale 443 listener on the old IP — checked at G2) |
| D17 | Studio stays reachable at `/` behind `DASHBOARD_*` basic auth, tailnet only | — | Useful for admin; acceptable only because the origin is tailnet-scoped. `/pg` additionally needs the service-role key | V |
| D18 | Optional: static web build served at `:8443` via a second `tailscale serve` target → nginx container on `127.0.0.1:8080` | later | Only if staff use the web app; Vercel Hobby forbids commercial use | I |

Not deviating: Envoy gateway (default), Postgres 17 image (default), no
analytics/logs overlay (not in base), file storage backend (default), imgproxy
(default), `GLOBAL_S3_BUCKET`/`TENANT_ID`/`REGION` left at `stub` (**U** whether
changing them later is safe; leave alone).

## 5. Directory layout on `lucashome`

```
/srv/supabase/
  stack/                       ← copy of docker/ from tag self-hosted/v0.8.2
    .env                       (0600, lucario)       secrets — never committed, never printed
    .supabase-version          ref=self-hosted/v0.8.2
    docker-compose.yml         vendor, untouched
    docker-compose.override.yml  D1–D9 (ours)
    volumes/
      db/data/                 PGDATA           ← backup set
      db/config/               pgsodium key     ← backup set (D3)
      storage/                 object files     ← backup set
      functions/               our 5 functions + main/ + deno.jsonc  ← in git (repo supabase/functions)
      api/, pooler/, snippets/ vendor
  backups/                     local dump staging (see 07)
  upstream/                    delete after stack/ is created from the tag
```

## 6. Identity, keys, and secrets

- `utils/generate-keys.sh --update-env` mints `POSTGRES_PASSWORD`, `JWT_SECRET`,
  `ANON_KEY`, `SERVICE_ROLE_KEY` (HS256, 5-year exp), `SECRET_KEY_BASE`,
  `REALTIME_DB_ENC_KEY`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`, `S3_PROTOCOL_*`,
  `DASHBOARD_PASSWORD` (V). `utils/add-new-auth-keys.sh` adds the EC key pair
  and `sb_publishable_…`/`sb_secret_…` keys (needs node ≥16 or Docker) (V).
- The app ships the **anon key** in the Electron bundle; the self-hosted stack's
  new anon key replaces it at build time. Legacy HS256 keys remain supported by
  supabase-js 2.106 (V from upstream `.env.example` keeping `ANON_KEY`).
- Hosted currently signs user JWTs with an **ES256 key** (`in_use`) and keeps
  HS256 as `previously_used` (V, Management API). The self-hosted stack signs
  with its own keys (`JWT_SECRET` HS256 plus the EC pair from
  `add-new-auth-keys.sh`); the app never verifies JWTs, so either works.
- Any signing-key change ⇒ every existing session and refresh token is invalid
  ⇒ one forced re-login per user at cutover (today: 1 live session, 3 refresh
  tokens). TOTP factors are independent of the
  JWT secret (they are base32 secrets in `auth.mfa_factors`; hosted stores them
  **unencrypted** — V, 2 verified `totp` factors, 0 in encrypted JSON shape).
- Secrets at rest: `.env` 0600; an `age`/`gpg`-encrypted copy of `.env` and
  `volumes/db/config` goes in the offsite backup (see 07). Nothing in git.

## 7. Network and access control

| Concern | Design |
|---|---|
| Reachability | Tills join the tailnet with **pre-authorised, tagged auth keys** (`tag:till`), key expiry **disabled** for tills and for `lucashome` (allowed on the free plan) |
| ACL | Replace default allow-all with: `tag:till → lucashome:443`; admins → `lucashome:22,443`; nothing else. Tills cannot see each other or other tailnet nodes |
| Plan limits | Tailscale Personal plan (since 2026-04): **6 users, unlimited devices** — sufficient; all tills can be owned by the business login |
| Tailnet account | The tailnet owner is the only admin today. Add a **second admin login** before cutover; losing the owner account means losing the ability to add tills or rotate keys |
| TLS | `tailscale serve` with Tailscale-issued Let's Encrypt cert; auto-renew. Certificate expiry monitored (09) |
| SSH | lucashome's sshd currently listens on all interfaces with probable password auth. Hardening (keys only, fail2ban or Tailscale-only bind) is a prerequisite in 10-go-no-go, not part of the stack |
| Studio | tailnet + basic auth; consider ACL-restricting `/` to admin devices only (not possible per-path in Tailscale ACLs → either accept or front with the optional nginx and IP-allow the admin devices) |

## 8. Expected latency profile (Myanmar → Barrie)

Measured from `lucashome`: Singapore DERP 243 ms, Tokyo 151 ms. Myanmar →
Singapore is typically 30–70 ms. Therefore:

| Path | Estimated RTT |
|---|---|
| Direct WireGuard till → lucashome | ≈ 250–320 ms (estimate; depends on Myanmar ISP's transit) |
| Relayed via DERP | lucashome's home DERP is Toronto (8 ms); a relayed packet is till → Toronto DERP → lucashome ≈ 260–340 ms |
| Today, till → Supabase Singapore | ≈ 30–80 ms (not measured) |

Each sequential round trip in the POS becomes ~4–8× slower. Whether that is
acceptable depends on how many sequential calls a sale makes — quantified in
[02-production-dependencies.md](./02-production-dependencies.md) §Latency and
tested at gate G10 from real shop devices.

## 9. What stays on hosted Supabase during the rollback window

The hosted project is left **untouched and unpaused** for ≥30 days after
cutover. It is on a **Free-plan** organisation (V, Management API), so it is
subject to inactivity pausing after 7 quiet days; a paused project can be
restored for up to 1 year per current docs (older material says 90 days). To
keep rollback instant, a scheduled read-only ping (e.g. one `SELECT 1` through
the Management API daily) keeps it active; this is the only action against
hosted during the window and is itself read-only.
