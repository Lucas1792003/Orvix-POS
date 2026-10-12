# Phase D · Idempotency contract (server ↔ client)

Status: design agreed 2026-10-12, implementation in progress. Applies to every
RPC that changes money or stock, or creates a record a retry could duplicate.

## Problem
`complete_sale` and friends mint ids server-side and accept no client identifier.
If the server commits and the response is lost, the client (online path or
outbox replay) re-sends and the operation is applied twice (duplicate sale,
double stock deduction, double payment). UI double-submit guards do not help
with lost responses.

## Server side

### Table
```sql
create table public.idempotency_keys (
  key            uuid primary key,
  rpc            text not null,
  actor_id       text,                 -- current_app_user().id at first execution (null for bootstrap paths)
  request_hash   text not null,        -- md5 of the canonical argument JSON (computed server-side)
  response       jsonb,                -- the RPC's return value, replayed on retry
  created_at     timestamptz not null default now()
);
-- RLS on, no policies; REVOKE ALL from anon, authenticated; only SECURITY DEFINER RPCs touch it.
```
Rows are pruned after 30 days (`prune_idempotency_keys()`, called by the
existing cron pattern later; not required for correctness).

### Helper
```sql
-- Returns the stored response if this key already completed with the same request; raises on mismatch;
-- returns NULL when the caller must execute the operation. Serialises concurrent calls on the same key.
create function public.idem_begin(p_key uuid, p_rpc text, p_request_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if p_key is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('idem:' || p_key::text));   -- concurrent duplicate waits here until the first txn commits
  select * into v from public.idempotency_keys where key = p_key;
  if found then
    if v.rpc <> p_rpc or v.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key using errcode = '23505';
    end if;
    return coalesce(v.response, '{}'::jsonb);   -- replay
  end if;
  insert into public.idempotency_keys(key, rpc, actor_id, request_hash)
  values (p_key, p_rpc, (select id from public.users where auth_id = auth.uid() limit 1), p_request_hash);
  return null;  -- execute
end $$;

create function public.idem_finish(p_key uuid, p_response jsonb) returns void ... -- update response = p_response where key = p_key
```
Because the insert happens inside the RPC's own transaction, a failed/rolled-back
operation leaves no key row, so a retry after a genuine failure executes again
(correct). A committed operation leaves the row and the response, so a retry
after a lost response replays the response without side effects.

### RPC pattern
Every in-scope RPC gains a **required** trailing parameter
`p_idempotency_key uuid default null` (null raises `IDEMPOTENCY_KEY_REQUIRED`;
there are no production clients to keep compatible), computes
`v_hash := md5(jsonb_build_object('a1', p_a1, 'a2', p_a2, …)::text)` over all
business arguments **excluding** `p_created_at`-style timestamps and the key
itself, then:
```sql
v_replay := public.idem_begin(p_idempotency_key, 'complete_sale', v_hash);
if v_replay is not null then return v_replay; end if;
-- … existing body unchanged …
perform public.idem_finish(p_idempotency_key, v_result);
return v_result;
```
Return types that are not jsonb are wrapped/unwrapped consistently (document per RPC).

### In scope (inspect all 45 SECURITY DEFINER RPCs; at minimum)
money/stock: `complete_sale`, `adjust_stock`, `record_supplier_payment`,
`pay_supplier_lump_sum`, `void_supplier_payment`, `receive_purchase_order`,
`dispatch_stock_transfer`, `receive_stock_transfer`;
record-creating: `create_purchase_order`, `create_stock_transfer`,
`create_refund_void_request`, `open_shift`, `close_shift`, `log_receipt_reprint`,
`log_audit_event`, `create_supplier`, `create_app_user`.
State-guarded RPCs (that today reject a replay with an error) also get the key
so a retry returns the **original result** instead of an error the client
cannot distinguish from a real rejection.

## Client side
- A UUID v4 idempotency key is generated **when the operation is created**
  (before the first network attempt) and stored on the outbox entry / in the
  provisional record; every attempt — online or replay — sends the same key as
  `p_idempotency_key`.
