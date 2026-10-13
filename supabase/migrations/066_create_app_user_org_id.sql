-- ============================================================
-- Migration 066: create_app_user must set users.org_id (defect found by the
--                Phase D harness)
--
-- Defect: migration 059 added users.org_id NOT NULL (backfilled), but the
-- create_app_user RPC (migration 049; current production body identical in
-- the 2026-10-11 snapshot) still inserts without org_id, so EVERY call fails
-- with `null value in column "org_id" of relation "users" violates not-null
-- constraint`. Creating a staff user through the app has therefore been
-- impossible since 059 was applied on 2026-09-02 (whether anyone tried is
-- UNKNOWN - check audit_logs for USER_CREATED rows after that date).
--
-- Fix: the new user inherits the creator's organization (v_user.org_id, the
-- same value app_org_id() returns for the caller). This is the only org a
-- caller can act in today; cross-org user creation is platform-console work
-- (service role, direct writes) and is not affected. The response gains an
-- 'orgId' field; nothing else changes. The body is otherwise the 063 body
-- (hosted body + idempotency gate) verbatim - same signature, so no DROP is
-- needed and 064's grants still apply.
--
-- Rollback: re-run the create_app_user block of 063 (restores the broken
-- body). Forward recovery: idempotent (CREATE OR REPLACE), re-run.
--
-- Verification:
--   SELECT prosrc LIKE '%v_user.org_id%' FROM pg_proc WHERE proname = 'create_app_user';   -- t
--   -- then, as an ADMIN session: SELECT create_app_user('u-x','X','x@y','CASHIER','<shop>',NULL,NULL,NULL,gen_random_uuid());
--   -- and: SELECT org_id FROM users WHERE id = 'u-x';  -- the caller's org
-- ============================================================

CREATE OR REPLACE FUNCTION "public"."create_app_user"("p_id" "text", "p_name" "text", "p_email" "text", "p_role" "text", "p_shop_id" "text", "p_auth_id" "uuid", "p_granted_permissions" "text"[] DEFAULT NULL::"text"[], "p_revoked_permissions" "text"[] DEFAULT NULL::"text"[], "p_idempotency_key" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  -- Phase D (063): idempotency bookkeeping.
  v_idem_hash   text;
  v_idem_replay jsonb;
  v_idem_result jsonb;
  v_user     users;
  v_now      timestamptz := now();
  v_audit_id text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Phase D (063): idempotency gate. A NULL key raises IDEMPOTENCY_KEY_REQUIRED;
  -- a replay of a committed request returns the stored response without
  -- side effects; the same key with a different payload raises
  -- IDEMPOTENCY_MISMATCH. Hash covers every business argument except the
  -- client timestamp (p_created_at) and the key itself.
  v_idem_hash := md5(jsonb_build_object(
    'p_id', p_id,
    'p_name', p_name,
    'p_email', p_email,
    'p_role', p_role,
    'p_shop_id', p_shop_id,
    'p_auth_id', p_auth_id,
    'p_granted_permissions', p_granted_permissions,
    'p_revoked_permissions', p_revoked_permissions
  )::text);
  v_idem_replay := public.idem_begin(p_idempotency_key, 'create_app_user', v_idem_hash);
  IF v_idem_replay IS NOT NULL THEN
    RETURN v_idem_replay;
  END IF;

  IF NOT app_has_perm('user:create') THEN
    RAISE EXCEPTION 'You are not permitted to create users';
  END IF;
  IF p_id IS NULL OR p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'User id and name are required';
  END IF;

  INSERT INTO users (
    id, name, email, role, shop_id, auth_id,
    granted_permissions, revoked_permissions, is_active, created_at,
    org_id  -- 066: inherit the creator's organization (059 made this NOT NULL)
  )
  VALUES (
    p_id, p_name, p_email, p_role, p_shop_id, p_auth_id,
    p_granted_permissions, p_revoked_permissions, true, v_now,
    v_user.org_id
  );

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, p_shop_id, v_user.id, 'USER_CREATED',
    'User ' || p_name || ' (' || p_role || ') created', 'User', p_id, v_now);

  v_idem_result := jsonb_build_object(
    'id', p_id, 'name', p_name, 'email', p_email, 'role', p_role, 'shopId', p_shop_id,
    'authId', p_auth_id, 'grantedPermissions', p_granted_permissions,
    'revokedPermissions', p_revoked_permissions, 'isActive', true, 'createdAt', v_now,
    'orgId', v_user.org_id
  );
  PERFORM public.idem_finish(p_idempotency_key, v_idem_result);
  RETURN v_idem_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_app_user(text, text, text, text, text, uuid, text[], text[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_app_user(text, text, text, text, text, uuid, text[], text[], uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
