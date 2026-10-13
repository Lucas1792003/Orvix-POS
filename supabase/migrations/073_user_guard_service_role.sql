-- ============================================================
-- Migration 073: guard_user_privilege_columns() - trust the service role and
--                count users without RLS (Phase G review follow-up)
--
-- PURPOSE
--   Two defects in the 047 trigger `users_guard_privilege_columns`
--   (BEFORE INSERT OR UPDATE ON users):
--
--   1. Second organization cannot be created. The platform console
--      (supabase/functions/platform-console, action create_organization)
--      inserts the new org's first ADMIN with the SERVICE ROLE key. The
--      service role has no app `users` row, so app_role() is NULL, and once
--      any user exists the guard raises "Only an ADMIN can create a user with
--      an elevated role ..." - every console-created org after the first
--      fails (the console then deletes the org and the auth user again).
--      Reproduced in supabase/tests/phase-d/sql/t11_second_org.sql.
--
--   2. The first-user bypass `IF NOT EXISTS (SELECT 1 FROM users)` runs as the
--      CALLER (the function is not SECURITY DEFINER), so it is RLS-filtered.
--      Since 069 scoped users_sel by organization, a caller without an active
--      users row sees zero users and the bypass fires on a populated install.
--      069 now closes the RLS side (users_ins/organizations_ins use
--      app_setup_needed()); this file closes the trigger side the same way
--      (defence in depth - both layers must agree).
--
-- WHAT IT DOES
--   CREATE OR REPLACE guard_user_privilege_columns() with exactly two changes
--   to the 047 body:
--     * `IF current_user = 'service_role' THEN RETURN NEW; END IF;` first.
--       current_user is the role PostgREST switched to after verifying the
--       JWT signature (service key -> service_role); it cannot be forged by a
--       client the way a request GUC could, and it is NOT the role inside a
--       SECURITY DEFINER RPC (those run as the function owner `postgres` and
--       keep going through the normal app_role() checks). The service role
--       already bypasses RLS and holds every table grant; this only stops the
--       guard from contradicting it.
--     * the first-user test uses public.app_setup_needed() (067, SECURITY
--       DEFINER, unfiltered count) instead of the RLS-filtered sub-select.
--   Asserts users_only_one_admin is the PER-ORG partial unique index from 059
--   (ON users (org_id) WHERE role = 'ADMIN'); recreates it if it is missing or
--   global, so "one ADMIN per organization" (not per install) holds.
--   No grant changes (trigger function; 064 grant shape kept).
--
-- ISOLATION IMPACT
--   None weakened: authenticated callers (incl. any org ADMIN) are still
--   bound by users_ins / users_upd (org_id = app_org_id()) and by this guard;
--   anon has no INSERT grant on users. Only the service role - i.e. the
--   platform console / operator scripts, which already bypass RLS - gains the
--   ability to write role/permission columns.
--
-- ROLLBACK
--   Re-run the CREATE OR REPLACE FUNCTION block of
--   047_guard_user_privilege_columns.sql (same signature, trigger untouched).
--   The index step is a no-op on a schema that already has the 059 index.
--
-- VERIFICATION
--   SELECT prosrc LIKE '%current_user = ''service_role''%'
--      AND prosrc LIKE '%app_setup_needed()%'
--     FROM pg_proc WHERE proname = 'guard_user_privilege_columns';      -- t
--   SELECT pg_get_indexdef('users_only_one_admin'::regclass);
--     -- ... ON public.users USING btree (org_id) WHERE (role = 'ADMIN'::text)
--   -- harness: bash supabase/tests/phase-d/run.sh  (t11_second_org)
--
-- NOT applied anywhere by this change. Requires 067 (app_setup_needed).
-- Idempotent (CREATE OR REPLACE; index recreated only when wrong).
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_user_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_caller_role text := app_role();
BEGIN
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

-- One ADMIN per ORGANIZATION (059), never one per install.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.users_only_one_admin');
  IF v_def IS NULL OR v_def NOT LIKE '%(org_id) WHERE (role = ''ADMIN''::text)%' THEN
    RAISE NOTICE '073: users_only_one_admin missing or not per-org (%); recreating', COALESCE(v_def, 'absent');
    DROP INDEX IF EXISTS public.users_only_one_admin;
    CREATE UNIQUE INDEX users_only_one_admin ON public.users (org_id) WHERE role = 'ADMIN';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
