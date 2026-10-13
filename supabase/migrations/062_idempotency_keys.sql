-- ============================================================
-- Migration 062: idempotency_keys table + idem_begin / idem_finish /
--                prune_idempotency_keys helpers (Phase D, change A1 / F15)
--
-- Design: docs/selfhost-migration/phase-d/idempotency-contract.md (followed
-- exactly). Defect: the production-dependencies audit (private ops notes) §8 -
-- a commit-then-lost-response retry re-executes complete_sale & friends and
-- duplicates the sale / stock deduction / payment. Migration 063 wires every
-- mutating RPC through these helpers; this file only creates the plumbing and
-- is behaviour-neutral on its own.
--
-- How it works: inside the RPC's own transaction, idem_begin() takes a
-- per-key transaction-scoped advisory lock, then either returns the stored
-- response (replay), raises IDEMPOTENCY_MISMATCH (same key, different request
-- hash or different RPC), or inserts the key row and returns NULL (execute).
-- Because the insert is part of the RPC transaction, a failed RPC rolls the
-- key row back too, so a genuine retry executes again; a committed RPC keeps
-- the row + response, so a retry after a lost response replays with no side
-- effects. A concurrent duplicate blocks on the advisory lock until the first
-- transaction commits, then sees the committed row and replays.
--
-- Security: RLS on, NO policies, ALL privileges revoked from anon and
-- authenticated (service_role keeps full access for ops/pruning). The helpers
-- are SECURITY DEFINER owned by postgres and EXECUTE is revoked from
-- PUBLIC/anon/authenticated: they are only ever called from the SECURITY
-- DEFINER RPCs, which run as their owner (postgres) and therefore do not need
-- a grant. prune_idempotency_keys() is granted to service_role so the existing
-- pg_cron -> edge-function pattern (supabase/schedule_audit_rotation.sql) or
-- a direct `SELECT cron.schedule(...)` can call it later; it is not required
-- for correctness.
--
-- Rollback: DROP FUNCTION public.idem_begin(uuid,text,text),
-- public.idem_finish(uuid,jsonb), public.prune_idempotency_keys();
-- DROP TABLE public.idempotency_keys; (only after 063 is rolled back - the
-- RPCs reference the helpers). Forward recovery: this file is idempotent
-- (IF NOT EXISTS / CREATE OR REPLACE / REVOKE-GRANT), re-run it.
--
-- Verification:
--   SELECT relrowsecurity, relacl FROM pg_class
--    WHERE oid = 'public.idempotency_keys'::regclass;          -- t, no anon/authenticated entry
--   SELECT count(*) FROM pg_policies WHERE tablename = 'idempotency_keys';   -- 0
--   SELECT proname, prosecdef,
--          has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
--          has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc_exec
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname IN ('idem_begin','idem_finish','prune_idempotency_keys');
--   -- expect prosecdef = t, anon_exec = f, auth_exec = f, svc_exec = t
-- ============================================================

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  key            uuid PRIMARY KEY,
  rpc            text NOT NULL,
  -- current_app_user().id at first execution (NULL for bootstrap paths)
  actor_id       text,
  -- md5 of the canonical argument JSON, computed server-side by the RPC
  request_hash   text NOT NULL,
  -- the RPC's return value; replayed verbatim on retry
  response       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Pruning walks by age.
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx
  ON public.idempotency_keys (created_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
-- No policies on purpose. The hosted default ACL grants ALL to anon/
-- authenticated on every new table, so revoke explicitly.
REVOKE ALL ON public.idempotency_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.idempotency_keys TO service_role;

-- ------------------------------------------------------------
-- idem_begin(key, rpc, request_hash) -> jsonb
--   NULL          : caller must execute the operation (row inserted)
--   non-NULL      : replay - return this as the RPC result
--   raises 22023  : IDEMPOTENCY_KEY_REQUIRED (key is NULL)
--   raises 23505  : IDEMPOTENCY_MISMATCH (key reused for a different request)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid, p_rpc text, p_request_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v record;
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Concurrent duplicates serialise here until the first transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('idem:' || p_key::text));

  SELECT * INTO v FROM public.idempotency_keys WHERE key = p_key;
  IF FOUND THEN
    IF v.rpc <> p_rpc OR v.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key
        USING ERRCODE = '23505';
    END IF;
    RETURN COALESCE(v.response, '{}'::jsonb);   -- replay
  END IF;

  INSERT INTO public.idempotency_keys (key, rpc, actor_id, request_hash)
  VALUES (
    p_key, p_rpc,
    (SELECT id FROM public.users WHERE auth_id = auth.uid() LIMIT 1),
    p_request_hash
  );
  RETURN NULL;  -- execute
END;
$$;

-- ------------------------------------------------------------
-- idem_finish(key, response): store the RPC's return value for replays.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.idem_finish(p_key uuid, p_response jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.idempotency_keys SET response = p_response WHERE key = p_key;
END;
$$;

-- ------------------------------------------------------------
-- prune_idempotency_keys(): delete rows older than 30 days. Returns the
-- number of rows removed. Not required for correctness.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prune_idempotency_keys()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.idempotency_keys WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Helpers are internal: only the SECURITY DEFINER RPCs (running as the owner,
-- postgres) call idem_begin/idem_finish; service_role may prune.
REVOKE ALL ON FUNCTION public.idem_begin(uuid, text, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idem_finish(uuid, jsonb)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_idempotency_keys()       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idem_begin(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.idem_finish(uuid, jsonb)     TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_idempotency_keys()     TO service_role;

COMMENT ON TABLE public.idempotency_keys IS
  'Phase D idempotency ledger: one row per client idempotency key; response is replayed on retry. Pruned after 30 days.';
