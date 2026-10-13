# Phase G — remaining security fixes (074–076 + client)

Status 2026-10-12: **prepared, not applied.** Nothing here has been run against
the self-hosted stack, the hosted project or any real database. Every database result
below comes from the disposable harness (`supabase/tests/phase-d/run.sh`,
throwaway container, synthetic data). Nothing is committed.

Source: the four "Open (not fixed)" items at the end of
`org-isolation-audit.md` → "Independent review corrections (2026-10-12)".

| # | Defect | Fix | Migration / files |
|---|---|---|---|
| 1 | Idempotency replay not bound to the caller's org (`create_supplier`, shop-less `log_audit_event`) | `idem_begin()` stores `org_id` and refuses a replay from another org | `074_idempotency_caller_binding.sql` |
| 2 | Expired phone-upload session: EXPIRED stamp lost, inconsistent error | reject with "Upload link is no longer active"; expiry is derived and persisted by the readers | `075_upload_session_expired_reject.sql` |
| 3 | Concurrent first-time setup → several initial orgs/ADMINs | `bootstrap_first_admin()` RPC (one transaction, install-wide advisory lock); RLS bootstrap hatch removed | `076_bootstrap_first_admin.sql`, `src/stores/authStore.ts` |
| 4 | Orphan account sent to /setup on a populated install | `login()` and the bootstrap re-check use `isAppSetupNeeded()` (server answer) instead of an RLS-scoped `users` read | `src/stores/authStore.ts` |

Tests: `supabase/tests/phase-d/sql/t12_remaining_fixes.sql`, plus
`t12_bootstrap_{prep,a,b,check}.sql` for the concurrent bootstrap. `run.sh`
runs them only when migrations ≥ 074 (concurrency part: ≥ 076). Vitest:
`src/stores/authStore.login.test.ts`, `src/stores/authStore.setup.test.ts`.

---

## 1. Cross-org idempotency replay (074)

**Root cause.** `idem_begin()` (062) returned the stored response for any
committed key whose RPC name and request hash matched. It never looked at
who was asking. The 070 org guard runs *before* `idem_begin()` and rejects a
foreign entity id (shop, PO, transfer …). `create_supplier` and
`log_audit_event(p_shop_id => NULL)` take no such argument, so a caller from
another org who sent the same key and payload got the stored response. For
`create_supplier` that response is org A's new supplier row. Reproduced on
the harness by restoring the 062 body inside a rolled-back transaction: an
org-B ADMIN got `{"supplier": {"id": "supplier-…", "code": "SUPPRE", …}}`
and `{"auditLog": {"actorId": "u-admin", …}}` (synthetic data).

**Fix.**
- `idempotency_keys.org_id` is added and backfilled from `users.org_id` through `actor_id`. It is nullable and has no FK, so a console rollback can still delete an org.
- `idem_begin()` looks up the caller (`users` by `auth.uid()`, the same lookup 062 used for `actor_id`) and stores `actor_id` and `org_id`.
- On a hit, if `v.org_id IS DISTINCT FROM caller_org`, it raises `IDEMPOTENCY_MISMATCH` with SQLSTATE 23505.
- The message is **byte-identical** to the payload-mismatch error, so:
  - the client handles it unchanged: `idempotentRpc.ts` never retries it, and the outbox marks the entry as a conflict;
  - a foreign caller cannot tell "this key exists in another org" from "wrong payload".
- No RPC body changes. All 30 RPCs get replays only through `idem_begin()`. t12 checks this structurally: all 30 call `idem_begin(p_idempotency_key, '<own name>' …)`, and only `idem_begin`, `idem_finish` and `prune_idempotency_keys` reference `idempotency_keys`.
- A legacy row with a NULL org is never replayed to an org caller (fail closed).

**Binding level: organization, not actor (decision).**
- The isolation boundary is the organization. Binding to the org closes the leak for all 30 RPCs.
- Binding to the actor would break a legitimate case on a shared till:
  - Cashier A's `complete_sale` commits but the response is lost. A logs out, B logs in, and the outbox drains as B.
  - Today B gets the stored response and the entry is marked synced. Nothing is duplicated.
  - With actor binding, this committed sale would become a permanent "conflict".
