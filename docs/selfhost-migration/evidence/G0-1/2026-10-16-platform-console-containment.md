# G0-1: `platform-console` containment on lucashome (2026-10-16)

| | |
|---|---|
| Approval | Owner, 2026-10-16: G0-0 (read-only inspection) and G0-1 (narrowly scoped containment) per `docs/plans/orvix-1.0.17-master-implementation-plan-v2.md` §7.1 |
| Change window | 2026-10-16 20:18:49 → 20:19:19 UTC |
| Scope | One directory moved out of the active Edge Functions volume; `functions` container restarted. **Not touched:** the database (all queries ran in `default_transaction_read_only=on` sessions), migrations, router, `.env`, compose files, Envoy, firewall, Tailscale, other containers, unrelated applications. Nothing was committed, pushed or deployed. |
| Result | **Contained.** The function can no longer execute. All other functions respond as before. Organisation-ADMIN workflows are unaffected. |

## 1. Pre-change dependency check (organisation ADMIN must not depend on it)

Repo search (HEAD `0e29236`):
- The only caller of `/functions/v1/platform-console` is `src/stores/platformAuthStore.ts`. That store is used only by the `/console` pages (`src/pages/PlatformConsolePage.tsx`, `PlatformConsoleLoginPage.tsx`; routes `src/app/routes/AppRouter.tsx:73,76`).
- No other Edge Function and no SQL references it. Mentions in migrations 061, 066, 073 and 077 are comments only.

Organisation-ADMIN workflows and the path each uses:

| Workflow | Path |
|---|---|
| Create managers / cashiers / buyers | `staff-admin` (`src/pages/UsersPage.tsx`, `src/lib/staffAdmin.ts`) |
| Assign roles, edit and deactivate accounts | RPCs `update_app_user`, `deactivate_app_user` (`src/stores/data/slices/shopSlice.ts:135,153`) |
| Manage shops | direct `shops` table writes (`shopSlice.ts`) |
| Admin sign-in second factor | `admin-2fa` (`src/stores/authStore.ts`) |
| First setup | RPCs `app_setup_needed`, `bootstrap_first_admin` |

**Conclusion:** no organisation-ADMIN workflow depends on `platform-console`. Only platform-level actions (create organisation, create platform admin, list organisations) are disabled.

## 2. Pre-checks (all matched; no stop condition)

| Check | Value |
|---|---|
| `platform_admins` (read-only) | 0 rows |
| `app_setup_needed()` | false |
| Router (`functions-router.sh status`) | `patched`, sha256 `d2901ffa…37cd111bc` |
| Containers | 10/10 healthy; functions started 2026-10-16T07:50:29Z |
| Deployed code vs repo | identical tree hashes for all six app functions |

## 3. Fingerprints (sha256 over each directory's sorted file hashes)

| Item | Before (20:18:52Z) | After (20:19:01Z) |
|---|---|---|
| `admin-2fa` | `c91c14468ba2c87d5831d5546530184510eae496c06b7ea60047c8286e9e33e2` | identical |
| `email-sales-report` | `e3cd71a93ac9123b832696e774b3a199b38ac14eb8847f448375eb45bf26a5f4` | identical |
| `main` (router) | `0ef5ac9f791b4ea930c8cf07b91959a32b7b3c77264169eb6851758c86f536db` | identical |
| `phone-upload-page` | `2bf726a87438b759ffa6435c15b3e2020b6f5c0d9bd0d15c7be7a4baa77c6b43` | identical |
| `phone-upload-token` | `508820a0eb6037fc5f22bcd68d75669cf35c3630ae491f1fd68f3f286ae3a7f5` | identical |
| `staff-admin` | `f8d07c35c4cb9430386835008fc0f0ce7c4cee1f11f2a8bf13e465e6336c5e24` | identical |
| `deno.jsonc` | `a9a29da36c2576f755dd868b9f553a02afdf7d7bccf52e97e65c7f68cf36bfef` | identical |
| `platform-console` | `0f650c9e9e3a338d8b75eb085fcc56e4c5935080d08ddea7ea73b821036a7bff` (active) | absent from active dir; rollback copy hash identical |

## 4. Change

```
mv <stack-dir>/volumes/functions/platform-console \
   ~/removed-edge-functions-20261016T2019Z/platform-console      # 20:19:01Z
cd <stack-dir> && docker compose restart functions                   # 20:19:06Z → healthy 20:19:12Z
```

