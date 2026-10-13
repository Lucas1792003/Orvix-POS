# Phase D live integration run (self-hosted stack)

End-to-end proof, against the **real self-hosted Supabase stack** (schema version
066), that the Phase D contract holds through the public API:
idempotent RPC replays, concurrency, the real app outbox/drain code on
fake-indexeddb, JWT refresh / revocation, staff creation, RLS/RPC
authorization, the anonymous phone-upload token flow and Realtime inventory
updates. Hosted Supabase is never touched; no container is restarted; no
non-QA row is ever modified.

Test file: `src/live/phase-d.live.test.ts` (helpers in `src/live/liveHelpers.ts`;
`src/live/realtimeProbe.ts` is a standalone Realtime diagnostic). The suite is
**skipped unless `LIVE_SUPABASE_URL` is set**, so `npm test` never runs it by
accident.

## Run

```sh
# keys into shell variables only (never into files, never echoed)
ANON=$(ssh -o BatchMode=yes <ssh-host> 'grep "^ANON_KEY=" <stack-dir>/.env | cut -d= -f2-')
SERVICE=$(ssh -o BatchMode=yes <ssh-host> 'grep "^SERVICE_ROLE_KEY=" <stack-dir>/.env | cut -d= -f2-')

LIVE_SSH_HOST=<ssh-host> LIVE_STACK_DIR=<stack-dir> \
LIVE_SUPABASE_URL=https://your-backend.example.ts.net \
LIVE_ANON_KEY="$ANON" LIVE_SERVICE_KEY="$SERVICE" \
npx vitest run src/live/phase-d.live.test.ts --reporter=verbose
```

| Variable | Meaning |
|---|---|
| `LIVE_SUPABASE_URL` | API base of the stack (gate: unset = suite skipped) |
| `LIVE_ANON_KEY`, `LIVE_SERVICE_KEY` | anon / service-role JWTs |
| `LIVE_SSH_HOST` | ssh host that runs `docker compose` for the db container (required, no default) |
| `LIVE_STACK_DIR` | compose directory on that host (required, no default) |
| `LIVE_QA_TS`, `LIVE_QA_PASSWORD` | reuse an existing seed instead of creating one (optional) |

The run takes ~40 s. A results table (test, PASS/FAIL, evidence) is printed at
the end (`[results ts=…]`).

## What the run creates

`beforeAll` seeds a self-contained QA tenant, identified everywhere:
ids `qa-…`, emails `…@qa.invalid`, names `QA …`.

1. Four auth users through the GoTrue signup API (`auth.signUp`, autoconfirm
   is on) with a random per-run password kept in memory only.
2. `seed.sql` as `supabase_admin` (copied to the host and into the db
   container, `psql -v` variables for the run stamp and the auth ids) inside
   one transaction with `session_replication_role = replica`, so the 046
   inventory auto-create triggers do not create real-product × QA-shop or
   QA-product × real-shop rows and the 047/020 user triggers do not block the
   direct inserts: QA org, two QA shops, ADMIN + MANAGER + 2 CASHIERs (linked
   by `auth_id`), 3 products with default units, explicit inventory (100 each
   in the QA shop, one row in the second shop), one supplier.
3. The RECEIVED purchase order with an outstanding balance is created by the
   tests through the RPCs (admin `create_purchase_order`, manager
   `approve_purchase_order` — self-approval guard checked —, manager
   `receive_purchase_order`), each with its own idempotency key and a replay.

Every test asserts on the API response **and** on the database (service-role
reads, or SQL over ssh where the schema is not exposed, e.g. `auth.sessions`).

## Cleanup (mandatory after every run)

```sh
scp supabase/tests/phase-d/live/cleanup.sql supabase/tests/phase-d/live/verify_clean.sql <ssh-host>:/tmp/
ssh -o BatchMode=yes <ssh-host> 'cd <stack-dir> \
  && docker compose cp /tmp/cleanup.sql db:/tmp/cleanup.sql \
  && docker compose cp /tmp/verify_clean.sql db:/tmp/verify_clean.sql \
  && docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -f /tmp/cleanup.sql </dev/null \
  && docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -f /tmp/verify_clean.sql </dev/null'
```

`cleanup.sql` is one transaction that deletes, in FK order, every row whose
id/actor/shop/product/supplier is `qa-…` (server-minted sales, shifts,
movements, audit rows, idempotency keys, PO/payment rows included), then the
QA users, shops, organizations and `auth.users` rows ending in `@qa.invalid`
(identities/sessions/refresh tokens/MFA factors cascade). It prints a count per
table. `verify_clean.sql` RAISEs if any QA row remains in any of those tables,
`auth.identities/sessions/refresh_tokens/mfa_factors` or `storage.objects`, and
that no inventory row for a QA shop or QA product remains; it prints `CLEAN`.

The suite performs no storage upload (the phone-upload RPCs validate the URL
string only), so the storage file count on the host
(`find <stack-dir>/volumes/storage -type f | wc -l`) must be unchanged
before and after a run.

## Notes on the environment

- 30 RPCs take a required trailing `p_idempotency_key uuid`; anon can execute
  exactly `get_product_image_upload_session_by_token` and
  `complete_product_image_upload_session`.
- Realtime: a channel's `SUBSCRIBED` status only acknowledges the join; the
  `postgres_changes` subscription is active after the channel's `system`
  message `{extension: "postgres_changes", status: "ok"}` — the test waits for
  that before writing (the first subscriber on the tenant starts the CDC
  poller, which takes a few seconds).
- GoTrue access tokens carry no `jti`: a refresh in the same second as the
  original sign-in yields a byte-identical JWT, so the refresh test compares
  `iat` instead of raw tokens.
