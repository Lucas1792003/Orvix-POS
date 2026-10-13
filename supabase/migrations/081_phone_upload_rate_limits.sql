-- ============================================================
-- Migration 081: phone-upload rate limits (server-side, DB-backed, atomic)
--                docs/selfhost-migration/phase-f/rate-limiting.md
--
-- WHY
--   The phone-upload-token Edge Function (phase-g/phone-upload-jit.md) signs
--   a 60 s upload token on every call while the QR session is PENDING. It was
--   measured live with no limit at all (50 sequential / 50 concurrent calls
--   for one session -> 100 x 200, each costing ~6 internal requests). Extra
--   tokens add no capability (one path, upsert false), so the risk is load
--   amplification on a home server shared with the tills, plus unbounded
--   session creation by a signed-in user.
--
-- WHAT IT DOES (limits are constants in the function bodies; rationale in the doc)
--   1. product_image_upload_sessions gains three counters (NOT NULL defaults,
--      no client grant change): token_issue_count, token_window_start,
--      token_window_count.
--   2. public.phone_upload_org_rate (org_id PK -> organizations ON DELETE
--      CASCADE, window_start, issued): one fixed 60 s window per org.
--      RLS on, NO grants to anon / authenticated / service_role; only the
--      SECURITY DEFINER function below (owner postgres) touches it.
--   3. public.claim_phone_upload_token_issue(p_token text) RETURNS jsonb,
--      SECURITY DEFINER, EXECUTE for service_role only (the Edge Function).
--      In ONE transaction: lock the session row (FOR UPDATE), lock the org
--      counter row (FOR UPDATE; order session -> org everywhere, no
--      deadlock), decide, and increment both only when every limit allows:
--        per session lifetime  20 tokens  -> then refused until the session expires
--        per session burst      5 tokens per fixed 10 s window
--        per organization      60 tokens per fixed 60 s window
--      Refused attempts do not count. Returns
--        {allowed:true, issued, remaining}
--        {allowed:false, reason:'rate_limited', scope:'session'|'session_burst'|'org', retry_after_seconds}
--        {allowed:false, reason:'invalid'} | {allowed:false, reason:'inactive', status} | {allowed:false, reason:'refused'}
--      It never raises for a caller-controlled condition and never writes
--      anything on a refusal.
--   4. create_product_image_upload_session (079 body + 1 hunk): at most 120
--      sessions per creating user per rolling hour, serialised per user with
--      pg_advisory_xact_lock so concurrent calls cannot overshoot. Beyond ->
--      RAISE 'Too many phone upload links ...' with SQLSTATE PT429
--      (PostgREST answers HTTP 429). Uses the existing index
--      product_image_upload_sessions_created_by_idx (created_by, created_at DESC).
--   Unchanged: the anon surface (still exactly 3 functions), storage
--   policies, every other RPC, the 60 s signed-upload lifetime.
--
-- ORDER / COMPATIBILITY
--   Apply 081 BEFORE deploying the rate-limited phone-upload-token function:
--   that function fails CLOSED (503) when the claim RPC is missing. The
--   currently deployed function ignores 081 entirely (additive).
--   Every client build works with 081.
--
-- ROLLBACK
--   Re-deploy the previous phone-upload-token function first, then re-run
--   079's create_product_image_upload_session block (with its grants) and:
--     DROP FUNCTION IF EXISTS public.claim_phone_upload_token_issue(text);
--     DROP TABLE IF EXISTS public.phone_upload_org_rate;
--   The three counter columns can stay (unused) or be dropped:
--     ALTER TABLE public.product_image_upload_sessions
--       DROP COLUMN IF EXISTS token_issue_count,
--       DROP COLUMN IF EXISTS token_window_start,
--       DROP COLUMN IF EXISTS token_window_count;
-- FORWARD RECOVERY
--   Idempotent (IF NOT EXISTS / CREATE OR REPLACE / REVOKE+GRANT). Re-run.
--
-- VERIFICATION
--   SELECT has_function_privilege('service_role','public.claim_phone_upload_token_issue(text)','EXECUTE'),
--          has_function_privilege('anon','public.claim_phone_upload_token_issue(text)','EXECUTE'),
--          has_function_privilege('authenticated','public.claim_phone_upload_token_issue(text)','EXECUTE');  -- t, f, f
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE');                      -- 3
--   SELECT prosrc LIKE '%081%' FROM pg_proc WHERE proname = 'create_product_image_upload_session';          -- t
--   -- harness: bash supabase/tests/phase-d/run.sh   (t17_rate_limits + t17 concurrency)
--
-- NOT applied anywhere by this change.
-- ============================================================

