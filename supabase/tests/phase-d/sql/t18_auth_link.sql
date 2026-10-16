-- t18: migration 082 - who may link a login account (users.auth_id).
-- docs/selfhost-migration/phase-f/migration-082.md
-- Part A. Runs after t17 (org-test + org-two populated). run.sh then
-- re-applies 082 to this populated database and runs t18_auth_link_b.sql,
-- which proves the re-apply left every existing users row unchanged.
--
-- Callers: u-admin (org-test ADMIN, no TOTP -> emailed-code path),
-- u-admin-x (org-two ADMIN, given a verified TOTP factor here), u-mgr-a,
-- u-cash-a1. Fresh login accounts are inserted the way staff-admin's
-- auth.admin.createUser() leaves them: never signed in, created now,
-- app_metadata {created_via: 'staff-admin', org_id: <caller org>}.
\set ON_ERROR_STOP on
\set AA   'a0000000-0000-4000-8000-000000000001'
\set AM   'a0000000-0000-4000-8000-000000000002'
\set AC   'a0000000-0000-4000-8000-000000000003'
\set AX   'a0000000-0000-4000-8000-000000000011'
\set ORPH 'a0000000-0000-4000-8000-0000000000f1'
\set F1   'd0000000-0000-4000-8000-000000000001'
\set F2   'd0000000-0000-4000-8000-000000000002'
\set F3   'd0000000-0000-4000-8000-000000000003'
\set F4   'd0000000-0000-4000-8000-000000000004'
\set F5   'd0000000-0000-4000-8000-000000000005'
\set F6   'd0000000-0000-4000-8000-000000000006'
\set F7   'd0000000-0000-4000-8000-000000000007'
\set F8   'd0000000-0000-4000-8000-000000000008'
\set F9   'd0000000-0000-4000-8000-000000000009'
\set FX   'd0000000-0000-4000-8000-00000000000a'
\set FM   'd0000000-0000-4000-8000-00000000000b'
SELECT test.logout() AS zz \gset

-- Snapshot of every pre-existing users row (whole-row text) for part B.
SELECT test.setvar('t18_users_digest', (SELECT md5(string_agg(u::text, E'\n' ORDER BY u.id)) FROM users u));
SELECT test.setvar('t18_users_count', (SELECT count(*)::text FROM users));
SELECT test.setvar('t18_links_digest', (SELECT md5(string_agg(u.id || '=' || COALESCE(u.auth_id::text, '-'), ',' ORDER BY u.id)) FROM users u));

-- ---------------------------------------------------------------- helpers
-- PostgREST-style claims with assurance level and amr (session start).
CREATE OR REPLACE FUNCTION test.login_mfa(p_auth uuid, p_aal text, p_session_start timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_auth::text, false);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_auth, 'role', 'authenticated', 'aal', p_aal,
    'amr', CASE WHEN p_session_start IS NULL THEN '[]'::jsonb
                ELSE jsonb_build_array(jsonb_build_object('method', 'password',
                       'timestamp', floor(extract(epoch FROM p_session_start))::bigint)) END)::text, false);
END $$;
-- create_app_user call as SQL text (for expect_error)
CREATE OR REPLACE FUNCTION test.t18_call(p_id text, p_email text, p_auth uuid, p_shop text, p_key uuid)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format($q$SELECT public.create_app_user(%L, 'T18 Staff', %L, 'CASHIER', %L, %L::uuid, NULL, NULL, %L::uuid)$q$,
                p_id, p_email, p_shop, p_auth, p_key);
$$;
-- an auth account as staff-admin creates it
CREATE OR REPLACE FUNCTION test.t18_auth(p_id uuid, p_email text, p_org text,
  p_created timestamptz DEFAULT now(), p_signed_in timestamptz DEFAULT NULL, p_via text DEFAULT 'staff-admin')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, email, created_at, last_sign_in_at, raw_app_meta_data)
  VALUES (p_id, p_email, p_created, p_signed_in,
          CASE WHEN p_org IS NULL AND p_via IS NULL THEN '{"provider":"email"}'::jsonb
               ELSE jsonb_strip_nulls(jsonb_build_object('provider', 'email', 'created_via', p_via, 'org_id', p_org)) END);