- The ten 055 offline RPCs already reject a different-actor replay *before* `idem_begin()` through `p_expected_actor_id`. That behaviour is unchanged. `complete_sale` has no such guard and relies on shift ownership.
- A cross-actor replay within one org discloses nothing new. The key is a UUIDv4 minted on the device and never returned by the server, so a second actor can hold it only through the same device or browser profile. That profile already holds the queued payload and the cached data.
- `actor_id` is still recorded for forensics.
- t12 documents this choice: a MANAGER replaying an org-A ADMIN's key gets the stored response and no second row is created.

**Tests (t12 §1).**
- Same-actor replay returns the stored response.
- Org-B ADMIN, same key and payload, `create_supplier`: `IDEMPOTENCY_MISMATCH`. Nothing is created in org B and the key row is untouched.
- The same for shop-less `log_audit_event`: one audit row only.
- Same org, different actor: the stored response is returned.
- Different payload: `IDEMPOTENCY_MISMATCH` (062 semantics kept).
- A NULL-org legacy row is not replayed.
- Every key row carries its actor's org.
- **Sweep:** every key row committed by t02–t12 (34 rows, 18 distinct RPCs: adjust_stock, approve_stock_transfer, cancel_purchase_order, close_shift, complete_sale, create_app_user, create_purchase_order, create_stock_transfer, create_supplier, dispatch_stock_transfer, log_audit_event, log_receipt_reprint, open_shift, pay_supplier_lump_sum, receive_purchase_order, receive_stock_transfer, record_supplier_payment, void_supplier_payment) is passed to `idem_begin` by a caller from another org. Result: 34/34 blocked, 0 leaked. All 34 replay to their own actor.
- **Backfill:** in an early run, 074 was applied to a database whose key rows came from t02–t11 before 074. The sweep and the "actor's org" check passed on those backfilled rows.

**Residual risk.** Same-org cross-actor replay is allowed by design (see above).
Pre-074 rows with no actor stay unreplayable. That is harmless: keys are pruned
after 30 days, and such rows only come from callers that have no app user.

## 2. Expired upload session completion (075)

**Root cause.** The review listed this as "completes an expired session". That
is **not** what the production body does. Re-tested at cap 073 on the harness:
completing an expired session raises `Upload link has expired`, and the row
**stays `PENDING`**. The actual defects are:
1. The branch runs `UPDATE … SET status='EXPIRED', signed_upload_token=NULL` and then `RAISE`. The raise rolls the UPDATE back, so the EXPIRED stamp and the token clearing are lost.
2. The message differs from every other inactive-session path, which all say `Upload link is no longer active`.

