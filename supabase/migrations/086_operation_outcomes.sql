-- ============================================================
-- Migration 086: durable operation outcomes, operation status lookup with
--                atomic fencing, guarded RPC executor bound to the
--                operation's own actor, executor-only UUIDv7 operations,
--                conservative idempotency retention, SECURITY DEFINER
--                search_path hardening
--                (G1 Stage 1; design, tests, rollout and rollback:
--                docs/selfhost-migration/phase-g/migration-086.md)
--
-- WHY
--   B2: an idempotent RPC that REFUSES (e.g. insufficient stock) rolls back
--       its idem_begin row, so the refusal leaves no trace. A till whose
--       reply was lost resends the same key later; if stock was restocked in
--       between, the refused sale now EXECUTES.
--   C1: an operation the till did not record (online attempt, reply lost,
--       offline rules refused it) can still arrive late and execute, because
--       nothing on the server can say "this key must never run".
--   S1: 69 functions pin search_path=public without pg_temp, so pg_temp is
--       searched FIRST for tables: a SQL session with TEMP privilege can
--       shadow `users` and run an ADMIN-only RPC as a cashier.
--
-- WHAT IT DOES (additive; the 30 idempotent RPC bodies are NOT changed;
--   idem_finish is NOT changed)
--   1. idempotency_keys: state (committed|rejected|abandoned, default
--      committed), outcome_code, outcome_message, decided_at, response_purged_at,
--      a state/prefix CHECK and an index on decided_at. Existing rows keep
--      their request_hash and become committed, decided_at = created_at.
--      A rejected row stores 'R:'||hash, an abandoned (fenced) row 'A:': the
--      idem_begin hash comparison is verbatim, so a legacy call with such a
--      key always gets IDEMPOTENCY_MISMATCH (also after a rollback).
--   2. idem_begin: ONE added guard. A key that is an RFC 9562 UUIDv7 (minted
--      only by 086 clients) is accepted only when op_execute is running
--      that very key (transaction-local setting orvix.op_execute_key, which
--      no PostgREST request can set). On an 086 server a UUIDv7 operation
--      therefore cannot run through a legacy direct RPC at all (downgraded
--      client, schema-cache fallback, late copy of a pruned key). v4 keys
--      (085 / v1.0.16 / Batch 2A clients) are unaffected. create_app_user
--      (direct-only) is exempt.
--   3. op_execute(p_key, p_rpc, p_args, p_actor_id): static allow-listed
--      executor for 29 RPCs (create_app_user stays direct-only). Typed
--      binding, unknown names/arguments refused before anything runs, the
--      key only from p_key. p_actor_id is the app user who CREATED the
--      operation (client record): a different caller is refused before
--      anything runs (OP_ACTOR_MISMATCH, nothing recorded) -- a queue drained
--      in another user's session never executes, so it can never be refused
--      for good because of who drained it. Required for UUIDv7 keys; for a
--      legacy key without it a refusal is never recorded. The idem advisory
--      lock is taken at the OUTER level, then the ledger row decides (replay
--      committed / rejected / abandoned, mismatch for changed arguments,
--      another org or another RPC); otherwise the unchanged RPC runs inside
--      a savepoint. Only an AUDITED definitive refusal (op_classify_refusal:
--      explicit messages and named constraints) is recorded as rejected;
--      every other failure re-raises and records NOTHING.
--   4. op_status(p_key, p_rpc, p_fence, p_expected_actor_id, p_args):
--      lookup (shared lock: concurrent lookups never see each other as
--      in_flight); with p_fence a never-delivered key is atomically decided
--      as abandoned so a late copy can never execute. The operation's own
--      actor, or ADMIN / sync:resolve of the organisation the operation's
--      arguments verifiably belong to, may fence; an ADMIN may fence a
--      legacy entry with no recorded actor only with that server-side
--      organisation evidence. Expired v7 keys are never fenced.
--   5. Retention: prune_idempotency_keys() deletes ONLY UUIDv7 rows whose
--      decision and key time are both older than 13 months, and ONLY while
--      the executor and the idem_begin guard are installed (otherwise it
--      deletes nothing). v4, derived and pre-086 keys are never pruned.
--      Nothing schedules it. Response purging (op_purge_responses, owner
--      only) is INACTIVE.
--   6. S1: the 68 remaining functions with search_path=public get
--      search_path=public, pg_temp (configuration only; bodies, owners and
--      grants unchanged).
--
-- GUARDS (DO blocks; production applies with --single-transaction)
--   * before: each of the 32 functions 086 depends on exists with its 085
--     body (idem_begin: 085 or 086 body), is SECURITY DEFINER and owned by
--     postgres; idempotency_keys is owned by postgres; the ledger has
--     exactly the 085 or the 086 columns; every hardened function exists
--     with search_path=public or public, pg_temp.
--   * after: the 31 untouched bodies unchanged, idem_begin = the 086 body;
--     ledger columns/constraint; every op_* function owned by postgres with
--     search_path pg_catalog, pg_temp; EXECUTE exactly authenticated on
--     op_execute/op_status and nobody else on any op_* helper; no public
--     function left with search_path=public.
--
-- ROLLBACK (doc "Rollback"): functions only + restore the 085 idem_begin
--   body (search_path kept hardened). KEEP the columns, constraint,
--   tombstones, the prune (inert without the executor) and the hardened
--   search paths. Never restore 062's prune body.
-- FORWARD RECOVERY: idempotent; re-run.
-- ============================================================

SET lock_timeout = '3s';

-- ------------------------------------------------------------
-- 0/8 preflight guard
-- ------------------------------------------------------------
DO $guard$
DECLARE
  v_expected CONSTANT jsonb := '{"public.adjust_stock(text,text,text,integer,text,text,integer,timestamp with time zone,text,uuid)":"6701ab0256abed02e34f7e20ece76c2f","public.approve_purchase_order(text,uuid)":"1730ef49f146b31afbf3eabe01adbdf7","public.approve_refund_request(text,uuid)":"acc3e5b7bfcd68a435e0f4170a508deb","public.approve_stock_transfer(text,uuid)":"5d031d2f765c888cb4c5d6fabc4329a7","public.approve_void_request(text,uuid)":"9589bac39f64059d2fb95a2b7209eeae","public.cancel_purchase_order(text,text,uuid)":"829aec95c5c3cd93e78d266b434b507e","public.cancel_stock_transfer(text,text,uuid)":"430e2f79bc6e2bade999447cd204a36a","public.close_shift(text,integer,text,timestamp with time zone,text,uuid)":"9536c7f1f2bac9e0355458bd5ad06c79","public.complete_sale(text,text,text,integer,numeric,jsonb,timestamp with time zone,uuid)":"f9844590bece7166caaf1d55f638dce3","public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)":"06d80afb8e87681f03fb3edfd3ab88bc","public.create_purchase_order(text,text,text,jsonb,uuid)":"8c43ffe84e6130072fa6c31c9475931d","public.create_refund_void_request(text,text,text,jsonb,timestamp with time zone,text,uuid)":"56ea96382d12171c9ba603fbc6fcc61e","public.create_stock_transfer(text,text,text,jsonb,uuid)":"64564f4082b58e663ba63bfe0e544674","public.create_supplier(text,text,text,text,text,text,text,uuid)":"0b2ca7e054fababe0889ab10d74774e5","public.deactivate_app_user(text,boolean,uuid)":"b335ccb5cfaad622090cfa203b6e0be4","public.delete_product(text,uuid)":"7fdbbe18860b8fcd9b5fa87d4896505d","public.dispatch_stock_transfer(text,timestamp with time zone,text,uuid)":"2e4c2edc75c391664b30415357cebf51","public.idem_begin(uuid,text,text)":"afca065fea226a0c7a5b9bb56b540a9d","public.idem_finish(uuid,jsonb)":"d832e312446dfaf2509cc0b0ccadcf28","public.log_audit_event(text,text,text,text,text,uuid)":"73b9154015ee61786243d70822c25618","public.log_receipt_reprint(text,uuid)":"11171c26d4e02db6244285b986b2536e","public.open_shift(text,integer,timestamp with time zone,text,uuid)":"97ccc663fec1150c90bda6263a46b33c","public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)":"7fe2929d412ca10d2a47ec76b956e76d","public.receive_purchase_order(text,jsonb,timestamp with time zone,text,uuid)":"d6e5ec1921f4e4d9e0b32c7ae48c589e","public.receive_stock_transfer(text,jsonb,timestamp with time zone,text,uuid)":"7bf2a3e120271787a1f2c5c21053b40b","public.record_supplier_payment(text,integer,text,text,text,timestamp with time zone,text,uuid)":"4ed0ce8e6a9c8516d73e23ef13c808eb","public.reject_refund_void_request(text,text,uuid)":"82e030f931169de811727d1e8e370967","public.reject_stock_transfer(text,text,uuid)":"b165a65897c5870cdeb5defbdd3fc2d4","public.replace_manager(text,text,uuid)":"27b10ab2731ac2fbfc52bb8b0239c379","public.update_app_user(text,text,text,text,text[],text[],uuid)":"b92eb4a6c46e6bf69316d4b6d86da4c0","public.update_supplier(text,text,text,text,text,text,text,text,boolean,uuid)":"cb422e77100c7199e1311bcd5f1b82d1","public.void_supplier_payment(text,text,uuid)":"f10dd8642eabcd9ec389e3c88678a875"}'::jsonb;
  v_idem_begin_086 CONSTANT text := '58a55436635b9ed1e8db09192c6b6e2b';
  v_harden   CONSTANT text[] := ARRAY[
    'public.adjust_stock(text,text,text,integer,text,text,integer,timestamp with time zone,text,uuid)',
    'public.app_can_for_shop(text,text)',
    'public.app_has_perm(text)',
    'public.app_org_id()',
    'public.app_org_shop_ids()',
    'public.app_org_user_ids()',
    'public.app_require_org_items(jsonb)',
    'public.app_require_org(text,text)',
    'public.app_role()',
    'public.app_seed_default_price_levels(text)',
    'public.app_setup_needed()',
    'public.app_shop_id()',
    'public.app_shop_in_org(text)',
    'public.app_storage_can_write_path(text)',
    'public.app_storage_object_in_my_org(text)',
    'public.app_storage_object_org(text)',
    'public.app_storage_owner_in_org(text,uuid)',
    'public.app_upload_session_public_url(text)',
    'public.app_user_id()',
    'public.approve_purchase_order(text,uuid)',
    'public.approve_refund_request(text,uuid)',
    'public.approve_stock_transfer(text,uuid)',
    'public.approve_void_request(text,uuid)',
    'public.attach_product_image_upload_session_token(text,text)',
    'public.bootstrap_first_admin()',
    'public.cancel_product_image_upload_session(text)',
    'public.cancel_purchase_order(text,text,uuid)',
    'public.cancel_stock_transfer(text,text,uuid)',
    'public.claim_phone_upload_token_issue(text)',
    'public.close_shift(text,integer,text,timestamp with time zone,text,uuid)',
    'public.complete_product_image_upload_session(text,text,text,integer,text)',
    'public.complete_sale(text,text,text,integer,numeric,jsonb,timestamp with time zone,uuid)',
    'public.complete_stock_transfer(text)',
    'public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)',
    'public.create_product_image_upload_session(text,text)',
    'public.create_purchase_order(text,text,text,jsonb,uuid)',
    'public.create_refund_void_request(text,text,text,jsonb,timestamp with time zone,text,uuid)',
    'public.create_stock_transfer(text,text,text,jsonb,uuid)',
    'public.create_supplier(text,text,text,text,text,text,text,uuid)',
    'public.current_app_user()',
    'public.deactivate_app_user(text,boolean,uuid)',
    'public.delete_product(text,uuid)',
    'public.dispatch_stock_transfer(text,timestamp with time zone,text,uuid)',
    'public.enforce_same_org_refs()',
    'public.ensure_inventory_rows_for_product()',
    'public.ensure_inventory_rows_for_shop()',
    'public.get_product_image_upload_session_by_token(text)',
    'public.get_product_image_upload_session_status(text)',
    'public.guard_user_privilege_columns()',
    'public.idem_begin(uuid,text,text)',
    'public.idem_finish(uuid,jsonb)',
    'public.log_audit_event(text,text,text,text,text,uuid)',
    'public.log_receipt_reprint(text,uuid)',
    'public.open_shift(text,integer,timestamp with time zone,text,uuid)',
    'public.organizations_seed_business_profile()',
    'public.organizations_seed_price_levels()',
    'public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)',
    'public.product_barcodes_set_org_id()',
    'public.receive_purchase_order(text,jsonb,timestamp with time zone,text,uuid)',
    'public.receive_stock_transfer(text,jsonb,timestamp with time zone,text,uuid)',
    'public.record_supplier_payment(text,integer,text,text,text,timestamp with time zone,text,uuid)',
    'public.reject_refund_void_request(text,text,uuid)',
    'public.reject_stock_transfer(text,text,uuid)',
    'public.replace_manager(text,text,uuid)',
    'public.set_org_id_from_caller()',
    'public.update_app_user(text,text,text,text,text[],text[],uuid)',
    'public.update_supplier(text,text,text,text,text,text,text,text,boolean,uuid)',
    'public.void_supplier_payment(text,text,uuid)']::text[];
  k text; v_md5 text; v_cols text; v_cfg text; v_secdef boolean; v_owner text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(v_expected) LOOP
    SELECT md5(prosrc), prosecdef, pg_get_userbyid(proowner) INTO v_md5, v_secdef, v_owner
      FROM pg_proc WHERE oid = to_regprocedure(k);
    IF v_md5 IS NULL THEN
      RAISE EXCEPTION '086 preflight: % does not exist', k;
    ELSIF v_md5 <> v_expected ->> k AND NOT (k = 'public.idem_begin(uuid,text,text)' AND v_md5 = v_idem_begin_086) THEN
      RAISE EXCEPTION '086 preflight: % is not the 085 body (md5 %); nothing changed', k, v_md5;
    ELSIF NOT v_secdef OR v_owner <> 'postgres' THEN
      RAISE EXCEPTION '086 preflight: % must be SECURITY DEFINER owned by postgres (secdef %, owner %)', k, v_secdef, v_owner;
    END IF;
  END LOOP;

  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.idempotency_keys'::regclass) <> 'postgres' THEN
    RAISE EXCEPTION '086 preflight: idempotency_keys must be owned by postgres';
  END IF;

  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.idempotency_keys'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols NOT IN ('actor_id,created_at,key,org_id,request_hash,response,rpc',
                    'actor_id,created_at,decided_at,key,org_id,outcome_code,outcome_message,request_hash,response,response_purged_at,rpc,state') THEN
    RAISE EXCEPTION '086 preflight: idempotency_keys has unexpected columns (%); nothing changed', v_cols;
  END IF;

  FOREACH k IN ARRAY v_harden LOOP
    SELECT coalesce(array_to_string(proconfig, ','), '<none>') INTO v_cfg FROM pg_proc WHERE oid = to_regprocedure(k);
    IF v_cfg IS NULL THEN
      RAISE EXCEPTION '086 preflight: % (search_path hardening) does not exist', k;
    ELSIF v_cfg NOT IN ('search_path=public', 'search_path=public, pg_temp') THEN
      RAISE EXCEPTION '086 preflight: % has unexpected configuration %', k, v_cfg;
    END IF;
  END LOOP;