$$;

-- true when the statement raises or touches no row
CREATE OR REPLACE FUNCTION test.t18_zero_or_denied(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    RETURN true;
  END;
  RETURN v_n = 0;
END $$;

-- ---------------------------------------------------------------- fixtures
SELECT test.t18_auth(:'F1', 'f1@t18.local', 'org-test');                                   -- good
SELECT test.t18_auth(:'F2', 'f2@t18.local', 'org-test');                                   -- linked twice
SELECT test.t18_auth(:'F3', 'f3@t18.local', 'org-two');                                    -- other org's marker
SELECT test.t18_auth(:'F4', 'f4@t18.local', NULL, now(), NULL, NULL);                      -- orphan, no marker
SELECT test.t18_auth(:'F5', 'f5@t18.local', 'org-test', now() - interval '30 days', now() - interval '29 days'); -- old, signed in
SELECT test.t18_auth(:'F6', 'f6@t18.local', 'org-test');                                   -- platform admin
SELECT test.t18_auth(:'F7', 'f7@t18.local', 'org-test');                                   -- email mismatch
SELECT test.t18_auth(:'F8', 'f8@t18.local', 'org-test', now() - interval '1 hour');        -- stale, never signed in
SELECT test.t18_auth(:'F9', 'f9@t18.local', 'org-test', now(), now());                     -- fresh but signed in
SELECT test.t18_auth(:'FX', 'fx@t18.local', 'org-two');                                    -- org-two good
SELECT test.t18_auth(:'FM', 'fm@t18.local', 'org-test');                                   -- direct-insert target
INSERT INTO platform_admins (auth_id, name, email) VALUES (:'F6', 'T18 Platform', 'f6@t18.local');
-- org-two ADMIN enrolled a TOTP authenticator
INSERT INTO auth.mfa_factors (user_id, factor_type, status) VALUES (:'AX', 'totp', 'verified');
-- u-admin (no TOTP) entered an emailed code 5 minutes ago
INSERT INTO admin_login_codes (auth_id, code_hash, expires_at, consumed_at, created_at)
VALUES (:'AA', 't18', now() + interval '5 minutes', now() - interval '5 minutes', now() - interval '6 minutes');

-- ---------------------------------------------------------------- happy path
-- u-admin: session signed in 10 min ago, code consumed 5 min ago (after it)
SELECT test.login_mfa(:'AA', 'aal1', now() - interval '10 minutes') AS zz \gset
SET ROLE authenticated;
SELECT public.create_app_user('u-t18-f1', 'T18 Staff', 'F1@t18.local ', 'CASHIER', 'shop-a', :'F1', NULL, NULL, 'eeeeeeee-0000-4000-8000-000000000001') AS r1 \gset
SELECT public.create_app_user('u-t18-f1', 'T18 Staff', 'F1@t18.local ', 'CASHIER', 'shop-a', :'F1', NULL, NULL, 'eeeeeeee-0000-4000-8000-000000000001') AS r1b \gset
RESET ROLE;
SELECT test.check('t18 admin links a fresh staff-admin account of its org (email-code verified session)',
  (:'r1'::jsonb->>'authId') = :'F1' AND (:'r1'::jsonb->>'orgId') = 'org-test'
  AND (SELECT auth_id = :'F1' AND org_id = 'org-test' AND role = 'CASHIER' FROM users WHERE id = 'u-t18-f1')
  AND (SELECT count(*) FROM audit_logs WHERE entity_id = 'u-t18-f1' AND action_type = 'USER_CREATED') = 1,
  left(:'r1', 160));
SELECT test.check('t18 replay of the successful link returns the stored response (no second row)',
  :'r1'::jsonb = :'r1b'::jsonb AND (SELECT count(*) FROM users WHERE auth_id = :'F1') = 1);

-- ---------------------------------------------------------------- refused targets (u-admin, verified)
SELECT test.login_mfa(:'AA', 'aal1', now() - interval '10 minutes') AS zz \gset
SET ROLE authenticated;
SELECT public.create_app_user('u-t18-f2', 'T18 Staff', 'f2@t18.local', 'CASHIER', 'shop-a', :'F2', NULL, NULL, 'eeeeeeee-0000-4000-8000-000000000002') AS zz \gset
SELECT test.expect_error('t18 linking an already-linked account (fresh, same org) to a second row is refused',
  test.t18_call('u-t18-f2b', 'f2@t18.local', :'F2', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000003'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking an existing staff member''s account (seeded cashier) is refused',
  test.t18_call('u-t18-c', 'cash-a1@test.local', :'AC', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000004'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking another organization''s ADMIN account is refused',
  test.t18_call('u-t18-x', 'admin-x@two.local', :'AX', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000005'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking an account staff-admin created for another org is refused',
  test.t18_call('u-t18-f3', 'f3@t18.local', :'F3', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000006'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking a fresh orphan account without the staff-admin marker is refused',
  test.t18_call('u-t18-f4', 'f4@t18.local', :'F4', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000007'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking the old orphan sign-up account (t10) is refused',
  test.t18_call('u-t18-o', 'orphan@review.local', :'ORPH', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000008'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking an old, previously signed-in account (even with the marker) is refused',
  test.t18_call('u-t18-f5', 'f5@t18.local', :'F5', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000009'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking a fresh account that has already signed in is refused',
  test.t18_call('u-t18-f9', 'f9@t18.local', :'F9', 'shop-a', 'eeeeeeee-0000-4000-8000-00000000000a'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking a marked account older than 15 minutes is refused',
  test.t18_call('u-t18-f8', 'f8@t18.local', :'F8', 'shop-a', 'eeeeeeee-0000-4000-8000-00000000000b'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking a platform admin''s account is refused',
  test.t18_call('u-t18-f6', 'f6@t18.local', :'F6', 'shop-a', 'eeeeeeee-0000-4000-8000-00000000000c'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking with an email that differs from the account''s is refused',
  test.t18_call('u-t18-f7', 'other@t18.local', :'F7', 'shop-a', 'eeeeeeee-0000-4000-8000-00000000000d'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking the caller''s own account is refused',
  test.t18_call('u-t18-self', 'admin@test.local', :'AA', 'shop-a', 'eeeeeeee-0000-4000-8000-00000000000e'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 linking a non-existent auth id is refused',
  test.t18_call('u-t18-nx', 'nx@t18.local', 'd0000000-0000-4000-8000-0000000000ff', 'shop-a', 'eeeeeeee-0000-4000-8000-00000000000f'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT test.expect_error('t18 cross-org: org-test ADMIN cannot create a linked row in an org-two shop',
  test.t18_call('u-t18-xs', 'fx@t18.local', :'FX', 'shop-x', 'eeeeeeee-0000-4000-8000-000000000010'), 'Shop not found in your organization');
RESET ROLE;
SELECT test.check('t18 refused links created no users row and no USER_CREATED audit row',
  (SELECT count(*) FROM users WHERE id LIKE 'u-t18-%') = 2
  AND NOT EXISTS (SELECT 1 FROM users WHERE auth_id IN (:'F3', :'F4', :'F5', :'F6', :'F7', :'F8', :'F9', :'FX', :'ORPH'))
  AND (SELECT count(*) FROM audit_logs WHERE entity_id LIKE 'u-t18-%' AND action_type = 'USER_CREATED') = 2,
  (SELECT string_agg(id, ',') FROM users WHERE id LIKE 'u-t18-%'));

-- ---------------------------------------------------------------- caller assurance
-- email-code ADMIN whose code was consumed BEFORE this session signed in
SELECT test.login_mfa(:'AA', 'aal1', now() - interval '1 minute') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 email-2FA ADMIN: code consumed before this session signed in -> refused',
  test.t18_call('u-t18-e1', 'fm@t18.local', :'FM', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000011'), 'VERIFICATION_REQUIRED');
RESET ROLE;
-- claims without amr
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 email-2FA ADMIN: JWT without amr -> refused (fail closed)',
  test.t18_call('u-t18-e2', 'fm@t18.local', :'FM', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000012'), 'VERIFICATION_REQUIRED');
SELECT test.check('t18 unlinked profile (p_auth_id NULL) still creatable without the link checks (t06 behaviour)',
  (public.create_app_user('u-t18-nolink', 'T18 Nolink', 'nolink@t18.local', 'CASHIER', 'shop-a', NULL, NULL, NULL,
     'eeeeeeee-0000-4000-8000-000000000013')->>'authId') IS NULL);
RESET ROLE;
-- TOTP ADMIN of org-two on aal1 / aal2
SELECT test.login_mfa(:'AX', 'aal1', now() - interval '1 minute') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 TOTP ADMIN on an aal1 session -> MFA_REQUIRED',
  test.t18_call('u-t18-x1', 'fx@t18.local', :'FX', 'shop-x', 'eeeeeeee-0000-4000-8000-000000000014'), 'MFA_REQUIRED');
RESET ROLE;
SELECT test.login_mfa(:'AX', 'aal2', now() - interval '1 minute') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 cross-org: org-two ADMIN (aal2) cannot link an account created for org-test',
  test.t18_call('u-t18-x2', 'fm@t18.local', :'FM', 'shop-x', 'eeeeeeee-0000-4000-8000-000000000015'), 'AUTH_ACCOUNT_NOT_LINKABLE');
SELECT public.create_app_user('u-t18-fx', 'T18 Staff', 'fx@t18.local', 'CASHIER', 'shop-x', :'FX', NULL, NULL, 'eeeeeeee-0000-4000-8000-000000000016') AS rx \gset
RESET ROLE;
SELECT test.check('t18 TOTP ADMIN on aal2 links a fresh account created for its org',
  (SELECT auth_id = :'FX' AND org_id = 'org-two' FROM users WHERE id = 'u-t18-fx'), left(:'rx', 160));

-- ---------------------------------------------------------------- non-admin callers
SELECT test.login_mfa(:'AC', 'aal1', now() - interval '1 minute') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 cashier cannot link an account',
  test.t18_call('u-t18-n1', 'fm@t18.local', :'FM', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000017'), 'not permitted to create users');
RESET ROLE;
SELECT test.login_mfa(:'AM', 'aal1', now() - interval '1 minute') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 manager without user:create cannot link an account',
  test.t18_call('u-t18-n2', 'fm@t18.local', :'FM', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000018'), 'not permitted to create users');
RESET ROLE;
SELECT test.login(:'ORPH') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 orphan auth account (no users row) cannot link an account',
  test.t18_call('u-t18-n3', 'fm@t18.local', :'FM', 'shop-a', 'eeeeeeee-0000-4000-8000-000000000019'), 'Not authenticated');
RESET ROLE;
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('t18 anon cannot execute create_app_user',
  test.t18_call('u-t18-n4', 'fm@t18.local', :'FM', 'shop-a', 'eeeeeeee-0000-4000-8000-00000000001a'), 'permission denied');
RESET ROLE;

-- ---------------------------------------------------------------- direct table writes
SELECT test.login_mfa(:'AA', 'aal1', now() - interval '10 minutes') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 direct UPDATE users SET auth_id (re-link a staff row) is refused for an ADMIN',
  format($q$UPDATE users SET auth_id = %L WHERE id = 'u-cash-a2'$q$, :'FM'), 'AUTH_ID_READ_ONLY');
SELECT test.expect_error('t18 direct UPDATE users SET auth_id = NULL (unlink) is refused for an ADMIN',
  $q$UPDATE users SET auth_id = NULL WHERE id = 'u-cash-a2'$q$, 'AUTH_ID_READ_ONLY');
SELECT test.expect_error('t18 direct INSERT users with auth_id is refused for an ADMIN',
  format($q$INSERT INTO users (id, name, email, role, shop_id, org_id, auth_id) VALUES ('u-t18-d1', 'D', 'fm@t18.local', 'CASHIER', 'shop-a', 'org-test', %L)$q$, :'FM'),
  'AUTH_ID_READ_ONLY');
SELECT test.check('t18 positive control: ADMIN direct UPDATE of other columns still works (1 row)',
  test.affected($q$UPDATE users SET name = 'Cashier A2' WHERE id = 'u-cash-a2'$q$) = 1);
SELECT test.check('t18 positive control: ADMIN direct INSERT of an unlinked row still works (1 row)',
  test.affected($q$INSERT INTO users (id, name, email, role, shop_id, org_id) VALUES ('u-t18-d2', 'D2', 'd2@t18.local', 'CASHIER', 'shop-a', 'org-test')$q$) = 1);
SELECT test.expect_error('t18 direct UPDATE linking that unlinked row is refused',
  format($q$UPDATE users SET auth_id = %L WHERE id = 'u-t18-d2'$q$, :'FM'), 'AUTH_ID_READ_ONLY');
RESET ROLE;
SELECT test.login_mfa(:'AC', 'aal1', now() - interval '1 minute') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t18 cashier direct UPDATE of auth_id touches nothing (RLS) and links nothing',
  test.affected(format($q$UPDATE users SET auth_id = %L WHERE id = 'u-cash-a1'$q$, :'FM')) = 0);
RESET ROLE;
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.t18_zero_or_denied(format($q$UPDATE users SET auth_id = %L WHERE id = 'u-cash-a1'$q$, :'FM')) AS anon_upd \gset
RESET ROLE;
SELECT test.check('t18 anon direct UPDATE of auth_id is refused or touches nothing', :'anon_upd'::boolean
  AND (SELECT auth_id = :'AC' FROM users WHERE id = 'u-cash-a1'));
SELECT test.as_service_role() AS zz \gset
SET ROLE service_role;
SELECT test.check('t18 service_role (platform console) can still set auth_id',
  test.affected(format($q$UPDATE users SET auth_id = %L WHERE id = 'u-t18-d2'$q$, :'FM')) = 1
  AND test.affected($q$UPDATE users SET auth_id = NULL WHERE id = 'u-t18-d2'$q$) = 1);
RESET ROLE;
SELECT test.logout() AS zz \gset

SELECT test.check('t18 seeded links untouched by every refused attempt',
  (SELECT auth_id FROM users WHERE id = 'u-cash-a2') = 'a0000000-0000-4000-8000-000000000004'
  AND (SELECT auth_id FROM users WHERE id = 'u-cash-a1') = :'AC'
  AND NOT EXISTS (SELECT 1 FROM users WHERE auth_id = :'FM'));

-- ---------------------------------------------------------------- inventory
SELECT test.check('t18 inventory: anon-executable public functions still exactly 3 (2 from 083: completion is service_role-only)',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')) = CASE WHEN test.m083() THEN 2 ELSE 3 END);
SELECT test.check('t18 inventory: 30 RPCs carry p_idempotency_key; create_app_user authenticated-only, SECURITY DEFINER',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_function_identity_arguments(p.oid) LIKE '%p_idempotency_key%') = 30
  AND has_function_privilege('authenticated', 'public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)', 'EXECUTE')
  AND (SELECT prosecdef FROM pg_proc WHERE oid = 'public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)'::regprocedure));
SELECT test.check('t18 inventory: users_guard_auth_id is an AFTER INSERT OR UPDATE row trigger on users',
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'users_guard_auth_id'
      AND tgenabled = 'O' AND (tgtype & 2) = 0 AND (tgtype & 1) = 1 AND (tgtype & 4) = 4 AND (tgtype & 16) = 16) = 1);
SELECT test.check('t18 pre-existing users rows unchanged by the t18 run (except the u-cash-a2 name no-op)',
  (SELECT md5(string_agg(u::text, E'\n' ORDER BY u.id)) FROM users u WHERE u.id NOT LIKE 'u-t18-%') = test.var('t18_users_digest'));

-- digest for part B (after the re-apply of 082)
SELECT test.setvar('t18_users_digest_b', (SELECT md5(string_agg(u::text, E'\n' ORDER BY u.id)) FROM users u));
SELECT test.setvar('t18_users_count_b', (SELECT count(*)::text FROM users));