**Downtime:** Edge Functions only, about 6 s. No other container restarted. No shop was trading, and the system has 0 sales.

## 5. Function responses

Probes went from the Mac through the tailnet origin. The anon key is the public value from the app build, sent from a mode-600 temp file that was deleted afterwards and never printed. No data was written.

| Probe | Before | After |
|---|---|---|
| `platform-console` POST, no token | 401 `UNAUTHORIZED_NO_AUTH_HEADER` (router gate) | 401 (same) |
| `platform-console` POST, anon key, `whoami` | 401 `{"error":"Invalid session."}` (**function code ran**) | **500 `InvalidWorkerCreation: worker boot error … could not find an appropriate entrypoint`** (function cannot execute) |
| `staff-admin` POST, anon key | 401 `{"error":"Invalid session.","code":"unauthenticated"}` | identical |
| `admin-2fa` POST, anon key | 500 `Email provider is not configured…` | identical (pre-existing, ORV-047; TOTP path unaffected) |
| `email-sales-report` POST, anon key | 500 `Email provider is not configured…` | identical (pre-existing, ORV-047) |
| `phone-upload-token` POST, anon key, bad token | 404 `{"code":"invalid"}` | identical |
| `phone-upload-page` GET | 200 (26,832 bytes) | identical |
| `staff-admin` POST, no token | 401 (router gate) | identical |

`functions-router.sh verify` with `FUNCTION_NAMES="admin-2fa email-sales-report phone-upload-token phone-upload-page staff-admin"` gave **37 passed, 0 failed**. The names were set explicitly because the default enumerates only directories present at run time.

Functions log after the restart: the only `platform-console` routing attempt is the 20:19:19Z verification probe, followed by `worker boot error`. Its code did not run.

A 404 is **not** expected from this runtime for a removed function. An external 404 will come only from the future public-ingress catch-all (plan §7.1, G7-b).

## 6. Rollback (not needed; < 10 min)

```
mv ~/removed-edge-functions-20261016T2019Z/platform-console <stack-dir>/volumes/functions/
cd <stack-dir> && docker compose restart functions
ssh lucashome 'FUNCTION_NAMES="admin-2fa email-sales-report phone-upload-token phone-upload-page staff-admin platform-console" bash -s -- verify' \
  < deploy/lucashome/functions-router.sh
```

Expected after rollback:
- the anon-key `whoami` returns the function's own 401 `Invalid session.`;
- the restored directory hash is `0f650c9e…a7bff`.

## 7. Redeploy protection (minimum change)

- **Automation:** none re-syncs functions. No cron entry or systemd timer mentions functions or `rsync`; verified read-only. The only ways back are the two **manual** `rsync` procedures in `deploy/lucashome/README.md`.
- **Change made** (repo doc only, uncommitted), in `deploy/lucashome/README.md`:
  - the function list marks `platform-console` as removed, with its rollback location;
  - a "do not re-sync" warning is added to the per-function `rsync` command;
  - the whole-directory rebuild step now carries `--exclude platform-console`.
- **Not done (beyond scope; needs separate approval):**
  - moving the source out of `supabase/functions/`;
  - a `release-gate.sh` deployed-function allow-list check (plan §7.1 step 4).
- **Residual:** an operator who ignores the README could still copy it back by hand. Backup archives made *before* 20:19Z still contain it (no offsite archive has been sent; the email tier is disabled).

## 8. Read-only inspection findings recorded at the same time (G0-0, 20:13Z)

| Topic | Finding |
|---|---|
| Receipt numbers | unique index `sales_shop_receipt_no_unique ON sales (shop_id, receipt_no)` **exists**; 0 duplicate pairs; 0 sales |
| Image hosts | `products.image_url`: 533 on the tailnet origin, 6 products without image; `business_profile.logo_url`: none; `product_image_upload_sessions.public_url`: 556 rows on the **old hosted project origin** (history only; image references are path-based); `app_config.supabase_public_url` = tailnet origin |
| Ledger | 84 rows, max 085, 084 absent |
| Listeners | Supabase gateway and Studio bound to loopback only; Supabase database not published; the POS API origin is tailnet-only (Funnel off). Several **non-POS co-tenant services** on the same host listen on all interfaces, and two of them have **public internet exposure**. Host names, ports and services are recorded in the private ops repository, not here. See plan decision D-27. |
