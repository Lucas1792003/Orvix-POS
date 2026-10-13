-- ============================================================
-- Migration 074: bind idempotency replays to the caller's organization
--                (Phase G follow-up, docs/selfhost-migration/phase-g/
--                 remaining-security-fixes.md §1)
--
-- PURPOSE
--   idem_begin() (062) returned the stored response of ANY committed key
--   whose rpc + request hash matched, regardless of who was asking. The 070
--   org guard runs before idem_begin() and stops a foreign replay only when
--   the call names an entity of another org (shop, PO, transfer ...). RPCs
--   whose arguments name no such entity - create_supplier, and
--   log_audit_event with p_shop_id NULL - reached idem_begin() unguarded:
--   an org-B user presenting an org-A key with the same payload received
--   org A's stored response (create_supplier: org A's new supplier row).
--   Reproduced in supabase/tests/phase-d/sql/t12_remaining_fixes.sql.
--
-- WHAT IT DOES
--   1. idempotency_keys gains `org_id text` (nullable, no FK - it is a
--      binding attribute, not a relationship; an org deleted by the console
--      rollback must not be blocked by key rows). Existing rows are
--      backfilled from users.org_id via actor_id.
--   2. idem_begin() resolves the caller (users row by auth.uid(), exactly the
--      lookup 062 already used for actor_id) once, stores actor_id AND
--      org_id on first execution, and on a hit raises IDEMPOTENCY_MISMATCH
--      when the stored org_id IS DISTINCT FROM the caller's org_id. The
--      error text and SQLSTATE (23505) are identical to the existing
--      payload-mismatch error, so (a) the client's existing handling applies
--      unchanged (src/stores/data/idempotentRpc.ts: never retried, outbox
--      entry flagged as a conflict) and (b) the error is not an oracle that
--      tells a foreign caller "this key exists in another org" apart from
--      "you sent a different payload".
--   Every one of the 30 idempotent RPCs obtains replays ONLY through
--   idem_begin() (verified in t12: 30 RPCs call it; no other function reads
--   idempotency_keys), so this single change binds all of them. No RPC body
--   changes. idem_begin's signature, owner, SECURITY DEFINER, search_path and
--   grants are unchanged.
--
-- BINDING LEVEL - ORGANIZATION, NOT ACTOR (deliberate)
--   * The isolation boundary of this product is the organization (068-073).
--     Org binding closes the cross-org leak for all 30 RPCs.
--   * Actor binding would change legitimate same-org behaviour without a
--     security gain: on a shared till, cashier A's sale commits but the
--     response is lost; A logs out, B logs in, the outbox drains as B. Today
--     B receives the stored response and the entry is marked synced (the sale
--     exists, nothing is duplicated). Actor binding would turn that into a
--     permanent IDEMPOTENCY_MISMATCH "conflict" for a sale that did commit.
--   * For the ten offline-eligible RPCs that take p_expected_actor_id (055),
--     a different-actor replay of a stamped outbox entry is ALREADY rejected
--     before idem_begin() is reached ("queued by a different user"), so the
--     055 semantics are untouched. complete_sale has no expected-actor guard
--     (055 relies on shift ownership) and is exactly the case above.
--   * Same-org cross-actor replay discloses nothing new: the key is a UUIDv4
--     minted on the device and never returned by the server; a second actor
--     can only hold it by using the same device/browser profile, which
--     already holds the queued payload and the cached data.
--   actor_id continues to be recorded for audit/forensics.
--
-- ROLLBACK
--   Re-run the idem_begin block of 062_idempotency_keys.sql (same
--   signature). The org_id column may stay (unused) or be dropped with
--   `ALTER TABLE public.idempotency_keys DROP COLUMN org_id;`.
-- FORWARD RECOVERY
--   Idempotent: ADD COLUMN IF NOT EXISTS, backfill only touches NULL org_id,
--   CREATE OR REPLACE, REVOKE/GRANT re-stated. Re-run the file.
--
-- VERIFICATION
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='idempotency_keys' AND column_name='org_id';  -- 1 row
--   SELECT prosrc LIKE '%v.org_id IS DISTINCT FROM v_caller_org%' FROM pg_proc
--    WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure;                         -- t
--   SELECT count(*) FROM public.idempotency_keys k
--     JOIN public.users u ON u.id = k.actor_id WHERE k.org_id IS DISTINCT FROM u.org_id;  -- 0
--   SELECT has_function_privilege('authenticated', 'public.idem_begin(uuid,text,text)', 'EXECUTE');  -- f
--   -- harness: bash supabase/tests/phase-d/run.sh   (t12_remaining_fixes)
--
-- NOT applied anywhere by this change. Requires 062 (+ 063/070 callers).
-- ============================================================

ALTER TABLE public.idempotency_keys ADD COLUMN IF NOT EXISTS org_id text;

COMMENT ON COLUMN public.idempotency_keys.org_id IS
  'Organization of the caller at first execution (074). A replay from another organization raises IDEMPOTENCY_MISMATCH.';

-- Backfill rows written before 074 (keys live 30 days; see prune_idempotency_keys).
UPDATE public.idempotency_keys k
   SET org_id = u.org_id
  FROM public.users u
 WHERE k.org_id IS NULL
   AND k.actor_id = u.id;

-- ------------------------------------------------------------
-- idem_begin(key, rpc, request_hash) -> jsonb
--   NULL          : caller must execute the operation (row inserted)
--   non-NULL      : replay - return this as the RPC result
--   raises 22023  : IDEMPOTENCY_KEY_REQUIRED (key is NULL)
--   raises 23505  : IDEMPOTENCY_MISMATCH (key reused for a different request,
--                   or - 074 - by a caller of a different organization)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid, p_rpc text, p_request_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v record;
  v_caller_id  text;  -- 074
  v_caller_org text;  -- 074
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Concurrent duplicates serialise here until the first transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('idem:' || p_key::text));

  -- 074: the caller, resolved exactly as 062 resolved actor_id.
  SELECT u.id, u.org_id INTO v_caller_id, v_caller_org
    FROM public.users u WHERE u.auth_id = auth.uid() LIMIT 1;

  SELECT * INTO v FROM public.idempotency_keys WHERE key = p_key;
  IF FOUND THEN
    IF v.rpc <> p_rpc OR v.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key
        USING ERRCODE = '23505';
    END IF;
    -- 074: a stored response is replayed only inside the organization that
    -- produced it. Same text as above on purpose (no cross-org oracle).
    IF v.org_id IS DISTINCT FROM v_caller_org THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key
        USING ERRCODE = '23505';
    END IF;
    RETURN COALESCE(v.response, '{}'::jsonb);   -- replay
  END IF;

  INSERT INTO public.idempotency_keys (key, rpc, actor_id, org_id, request_hash)
  VALUES (p_key, p_rpc, v_caller_id, v_caller_org, p_request_hash);
  RETURN NULL;  -- execute
END;
$$;

-- Unchanged grant shape (062/064): internal helper, never client-callable.
REVOKE ALL ON FUNCTION public.idem_begin(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idem_begin(uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