-- 1/4 per-session counters
ALTER TABLE public.product_image_upload_sessions
  ADD COLUMN IF NOT EXISTS token_issue_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS token_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS token_window_count integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.product_image_upload_sessions.token_issue_count IS
  '081: signed upload tokens issued for this session (phone-upload-token); capped by claim_phone_upload_token_issue()';

-- 2/4 per-organization window (service-internal; no API role may touch it)
CREATE TABLE IF NOT EXISTS public.phone_upload_org_rate (
  org_id       text PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  issued       integer NOT NULL DEFAULT 0 CHECK (issued >= 0)
);
ALTER TABLE public.phone_upload_org_rate OWNER TO postgres;
ALTER TABLE public.phone_upload_org_rate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.phone_upload_org_rate FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.phone_upload_org_rate IS
  '081: per-organization phone-upload token window (claim_phone_upload_token_issue only; no API grants).';

-- 3/4 the limiter (called by the phone-upload-token Edge Function with the service role)
CREATE OR REPLACE FUNCTION public.claim_phone_upload_token_issue(p_token text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- 081 limits (docs/selfhost-migration/phase-f/rate-limiting.md)
  c_session_cap    constant integer  := 20;
  c_burst_max      constant integer  := 5;
  c_burst_window   constant interval := interval '10 seconds';
  c_org_max        constant integer  := 60;
  c_org_window     constant interval := interval '60 seconds';
  v_session product_image_upload_sessions;
  v_org_id  text;
  v_org     phone_upload_org_rate;
  v_now     timestamptz;
  v_burst_open boolean;
  v_org_open   boolean;
BEGIN
  IF COALESCE(length(p_token), 0) < 32 OR length(p_token) > 512 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid');
  END IF;

  -- one writer per session at a time: concurrent claims queue here
  SELECT * INTO v_session
    FROM product_image_upload_sessions
   WHERE token_hash = product_image_upload_token_hash(p_token)
   FOR UPDATE;
  IF v_session.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid');
  END IF;

  -- measured AFTER the lock, so a queued caller sees the real time
  v_now := clock_timestamp();

  IF v_session.status <> 'PENDING' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'inactive', 'status', v_session.status);
  END IF;
  IF v_session.expires_at <= v_now THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'inactive', 'status', 'EXPIRED');
  END IF;

  SELECT u.org_id INTO v_org_id FROM users u WHERE u.id = v_session.created_by;
  IF v_org_id IS NULL OR NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = v_org_id) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'refused');
  END IF;

  -- per session, lifetime: refused until the session expires
  IF v_session.token_issue_count >= c_session_cap THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'scope', 'session',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM v_session.expires_at - v_now))::integer));
  END IF;

  -- per session, burst (fixed window)
  v_burst_open := v_session.token_window_start IS NOT NULL
                  AND v_session.token_window_start > v_now - c_burst_window;
  IF v_burst_open AND v_session.token_window_count >= c_burst_max THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'scope', 'session_burst',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM v_session.token_window_start + c_burst_window - v_now))::integer));
  END IF;

  -- per organization (fixed window); row created on first use, then locked
  INSERT INTO phone_upload_org_rate (org_id, window_start, issued)
  VALUES (v_org_id, v_now, 0)
  ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v_org FROM phone_upload_org_rate WHERE org_id = v_org_id FOR UPDATE;
  v_org_open := v_org.window_start > v_now - c_org_window;
  IF v_org_open AND v_org.issued >= c_org_max THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'scope', 'org',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM v_org.window_start + c_org_window - v_now))::integer));
  END IF;

  -- every limit allows: count this issue
  UPDATE phone_upload_org_rate
     SET window_start = CASE WHEN v_org_open THEN window_start ELSE v_now END,
         issued       = CASE WHEN v_org_open THEN issued + 1 ELSE 1 END
   WHERE org_id = v_org_id;

  UPDATE product_image_upload_sessions
     SET token_issue_count  = token_issue_count + 1,
         token_window_start = CASE WHEN v_burst_open THEN token_window_start ELSE v_now END,
         token_window_count = CASE WHEN v_burst_open THEN token_window_count + 1 ELSE 1 END
   WHERE id = v_session.id
   RETURNING * INTO v_session;

  RETURN jsonb_build_object('allowed', true,
    'issued', v_session.token_issue_count,
    'remaining', c_session_cap - v_session.token_issue_count);