**Fix.**
- The 019/snapshot body is kept byte-for-byte except one hunk: the dead UPDATE is removed and the expired branch raises `Upload link is no longer active`.
- The migration is generated by `gen075.py`, which asserts that the diff is exactly that hunk. The generator is in the session scratchpad `…/scratchpad/g/gen075.py` and is not committed; its header is in the migration.
- Expiry is **derived**, which is the only option, because any RAISE aborts the PostgREST transaction:
  - every function treats `PENDING AND expires_at <= now()` as expired;
  - `get_product_image_upload_session_status` (the desktop poll) and `_by_token` (the phone page's first call) stamp EXPIRED and clear the signed token in a transaction that does not raise, so the stamp persists.
- Signature and grants are unchanged; anon still executes the function (064).
- No client change: the phone page shows `error.message`.

**Tests (t12 §2).**
- Completing an expired session is rejected with the common message.
- The row is unchanged and still derivably expired.
- The desktop status poll returns EXPIRED, and the row ends `EXPIRED` with `signed_upload_token` NULL.
- Completing again is still rejected.
- The by-token read of an expired session returns EXPIRED, hands out no upload token, and persists EXPIRED.
- A CANCELED session is rejected.
- A valid session completes (COMPLETED, `bytes` stored). Completing it a second time is rejected.
- The anon grant is kept.

**Residual risk.**
- `attach_product_image_upload_session_token` has the same UPDATE-then-RAISE pattern, so its EXPIRED stamp is also lost. It is behaviourally safe because it still raises, but it is out of scope and left unchanged.
- A storage signed-upload token can outlive the 10-minute session. Completion is refused, but the file can still land in `temp/` as an orphan.
- Follow-up (prepared, not applied): both points are addressed in `upload-security-and-077.md`. 079 removes the dead UPDATE in `attach_…`. 078 gates token issuing by a live session, and §2c documents the residual for tokens that were already issued.

## 3. Concurrent first-time setup (076)

**Root cause.**
- Setup was three client round trips under RLS: `app_setup_needed()`, then INSERT organizations (policy: `app_setup_needed()`), then INSERT the users ADMIN (policy: `app_setup_needed() AND auth_id = auth.uid()`).
- Nothing serialised two operators. While one operator's rows are uncommitted, the other still sees an empty `users` table.
- `users_only_one_admin` is per org (059), so it cannot catch this.
- Reproduced at cap 073 on the harness, with users emptied and session A holding its org+ADMIN insert open for 3 s while session B did the same. Result: `users: user-one:ADMIN:org-race-a, user-two:ADMIN:org-race-b`, orgs 4 → 6.
- With PostgREST's per-statement transactions, the more likely bad outcome is an org left behind with no ADMIN.

**Fix.**
- `public.bootstrap_first_admin()` is `SECURITY DEFINER`, takes no arguments and returns jsonb. In one transaction it:
  1. requires `auth.uid()` and READ COMMITTED;
  2. takes `pg_advisory_xact_lock(76, 1)`, a two-key lock space that cannot collide with `idem_begin`'s `hashtext` locks;
  3. re-checks `app_setup_needed()` **inside the lock**, otherwise raising `SETUP_ALREADY_COMPLETED` (42501);
  4. reads the email from `auth.users` and derives the user id, name and org id exactly as the client did before;
  5. inserts the organization (the 068 trigger seeds `business_profile`) and the ADMIN row.
- Grants: authenticated and service_role; not anon.
- Policies:
  - `organizations_ins` becomes `WITH CHECK (false)`. It is kept as an explicit deny so the policy inventory and t09's count stay stable. The console uses the service role and bypasses RLS.
  - `users_ins` loses its bootstrap branch and is now only `user:create AND org_id = app_org_id()`.
- So the RPC is the only bootstrap path for client sessions.

**Why not a lock in a trigger and keep the policies.** The org insert and the
ADMIN insert are separate PostgREST transactions. A trigger lock would be
released between them and could not make the pair atomic. A failed second
insert would also leave an orphan org behind. That hatch already produced one
critical finding (review correction 1).

**Client.** `bootstrapFirstAdmin()` now works as follows:
1. Server check.
2. Sign in, or sign up if that fails.
3. Re-check with `isAppSetupNeeded()`. This replaces the RLS-scoped `users` read.
4. `supabase.rpc("bootstrap_first_admin")`. On `SETUP_ALREADY_COMPLETED` it shows "Setup has already been completed…" and signs out. Any other error is surfaced verbatim and also signs out. A malformed result is rejected.

The client no longer inserts into `organizations` or `users`. `SetupPage.tsx` is unchanged because it calls the store action.

**Tests.**
- **t12 §3, populated install:** the RPC is SECURITY DEFINER and not anon; the policies are tightened; an org ADMIN and an orphan get `SETUP_ALREADY_COMPLETED`; anon gets permission denied; nothing is created.
- **`t12_bootstrap_*`, run last because they `TRUNCATE public.users CASCADE`:**
  - On the empty install, direct INSERTs into organizations and of a users ADMIN are refused by RLS.
  - Two sessions call the RPC simultaneously. A holds its transaction for 3 s; B waits about 2 s and is refused.
  - Exactly one users row results (ADMIN, operator A, in A's new org), plus exactly one new organization with its business_profile.
  - Later calls by B and by A are refused. The new ADMIN sees only its own org through RLS.
- **Why not a separate scratch database:** `CREATE DATABASE … TEMPLATE postgres` is refused while the pg_cron and pg_net workers are connected, and the auth/storage/extension shims exist only in `postgres`. Emptying `users` at the very end of the run leaves every other result untouched.
- **Vitest (`authStore.setup.test.ts`):** refusal when the server says no or the check errors; happy path is exactly one RPC call with no table access; existing account; signUp failure; re-check says done; re-check errors; losing the race (`SETUP_ALREADY_COMPLETED` mapped to a friendly message plus sign-out); RPC missing; malformed result.

**Residual risk.**
- A response lost after a successful bootstrap: the retry is refused with "already completed", and the operator signs in normally.
- The RPC refuses non-READ COMMITTED transactions. PostgREST uses READ COMMITTED.

## 4. Misleading login message for orphan accounts (client)

**Root cause.** When `login()` found no linked app user, it decided "empty
install → /setup" by reading `users` under RLS. Since 069, `users_sel` is
org-scoped, so an orphan sees zero rows on a populated install and was told
to run first-time setup.

**Fix.** `login()` now asks `isAppSetupNeeded()`, which is
`app_setup_needed()`, an unfiltered SECURITY DEFINER count:
- **true:** the /setup message with `setupNeeded`;
- **false or error:** "No staff profile is linked to this account. Contact an administrator." This fails closed.

The existing orphan wording was kept. It carries the same meaning as "This
account has no staff profile; ask your administrator", and the UI already
shows it. The bootstrap step-3 re-check uses the same server call (§3).

**Tests (`authStore.login.test.ts`).**
- Empty install → /setup.
- Orphan on a populated install, where RLS returns zero rows and the server says false → the orphan message, not /setup.
- Setup-check error → the orphan message.
- The mocks throw if `users.select("id")` or any insert is reached.

---

## Results (real outputs)

Harness, all migrations (062–076, each applied twice for idempotency):

```
==> test t12_bootstrap concurrency (two sessions, empty users table, A holds its txn open 3 s)
session B: PASS t12/076 concurrent: the second simultaneous bootstrap_first_admin is refused after waiting for the first -- got: SETUP_ALREADY_COMPLETED: ...
session B wall time 2s
PASS t12/076 concurrent: exactly one users row, an ADMIN, linked to operator A, in A's new org
PASS t12/076 concurrent: exactly one new organization, with its business_profile row -- orgs before=4 after=5
assertions: 371  failed: 0  findings: 0 of 103 isolation checks  aborted steps: 0  migrations capped at: 999  image: supabase/postgres:17.6.1.136
RESULT: PASS
```

Harness, cap 073 (deployed schema; t12 skipped, everything else unchanged from before this work, 327/0):

```
==> skipping t12_remaining_fixes (migrations capped at 073 < 074)
==> skipping t12 bootstrap concurrency (migrations capped at 073 < 076)
assertions: 327  failed: 0  findings: 0 of 103 isolation checks  aborted steps: 0  migrations capped at: 073  image: supabase/postgres:17.6.1.136
RESULT: PASS
```

Client: `npx tsc -b` exit 0; `npm test` → 72 files passed / 2 skipped, 741 tests passed / 28 skipped; `npx eslint` on the three touched files exit 0.

Other harness edits: `t01` function count +1 when `bootstrap_first_admin()` exists (conditional, so cap 073 is unchanged); `run.sh` gates t12 (≥074) and the bootstrap concurrency (≥076, run last) and also prints `SKIP`/`INFO` lines.

## Apply (after owner approval only)

```sh
<deployment>/apply-migrations.sh --from 074 --to 076 --dry-run
<deployment>/apply-migrations.sh --from 074 --to 076
```

The three migrations are independent of each other, and each is idempotent
and can be re-run. Post-apply verification queries are in each file's header.

## Client/server compatibility

| Combination | Behaviour |
|---|---|
| 074 alone | Transparent to clients. Same error text and SQLSTATE as before; the only new rejection is a cross-org replay. |
| 075 alone | Transparent. The phone page shows "Upload link is no longer active" instead of "Upload link has expired". |
| 076 + **old** client | /setup's direct `INSERT organizations` is refused by RLS. Nothing is created (fail closed). Login is unaffected. |
| **new** client without 076 | /setup's RPC is missing ("Could not find the function"). Nothing is created. The login fix (§4) works without any migration (it needs 067, which is already applied). |
| 076 + new client | Intended state. **Ship the /setup client build together with 076.** |

Production is a populated install, so `app_setup_needed()` is false and /setup
is unreachable there in every combination. The window only matters for fresh
installs.

## Rollback

- **074:** re-run 062's `idem_begin` block. The `org_id` column may stay.
- **075:** re-run 019's `complete_product_image_upload_session` block.
- **076:** `DROP FUNCTION public.bootstrap_first_admin();`, re-run 069's `organizations_ins` / `users_ins` blocks, and ship the previous client.
