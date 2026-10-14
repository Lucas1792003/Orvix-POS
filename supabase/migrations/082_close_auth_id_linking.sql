-- ============================================================
-- Migration 082: close the admin "link any auth account" path
--                docs/selfhost-migration/phase-f/migration-082.md
--
-- WHY (found 2026-10-13)
--   create_app_user(p_id, ..., p_auth_id, ...) (049 -> 063 -> 066 -> 070)
--   inserted p_auth_id verbatim. Any caller with `user:create` (an org ADMIN,
--   or a MANAGER granted it) could therefore attach ANY existing auth account
--   - an orphan sign-up account, an old QA account, a platform admin's login
--   - to a new staff row in their own organization. Two direct-table paths
--   did the same without the RPC: users_ins (INSERT ... auth_id under
--   app_has_perm('user:create')) and users_upd (UPDATE users SET auth_id
--   under app_has_perm('user:update')); both are row policies, and the
--   065 table grants give authenticated full INSERT/UPDATE on users, so no
--   column privilege stopped auth_id either.
--
-- WHAT IT DOES (no existing row is modified - asserted at the end)
--   1. create_app_user: same signature, grants and behaviour, plus - only
--      when p_auth_id IS NOT NULL (a NULL p_auth_id still creates an
--      unlinked profile, which nobody but the service role can ever link):
--      a. caller assurance, mirroring the staff-admin Edge Function and the
--         app's admin gate (never weaker):
--           * caller has a verified TOTP factor (auth.mfa_factors) -> the
--             JWT must carry aal = 'aal2'                  (MFA_REQUIRED)
--           * else caller is ADMIN -> an admin_login_codes row of this auth
--             user consumed at/after the session's first amr timestamp,
--             i.e. the emailed code was entered after this session signed
--             in; a JWT without amr fails closed     (VERIFICATION_REQUIRED)
--           * else (non-ADMIN granted user:create, no TOTP) -> nothing extra
--      b. the target auth account must be linkable    (AUTH_ACCOUNT_NOT_LINKABLE,
--         one message for every reason - no cross-org oracle):
--           * exists in auth.users;
--           * raw_app_meta_data.created_via = 'staff-admin' AND
--             raw_app_meta_data.org_id = the caller's org (app_metadata is
--             writable only with the service role, i.e. by staff-admin at
--             creation - never by the account holder);
--           * never signed in (last_sign_in_at IS NULL);
--           * created within the last 15 minutes;
--           * email equals p_email (trimmed, case-insensitive);
--           * not already linked to any users row (any org);
--           * not a platform admin; not the caller's own account.
--   2. guard_user_privilege_columns (047/073) - same function, one new
--      branch: when fired as the new AFTER trigger users_guard_auth_id, a
--      direct client write (current_user anon / authenticated) that sets
--      auth_id on INSERT or changes it on UPDATE is refused (AUTH_ID_READ_ONLY).
--      AFTER, so RLS WITH CHECK, the BEFORE guards and constraints keep
--      reporting first exactly as before. SECURITY DEFINER RPCs run as their
--      owner and the service role (platform console) is trusted, so
--      create_app_user, bootstrap_first_admin (076) and the console keep
--      working; FK ON DELETE SET NULL runs as the table owner.
--      Why not a column REVOKE: authenticated holds table-level INSERT/UPDATE
--      on users (065 hosted parity); a column-level REVOKE is a no-op under a
--      table grant, and changing the table grant would break 065 parity.
--   No grant changes; no new functions (public function count, anon-
--   executable set and the 30 keyed RPCs unchanged).
--
-- COMPATIBILITY
--   Deploy together with the staff-admin version that writes app_metadata
--   {created_via, org_id} at createUser (same window, function first - see
--   the doc). Older staff-admin + 082 -> create_staff is refused and the
--   function deletes the auth user again (compensation): fail closed.
--   The pre-staff-admin client flow (signUp + create_app_user with the new
--   account) is refused by 082; v1.0.15 targets hosted, which never gets 082.
--
-- ROLLBACK
--   Re-run the create_app_user block of 070_org_isolation_rpc_guards.sql and
--   the guard function block of 073_user_guard_service_role.sql, then
--   DROP TRIGGER IF EXISTS users_guard_auth_id ON public.users;
--
-- VERIFICATION
--   SELECT prosrc LIKE '%AUTH_ACCOUNT_NOT_LINKABLE%' FROM pg_proc
--    WHERE oid = 'public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)'::regprocedure;  -- t
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'users_guard_auth_id';
--   -- harness: bash supabase/tests/phase-d/run.sh   (t18_auth_link)
--
-- NOT applied anywhere by this change. Requires 042, 061, 070, 073.
-- Idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS + CREATE).
-- ============================================================