END
$guard$;

-- ------------------------------------------------------------
-- 1/8 durable outcomes on the existing ledger
-- ------------------------------------------------------------
ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'committed',
  ADD COLUMN IF NOT EXISTS outcome_code text,
  ADD COLUMN IF NOT EXISTS outcome_message text,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS response_purged_at timestamptz;

-- Re-apply after a rollback that dropped the columns (not the documented
-- rollback): the prefix still says what each row was; the code is lost.
UPDATE public.idempotency_keys
   SET state = CASE WHEN left(request_hash, 2) = 'R:' THEN 'rejected' ELSE 'abandoned' END,
       outcome_code = coalesce(outcome_code, CASE WHEN left(request_hash, 2) = 'R:' THEN 'UNKNOWN' ELSE 'FENCED' END)
 WHERE state = 'committed' AND (left(request_hash, 2) = 'R:' OR request_hash = 'A:');

-- Pre-086 rows were decided when idem_begin inserted them (server clock).
-- The default is set AFTER this backfill so they keep that time.
UPDATE public.idempotency_keys SET decided_at = created_at WHERE decided_at IS NULL;
ALTER TABLE public.idempotency_keys
  ALTER COLUMN decided_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN decided_at SET NOT NULL;

ALTER TABLE public.idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_state_chk;
ALTER TABLE public.idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_chk CHECK (
       (state = 'committed' AND left(request_hash, 2) NOT IN ('R:', 'A:'))
    OR (state = 'rejected'  AND left(request_hash, 2) = 'R:' AND response IS NULL AND outcome_code IS NOT NULL)
    OR (state = 'abandoned' AND request_hash = 'A:'          AND response IS NULL));

CREATE INDEX IF NOT EXISTS idempotency_keys_decided_at_idx ON public.idempotency_keys (decided_at);

COMMENT ON COLUMN public.idempotency_keys.state IS
  '086: committed (idem_begin row, also every pre-086 row) | rejected (definitive refusal recorded by op_execute; request_hash R:<hash>) | abandoned (fenced by op_status; request_hash A:). Rejected/abandoned keys never execute, also through the legacy direct path.';
COMMENT ON COLUMN public.idempotency_keys.decided_at IS
  '086: server clock when the row was INSERTED (clock_timestamp()). Not the commit time. Pre-086 rows: created_at.';

-- ------------------------------------------------------------
-- 2/8 idem_begin: UUIDv7 operations only through op_execute. The 085 body
--     with exactly one added block (after the key check, before the lock).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid, p_rpc text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v record;
  v_caller_id  text;  -- 074
  v_caller_org text;  -- 074
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- 086: a UUIDv7 key (minted only by 086 clients) runs only through
  -- op_execute, which marks the one key it is executing (transaction-local;
  -- no PostgREST request can set it). create_app_user stays direct-only.
  IF (get_byte(uuid_send(p_key), 8) >> 6) = 2 AND (get_byte(uuid_send(p_key), 6) >> 4) = 7
     AND p_rpc <> 'create_app_user'
     AND current_setting('orvix.op_execute_key', true) IS DISTINCT FROM p_key::text THEN
    RAISE EXCEPTION 'OP_EXECUTOR_REQUIRED: this operation must be sent through op_execute' USING ERRCODE = '22023';
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
$function$;

-- ------------------------------------------------------------
-- 3/8 typed argument binding, key identity, refusal classification
-- ------------------------------------------------------------
-- Strict JSON types; anything else is a client error (22023
-- OP_INVALID_ARGUMENT) raised BEFORE execution and never recorded.
CREATE OR REPLACE FUNCTION public.op_bad_arg(p_name text, p_want text)
 RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
  RAISE EXCEPTION 'OP_INVALID_ARGUMENT: % must be %', p_name, p_want USING ERRCODE = '22023';
END;
$f$;

CREATE OR REPLACE FUNCTION public.op_arg_text(p_args jsonb, p_name text)
 RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v jsonb := p_args -> p_name;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'string' THEN PERFORM public.op_bad_arg(p_name, 'a string'); END IF;
  RETURN v #>> '{}';
END;
$f$;

