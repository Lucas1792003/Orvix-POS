# Migration 086 — SQL change proposals (NOT implemented)

> **Where these land matters (review-snapshot-10 D-H2).** The documented
> forward recovery after a rollback is "re-apply 086". 086's preflight pins
> the 085 bodies of the 32 guarded functions and 086 defines `op_status`
> itself. So a proposal shipped as a LATER migration conflicts with that
> recovery: re-applying 086 after proposal 2 (a new `pay_supplier_lump_sum`
> body) aborts in the preflight, and re-applying 086 after proposal 1 silently
> restores the vulnerable `op_status`. Either fold proposals 1 and 2 into a
> **regenerated 086 before it is deployed anywhere** (generator:
> `tools/m086-verify/generator/`), or change the documented forward recovery
> to "re-apply 086, then every later migration in order" and teach 086's
> preflight to accept the newer bodies. Owner decision.
>
> **After the §1 per-organisation key redesign, re-applying the ORIGINAL 086
> is unsafe, not merely regressive:** it restores key-only bodies of
> `idem_begin`, `op_execute` and `op_status` over a ledger that may then hold
> `(org-a, k)` and `(org-b, k)`; a key-only lookup can return another
> organisation's row (a committed sale reported abandoned or mismatched — and
> entered again), and a rollback restoring the key-only primary key fails on
> those duplicates. With §1, 086 itself must be regenerated (and its rollback
> and forward-recovery documentation rewritten together) — never a later
> migration on top of the original 086.

Status: **proposals for owner review only.** Nothing here is applied, committed
as a migration, or run against any server. Migration 086, its rollback and
`apply-migrations.sh` are unchanged. Each proposal names its minimal diff, its
risks, and the disposable test that would prove it (`tools/m086-verify`).

---

## 1. A fence without arguments can claim another organisation's never-delivered key

**Finding (confirmed in SQL, residual R3).** `op_status` (086, around line
1230) computes organisation evidence only when `p_args` is sent:

```sql
v_evidence := CASE WHEN p_args IS NOT NULL THEN public.op_org_of(p_rpc, p_args) END;
...
IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id = v_actor THEN
  v_owner := v_actor; v_authorized := true;          -- own fence: no evidence needed
```