-- Snapshot of every users row (whole-row text) before any change; compared
-- at the end of this file. Session GUC: the file runs in one psql session.
SELECT set_config('pos.m082_users_digest',
  COALESCE((SELECT md5(string_agg(u::text, E'\n' ORDER BY u.id)) FROM public.users u), 'empty'),
  false);
SELECT set_config('pos.m082_users_count', (SELECT count(*)::text FROM public.users), false);

-- ------------------------------------------------------------
-- 1. create_app_user
-- ------------------------------------------------------------
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
  -- 082: link checks.
  v_claims        jsonb;
  v_session_start numeric;
  v_auth_found    boolean;
  v_auth_email    text;
  v_auth_created  timestamptz;
  v_auth_signin   timestamptz;
  v_auth_meta     jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Phase G (070): organization isolation guard. Every shop / entity this
  -- call targets must belong to the caller's organization; a row of another
  -- organization is reported as not found (068 app_require_org). Placed
  -- before the idempotency gate so a rejected call leaves no key row.
  PERFORM public.app_require_org('shop', p_shop_id);

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

  -- 082: linking a login account. Only a fresh account that the staff-admin
  -- Edge Function created for THIS organization, by a fully verified caller.
  IF p_auth_id IS NOT NULL THEN
    -- a. caller assurance (mirrors staff-admin step 3; never weaker)
    v_claims := COALESCE(auth.jwt(), '{}'::jsonb);
    IF EXISTS (SELECT 1 FROM auth.mfa_factors f
                WHERE f.user_id = auth.uid()
                  AND f.factor_type::text = 'totp'
                  AND f.status::text = 'verified') THEN
      IF COALESCE(v_claims->>'aal', '') <> 'aal2' THEN
        RAISE EXCEPTION 'MFA_REQUIRED: verify with your authenticator app before creating staff accounts'
          USING ERRCODE = '42501';
      END IF;
    ELSIF v_user.role = 'ADMIN' THEN
      SELECT min((e->>'timestamp')::numeric) INTO v_session_start
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_claims->'amr') = 'array'
                                       THEN v_claims->'amr' ELSE '[]'::jsonb END) e
       WHERE jsonb_typeof(e->'timestamp') = 'number';
      IF v_session_start IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.admin_login_codes c
                         WHERE c.auth_id = auth.uid()
                           AND c.consumed_at IS NOT NULL
                           AND c.consumed_at >= to_timestamp(v_session_start)) THEN
        RAISE EXCEPTION 'VERIFICATION_REQUIRED: verify your sign-in before creating staff accounts'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    -- b. the target account must be linkable (one message for every reason)
    SELECT true, a.email, a.created_at, a.last_sign_in_at, COALESCE(a.raw_app_meta_data, '{}'::jsonb)
      INTO v_auth_found, v_auth_email, v_auth_created, v_auth_signin, v_auth_meta
      FROM auth.users a
     WHERE a.id = p_auth_id;
    IF v_auth_found IS NOT TRUE
       OR v_auth_signin IS NOT NULL
       OR v_auth_created IS NULL
       OR v_auth_created < v_now - interval '15 minutes'
       OR COALESCE(v_auth_meta->>'created_via', '') <> 'staff-admin'
       OR COALESCE(v_auth_meta->>'org_id', '') IS DISTINCT FROM v_user.org_id
       OR lower(btrim(COALESCE(v_auth_email, ''))) <> lower(btrim(COALESCE(p_email, '')))
       OR btrim(COALESCE(p_email, '')) = ''
       OR p_auth_id = auth.uid()
       OR EXISTS (SELECT 1 FROM public.users u WHERE u.auth_id = p_auth_id)
       OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.auth_id = p_auth_id)
    THEN
      RAISE EXCEPTION 'AUTH_ACCOUNT_NOT_LINKABLE: this login account cannot be linked to a staff profile'
        USING ERRCODE = '42501';
    END IF;
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