CREATE OR REPLACE FUNCTION public.op_arg_int(p_args jsonb, p_name text)
 RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v jsonb := p_args -> p_name; n numeric;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'number' THEN PERFORM public.op_bad_arg(p_name, 'an integer'); END IF;
  n := (v #>> '{}')::numeric;
  IF n <> trunc(n) OR n < -2147483648 OR n > 2147483647 THEN PERFORM public.op_bad_arg(p_name, 'an integer'); END IF;
  RETURN n::integer;
END;
$f$;

CREATE OR REPLACE FUNCTION public.op_arg_numeric(p_args jsonb, p_name text)
 RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v jsonb := p_args -> p_name;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'number' THEN PERFORM public.op_bad_arg(p_name, 'a number'); END IF;
  RETURN (v #>> '{}')::numeric;
END;
$f$;

CREATE OR REPLACE FUNCTION public.op_arg_bool(p_args jsonb, p_name text)
 RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v jsonb := p_args -> p_name;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'boolean' THEN PERFORM public.op_bad_arg(p_name, 'a boolean'); END IF;
  RETURN (v #>> '{}')::boolean;
END;
$f$;

CREATE OR REPLACE FUNCTION public.op_arg_jsonb(p_args jsonb, p_name text)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v jsonb := p_args -> p_name;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  RETURN v;
END;
$f$;

CREATE OR REPLACE FUNCTION public.op_arg_text_array(p_args jsonb, p_name text)
 RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v jsonb := p_args -> p_name;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN
    PERFORM public.op_bad_arg(p_name, 'an array of strings');
  END IF;
  RETURN ARRAY(SELECT jsonb_array_elements_text(v));
END;
$f$;

-- STABLE: an offset-less value is parsed in the session TimeZone.
CREATE OR REPLACE FUNCTION public.op_arg_tstz(p_args jsonb, p_name text)
 RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v jsonb := p_args -> p_name;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'string' THEN PERFORM public.op_bad_arg(p_name, 'an ISO-8601 timestamp'); END IF;
  BEGIN
    RETURN (v #>> '{}')::timestamptz;
  EXCEPTION WHEN data_exception THEN
    PERFORM public.op_bad_arg(p_name, 'an ISO-8601 timestamp');
  END;
  RETURN NULL;
END;
$f$;

CREATE OR REPLACE FUNCTION public.op_arg_check(p_type text, p_args jsonb, p_name text)
 RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
  CASE p_type
    WHEN 'text' THEN PERFORM public.op_arg_text(p_args, p_name);
    WHEN 'integer' THEN PERFORM public.op_arg_int(p_args, p_name);
    WHEN 'numeric' THEN PERFORM public.op_arg_numeric(p_args, p_name);
    WHEN 'boolean' THEN PERFORM public.op_arg_bool(p_args, p_name);
    WHEN 'jsonb' THEN PERFORM public.op_arg_jsonb(p_args, p_name);
    WHEN 'text[]' THEN PERFORM public.op_arg_text_array(p_args, p_name);
    WHEN 'timestamp with time zone' THEN PERFORM public.op_arg_tstz(p_args, p_name);
    ELSE RAISE EXCEPTION 'OP_INTERNAL: unbindable type %', p_type USING ERRCODE = 'XX000';
  END CASE;
END;
$f$;

-- Key identity. Only an RFC 9562 UUIDv7 carries a time. That time is chosen
-- by the client: it is never the operation's time; it is only a bound that
-- op_execute ENFORCES (server clock) before it executes anything.
CREATE OR REPLACE FUNCTION public.op_key_version(p_key uuid)
 RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
  SELECT CASE WHEN (get_byte(uuid_send(p_key), 8) >> 6) = 2 THEN get_byte(uuid_send(p_key), 6) >> 4 END;
$f$;

CREATE OR REPLACE FUNCTION public.op_key_time(p_key uuid)
 RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
  SELECT CASE WHEN public.op_key_version(p_key) = 7
              THEN 'epoch'::timestamptz + (('x' || substr(replace(p_key::text, '-', ''), 1, 12))::bit(48)::bigint) * interval '1 millisecond' END;
$f$;

-- A v7 key executes only while its time is inside this window (server
-- clock). The PAST bound is what makes pruning safe (a pruned key is always
-- older than 13 months, so it can never execute again). The FUTURE bound
-- only tolerates till clocks running ahead: a future key time merely keeps
-- its decision longer (pruning uses the later of decision and key time).
-- Too old: a v7 key whose time is more than 12 months in the past can never
-- execute again (the bound the prune relies on).
CREATE OR REPLACE FUNCTION public.op_key_too_old(p_key uuid)
 RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $f$
  SELECT public.op_key_version(p_key) = 7 AND public.op_key_time(p_key) < now() - interval '12 months';
$f$;

CREATE OR REPLACE FUNCTION public.op_key_executable(p_key uuid)
 RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $f$
  SELECT CASE WHEN public.op_key_version(p_key) = 7
              THEN public.op_key_time(p_key) BETWEEN now() - interval '12 months' AND now() + interval '30 days'
              ELSE true END;
$f$;

-- Which failures are DEFINITIVE refusals (recorded as rejected, never
-- executed later) and which are not. An explicit, audited allow-list:
-- every RAISE in the 29 executor RPCs and the helpers/triggers they reach
-- (085), plus the named constraints those RPCs can violate as a business
-- outcome. Order matters: the not-recorded classes are tested first.
-- Anything not explicitly listed -- including every unexpected class 22 /
-- class 23 / 42501 error -- is 'unclassified' and is NOT recorded (fail
-- closed: the operation stays unresolved and a person decides).
--   rejected     definitive business or permission refusal of this request
--   dependency   a prerequisite may not have synchronised yet (another till's
--                queued operation): retrying later may legitimately succeed
--   auth         the caller's sign-in / identity, not the request
--   actor        the operation belongs to another user (055 actor stamp)
--   internal     a server defect or misconfiguration
--   idempotency  idem_begin contract markers (answered as mismatch)
--   unclassified anything else
CREATE OR REPLACE FUNCTION public.op_classify_refusal(p_sqlstate text, p_message text, p_constraint text DEFAULT NULL)
 RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE
  m text := coalesce(p_message, '');
BEGIN
  IF m LIKE 'IDEMPOTENCY\_%' THEN RETURN 'idempotency'; END IF;
  IF p_sqlstate = 'P0001' THEN
    IF m ~ '^(Not authenticated$|No app user found for this auth identity$|MFA_REQUIRED:|VERIFICATION_REQUIRED:)' THEN
      RETURN 'auth';
    END IF;
    IF m ~ '^This offline action was queued by a different user' THEN RETURN 'actor'; END IF;
    IF m ~ '^(app_require_org|enforce_same_org_refs): ' THEN RETURN 'internal'; END IF;
    IF m ~ ' not found' OR m ~ ('^(No open shift for this cashier and shop$'
                               '|Transfer cannot be received from status '
                               '|Supplier payments can only be recorded against received purchase orders$'
                               '|Purchase order is not in a receivable \(APPROVED\) status$'
                               '|This cashier already has an open shift$)') THEN
      RETURN 'dependency';
    END IF;
    IF m ~ ('^(You are not permitted |You cannot approve your own |Only an ADMIN can |Only a normal sale can be voided$'
            '|Insufficient stock |Adjustment would drive stock negative |Damage write-off must reduce stock$'
            '|Stock-in adjustments must increase stock$|Quantity change cannot be zero$'
            '|Paid amount |Payment amount |This supplier has no outstanding balance in this shop$'
            '|Purchase order is already paid$|Supplier payment is already voided$'
            '|Invalid (ordered quantity|quantity|refund amount|refund quantity|requested quantity|selected unit quantity|unit cost|unit price) for '
            '|Cart discount must be between 0 and 100$|Cart is empty$|Item discount must be between 0 and 100 for '
            '|Open Price |No active price configured for |No active price level available$|Price level .+ is not active$'
            '|Sellable unit .+ is not active for product |Unit qty must be greater than zero when a sellable unit is selected$'
            '|Received (quantity cannot be negative|quantity exceeds|unit qty must be zero or greater|items must be a JSON array)'
            '|Refund (amount exceeds|item is not part of the sale|item product is required$|quantity exceeds|request has no items$'
            '|request is not pending$|request shop does not match sale shop$)'
            '|A pending .+ request already exists for this sale$|A product appears more than once |A product unit \+ price level appears more than once '
            '|A purchase order needs at least one item$|A reason is required$|A transfer needs at least one item$|A void reason is required$'
            '|A voided sale cannot be refunded$|Cannot refund a voided sale$|Cannot remove the only manager of this shop '
            '|Cannot create cashier for a shop without an active manager\.$'
            '|Closing cash must be zero or greater$|Opening cash must be zero or greater$'
            '|Variance reason is required when closing cash does not match expected cash$|Shift is already closed$'
            '|(Shift|Shop|Supplier code|Supplier name|Supplier|Product|Purchase order|Stock transfer|Destination shop|Source shop|Open shift|Payment) is required$'
            '|Product is required for every sale item$|User id and name are required$|User name is required$'
            '|Source and destination shop must differ$|Transfer source and destination shop are the same$'
            '|Unsupported (adjustment type|audit action type|payment method|request type|supplier payment method)'
            '|Sale is not voidable$|Request is not a (refund|void) request$|Request is not pending$|Void request is not pending$'
            '|Void request shop does not match sale shop$'
            '|Purchase order cannot be (approved|canceled) from status |Transfer cannot be (approved|canceled|rejected|dispatched) from status '
            '|This user is already the manager of this shop$|(Buyer|Cashier|Manager) must be assigned to a shop\.$'
            '|Barcode product_unit_id must belong to the same product_id$)') THEN
      RETURN 'rejected';
    END IF;
    RETURN 'unclassified';
  END IF;
  IF p_sqlstate = '42501' THEN
    -- Only the two audited guard-trigger refusals (082) are definitive.
    IF m ~ '^(AUTH_ID_READ_ONLY|AUTH_ACCOUNT_NOT_LINKABLE): ' THEN RETURN 'rejected'; END IF;
    IF m ~ '^(MFA_REQUIRED|VERIFICATION_REQUIRED|OP_NOT_AUTHENTICATED)' THEN RETURN 'auth'; END IF;
    IF m ~ '^permission denied for ' THEN RETURN 'internal'; END IF;
    RETURN 'unclassified';
  END IF;
  IF left(p_sqlstate, 2) = '23' THEN
    IF p_sqlstate = '23503' THEN RETURN 'dependency'; END IF;   -- a referenced row does not exist (yet)
    -- Named constraints that encode a business outcome of these RPCs.
    IF p_constraint IN ('suppliers_unique_normalized_code_per_org',          -- duplicate supplier code
                        'purchase_orders_paid_mmk_not_over_total',           -- payment above the balance
                        'purchase_orders_paid_mmk_nonnegative',
                        'supplier_payments_amount_mmk_check') THEN
      RETURN 'rejected';
    END IF;
    IF p_constraint = 'shifts_one_open_per_cashier_shop' THEN RETURN 'dependency'; END IF;  -- a close may still be queued
    RETURN 'unclassified';
  END IF;
  RETURN 'unclassified';   -- class 22 and anything else: never recorded
END;
$f$;

-- The organisation an operation's arguments verifiably belong to (server
-- evidence, never the client's word): the first referenced row that names
-- it. NULL when it cannot be established (e.g. a provisional id).
CREATE OR REPLACE FUNCTION public.op_org_of(p_rpc text, p_args jsonb)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE
  a jsonb := coalesce(p_args, '{}'::jsonb);
  v text;
BEGIN
  IF a ->> 'p_shop_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.shops s WHERE s.id = a ->> 'p_shop_id';
  ELSIF a ->> 'p_from_shop_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.shops s WHERE s.id = a ->> 'p_from_shop_id';
  ELSIF a ->> 'p_shift_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.shifts x JOIN public.shops s ON s.id = x.shop_id WHERE x.id = a ->> 'p_shift_id';
  ELSIF a ->> 'p_purchase_order_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.purchase_orders x JOIN public.shops s ON s.id = x.shop_id WHERE x.id = a ->> 'p_purchase_order_id';
  ELSIF a ->> 'p_transfer_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.stock_transfers x JOIN public.shops s ON s.id = x.from_shop_id WHERE x.id = a ->> 'p_transfer_id';
  ELSIF a ->> 'p_sale_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.sales x JOIN public.shops s ON s.id = x.shop_id WHERE x.id = a ->> 'p_sale_id';
  ELSIF a ->> 'p_request_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.refund_void_requests x JOIN public.shops s ON s.id = x.shop_id WHERE x.id = a ->> 'p_request_id';
  ELSIF a ->> 'p_payment_id' IS NOT NULL THEN
    SELECT s.org_id INTO v FROM public.supplier_payments x JOIN public.shops s ON s.id = x.shop_id WHERE x.id = a ->> 'p_payment_id';
  ELSIF a ->> 'p_supplier_id' IS NOT NULL THEN
    SELECT x.org_id INTO v FROM public.suppliers x WHERE x.id = a ->> 'p_supplier_id';
  ELSIF a ->> 'p_product_id' IS NOT NULL THEN
    SELECT x.org_id INTO v FROM public.products x WHERE x.id = a ->> 'p_product_id';
  ELSIF p_rpc IN ('update_app_user', 'deactivate_app_user') AND a ->> 'p_id' IS NOT NULL THEN
    SELECT x.org_id INTO v FROM public.users x WHERE x.id = a ->> 'p_id';
  ELSIF p_rpc = 'update_supplier' AND a ->> 'p_id' IS NOT NULL THEN
    SELECT x.org_id INTO v FROM public.suppliers x WHERE x.id = a ->> 'p_id';
  END IF;
  RETURN v;
END;
$f$;

-- ------------------------------------------------------------
-- 4/8 static dispatch (generated once from the 085 catalog; every RPC's own
--     v_idem_hash is md5(jsonb_build_object(<all parameters except
--     p_created_at and p_idempotency_key>)::text) -- verified per RPC)
-- ------------------------------------------------------------
-- Allow-list: 29 RPCs.
CREATE OR REPLACE FUNCTION public.op_spec(p_rpc text, OUT v_names text[], OUT v_types text[], OUT v_required text[])
 LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
  CASE p_rpc
    WHEN 'adjust_stock' THEN
      v_names := ARRAY['p_shop_id','p_product_id','p_adjustment_type','p_quantity_delta','p_reason','p_product_unit_id','p_unit_qty','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','text','text','integer','text','text','integer','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_shop_id','p_product_id','p_adjustment_type','p_quantity_delta','p_reason']::text[];
    WHEN 'approve_purchase_order' THEN
      v_names := ARRAY['p_purchase_order_id']::text[];
      v_types := ARRAY['text']::text[];
      v_required := ARRAY['p_purchase_order_id']::text[];
    WHEN 'approve_refund_request' THEN
      v_names := ARRAY['p_request_id']::text[];
      v_types := ARRAY['text']::text[];
      v_required := ARRAY['p_request_id']::text[];
    WHEN 'approve_stock_transfer' THEN
      v_names := ARRAY['p_transfer_id']::text[];
      v_types := ARRAY['text']::text[];
      v_required := ARRAY['p_transfer_id']::text[];
    WHEN 'approve_void_request' THEN
      v_names := ARRAY['p_request_id']::text[];
      v_types := ARRAY['text']::text[];
      v_required := ARRAY['p_request_id']::text[];
    WHEN 'cancel_purchase_order' THEN
      v_names := ARRAY['p_purchase_order_id','p_reason']::text[];
      v_types := ARRAY['text','text']::text[];
      v_required := ARRAY['p_purchase_order_id']::text[];
    WHEN 'cancel_stock_transfer' THEN
      v_names := ARRAY['p_transfer_id','p_reason']::text[];
      v_types := ARRAY['text','text']::text[];
      v_required := ARRAY['p_transfer_id']::text[];
    WHEN 'close_shift' THEN
      v_names := ARRAY['p_shift_id','p_closing_cash_mmk','p_variance_reason','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','integer','text','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_shift_id','p_closing_cash_mmk']::text[];
    WHEN 'complete_sale' THEN
      v_names := ARRAY['p_shop_id','p_shift_id','p_payment_method','p_paid_mmk','p_cart_discount_pct','p_items','p_created_at']::text[];
      v_types := ARRAY['text','text','text','integer','numeric','jsonb','timestamp with time zone']::text[];
      v_required := ARRAY['p_shop_id','p_shift_id','p_payment_method','p_paid_mmk','p_cart_discount_pct','p_items']::text[];
    WHEN 'create_purchase_order' THEN
      v_names := ARRAY['p_shop_id','p_supplier_id','p_notes','p_items']::text[];
      v_types := ARRAY['text','text','text','jsonb']::text[];
      v_required := ARRAY['p_shop_id','p_supplier_id','p_notes','p_items']::text[];
    WHEN 'create_refund_void_request' THEN
      v_names := ARRAY['p_sale_id','p_type','p_reason','p_items','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','text','text','jsonb','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_sale_id','p_type','p_reason']::text[];
    WHEN 'create_stock_transfer' THEN
      v_names := ARRAY['p_from_shop_id','p_to_shop_id','p_notes','p_items']::text[];
      v_types := ARRAY['text','text','text','jsonb']::text[];
      v_required := ARRAY['p_from_shop_id','p_to_shop_id','p_notes','p_items']::text[];
    WHEN 'create_supplier' THEN
      v_names := ARRAY['p_code','p_name','p_contact_person','p_phone','p_email','p_address','p_notes']::text[];
      v_types := ARRAY['text','text','text','text','text','text','text']::text[];
      v_required := ARRAY['p_code','p_name']::text[];
    WHEN 'deactivate_app_user' THEN
      v_names := ARRAY['p_id','p_is_active']::text[];
      v_types := ARRAY['text','boolean']::text[];
      v_required := ARRAY['p_id','p_is_active']::text[];
    WHEN 'delete_product' THEN
      v_names := ARRAY['p_product_id']::text[];
      v_types := ARRAY['text']::text[];
      v_required := ARRAY['p_product_id']::text[];
    WHEN 'dispatch_stock_transfer' THEN
      v_names := ARRAY['p_transfer_id','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_transfer_id']::text[];
    WHEN 'log_audit_event' THEN
      v_names := ARRAY['p_action_type','p_message','p_entity_type','p_entity_id','p_shop_id']::text[];
      v_types := ARRAY['text','text','text','text','text']::text[];
      v_required := ARRAY['p_action_type','p_message','p_entity_type','p_entity_id']::text[];
    WHEN 'log_receipt_reprint' THEN
      v_names := ARRAY['p_sale_id']::text[];
      v_types := ARRAY['text']::text[];
      v_required := ARRAY['p_sale_id']::text[];
    WHEN 'open_shift' THEN
      v_names := ARRAY['p_shop_id','p_opening_cash_mmk','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','integer','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_shop_id','p_opening_cash_mmk']::text[];
    WHEN 'pay_supplier_lump_sum' THEN
      v_names := ARRAY['p_supplier_id','p_shop_id','p_amount_mmk','p_payment_method','p_reference_no','p_notes']::text[];
      v_types := ARRAY['text','text','integer','text','text','text']::text[];
      v_required := ARRAY['p_supplier_id','p_shop_id','p_amount_mmk','p_payment_method']::text[];
    WHEN 'receive_purchase_order' THEN
      v_names := ARRAY['p_purchase_order_id','p_received_items','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','jsonb','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_purchase_order_id']::text[];
    WHEN 'receive_stock_transfer' THEN
      v_names := ARRAY['p_transfer_id','p_received_items','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','jsonb','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_transfer_id']::text[];
    WHEN 'record_supplier_payment' THEN
      v_names := ARRAY['p_purchase_order_id','p_amount_mmk','p_payment_method','p_reference_no','p_notes','p_created_at','p_expected_actor_id']::text[];
      v_types := ARRAY['text','integer','text','text','text','timestamp with time zone','text']::text[];
      v_required := ARRAY['p_purchase_order_id','p_amount_mmk','p_payment_method']::text[];
    WHEN 'reject_refund_void_request' THEN
      v_names := ARRAY['p_request_id','p_reason']::text[];
      v_types := ARRAY['text','text']::text[];
      v_required := ARRAY['p_request_id']::text[];
    WHEN 'reject_stock_transfer' THEN
      v_names := ARRAY['p_transfer_id','p_reason']::text[];
      v_types := ARRAY['text','text']::text[];
      v_required := ARRAY['p_transfer_id']::text[];
    WHEN 'replace_manager' THEN
      v_names := ARRAY['p_shop_id','p_new_manager_id']::text[];
      v_types := ARRAY['text','text']::text[];
      v_required := ARRAY['p_shop_id','p_new_manager_id']::text[];
    WHEN 'update_app_user' THEN
      v_names := ARRAY['p_id','p_name','p_role','p_shop_id','p_granted_permissions','p_revoked_permissions']::text[];
      v_types := ARRAY['text','text','text','text','text[]','text[]']::text[];
      v_required := ARRAY['p_id','p_name','p_role','p_shop_id']::text[];
    WHEN 'update_supplier' THEN
      v_names := ARRAY['p_id','p_code','p_name','p_contact_person','p_phone','p_email','p_address','p_notes','p_is_active']::text[];
      v_types := ARRAY['text','text','text','text','text','text','text','text','boolean']::text[];
      v_required := ARRAY['p_id','p_code','p_name']::text[];
    WHEN 'void_supplier_payment' THEN
      v_names := ARRAY['p_payment_id','p_reason']::text[];
      v_types := ARRAY['text','text']::text[];
      v_required := ARRAY['p_payment_id','p_reason']::text[];
    ELSE v_names := NULL; v_types := NULL; v_required := NULL;
  END CASE;
END;
$f$;

-- The RPC's own signature (for the EXECUTE-privilege parity check).
CREATE OR REPLACE FUNCTION public.op_rpc_signature(p_rpc text)
 RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
  CASE p_rpc
    WHEN 'adjust_stock' THEN RETURN 'public.adjust_stock(text,text,text,integer,text,text,integer,timestamp with time zone,text,uuid)';
    WHEN 'approve_purchase_order' THEN RETURN 'public.approve_purchase_order(text,uuid)';
    WHEN 'approve_refund_request' THEN RETURN 'public.approve_refund_request(text,uuid)';
    WHEN 'approve_stock_transfer' THEN RETURN 'public.approve_stock_transfer(text,uuid)';
    WHEN 'approve_void_request' THEN RETURN 'public.approve_void_request(text,uuid)';
    WHEN 'cancel_purchase_order' THEN RETURN 'public.cancel_purchase_order(text,text,uuid)';
    WHEN 'cancel_stock_transfer' THEN RETURN 'public.cancel_stock_transfer(text,text,uuid)';
    WHEN 'close_shift' THEN RETURN 'public.close_shift(text,integer,text,timestamp with time zone,text,uuid)';
    WHEN 'complete_sale' THEN RETURN 'public.complete_sale(text,text,text,integer,numeric,jsonb,timestamp with time zone,uuid)';
    WHEN 'create_purchase_order' THEN RETURN 'public.create_purchase_order(text,text,text,jsonb,uuid)';
    WHEN 'create_refund_void_request' THEN RETURN 'public.create_refund_void_request(text,text,text,jsonb,timestamp with time zone,text,uuid)';
    WHEN 'create_stock_transfer' THEN RETURN 'public.create_stock_transfer(text,text,text,jsonb,uuid)';
    WHEN 'create_supplier' THEN RETURN 'public.create_supplier(text,text,text,text,text,text,text,uuid)';
    WHEN 'deactivate_app_user' THEN RETURN 'public.deactivate_app_user(text,boolean,uuid)';
    WHEN 'delete_product' THEN RETURN 'public.delete_product(text,uuid)';
    WHEN 'dispatch_stock_transfer' THEN RETURN 'public.dispatch_stock_transfer(text,timestamp with time zone,text,uuid)';
    WHEN 'log_audit_event' THEN RETURN 'public.log_audit_event(text,text,text,text,text,uuid)';
    WHEN 'log_receipt_reprint' THEN RETURN 'public.log_receipt_reprint(text,uuid)';
    WHEN 'open_shift' THEN RETURN 'public.open_shift(text,integer,timestamp with time zone,text,uuid)';
    WHEN 'pay_supplier_lump_sum' THEN RETURN 'public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)';
    WHEN 'receive_purchase_order' THEN RETURN 'public.receive_purchase_order(text,jsonb,timestamp with time zone,text,uuid)';
    WHEN 'receive_stock_transfer' THEN RETURN 'public.receive_stock_transfer(text,jsonb,timestamp with time zone,text,uuid)';
    WHEN 'record_supplier_payment' THEN RETURN 'public.record_supplier_payment(text,integer,text,text,text,timestamp with time zone,text,uuid)';
    WHEN 'reject_refund_void_request' THEN RETURN 'public.reject_refund_void_request(text,text,uuid)';
    WHEN 'reject_stock_transfer' THEN RETURN 'public.reject_stock_transfer(text,text,uuid)';
    WHEN 'replace_manager' THEN RETURN 'public.replace_manager(text,text,uuid)';
    WHEN 'update_app_user' THEN RETURN 'public.update_app_user(text,text,text,text,text[],text[],uuid)';
    WHEN 'update_supplier' THEN RETURN 'public.update_supplier(text,text,text,text,text,text,text,text,boolean,uuid)';
    WHEN 'void_supplier_payment' THEN RETURN 'public.void_supplier_payment(text,text,uuid)';
    ELSE RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023';
  END CASE;
END;
$f$;

-- The RPC's own request hash, computed from the typed arguments.
CREATE OR REPLACE FUNCTION public.op_request_hash(p_rpc text, p_args jsonb)
 RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v_hash text;
BEGIN
  CASE p_rpc
    WHEN 'adjust_stock' THEN v_hash := md5(jsonb_build_object('p_shop_id', public.op_arg_text(p_args, 'p_shop_id'), 'p_product_id', public.op_arg_text(p_args, 'p_product_id'), 'p_adjustment_type', public.op_arg_text(p_args, 'p_adjustment_type'), 'p_quantity_delta', public.op_arg_int(p_args, 'p_quantity_delta'), 'p_reason', public.op_arg_text(p_args, 'p_reason'), 'p_product_unit_id', public.op_arg_text(p_args, 'p_product_unit_id'), 'p_unit_qty', public.op_arg_int(p_args, 'p_unit_qty'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'approve_purchase_order' THEN v_hash := md5(jsonb_build_object('p_purchase_order_id', public.op_arg_text(p_args, 'p_purchase_order_id'))::text);
    WHEN 'approve_refund_request' THEN v_hash := md5(jsonb_build_object('p_request_id', public.op_arg_text(p_args, 'p_request_id'))::text);
    WHEN 'approve_stock_transfer' THEN v_hash := md5(jsonb_build_object('p_transfer_id', public.op_arg_text(p_args, 'p_transfer_id'))::text);
    WHEN 'approve_void_request' THEN v_hash := md5(jsonb_build_object('p_request_id', public.op_arg_text(p_args, 'p_request_id'))::text);
    WHEN 'cancel_purchase_order' THEN v_hash := md5(jsonb_build_object('p_purchase_order_id', public.op_arg_text(p_args, 'p_purchase_order_id'), 'p_reason', public.op_arg_text(p_args, 'p_reason'))::text);
    WHEN 'cancel_stock_transfer' THEN v_hash := md5(jsonb_build_object('p_transfer_id', public.op_arg_text(p_args, 'p_transfer_id'), 'p_reason', public.op_arg_text(p_args, 'p_reason'))::text);
    WHEN 'close_shift' THEN v_hash := md5(jsonb_build_object('p_shift_id', public.op_arg_text(p_args, 'p_shift_id'), 'p_closing_cash_mmk', public.op_arg_int(p_args, 'p_closing_cash_mmk'), 'p_variance_reason', public.op_arg_text(p_args, 'p_variance_reason'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'complete_sale' THEN v_hash := md5(jsonb_build_object('p_shop_id', public.op_arg_text(p_args, 'p_shop_id'), 'p_shift_id', public.op_arg_text(p_args, 'p_shift_id'), 'p_payment_method', public.op_arg_text(p_args, 'p_payment_method'), 'p_paid_mmk', public.op_arg_int(p_args, 'p_paid_mmk'), 'p_cart_discount_pct', public.op_arg_numeric(p_args, 'p_cart_discount_pct'), 'p_items', public.op_arg_jsonb(p_args, 'p_items'))::text);
    WHEN 'create_purchase_order' THEN v_hash := md5(jsonb_build_object('p_shop_id', public.op_arg_text(p_args, 'p_shop_id'), 'p_supplier_id', public.op_arg_text(p_args, 'p_supplier_id'), 'p_notes', public.op_arg_text(p_args, 'p_notes'), 'p_items', public.op_arg_jsonb(p_args, 'p_items'))::text);
    WHEN 'create_refund_void_request' THEN v_hash := md5(jsonb_build_object('p_sale_id', public.op_arg_text(p_args, 'p_sale_id'), 'p_type', public.op_arg_text(p_args, 'p_type'), 'p_reason', public.op_arg_text(p_args, 'p_reason'), 'p_items', public.op_arg_jsonb(p_args, 'p_items'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'create_stock_transfer' THEN v_hash := md5(jsonb_build_object('p_from_shop_id', public.op_arg_text(p_args, 'p_from_shop_id'), 'p_to_shop_id', public.op_arg_text(p_args, 'p_to_shop_id'), 'p_notes', public.op_arg_text(p_args, 'p_notes'), 'p_items', public.op_arg_jsonb(p_args, 'p_items'))::text);
    WHEN 'create_supplier' THEN v_hash := md5(jsonb_build_object('p_code', public.op_arg_text(p_args, 'p_code'), 'p_name', public.op_arg_text(p_args, 'p_name'), 'p_contact_person', public.op_arg_text(p_args, 'p_contact_person'), 'p_phone', public.op_arg_text(p_args, 'p_phone'), 'p_email', public.op_arg_text(p_args, 'p_email'), 'p_address', public.op_arg_text(p_args, 'p_address'), 'p_notes', public.op_arg_text(p_args, 'p_notes'))::text);
    WHEN 'deactivate_app_user' THEN v_hash := md5(jsonb_build_object('p_id', public.op_arg_text(p_args, 'p_id'), 'p_is_active', public.op_arg_bool(p_args, 'p_is_active'))::text);
    WHEN 'delete_product' THEN v_hash := md5(jsonb_build_object('p_product_id', public.op_arg_text(p_args, 'p_product_id'))::text);
    WHEN 'dispatch_stock_transfer' THEN v_hash := md5(jsonb_build_object('p_transfer_id', public.op_arg_text(p_args, 'p_transfer_id'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'log_audit_event' THEN v_hash := md5(jsonb_build_object('p_action_type', public.op_arg_text(p_args, 'p_action_type'), 'p_message', public.op_arg_text(p_args, 'p_message'), 'p_entity_type', public.op_arg_text(p_args, 'p_entity_type'), 'p_entity_id', public.op_arg_text(p_args, 'p_entity_id'), 'p_shop_id', public.op_arg_text(p_args, 'p_shop_id'))::text);
    WHEN 'log_receipt_reprint' THEN v_hash := md5(jsonb_build_object('p_sale_id', public.op_arg_text(p_args, 'p_sale_id'))::text);
    WHEN 'open_shift' THEN v_hash := md5(jsonb_build_object('p_shop_id', public.op_arg_text(p_args, 'p_shop_id'), 'p_opening_cash_mmk', public.op_arg_int(p_args, 'p_opening_cash_mmk'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'pay_supplier_lump_sum' THEN v_hash := md5(jsonb_build_object('p_supplier_id', public.op_arg_text(p_args, 'p_supplier_id'), 'p_shop_id', public.op_arg_text(p_args, 'p_shop_id'), 'p_amount_mmk', public.op_arg_int(p_args, 'p_amount_mmk'), 'p_payment_method', public.op_arg_text(p_args, 'p_payment_method'), 'p_reference_no', public.op_arg_text(p_args, 'p_reference_no'), 'p_notes', public.op_arg_text(p_args, 'p_notes'))::text);
    WHEN 'receive_purchase_order' THEN v_hash := md5(jsonb_build_object('p_purchase_order_id', public.op_arg_text(p_args, 'p_purchase_order_id'), 'p_received_items', public.op_arg_jsonb(p_args, 'p_received_items'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'receive_stock_transfer' THEN v_hash := md5(jsonb_build_object('p_transfer_id', public.op_arg_text(p_args, 'p_transfer_id'), 'p_received_items', public.op_arg_jsonb(p_args, 'p_received_items'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'record_supplier_payment' THEN v_hash := md5(jsonb_build_object('p_purchase_order_id', public.op_arg_text(p_args, 'p_purchase_order_id'), 'p_amount_mmk', public.op_arg_int(p_args, 'p_amount_mmk'), 'p_payment_method', public.op_arg_text(p_args, 'p_payment_method'), 'p_reference_no', public.op_arg_text(p_args, 'p_reference_no'), 'p_notes', public.op_arg_text(p_args, 'p_notes'), 'p_expected_actor_id', public.op_arg_text(p_args, 'p_expected_actor_id'))::text);
    WHEN 'reject_refund_void_request' THEN v_hash := md5(jsonb_build_object('p_request_id', public.op_arg_text(p_args, 'p_request_id'), 'p_reason', public.op_arg_text(p_args, 'p_reason'))::text);
    WHEN 'reject_stock_transfer' THEN v_hash := md5(jsonb_build_object('p_transfer_id', public.op_arg_text(p_args, 'p_transfer_id'), 'p_reason', public.op_arg_text(p_args, 'p_reason'))::text);
    WHEN 'replace_manager' THEN v_hash := md5(jsonb_build_object('p_shop_id', public.op_arg_text(p_args, 'p_shop_id'), 'p_new_manager_id', public.op_arg_text(p_args, 'p_new_manager_id'))::text);
    WHEN 'update_app_user' THEN v_hash := md5(jsonb_build_object('p_id', public.op_arg_text(p_args, 'p_id'), 'p_name', public.op_arg_text(p_args, 'p_name'), 'p_role', public.op_arg_text(p_args, 'p_role'), 'p_shop_id', public.op_arg_text(p_args, 'p_shop_id'), 'p_granted_permissions', public.op_arg_text_array(p_args, 'p_granted_permissions'), 'p_revoked_permissions', public.op_arg_text_array(p_args, 'p_revoked_permissions'))::text);
    WHEN 'update_supplier' THEN v_hash := md5(jsonb_build_object('p_id', public.op_arg_text(p_args, 'p_id'), 'p_code', public.op_arg_text(p_args, 'p_code'), 'p_name', public.op_arg_text(p_args, 'p_name'), 'p_contact_person', public.op_arg_text(p_args, 'p_contact_person'), 'p_phone', public.op_arg_text(p_args, 'p_phone'), 'p_email', public.op_arg_text(p_args, 'p_email'), 'p_address', public.op_arg_text(p_args, 'p_address'), 'p_notes', public.op_arg_text(p_args, 'p_notes'), 'p_is_active', public.op_arg_bool(p_args, 'p_is_active'))::text);
    WHEN 'void_supplier_payment' THEN v_hash := md5(jsonb_build_object('p_payment_id', public.op_arg_text(p_args, 'p_payment_id'), 'p_reason', public.op_arg_text(p_args, 'p_reason'))::text);
    ELSE RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023';
  END CASE;
  RETURN v_hash;
END;
$f$;

-- Invoker: runs as op_execute's owner, inside op_execute's savepoint.
CREATE OR REPLACE FUNCTION public.op_dispatch(p_key uuid, p_rpc text, p_args jsonb)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v_resp jsonb;
BEGIN
  CASE p_rpc
    WHEN 'adjust_stock' THEN
      v_resp := public.adjust_stock(
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_product_id => public.op_arg_text(p_args, 'p_product_id'),
          p_adjustment_type => public.op_arg_text(p_args, 'p_adjustment_type'),
          p_quantity_delta => public.op_arg_int(p_args, 'p_quantity_delta'),
          p_reason => public.op_arg_text(p_args, 'p_reason'),
          p_product_unit_id => public.op_arg_text(p_args, 'p_product_unit_id'),
          p_unit_qty => public.op_arg_int(p_args, 'p_unit_qty'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'approve_purchase_order' THEN
      v_resp := public.approve_purchase_order(
          p_purchase_order_id => public.op_arg_text(p_args, 'p_purchase_order_id'),
          p_idempotency_key => p_key);
    WHEN 'approve_refund_request' THEN
      v_resp := public.approve_refund_request(
          p_request_id => public.op_arg_text(p_args, 'p_request_id'),
          p_idempotency_key => p_key);
    WHEN 'approve_stock_transfer' THEN
      v_resp := public.approve_stock_transfer(
          p_transfer_id => public.op_arg_text(p_args, 'p_transfer_id'),
          p_idempotency_key => p_key);
    WHEN 'approve_void_request' THEN
      v_resp := public.approve_void_request(
          p_request_id => public.op_arg_text(p_args, 'p_request_id'),
          p_idempotency_key => p_key);
    WHEN 'cancel_purchase_order' THEN
      v_resp := public.cancel_purchase_order(
          p_purchase_order_id => public.op_arg_text(p_args, 'p_purchase_order_id'),
          p_reason => public.op_arg_text(p_args, 'p_reason'),
          p_idempotency_key => p_key);
    WHEN 'cancel_stock_transfer' THEN
      v_resp := public.cancel_stock_transfer(
          p_transfer_id => public.op_arg_text(p_args, 'p_transfer_id'),
          p_reason => public.op_arg_text(p_args, 'p_reason'),
          p_idempotency_key => p_key);
    WHEN 'close_shift' THEN
      v_resp := public.close_shift(
          p_shift_id => public.op_arg_text(p_args, 'p_shift_id'),
          p_closing_cash_mmk => public.op_arg_int(p_args, 'p_closing_cash_mmk'),
          p_variance_reason => public.op_arg_text(p_args, 'p_variance_reason'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'complete_sale' THEN
      v_resp := public.complete_sale(
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_shift_id => public.op_arg_text(p_args, 'p_shift_id'),
          p_payment_method => public.op_arg_text(p_args, 'p_payment_method'),
          p_paid_mmk => public.op_arg_int(p_args, 'p_paid_mmk'),
          p_cart_discount_pct => public.op_arg_numeric(p_args, 'p_cart_discount_pct'),
          p_items => public.op_arg_jsonb(p_args, 'p_items'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_idempotency_key => p_key);
    WHEN 'create_purchase_order' THEN
      v_resp := public.create_purchase_order(
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_supplier_id => public.op_arg_text(p_args, 'p_supplier_id'),
          p_notes => public.op_arg_text(p_args, 'p_notes'),
          p_items => public.op_arg_jsonb(p_args, 'p_items'),
          p_idempotency_key => p_key);
    WHEN 'create_refund_void_request' THEN
      v_resp := public.create_refund_void_request(
          p_sale_id => public.op_arg_text(p_args, 'p_sale_id'),
          p_type => public.op_arg_text(p_args, 'p_type'),
          p_reason => public.op_arg_text(p_args, 'p_reason'),
          p_items => public.op_arg_jsonb(p_args, 'p_items'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'create_stock_transfer' THEN
      v_resp := public.create_stock_transfer(
          p_from_shop_id => public.op_arg_text(p_args, 'p_from_shop_id'),
          p_to_shop_id => public.op_arg_text(p_args, 'p_to_shop_id'),
          p_notes => public.op_arg_text(p_args, 'p_notes'),
          p_items => public.op_arg_jsonb(p_args, 'p_items'),
          p_idempotency_key => p_key);
    WHEN 'create_supplier' THEN
      v_resp := public.create_supplier(
          p_code => public.op_arg_text(p_args, 'p_code'),
          p_name => public.op_arg_text(p_args, 'p_name'),
          p_contact_person => public.op_arg_text(p_args, 'p_contact_person'),
          p_phone => public.op_arg_text(p_args, 'p_phone'),
          p_email => public.op_arg_text(p_args, 'p_email'),
          p_address => public.op_arg_text(p_args, 'p_address'),
          p_notes => public.op_arg_text(p_args, 'p_notes'),
          p_idempotency_key => p_key);
    WHEN 'deactivate_app_user' THEN
      v_resp := public.deactivate_app_user(
          p_id => public.op_arg_text(p_args, 'p_id'),
          p_is_active => public.op_arg_bool(p_args, 'p_is_active'),
          p_idempotency_key => p_key);
    WHEN 'delete_product' THEN
      v_resp := public.delete_product(
          p_product_id => public.op_arg_text(p_args, 'p_product_id'),
          p_idempotency_key => p_key);
    WHEN 'dispatch_stock_transfer' THEN
      v_resp := public.dispatch_stock_transfer(
          p_transfer_id => public.op_arg_text(p_args, 'p_transfer_id'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'log_audit_event' THEN
      v_resp := public.log_audit_event(
          p_action_type => public.op_arg_text(p_args, 'p_action_type'),
          p_message => public.op_arg_text(p_args, 'p_message'),
          p_entity_type => public.op_arg_text(p_args, 'p_entity_type'),
          p_entity_id => public.op_arg_text(p_args, 'p_entity_id'),
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_idempotency_key => p_key);
    WHEN 'log_receipt_reprint' THEN
      v_resp := public.log_receipt_reprint(
          p_sale_id => public.op_arg_text(p_args, 'p_sale_id'),
          p_idempotency_key => p_key);
    WHEN 'open_shift' THEN
      v_resp := public.open_shift(
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_opening_cash_mmk => public.op_arg_int(p_args, 'p_opening_cash_mmk'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'pay_supplier_lump_sum' THEN
      v_resp := public.pay_supplier_lump_sum(
          p_supplier_id => public.op_arg_text(p_args, 'p_supplier_id'),
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_amount_mmk => public.op_arg_int(p_args, 'p_amount_mmk'),
          p_payment_method => public.op_arg_text(p_args, 'p_payment_method'),
          p_reference_no => public.op_arg_text(p_args, 'p_reference_no'),
          p_notes => public.op_arg_text(p_args, 'p_notes'),
          p_idempotency_key => p_key);
    WHEN 'receive_purchase_order' THEN
      v_resp := public.receive_purchase_order(
          p_purchase_order_id => public.op_arg_text(p_args, 'p_purchase_order_id'),
          p_received_items => public.op_arg_jsonb(p_args, 'p_received_items'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'receive_stock_transfer' THEN
      v_resp := public.receive_stock_transfer(
          p_transfer_id => public.op_arg_text(p_args, 'p_transfer_id'),
          p_received_items => public.op_arg_jsonb(p_args, 'p_received_items'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'record_supplier_payment' THEN
      v_resp := public.record_supplier_payment(
          p_purchase_order_id => public.op_arg_text(p_args, 'p_purchase_order_id'),
          p_amount_mmk => public.op_arg_int(p_args, 'p_amount_mmk'),
          p_payment_method => public.op_arg_text(p_args, 'p_payment_method'),
          p_reference_no => public.op_arg_text(p_args, 'p_reference_no'),
          p_notes => public.op_arg_text(p_args, 'p_notes'),
          p_created_at => public.op_arg_tstz(p_args, 'p_created_at'),
          p_expected_actor_id => public.op_arg_text(p_args, 'p_expected_actor_id'),
          p_idempotency_key => p_key);
    WHEN 'reject_refund_void_request' THEN
      v_resp := public.reject_refund_void_request(
          p_request_id => public.op_arg_text(p_args, 'p_request_id'),
          p_reason => public.op_arg_text(p_args, 'p_reason'),
          p_idempotency_key => p_key);
    WHEN 'reject_stock_transfer' THEN
      v_resp := public.reject_stock_transfer(
          p_transfer_id => public.op_arg_text(p_args, 'p_transfer_id'),
          p_reason => public.op_arg_text(p_args, 'p_reason'),
          p_idempotency_key => p_key);
    WHEN 'replace_manager' THEN
      v_resp := public.replace_manager(
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_new_manager_id => public.op_arg_text(p_args, 'p_new_manager_id'),
          p_idempotency_key => p_key);
    WHEN 'update_app_user' THEN
      v_resp := public.update_app_user(
          p_id => public.op_arg_text(p_args, 'p_id'),
          p_name => public.op_arg_text(p_args, 'p_name'),
          p_role => public.op_arg_text(p_args, 'p_role'),
          p_shop_id => public.op_arg_text(p_args, 'p_shop_id'),
          p_granted_permissions => public.op_arg_text_array(p_args, 'p_granted_permissions'),
          p_revoked_permissions => public.op_arg_text_array(p_args, 'p_revoked_permissions'),
          p_idempotency_key => p_key);
    WHEN 'update_supplier' THEN
      v_resp := public.update_supplier(
          p_id => public.op_arg_text(p_args, 'p_id'),
          p_code => public.op_arg_text(p_args, 'p_code'),
          p_name => public.op_arg_text(p_args, 'p_name'),
          p_contact_person => public.op_arg_text(p_args, 'p_contact_person'),
          p_phone => public.op_arg_text(p_args, 'p_phone'),
          p_email => public.op_arg_text(p_args, 'p_email'),
          p_address => public.op_arg_text(p_args, 'p_address'),
          p_notes => public.op_arg_text(p_args, 'p_notes'),
          p_is_active => public.op_arg_bool(p_args, 'p_is_active'),
          p_idempotency_key => p_key);
    WHEN 'void_supplier_payment' THEN
      v_resp := public.void_supplier_payment(
          p_payment_id => public.op_arg_text(p_args, 'p_payment_id'),
          p_reason => public.op_arg_text(p_args, 'p_reason'),
          p_idempotency_key => p_key);
    ELSE RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023';
  END CASE;
  RETURN v_resp;
END;
$f$;

-- ------------------------------------------------------------
-- 5/8 caller, executor, status lookup + fence
-- ------------------------------------------------------------
-- The caller: an active app user in an organization, from the request JWT
-- (auth.uid() is unaffected by SECURITY DEFINER). The role is the
-- server-side users.role.
CREATE OR REPLACE FUNCTION public.op_caller(OUT v_actor text, OUT v_org text, OUT v_role text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
  SELECT u.id, u.org_id, upper(u.role) INTO v_actor, v_org, v_role
    FROM public.users u WHERE u.auth_id = auth.uid() AND u.is_active LIMIT 1;
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'OP_NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;
END;
$f$;

-- May the caller see/resolve operations of other users in their own org?
-- ADMIN (server role), or an explicit 'sync:resolve' grant. MANAGER does
-- not get it by default.
CREATE OR REPLACE FUNCTION public.op_may_resolve(p_role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  SELECT p_role = 'ADMIN' OR public.app_has_perm('sync:resolve');
$f$;

DROP FUNCTION IF EXISTS public.op_execute(uuid, text, jsonb);   -- an earlier candidate signature
CREATE OR REPLACE FUNCTION public.op_execute(p_key uuid, p_rpc text, p_args jsonb, p_actor_id text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_actor text; v_org text; v_role text;
  v_names text[]; v_types text[]; v_required text[];
  k text; i integer;
  v_hash text;
  v_row public.idempotency_keys%ROWTYPE;
  v_may_see boolean;
  v_resp jsonb;
  v_state text; v_msg text; v_detail text; v_constraint text; v_class text;
BEGIN
  -- 1. Caller, and the operation's own actor. An operation is executed ONLY
  --    in its creator's session: a queue drained by another user never runs
  --    it (and so can never be refused for good because of who drained it).
  SELECT c.v_actor, c.v_org, c.v_role INTO v_actor, v_org, v_role FROM public.op_caller() c;
  IF p_key IS NULL THEN RAISE EXCEPTION 'OP_KEY_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'OP_ACTOR_MISMATCH: this operation belongs to another user' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL AND public.op_key_version(p_key) = 7 THEN
    RAISE EXCEPTION 'OP_ACTOR_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- 2. Request shape, checked BEFORE anything executes or is recorded.
  SELECT s.v_names, s.v_types, s.v_required INTO v_names, v_types, v_required FROM public.op_spec(p_rpc) s;
  IF v_names IS NULL THEN RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023'; END IF;
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'OP_INVALID_ARGUMENTS: an object is required' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_args) LOOP
    IF NOT k = ANY (v_names) THEN   -- includes p_idempotency_key: the key comes from p_key only
      RAISE EXCEPTION 'OP_UNKNOWN_ARGUMENT: %', k USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY v_required LOOP
    IF NOT p_args ? k THEN RAISE EXCEPTION 'OP_MISSING_ARGUMENT: %', k USING ERRCODE = '22023'; END IF;
  END LOOP;
  FOR i IN 1 .. array_length(v_names, 1) LOOP   -- every argument, hashed or not
    PERFORM public.op_arg_check(v_types[i], p_args, v_names[i]);
  END LOOP;
  v_hash := public.op_request_hash(p_rpc, p_args);   -- byte-identical to the RPC's own v_idem_hash

  -- The executor never runs an RPC the caller's role may not run directly
  -- (a REVOKE on the RPC stays a kill switch).
  IF NOT has_function_privilege('authenticated', public.op_rpc_signature(p_rpc), 'EXECUTE') THEN
    RAISE EXCEPTION 'OP_RPC_DISABLED: %', p_rpc USING ERRCODE = '42501';
  END IF;

  -- 3. A decision is immutable once committed: answer it without waiting
  --    for the lock (a lookup or replay then never sees a false in_flight).
  --    Otherwise take the SAME advisory lock idem_begin takes, at the OUTER
  --    level (a lock first taken inside the savepoint below would be
  --    released when the savepoint rolls back), and read again.
  SELECT * INTO v_row FROM public.idempotency_keys WHERE key = p_key;
  IF NOT FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtext('idem:' || p_key::text));
    SELECT * INTO v_row FROM public.idempotency_keys WHERE key = p_key;
  END IF;

  -- 4. An existing decision is answered, never re-executed.
  IF FOUND THEN
    IF v_row.org_id IS DISTINCT FROM v_org OR v_row.rpc <> p_rpc THEN
      RETURN jsonb_build_object('outcome', 'mismatch');            -- one answer, no detail, no write
    END IF;
    IF v_row.state = 'abandoned' THEN
      RETURN jsonb_build_object('outcome', 'abandoned', 'replayed', true);
    END IF;
    IF regexp_replace(v_row.request_hash, '^R:', '') <> v_hash THEN
      RETURN jsonb_build_object('outcome', 'mismatch');            -- changed arguments
    END IF;
    v_may_see := (v_row.actor_id IS NOT NULL AND v_row.actor_id = v_actor) OR public.op_may_resolve(v_role);
    IF v_row.state = 'rejected' THEN
      RETURN jsonb_build_object('outcome', 'rejected', 'replayed', true,
        'code', CASE WHEN v_may_see THEN v_row.outcome_code END,
        'message', CASE WHEN v_may_see THEN v_row.outcome_message END,
        'withheld', NOT v_may_see);
    END IF;
    RETURN jsonb_build_object('outcome', 'committed', 'replayed', true,
      'response', CASE WHEN v_may_see THEN v_row.response END,
      'withheld', NOT v_may_see,
      'response_purged', v_row.response_purged_at IS NOT NULL);
  END IF;

  -- 5. New execution: a v7 key must be inside its window (server clock);
  --    refused and NOT recorded otherwise.
  IF NOT public.op_key_executable(p_key) THEN
    RAISE EXCEPTION 'OP_KEY_OUTSIDE_WINDOW' USING ERRCODE = '22023';
  END IF;

  -- 6. The UNCHANGED RPC, inside a savepoint. The transaction-local marker
  --    lets idem_begin accept this one UUIDv7 key. Only audited definitive
  --    refusals are recorded; every other failure propagates.
  PERFORM set_config('orvix.op_execute_key', p_key::text, true);
  BEGIN
    v_resp := public.op_dispatch(p_key, p_rpc, p_args);
    PERFORM set_config('orvix.op_execute_key', '', true);
    RETURN jsonb_build_object('outcome', 'committed', 'replayed', false, 'response', v_resp);
  EXCEPTION
    WHEN raise_exception OR insufficient_privilege OR data_exception OR integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL,
                              v_constraint = CONSTRAINT_NAME;
      PERFORM set_config('orvix.op_execute_key', '', true);
      v_class := public.op_classify_refusal(v_state, v_msg, nullif(v_constraint, ''));
      IF v_class = 'idempotency' THEN
        RETURN jsonb_build_object('outcome', 'mismatch');          -- defensive; impossible under the lock
      END IF;
      IF v_class = 'rejected' AND p_actor_id IS NULL THEN
        v_class := 'actor_unverified';                             -- a legacy key with no recorded actor
      END IF;
      IF v_class <> 'rejected' THEN
        -- Not definitive: nothing recorded; the caller sees the original
        -- error (and why it was not recorded).
        IF coalesce(v_detail, '') = '' THEN
          RAISE EXCEPTION USING ERRCODE = v_state, MESSAGE = v_msg, HINT = 'op_not_recorded:' || v_class;
        END IF;
        RAISE EXCEPTION USING ERRCODE = v_state, MESSAGE = v_msg, DETAIL = v_detail, HINT = 'op_not_recorded:' || v_class;
      END IF;
      -- The savepoint is rolled back: no effect of the RPC survives.
      INSERT INTO public.idempotency_keys
        (key, rpc, actor_id, org_id, request_hash, response, state, outcome_code, outcome_message, decided_at)
      VALUES (p_key, p_rpc, v_actor, v_org, 'R:' || v_hash, NULL, 'rejected', v_state, left(v_msg, 500), clock_timestamp());
      RETURN jsonb_build_object('outcome', 'rejected', 'replayed', false, 'code', v_state, 'message', left(v_msg, 500));
  END;
END;
$f$;

DROP FUNCTION IF EXISTS public.op_status(uuid, text, boolean, text);   -- an earlier candidate signature
CREATE OR REPLACE FUNCTION public.op_status(
  p_key uuid, p_rpc text, p_fence boolean DEFAULT false, p_expected_actor_id text DEFAULT NULL, p_args jsonb DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_actor text; v_org text; v_role text;
  v_row public.idempotency_keys%ROWTYPE;
  v_may_see boolean;
  v_fence boolean := p_fence IS TRUE;   -- NULL is a lookup, never a fence
  v_evidence text;
  v_owner text;
  v_authorized boolean := false;
BEGIN
  SELECT c.v_actor, c.v_org, c.v_role INTO v_actor, v_org, v_role FROM public.op_caller() c;
  IF p_key IS NULL THEN RAISE EXCEPTION 'OP_KEY_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF (SELECT s.v_names FROM public.op_spec(p_rpc) s) IS NULL THEN
    RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023';
  END IF;

  -- A decided key is final (its row only becomes visible once the deciding
  -- transaction commits, and is never changed back): answered from the
  -- ledger BEFORE the lock, so a concurrent lookup, fence or replay holding
  -- the lock never makes a decided key look "in flight". Another
  -- organization's (or another RPC's) decided key: one fixed answer (no
  -- state, actor, time or in-flight signal).
  SELECT * INTO v_row FROM public.idempotency_keys WHERE key = p_key;
  IF FOUND THEN
    IF v_row.org_id IS DISTINCT FROM v_org OR v_row.rpc <> p_rpc THEN
      RETURN jsonb_build_object('status', 'unavailable');
    END IF;
    v_may_see := (v_row.actor_id IS NOT NULL AND v_row.actor_id = v_actor) OR public.op_may_resolve(v_role);
    RETURN jsonb_build_object('status', v_row.state,
      'response', CASE WHEN v_may_see AND v_row.state = 'committed' THEN v_row.response END,
      'code', CASE WHEN v_may_see AND v_row.state = 'rejected' THEN v_row.outcome_code END,
      'message', CASE WHEN v_may_see AND v_row.state = 'rejected' THEN v_row.outcome_message END,
      'withheld', NOT v_may_see,
      'response_purged', v_row.response_purged_at IS NOT NULL);
  END IF;

  -- An execution holding the key's lock has neither committed nor rolled
  -- back: say so, never guess. Lookups share the lock (they never see each
  -- other as in flight); a fence needs it exclusively.
  IF NOT (CASE WHEN v_fence THEN pg_try_advisory_xact_lock(hashtext('idem:' || p_key::text))
               ELSE pg_try_advisory_xact_lock_shared(hashtext('idem:' || p_key::text)) END) THEN
    RETURN jsonb_build_object('status', 'in_flight');
  END IF;

  SELECT * INTO v_row FROM public.idempotency_keys WHERE key = p_key;   -- re-read under the lock
  IF FOUND THEN
    IF v_row.org_id IS DISTINCT FROM v_org OR v_row.rpc <> p_rpc THEN
      RETURN jsonb_build_object('status', 'unavailable');
    END IF;
    v_may_see := (v_row.actor_id IS NOT NULL AND v_row.actor_id = v_actor) OR public.op_may_resolve(v_role);
    RETURN jsonb_build_object('status', v_row.state,
      'response', CASE WHEN v_may_see AND v_row.state = 'committed' THEN v_row.response END,
      'code', CASE WHEN v_may_see AND v_row.state = 'rejected' THEN v_row.outcome_code END,
      'message', CASE WHEN v_may_see AND v_row.state = 'rejected' THEN v_row.outcome_message END,
      'withheld', NOT v_may_see,
      'response_purged', v_row.response_purged_at IS NOT NULL);
  END IF;

  IF NOT v_fence THEN
    -- Undecided. 'executable' false: a v7 key outside its window can never
    -- execute any more (op_execute and idem_begin refuse it).
    RETURN jsonb_build_object('status', 'not_found', 'executable', public.op_key_executable(p_key));
  END IF;
  IF public.op_key_too_old(p_key) THEN
    -- Can never execute; and with no row the server cannot say whether it
    -- once ran. Nothing is written: a person verifies it. (A FUTURE-dated
    -- v7 key is fenced like any other: with no row it has not committed,
    -- and the fence takes the key's lock EXCLUSIVELY, so no execution is
    -- in progress; once the row exists no copy can ever execute it. Keys
    -- up to 30 days ahead are executable — clock skew — and beyond that
    -- op_execute refuses them, so fencing is safe either way.)
    RETURN jsonb_build_object('status', 'not_found', 'executable', false, 'fenced', false, 'reason', 'expired');
  END IF;

  -- Fence authority. The server cannot know who minted a never-delivered
  -- key: the caller may fence their OWN operation; ADMIN / sync:resolve may
  -- fence one of a user of their organisation; and, for a legacy entry with
  -- no recorded actor, only when its arguments name rows of their own
  -- organisation (a consistency check on what the till sent — it does not
  -- bind the key; R3). Arguments that verifiably name ANOTHER
  -- organisation's rows refuse the fence on every path, the caller's own
  -- included (no cross-tenant squatting of a key with a victim's real
  -- arguments). Residual signal: "another organisation's row" (refused) vs
  -- "no such row" (own fence allowed) — documented, ids are opaque.
  v_evidence := CASE WHEN p_args IS NOT NULL THEN public.op_org_of(p_rpc, p_args) END;
  IF v_evidence IS NOT NULL AND v_evidence IS DISTINCT FROM v_org THEN
    RETURN jsonb_build_object('status', 'not_found', 'fenced', false, 'reason', 'not_authorized');
  END IF;
  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id = v_actor THEN
    v_owner := v_actor; v_authorized := true;
  ELSIF public.op_may_resolve(v_role) THEN
    IF p_expected_actor_id IS NOT NULL THEN
      SELECT u.id INTO v_owner FROM public.users u WHERE u.id = p_expected_actor_id AND u.org_id = v_org;
      v_authorized := v_owner IS NOT NULL;
    ELSIF p_args IS NOT NULL THEN
      v_authorized := v_evidence IS NOT NULL;   -- = v_org (checked above); owner stays unknown
    END IF;
  END IF;
  IF NOT v_authorized THEN
    RETURN jsonb_build_object('status', 'not_found', 'fenced', false, 'reason', 'not_authorized');
  END IF;

  INSERT INTO public.idempotency_keys
    (key, rpc, actor_id, org_id, request_hash, response, state, outcome_code, outcome_message, decided_at)
  VALUES (p_key, p_rpc, v_owner, v_org, 'A:', NULL, 'abandoned', 'FENCED', 'fenced by ' || v_actor, clock_timestamp());
  RETURN jsonb_build_object('status', 'abandoned', 'fenced', true);
END;
$f$;

-- ------------------------------------------------------------
-- 6/8 retention (owner/service only; NOTHING is scheduled here)
-- ------------------------------------------------------------
-- 062's body (DELETE everything older than 30 days) deleted rejected and
-- abandoned tombstones and re-opened refused keys. Replaced: only UUIDv7
-- rows whose decision AND key time are both older than 13 months, and only
-- while BOTH paths refuse such a key -- op_execute (12-month window) and
-- idem_begin (UUIDv7 only through op_execute). Without them (e.g. after a
-- rollback) it deletes nothing. v4, derived and pre-086 keys are never
-- deleted (their age cannot be proven). Self-contained. Does NOT purge
-- responses.
CREATE OR REPLACE FUNCTION public.prune_idempotency_keys()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE
  v_count integer;
BEGIN
  IF to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.idem_begin(uuid,text,text)') AND prosrc LIKE '%OP_EXECUTOR_REQUIRED%') THEN
    RAISE NOTICE 'prune_idempotency_keys: the legacy path does not refuse UUIDv7 keys here; nothing pruned';
    RETURN 0;
  END IF;
  DELETE FROM public.idempotency_keys k
   WHERE k.rpc <> 'create_app_user'   -- direct-only: no window on its path, so never pruned
     AND (get_byte(uuid_send(k.key), 8) >> 6) = 2
     AND (get_byte(uuid_send(k.key), 6) >> 4) = 7
     AND greatest(k.decided_at,
                  'epoch'::timestamptz + (('x' || substr(replace(k.key::text, '-', ''), 1, 12))::bit(48)::bigint) * interval '1 millisecond')
         < now() - interval '13 months';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$f$;

-- Response purging: INACTIVE in Stage 1 (legacy 085 clients replay a
-- purged response as {}). Owner only, never below 90 days, not scheduled.
CREATE OR REPLACE FUNCTION public.op_purge_responses(p_older_than interval)
 RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE n integer;
BEGIN
  IF p_older_than IS NULL OR p_older_than < interval '90 days' THEN
    RAISE EXCEPTION 'op_purge_responses: the minimum age is 90 days' USING ERRCODE = '22023';
  END IF;
  UPDATE public.idempotency_keys
     SET response = NULL, response_purged_at = clock_timestamp()
   WHERE state = 'committed' AND response IS NOT NULL AND response_purged_at IS NULL
     AND decided_at < now() - p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$f$;

-- ------------------------------------------------------------
-- 7/8 ownership and grants
-- ------------------------------------------------------------
DO $grants$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'op\_%' OR p.proname = 'prune_idempotency_keys') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END
$grants$;
GRANT EXECUTE ON FUNCTION public.op_execute(uuid, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_status(uuid, text, boolean, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prune_idempotency_keys() TO service_role;   -- as 062 granted it

COMMENT ON FUNCTION public.op_execute(uuid, text, jsonb, text) IS
  '086: guarded executor for the 29 allow-listed idempotent RPCs, bound to the operation''s own actor; durable rejected outcomes (docs/selfhost-migration/phase-g/migration-086.md).';
COMMENT ON FUNCTION public.op_status(uuid, text, boolean, text, jsonb) IS
  '086: operation status lookup; p_fence atomically abandons a never-delivered key.';

-- ------------------------------------------------------------
-- 8/8 S1: pin pg_temp LAST on every function that had search_path=public
--     (configuration only; bodies, owners and grants are unchanged; none of
--     them creates or reads temporary tables)
-- ------------------------------------------------------------
ALTER FUNCTION public.adjust_stock(text,text,text,integer,text,text,integer,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_can_for_shop(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_has_perm(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_org_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.app_org_shop_ids() SET search_path = public, pg_temp;
ALTER FUNCTION public.app_org_user_ids() SET search_path = public, pg_temp;
ALTER FUNCTION public.app_require_org_items(jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_require_org(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_role() SET search_path = public, pg_temp;
ALTER FUNCTION public.app_seed_default_price_levels(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_setup_needed() SET search_path = public, pg_temp;
ALTER FUNCTION public.app_shop_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.app_shop_in_org(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_storage_can_write_path(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_storage_object_in_my_org(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_storage_object_org(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_storage_owner_in_org(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_upload_session_public_url(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.app_user_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_purchase_order(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_refund_request(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_stock_transfer(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_void_request(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.attach_product_image_upload_session_token(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.bootstrap_first_admin() SET search_path = public, pg_temp;
ALTER FUNCTION public.cancel_product_image_upload_session(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.cancel_purchase_order(text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.cancel_stock_transfer(text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.claim_phone_upload_token_issue(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.close_shift(text,integer,text,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.complete_product_image_upload_session(text,text,text,integer,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.complete_sale(text,text,text,integer,numeric,jsonb,timestamp with time zone,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.complete_stock_transfer(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_product_image_upload_session(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_purchase_order(text,text,text,jsonb,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_refund_void_request(text,text,text,jsonb,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_stock_transfer(text,text,text,jsonb,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_supplier(text,text,text,text,text,text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.current_app_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.deactivate_app_user(text,boolean,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_product(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.dispatch_stock_transfer(text,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.enforce_same_org_refs() SET search_path = public, pg_temp;
ALTER FUNCTION public.ensure_inventory_rows_for_product() SET search_path = public, pg_temp;
ALTER FUNCTION public.ensure_inventory_rows_for_shop() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_product_image_upload_session_by_token(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_product_image_upload_session_status(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.guard_user_privilege_columns() SET search_path = public, pg_temp;
ALTER FUNCTION public.idem_begin(uuid,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.idem_finish(uuid,jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_audit_event(text,text,text,text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_receipt_reprint(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.open_shift(text,integer,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.organizations_seed_business_profile() SET search_path = public, pg_temp;
ALTER FUNCTION public.organizations_seed_price_levels() SET search_path = public, pg_temp;
ALTER FUNCTION public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.product_barcodes_set_org_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.receive_purchase_order(text,jsonb,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.receive_stock_transfer(text,jsonb,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.record_supplier_payment(text,integer,text,text,text,timestamp with time zone,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.reject_refund_void_request(text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.reject_stock_transfer(text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.replace_manager(text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_org_id_from_caller() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_app_user(text,text,text,text,text[],text[],uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_supplier(text,text,text,text,text,text,text,text,boolean,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.void_supplier_payment(text,text,uuid) SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- post-checks
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_expected CONSTANT jsonb := '{"public.adjust_stock(text,text,text,integer,text,text,integer,timestamp with time zone,text,uuid)":"6701ab0256abed02e34f7e20ece76c2f","public.approve_purchase_order(text,uuid)":"1730ef49f146b31afbf3eabe01adbdf7","public.approve_refund_request(text,uuid)":"acc3e5b7bfcd68a435e0f4170a508deb","public.approve_stock_transfer(text,uuid)":"5d031d2f765c888cb4c5d6fabc4329a7","public.approve_void_request(text,uuid)":"9589bac39f64059d2fb95a2b7209eeae","public.cancel_purchase_order(text,text,uuid)":"829aec95c5c3cd93e78d266b434b507e","public.cancel_stock_transfer(text,text,uuid)":"430e2f79bc6e2bade999447cd204a36a","public.close_shift(text,integer,text,timestamp with time zone,text,uuid)":"9536c7f1f2bac9e0355458bd5ad06c79","public.complete_sale(text,text,text,integer,numeric,jsonb,timestamp with time zone,uuid)":"f9844590bece7166caaf1d55f638dce3","public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)":"06d80afb8e87681f03fb3edfd3ab88bc","public.create_purchase_order(text,text,text,jsonb,uuid)":"8c43ffe84e6130072fa6c31c9475931d","public.create_refund_void_request(text,text,text,jsonb,timestamp with time zone,text,uuid)":"56ea96382d12171c9ba603fbc6fcc61e","public.create_stock_transfer(text,text,text,jsonb,uuid)":"64564f4082b58e663ba63bfe0e544674","public.create_supplier(text,text,text,text,text,text,text,uuid)":"0b2ca7e054fababe0889ab10d74774e5","public.deactivate_app_user(text,boolean,uuid)":"b335ccb5cfaad622090cfa203b6e0be4","public.delete_product(text,uuid)":"7fdbbe18860b8fcd9b5fa87d4896505d","public.dispatch_stock_transfer(text,timestamp with time zone,text,uuid)":"2e4c2edc75c391664b30415357cebf51","public.idem_begin(uuid,text,text)":"afca065fea226a0c7a5b9bb56b540a9d","public.idem_finish(uuid,jsonb)":"d832e312446dfaf2509cc0b0ccadcf28","public.log_audit_event(text,text,text,text,text,uuid)":"73b9154015ee61786243d70822c25618","public.log_receipt_reprint(text,uuid)":"11171c26d4e02db6244285b986b2536e","public.open_shift(text,integer,timestamp with time zone,text,uuid)":"97ccc663fec1150c90bda6263a46b33c","public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)":"7fe2929d412ca10d2a47ec76b956e76d","public.receive_purchase_order(text,jsonb,timestamp with time zone,text,uuid)":"d6e5ec1921f4e4d9e0b32c7ae48c589e","public.receive_stock_transfer(text,jsonb,timestamp with time zone,text,uuid)":"7bf2a3e120271787a1f2c5c21053b40b","public.record_supplier_payment(text,integer,text,text,text,timestamp with time zone,text,uuid)":"4ed0ce8e6a9c8516d73e23ef13c808eb","public.reject_refund_void_request(text,text,uuid)":"82e030f931169de811727d1e8e370967","public.reject_stock_transfer(text,text,uuid)":"b165a65897c5870cdeb5defbdd3fc2d4","public.replace_manager(text,text,uuid)":"27b10ab2731ac2fbfc52bb8b0239c379","public.update_app_user(text,text,text,text,text[],text[],uuid)":"b92eb4a6c46e6bf69316d4b6d86da4c0","public.update_supplier(text,text,text,text,text,text,text,text,boolean,uuid)":"cb422e77100c7199e1311bcd5f1b82d1","public.void_supplier_payment(text,text,uuid)":"f10dd8642eabcd9ec389e3c88678a875"}'::jsonb;
  v_idem_begin_086 CONSTANT text := '58a55436635b9ed1e8db09192c6b6e2b';
  k text; v_md5 text; n integer; v_bad text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(v_expected) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(k);
    IF k = 'public.idem_begin(uuid,text,text)' THEN
      IF v_md5 IS DISTINCT FROM v_idem_begin_086 THEN RAISE EXCEPTION '086 post-check: idem_begin is not the 086 body'; END IF;
    ELSIF v_md5 IS DISTINCT FROM v_expected ->> k THEN
      RAISE EXCEPTION '086 post-check: % body changed', k;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proconfig = '{search_path=public}';
  IF n <> 0 THEN RAISE EXCEPTION '086 post-check: % function(s) still have search_path=public', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_state_chk') THEN
    RAISE EXCEPTION '086 post-check: state constraint missing';
  END IF;
  -- Exact EXECUTE matrix: authenticated on op_execute/op_status, nobody
  -- (but the owner) on every other op_* function.
  SELECT string_agg(p.oid::regprocedure::text || ' -> ' || coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC'), '; ') INTO v_bad
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'op\_%' AND a.privilege_type = 'EXECUTE'
     AND a.grantee <> p.proowner
     AND NOT (p.proname IN ('op_execute', 'op_status') AND a.grantee = 'authenticated'::regrole);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '086 post-check: unexpected EXECUTE grants: %', v_bad; END IF;
  IF NOT has_function_privilege('authenticated', 'public.op_execute(uuid,text,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.op_status(uuid,text,boolean,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.prune_idempotency_keys()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.prune_idempotency_keys()', 'EXECUTE') THEN
    RAISE EXCEPTION '086 post-check: unexpected function privileges';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'op\_%'
     AND (pg_get_userbyid(p.proowner) <> 'postgres' OR p.proconfig IS DISTINCT FROM '{"search_path=pg_catalog, pg_temp"}');
  IF n <> 0 THEN RAISE EXCEPTION '086 post-check: % op_* function(s) with wrong owner or search_path', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE oid IN (to_regprocedure('public.op_execute(uuid,text,jsonb,text)'),
                                                     to_regprocedure('public.op_status(uuid,text,boolean,text,jsonb)')) AND prosecdef;
  IF n <> 2 THEN RAISE EXCEPTION '086 post-check: op_execute/op_status must be SECURITY DEFINER'; END IF;
END
$post$;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