A user who knows an undelivered UUIDv7 key of another organisation (from a
decrypted export or a shared till's IndexedDB) calls
`op_status(p_key, p_rpc, p_fence => true, p_expected_actor_id => <self>, p_args => NULL)`.
The key is recorded `abandoned` in the caller's organisation; the real
organisation's `op_execute` then answers `mismatch` and its `op_status`
`unavailable`. **No money moves** (the operation simply never runs), but that
payment / sale is permanently blocked and the victim's owner cannot verify it
(the client refuses to close it on `unavailable`). Covered as a recorded GAP by
`tools/security-audit/suites/ops.ts` (§7).

**Requiring arguments is NOT enough (review-snapshot-10 B-M2).** A guard that
only refuses `p_args IS NULL` is bypassed with `p_args => '{}'`, with arguments
naming rows that do not exist (`op_org_of` returns NULL), or with arguments
naming the caller's OWN organisation's rows (evidence = the caller's org).
The arguments are never bound to the key, so no evidence check on the fence can
tell "my key" from "a key I learnt". `ops.ts` §7 records all three variants as
GAPs (none of them may turn into a false PASS).

**Proposed fix: make the ledger key per organisation.** The squat works because
a fence in organisation B decides the key for everyone. If a key's row belongs
to the organisation that wrote it, a fence in B can only decide B's row:

```sql
-- idempotency_keys: primary key (key)  ->  (org_id, key)
ALTER TABLE public.idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE public.idempotency_keys ADD PRIMARY KEY (org_id, key);   -- org_id NOT NULL first (backfill legacy NULLs)
-- op_execute / op_status / idem_begin / idem_finish: every lookup and insert
-- becomes  WHERE org_id = v_org AND key = p_key  (v_org from op_caller, never from the client)
```

Then B's fence writes `(org-b, k)`; A's later `op_execute` finds no
`(org-a, k)` row and runs normally; A's own lookups never see B's row. Same-org
squatting (a cashier fencing a key of another user of the same organisation)
remains possible and is bounded by the existing own-actor / ADMIN rules.

**Interim narrowing (smaller, not a fix):** refuse a fence whose evidence is
NULL — `IF v_fence AND public.op_org_of(p_rpc, coalesce(p_args, '{}')) IS NULL
THEN RETURN … 'evidence_required'` (note: the body's own variable is `v_fence`,
`p_fence` may be NULL). It stops the `null` / `{}` / non-existent-rows variants
but not the "own rows" one.

**Compatibility.** Every fence the current client and recovery tool send
already carries the arguments (`stores/data/onlineOnly.ts` decideOnServer /
settleEarlier / markOnlineOperationVerified, `stores/data/outbox.ts` lookups,
`tools/queue-recovery/replay.ts` statusOf). The per-organisation key changes
the ledger's primary key and every 086 function body: a schema migration with a
backfill (legacy rows with `org_id IS NULL` need a decision), re-fingerprinting
of 086, and a re-run of the whole `tools/m086-verify` suite. A key reused across
organisations by the same till (shared till, two organisations) becomes two
independent operations — intended.

**Risk.** The primary-key change rewrites the index of the ledger table
(locks; size-dependent); every lookup by key alone must be found and changed.
UUIDv7 keys carry 74 random bits, so accidental cross-organisation collisions
are not a concern either way.

**Disposable test.** `ops.ts` §7: all three variants PASS (no squat; A's own
execution commits once afterwards, nothing in B); §1–§6, §8–§11 unchanged; the
`client`, `recovery`, `rollback` and `e2e` parts unchanged.

**Where.** A regenerated 086 (`tools/m086-verify/generator/template.sql`)
with a new fingerprint, before 086 is deployed anywhere — see the note at the
top: as a later migration it is unsafe with the documented "re-apply 086"
recovery.

---

## 2. Concurrent `pay_supplier_lump_sum` can silently record less than entered

**Finding (confirmed in SQL).** The function reads the supplier's outstanding
total **without a lock**, checks the requested amount against it, then locks the
purchase orders (`FOR UPDATE`) and allocates. Under READ COMMITTED, a second
payment that commits between the read and the lock leaves less balance on the
locked rows; the loop ends with `v_remaining > 0` and **the remainder is
dropped without an error** — the response and the ledger say "applied", but the
supplier received less than the cashier entered. (Two payments never exceed the
outstanding balance: no overpayment.)

**Proposed diff:**

```sql
  -- Lock this supplier's receivable POs in this shop BEFORE summing them.
  PERFORM 1 FROM purchase_orders
   WHERE supplier_id = p_supplier_id AND shop_id = p_shop_id AND status = 'RECEIVED'
   ORDER BY created_at ASC, id ASC
   FOR UPDATE;
  SELECT COALESCE(sum(total_mmk - COALESCE(paid_mmk, 0)), 0) INTO v_outstanding ...;   -- unchanged
  ...
  END LOOP;
  -- Defence in depth: never record less than was entered.
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Payment amount exceeds total outstanding balance';
  END IF;
```

The error text is the existing one (classified as a final refusal by
`op_classify_refusal`, recorded `rejected` by the executor): a client shows
"refused", nothing is applied, the whole transaction rolls back.

**Risk.** Lock order: both the new `PERFORM … FOR UPDATE` and the existing loop
lock in `created_at, id` order (no new deadlock pattern). The function body's
md5 changes: **086's preflight guard pins this body** — the change must ship
after 086 (a later migration) and the 086 fingerprint documentation updated, or
be folded into a regenerated 086 before it is deployed.

**Disposable test.** Two sessions on one supplier: session 1 locks (or pays)
between session 2's sum and its loop (`pg_sleep` injected via a test-only
wrapper, or two concurrent `op_execute` calls with an advisory-lock barrier);
assert `sum(supplier_payments.amount_mmk) = sum(entered amounts)` for every
committed call and that the short one is `rejected` with no rows.

---

## 3. The rollback leaves the ledger saying 086 is applied

**Finding.** `supabase/rollbacks/086_operation_outcomes.rollback.sql` drops the
executor but never removes the `086` row from
`supabase_migrations.schema_migrations`; it has no `lock_timeout`, no
preflight, and its own `BEGIN … COMMIT` while its header says to run it with
`--single-transaction` (psql documents that combination as not behaving as
intended).

**Proposed diff (generated by `gen086.py`, so the generator changes too):**

```sql
-- run WITHOUT --single-transaction (the file is its own transaction):
--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f 086_operation_outcomes.rollback.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.op_execute(uuid,text,jsonb,text)')) THEN
    RAISE EXCEPTION 'rollback preflight: 086 is not applied here (no op_execute); nothing changed';
  END IF;
END $$;
... (unchanged body) ...
DELETE FROM supabase_migrations.schema_migrations WHERE version = '086';
... (unchanged post-checks) ...
COMMIT;
```

**Risk.** Removing the ledger row means a later `apply-migrations.sh --from 086`
re-applies 086 (it is idempotent and that IS the documented forward recovery).
The `DELETE` must stay inside the same transaction as the drop.

**Disposable test.** `rollback` part: after the rollback, `schema_migrations`
has no `086` and `max(version) = '085'`; a second run aborts in the preflight
with nothing changed; re-apply restores the 086 fingerprint.

---

## 4. The migration runner has no prerequisite / gap / duplicate check and stores no checksum

**Finding.** `deploy/lucashome/apply-migrations.sh` selects files by a text
range of version prefixes. It does not check that every earlier version is
recorded, does not refuse versions already recorded, does not know about the
deliberately skipped 084 (`--from 084` would apply it), and records versions
with an empty `statements` array (no proof of which file content ran).

**Proposed diff (pre-flight, before any backup or copy):**

```bash
SKIP_OK="${SKIP_OK:-084}"     # versions deliberately not applied (documented)
APPLIED=$(dbx -c "select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations" </dev/null)
for f in $(ls "$MIG" | grep -E '^[0-9]{3}_.*\.sql$'); do
  v=${f:0:3}
  if [[ "$v" < "$FROM" ]] && ! grep -qw "$v" <<<"$APPLIED" && ! grep -qw "$v" <<<"$SKIP_OK"; then
    echo "REFUSE: earlier migration $v is not recorded (gap)"; exit 2; fi
done
for f in $FILES; do v=${f:0:3}
  grep -qw "$v" <<<"$APPLIED" && { echo "REFUSE: $v is already recorded"; exit 2; }
  grep -qw "$v" <<<"$SKIP_OK" && [ "${ALLOW_SKIPPED:-0}" != 1 ] && { echo "REFUSE: $v is on the skip list"; exit 2; }
done
```

and record the checksum with each version (no schema change — the existing
`statements text[]` column):

```bash
printf "(%s, ARRAY['sha256:%s']::text[], %s)," "'$v'" "$(shasum -a 256 "$MIG/$f" | cut -c1-64)" "'$n'"
```

**Also (review-snapshot-10 D-M4).** The runner applies the files in one
transaction but records their versions in a SECOND psql call afterwards — a
failure between the two leaves applied-but-unrecorded migrations (the script
says so, but it is avoidable): append the `INSERT INTO
supabase_migrations.schema_migrations …` as a final `--command` of the same
`--single-transaction` psql invocation. **Ordering with proposal 3:** the
"already recorded" refusal blocks the documented "re-apply 086" forward
recovery unless the rollback removes the `086` ledger row (proposal 3) — land
3 before (or with) 4.

**Risk.** Operational only: an owner who intends to apply a skipped migration
must say so (`ALLOW_SKIPPED=1`). Existing ledger rows (062–085) keep their empty
`statements`; their content proof remains the per-deploy evidence (G-series).

**Disposable test.** Against the `phf-iso-db` container with a fake ledger:
`--from 086` with 084 absent passes (skip list), with 083 absent refuses (gap);
`--from 085` refuses (already recorded); the recorded row carries the file's
sha256.