REVOKE ALL ON FUNCTION "public"."create_app_user"(text, text, text, text, text, uuid, text[], text[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION "public"."create_app_user"(text, text, text, text, text, uuid, text[], text[], uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. users.auth_id is read-only for direct client writes
-- ------------------------------------------------------------
-- 073 body unchanged except the new TG_WHEN = 'AFTER' branch at the top.
CREATE OR REPLACE FUNCTION public.guard_user_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_caller_role text := app_role();
BEGIN
  -- 082: fired as users_guard_auth_id (AFTER INSERT OR UPDATE). Runs after
  -- RLS WITH CHECK and the BEFORE guards, so their errors keep precedence.
  -- current_user is the PostgREST role for a direct table write and the
  -- function owner inside a SECURITY DEFINER RPC (create_app_user,
  -- bootstrap_first_admin), which carry their own checks.
  IF TG_WHEN = 'AFTER' THEN
    IF current_user IN ('anon', 'authenticated')
       AND ((TG_OP = 'INSERT' AND NEW.auth_id IS NOT NULL)
            OR (TG_OP = 'UPDATE' AND NEW.auth_id IS DISTINCT FROM OLD.auth_id))
    THEN
      RAISE EXCEPTION 'AUTH_ID_READ_ONLY: the login link of a staff profile cannot be set or changed directly'
        USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END IF;

  -- 073: the service role (platform console, operator scripts) is a trusted
  -- server identity; it already bypasses RLS.
  IF current_user = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- 073: unfiltered count (SECURITY DEFINER), not an RLS-filtered sub-select.
    IF public.app_setup_needed() THEN
      RETURN NEW; -- first-ever user: legitimate self-bootstrap as ADMIN.
    END IF;
    IF v_caller_role IS DISTINCT FROM 'ADMIN' THEN
      IF NEW.role = 'ADMIN'
         OR NEW.granted_permissions IS NOT NULL
         OR NEW.revoked_permissions IS NOT NULL
         OR NEW.permissions IS NOT NULL
      THEN
        RAISE EXCEPTION 'Only an ADMIN can create a user with an elevated role or custom permission overrides.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF (NEW.role IS DISTINCT FROM OLD.role
      OR NEW.granted_permissions IS DISTINCT FROM OLD.granted_permissions
      OR NEW.revoked_permissions IS DISTINCT FROM OLD.revoked_permissions
      OR NEW.permissions IS DISTINCT FROM OLD.permissions)
     AND v_caller_role IS DISTINCT FROM 'ADMIN'
  THEN
    RAISE EXCEPTION 'Only an ADMIN can change role or permission overrides.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_guard_auth_id ON public.users;
CREATE TRIGGER users_guard_auth_id
AFTER INSERT OR UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.guard_user_privilege_columns();

-- ------------------------------------------------------------
-- 3. Assert: no existing users row was touched by this file
-- ------------------------------------------------------------
DO $$
DECLARE
  v_before text := current_setting('pos.m082_users_digest', true);
  v_after  text := COALESCE((SELECT md5(string_agg(u::text, E'\n' ORDER BY u.id)) FROM public.users u), 'empty');
BEGIN
  IF v_before IS NULL OR v_before = '' THEN
    RAISE EXCEPTION '082: users snapshot missing (run the whole file in one session)';
  END IF;
  IF v_after IS DISTINCT FROM v_before
     OR (SELECT count(*)::text FROM public.users) IS DISTINCT FROM current_setting('pos.m082_users_count', true) THEN
    RAISE EXCEPTION '082: public.users changed during the migration - aborting';
  END IF;
  RAISE NOTICE '082: public.users unchanged (% rows)', current_setting('pos.m082_users_count', true);
END $$;

NOTIFY pgrst, 'reload schema';
