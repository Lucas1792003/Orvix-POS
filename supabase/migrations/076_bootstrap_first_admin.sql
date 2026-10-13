-- ============================================================
-- Migration 076: atomic first-time setup - bootstrap_first_admin() RPC
--                (Phase G follow-up, docs/selfhost-migration/phase-g/
--                 remaining-security-fixes.md §3)
--
-- PURPOSE
--   First-time setup was three client round trips under RLS (067/069):
--   `app_setup_needed()` -> INSERT organizations (policy organizations_ins:
--   app_setup_needed()) -> INSERT users as ADMIN (policy users_ins bootstrap
--   branch: app_setup_needed() AND auth_id = auth.uid()). Nothing serialised
--   two operators on a fresh install: both saw an empty users table (the
--   other's rows uncommitted / not yet inserted), both inserts passed, and
--   the install ended with TWO organizations and TWO ADMINs (users_only_one_admin
--   is per org since 059, so it cannot catch this). The client-side re-check
--   (authStore bootstrapFirstAdmin step 3) narrows but cannot close the
--   window, and read users under RLS.
--
-- WHAT IT DOES
--   1. public.bootstrap_first_admin() RETURNS jsonb, SECURITY DEFINER,
--      search_path = public. In ONE transaction:
--        - requires a session (auth.uid()) and READ COMMITTED (PostgREST's
--          default; under REPEATABLE READ the post-lock re-check would read
--          the pre-lock snapshot, so other levels are refused);
--        - takes an install-wide transaction advisory lock
--          pg_advisory_xact_lock(76, 1) (two-key space: cannot collide with
--          idem_begin's single-key hashtext('idem:'||key) locks);
--        - re-checks app_setup_needed() INSIDE the lock - a concurrent second
--          caller blocks until the first commits, then sees its user and gets
--          SETUP_ALREADY_COMPLETED;
--        - derives email / user id / name from auth.users exactly as the
--          client did (id 'user-' || email with [^a-z0-9] -> '-', name = local
--          part with [^a-z0-9] -> ' ', fallback 'Admin'), mints the org id
--          ('org-' || uuid hex, same shape as src/lib/id.ts newId('org'));
--        - inserts the organization (the 068 AFTER INSERT trigger seeds its
--          business_profile row in the same transaction) and the ADMIN row
--          linked by auth_id. The 047/073 guard admits the ADMIN row because
--          app_setup_needed() is still true inside this transaction.
--      Returns {userId, orgId, role, name, email}. Grants: authenticated +
--      service_role (service_role has no auth.uid() -> 'Not authenticated');
--      NOT anon.
--   2. Tightens the policies so this RPC is the ONLY bootstrap path for
--      client sessions:
--        organizations_ins  WITH CHECK (false)   (kept as an explicit deny so
--                           the policy inventory stays stable; the platform
--                           console uses the service role, which bypasses RLS)
--        users_ins          bootstrap branch removed: only
--                           app_has_perm('user:create') AND org_id = app_org_id()
--      Why not "keep the policies and add the lock in a trigger": a BEFORE
--      INSERT trigger on organizations could take the lock, but the org and
--      the ADMIN row are separate client statements in separate PostgREST
--      transactions, so the lock would be released between them and the
--      check "no users yet" would have to be re-made on users - two triggers
--      cooperating across transactions, plus an orphan org left behind when
--      the second insert fails. One SECURITY DEFINER function is atomic and
--      testable; the RLS hatch it replaces was already the subject of one
--      critical finding (review correction 1).
--
-- CLIENT/SERVER COMPATIBILITY
--   The /setup page must ship with 076 (src/stores/authStore.ts
--   bootstrapFirstAdmin -> supabase.rpc('bootstrap_first_admin')).
--   Old client + 076: its direct INSERT organizations is refused by RLS ->
--   /setup shows the RLS error, nothing is created (fail closed). New client
--   without 076: the RPC is missing -> /setup shows "Could not find the
--   function", nothing is created. Production is a populated install, so
--   /setup is unreachable there either way (app_setup_needed() = false).
--
-- ROLLBACK
--   DROP FUNCTION public.bootstrap_first_admin();
--   re-run the organizations_ins / users_ins blocks of 069 (restores the
--   app_setup_needed() hatch) and ship the previous client.
-- FORWARD RECOVERY
--   Idempotent: CREATE OR REPLACE, DROP POLICY IF EXISTS + CREATE POLICY,
--   REVOKE/GRANT. Re-run the file.
--
-- VERIFICATION
--   SELECT prosecdef FROM pg_proc WHERE oid = 'public.bootstrap_first_admin()'::regprocedure;  -- t
--   SELECT has_function_privilege('anon', 'public.bootstrap_first_admin()', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.bootstrap_first_admin()', 'EXECUTE');  -- f, t
--   SELECT with_check FROM pg_policies WHERE tablename = 'organizations' AND policyname = 'organizations_ins';  -- false
--   SELECT with_check NOT LIKE '%app_setup_needed%' FROM pg_policies
--    WHERE tablename = 'users' AND policyname = 'users_ins';                                         -- t
--   -- harness: bash supabase/tests/phase-d/run.sh   (t12 concurrent bootstrap on an empty users table)
--
-- NOT applied anywhere by this change. Requires 067 (app_setup_needed),
-- 068 (business_profile seed trigger), 069 (policies), 073 (guard).
-- ============================================================

CREATE OR REPLACE FUNCTION public.bootstrap_first_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_uid uuid := auth.uid();
  v_email    text;
  v_name     text;
  v_user_id  text;
  v_org_id   text := 'org-' || replace(gen_random_uuid()::text, '-', '');
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'bootstrap_first_admin must run in a READ COMMITTED transaction';
  END IF;

  -- One bootstrap at a time, install-wide; released at commit/rollback.
  -- Two-int4 key form: a separate lock space from the single-bigint
  -- hashtext('idem:...') locks of idem_begin (062), so no collision.
  PERFORM pg_advisory_xact_lock(76, 1);

  -- Re-checked INSIDE the lock with a fresh (READ COMMITTED) snapshot, so a
  -- caller that waited sees the winner's committed ADMIN row.
  IF NOT public.app_setup_needed() THEN
    RAISE EXCEPTION 'SETUP_ALREADY_COMPLETED: first-time setup has already been completed on this install'
      USING ERRCODE = '42501';
  END IF;

  SELECT lower(btrim(u.email)) INTO v_email FROM auth.users u WHERE u.id = v_auth_uid;
  IF COALESCE(v_email, '') = '' THEN
    RAISE EXCEPTION 'This sign-in has no email address; first-time setup needs one';
  END IF;

  v_user_id := 'user-' || regexp_replace(v_email, '[^a-z0-9]', '-', 'gi');
  v_name := COALESCE(NULLIF(btrim(regexp_replace(split_part(v_email, '@', 1), '[^a-z0-9]', ' ', 'gi')), ''), 'Admin');

  -- organizations_seed_business_profile (068) adds the business_profile row.
  INSERT INTO organizations (id, name, created_at)
  VALUES (v_org_id, v_name, now());

  INSERT INTO users (id, name, email, role, org_id, auth_id, is_active, created_at)
  VALUES (v_user_id, v_name, v_email, 'ADMIN', v_org_id, v_auth_uid, true, now());

  RETURN jsonb_build_object(
    'userId', v_user_id,
    'orgId',  v_org_id,
    'role',   'ADMIN',
    'name',   v_name,
    'email',  v_email
  );
END;
$$;

COMMENT ON FUNCTION public.bootstrap_first_admin() IS
  'First-time setup (076): creates the first organization + its ADMIN for the calling auth user, atomically under an install-wide advisory lock; refuses once any app user exists.';

REVOKE ALL ON FUNCTION public.bootstrap_first_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_admin() TO authenticated, service_role;

-- The RPC is the only bootstrap path for client sessions.
DROP POLICY IF EXISTS "organizations_ins" ON organizations;
CREATE POLICY "organizations_ins" ON organizations FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "users_ins" ON users;
CREATE POLICY "users_ins" ON users FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('user:create') AND org_id = app_org_id());

NOTIFY pgrst, 'reload schema';