END;
$$;
ALTER FUNCTION public.claim_phone_upload_token_issue(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_phone_upload_token_issue(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_phone_upload_token_issue(text) TO service_role;
COMMENT ON FUNCTION public.claim_phone_upload_token_issue(text) IS
  '081: atomic phone-upload token rate limiter (per session lifetime/burst, per org). service_role only.';

-- 4/4 create_product_image_upload_session (079 body + 1 hunk: per-user session limit)
CREATE OR REPLACE FUNCTION "public"."create_product_image_upload_session"("p_shop_id" "text" DEFAULT NULL::"text", "p_product_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users;
  v_session_id text := 'pimg-' || replace(gen_random_uuid()::text, '-', '');
  v_token text := replace(gen_random_uuid()::text, '-', '')
                  || replace(gen_random_uuid()::text, '-', '')
                  || replace(gen_random_uuid()::text, '-', '')
                  || replace(gen_random_uuid()::text, '-', '');
  v_storage_path text := 'temp/' || v_session_id;
  v_product_id text;
  v_expires_at timestamptz := now() + interval '10 minutes';
  -- 081: per-user session creation limit
  c_user_max constant integer := 120;
  v_recent integer;
  v_oldest timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 079: organization-scoped object path (078 storage policies:
  -- org/<org>/temp/<session>). Minted here, never by the client.
  v_storage_path := 'org/' || v_user.org_id || '/temp/' || v_session_id;

  -- Phase G (070): organization isolation guard. Every shop / entity this
  -- call targets must belong to the caller's organization; a row of another
  -- organization is reported as not found (068 app_require_org). Placed
  -- before the idempotency gate so a rejected call leaves no key row.
  PERFORM public.app_require_org('shop', p_shop_id);
  PERFORM public.app_require_org('product', p_product_id);

  IF NOT (app_has_perm('product:create') OR app_has_perm('product:update')) THEN
    RAISE EXCEPTION 'You are not permitted to upload product images';
  END IF;

  IF p_shop_id IS NOT NULL
     AND app_role() <> 'ADMIN'
     AND app_shop_id() IS DISTINCT FROM p_shop_id THEN
    RAISE EXCEPTION 'You are not permitted to create an upload session for this shop';
  END IF;

  -- 081: at most c_user_max sessions per creating user per rolling hour.
  -- Serialised per user (transaction-scoped advisory lock) so concurrent
  -- calls cannot both see room for one more. PT429 -> PostgREST HTTP 429.
  PERFORM pg_advisory_xact_lock(hashtextextended('pimg-create:' || v_user.id, 81));
  SELECT count(*), min(created_at) INTO v_recent, v_oldest
    FROM product_image_upload_sessions
   WHERE created_by = v_user.id
     AND created_at > now() - interval '1 hour';
  IF v_recent >= c_user_max THEN
    RAISE EXCEPTION 'Too many phone upload links were created. Try again in % minutes.',
      GREATEST(1, ceil(extract(epoch FROM v_oldest + interval '1 hour' - now()) / 60))::integer
      USING ERRCODE = 'PT429', HINT = 'rate_limited';
  END IF;

  IF p_product_id IS NOT NULL AND EXISTS (SELECT 1 FROM products WHERE id = p_product_id) THEN
    v_product_id := p_product_id;
  END IF;

  INSERT INTO product_image_upload_sessions (
    id, token_hash, created_by, shop_id, product_id, storage_path, expires_at
  )
  VALUES (
    v_session_id, product_image_upload_token_hash(v_token), v_user.id,
    p_shop_id, v_product_id, v_storage_path, v_expires_at
  );

  RETURN jsonb_build_object(
    'sessionId', v_session_id,
    'token', v_token,
    'storagePath', v_storage_path,
    'expiresAt', v_expires_at,
    'status', 'PENDING'
  );
END;
$$;

REVOKE ALL ON FUNCTION "public"."create_product_image_upload_session"(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION "public"."create_product_image_upload_session"(text, text) TO authenticated, service_role;

-- pre-conditions (the whole transaction aborts otherwise)
DO $$
BEGIN
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc
       WHERE oid = 'public.claim_phone_upload_token_issue(text)'::regprocedure) <> 'postgres'
     OR (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.phone_upload_org_rate'::regclass) <> 'postgres' THEN
    RAISE EXCEPTION '081: limiter function / table must be owned by postgres';
  END IF;
  IF has_function_privilege('anon', 'public.claim_phone_upload_token_issue(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_phone_upload_token_issue(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '081: claim_phone_upload_token_issue must not be executable by anon/authenticated';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