- `IDEMPOTENCY_MISMATCH` is a permanent error (never retried, surfaced to the
  user); `IDEMPOTENCY_KEY_REQUIRED` indicates a client bug.
- On replay the client treats the stored response exactly as a first-time
  success (reconcile provisional → authoritative).

## Tests (minimum)
Same key twice → one row, identical response. Same key, concurrent (two
sessions) → one row, both get the same response. Same key, different payload →
error, no second row. Key rolled back with the failing txn → retry executes.
Commit-then-timeout simulated by calling the RPC, discarding the result, and
calling again. Stock/payment totals unchanged after replays.

Implemented and run by `supabase/tests/phase-d/run.sh` (135 assertions, all
passing on `supabase/postgres:17.6.1.136`, 2026-10-12).

## Implementation status (2026-10-12)
Migrations `062_idempotency_keys.sql` (table + helpers), `063_rpc_idempotency.sql`
(30 RPCs), `064_revoke_anon_execute.sql`, `065_table_grant_parity.sql`,
`066_create_app_user_org_id.sql`. Server side done; client side pending.

## Deviations and clarifications
Everything above is implemented as written. The points below are decisions the
contract left open, or facts the implementation surfaced.

1. **Scope: 30 RPCs, not 17.** Every client-callable mutating RPC got the key:
   the 17 listed, plus the state-guarded transitions `approve_purchase_order`,
   `approve_refund_request`, `approve_stock_transfer`, `approve_void_request`,
   `cancel_purchase_order`, `cancel_stock_transfer`, `reject_refund_void_request`,
   `reject_stock_transfer`, `replace_manager`, `delete_product`, and the updates
   that duplicate an audit row on retry: `deactivate_app_user`,
   `update_app_user`, `update_supplier`. Out of scope (28): 11 STABLE/IMMUTABLE
   helpers, 10 trigger functions, the 6 ephemeral image-upload-session RPCs
   (10-minute TTL, token/owner scoped, two of them callable without a session),
   and the legacy `complete_stock_transfer` (revoked in 052). Full table in the
   063 header. **The client must send `p_idempotency_key` on all 30** — a
   missing key is `IDEMPOTENCY_KEY_REQUIRED` (SQLSTATE 22023).
2. **Hash input.** `md5(jsonb_build_object(<every parameter except
   p_created_at and p_idempotency_key>)::text)`. `p_expected_actor_id` (055) is
   a business argument and is hashed; the outbox already stores it per entry,
   so it is stable across retries. jsonb canonicalisation makes key order and
   whitespace inside `p_items` irrelevant (tested).
3. **Gate position.** `idem_begin` runs after the authentication block
   (`auth.uid()` / `current_app_user()` / expected-actor guard) and before any
   validation or business lock. Consequences: an unauthenticated call never
   touches the ledger and still raises `Not authenticated`; a replay returns
   the stored response even if the caller has since lost the permission
   (the operation already happened); `IDEMPOTENCY_MISMATCH` is raised before
   state guards, so "same key, different request" is never mistaken for a
   state error.
4. **Replay is not actor-checked.** `actor_id` is recorded but a different
   authenticated user presenting the same key + same hash gets the stored
   response. The contract did not ask for a check; a UUID v4 is not guessable
   and no cross-user leak path exists in the client. Can be tightened in
   `idem_begin` later without touching the RPCs.
5. **Return types unchanged.** All 30 already returned `jsonb`; no wrapping was
   needed. The only `void` RPC (`cancel_product_image_upload_session`) is out
   of scope.
6. **Helpers' grants.** `idem_begin`/`idem_finish` are executable by
   `service_role` (and the owner `postgres`, which the SECURITY DEFINER RPCs run
   as); never by `anon`/`authenticated`. `prune_idempotency_keys()` returns the
   deleted row count (integer) so a cron job can log it.
7. **Not in the contract, required to make it work:** `create_app_user` in
   production inserts no `org_id` and has failed on every call since 059 made
   the column NOT NULL. 066 sets it to the caller's `org_id` (adds `orgId` to
   the response). Found by the harness.
