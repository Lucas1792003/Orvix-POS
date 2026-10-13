-- t12: the four open items of the Phase G independent review
-- (docs/selfhost-migration/phase-g/remaining-security-fixes.md).
-- Runs after t11 (reuses the org-two seed of t09) and only when migrations
-- >= 074 are applied (run.sh gates it). Sections 2 and 3 additionally check
-- that 075 / 076 are present and print SKIP otherwise.
--   1. (074) idempotency replay bound to the caller's organization:
--      create_supplier / shop-less log_audit_event replayed by another org
--      with the same key + payload -> IDEMPOTENCY_MISMATCH, no stored
--      response, no side effect; same actor -> stored response; same org,
--      different actor -> stored response (documented choice); sweep over
--      EVERY key row the earlier tests committed (all RPC kinds in the
--      ledger) through idem_begin as a foreign-org caller.
--   2. (075) expired phone-upload session: completion rejected with
--      'Upload link is no longer active', expiry derivable and persisted by
--      the next status read; cancelled / completed still rejected; a valid
--      session completes.
--   3. (076) bootstrap_first_admin on a POPULATED install is refused for
--      everyone; anon cannot execute it; the RLS bootstrap hatch is gone.
--      The empty-install + concurrency half runs LAST from run.sh
--      (t12_bootstrap_*.sql) because it empties public.users.
\set ON_ERROR_STOP on
\set AA   'a0000000-0000-4000-8000-000000000001'
\set MA   'a0000000-0000-4000-8000-000000000002'
\set AX   'a0000000-0000-4000-8000-000000000011'
\set ORPH 'a0000000-0000-4000-8000-0000000000f1'
\set K1 '12121212-0000-4000-8000-000000000001'
\set K2 '12121212-0000-4000-8000-000000000002'
\set K3 '12121212-0000-4000-8000-000000000003'
\set K4 '12121212-0000-4000-8000-000000000004'
SELECT test.logout() AS zz \gset

-- ============================================================
-- 1. Idempotency replay bound to the caller's organization (074)
-- ============================================================
SELECT test.check('t12/074: idempotency_keys.org_id exists', test.col_exists('idempotency_keys', 'org_id'));

-- 1a. create_supplier (no shop/entity argument -> the 070 guard cannot help)
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_supplier('SUPT12', 'Supplier T12', NULL, NULL, NULL, NULL, NULL, :'K1') AS su1 \gset
SELECT public.create_supplier('SUPT12', 'Supplier T12', NULL, NULL, NULL, NULL, NULL, :'K1') AS su2 \gset
RESET ROLE;
SELECT test.check('t12/074: create_supplier same-actor replay returns the stored response',
  :'su1'::jsonb = :'su2'::jsonb AND :'su1'::jsonb = (SELECT response FROM idempotency_keys WHERE key = :'K1'));
SELECT test.check('t12/074: key row records actor and org of the first caller',
  (SELECT actor_id = 'u-admin' AND org_id = 'org-test' FROM idempotency_keys WHERE key = :'K1'));
SELECT count(*) AS sup_two_before FROM suppliers WHERE org_id = 'org-two' \gset

SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/074: org B ADMIN replaying org A''s create_supplier key (same payload) gets IDEMPOTENCY_MISMATCH, not the stored response',
  format($q$SELECT public.create_supplier('SUPT12', 'Supplier T12', NULL, NULL, NULL, NULL, NULL, '%s')$q$, :'K1'),
  'IDEMPOTENCY_MISMATCH');
RESET ROLE;
SELECT test.check('t12/074: the rejected foreign replay created nothing in org B and left the key row untouched',
  (SELECT count(*) FROM suppliers WHERE org_id = 'org-two') = :sup_two_before
  AND NOT EXISTS (SELECT 1 FROM suppliers WHERE org_id = 'org-two' AND code = 'SUPT12')
  AND (SELECT org_id = 'org-test' AND response = :'su1'::jsonb FROM idempotency_keys WHERE key = :'K1'));

-- 1b. log_audit_event without a shop
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.log_audit_event('PRODUCT_EDIT', 't12 shop-less audit', 'Product', 'prod-1', NULL, :'K2') AS ae1 \gset
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/074: org B ADMIN replaying org A''s shop-less log_audit_event key gets IDEMPOTENCY_MISMATCH',
  format($q$SELECT public.log_audit_event('PRODUCT_EDIT', 't12 shop-less audit', 'Product', 'prod-1', NULL, '%s')$q$, :'K2'),
  'IDEMPOTENCY_MISMATCH');
RESET ROLE;
SELECT test.check('t12/074: exactly one audit row for the shop-less event (no org B row)',
  (SELECT count(*) FROM audit_logs WHERE message = 't12 shop-less audit') = 1);

-- 1c. same organization, different actor: replay returns the stored
--     response (documented: binding is per ORGANIZATION; see 074 header)
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT public.log_audit_event('PRODUCT_EDIT', 't12 shop-less audit', 'Product', 'prod-1', NULL, :'K2') AS ae2 \gset
RESET ROLE;
SELECT test.check('t12/074: same-org different actor (MANAGER replays ADMIN''s key) gets the stored response, no second row',
  :'ae1'::jsonb = :'ae2'::jsonb
  AND (SELECT count(*) FROM audit_logs WHERE message = 't12 shop-less audit') = 1
  AND (SELECT actor_id FROM idempotency_keys WHERE key = :'K2') = 'u-admin');

-- 1d. the payload-mismatch error is unchanged and indistinguishable
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/074: same actor, different payload -> IDEMPOTENCY_MISMATCH (062 semantics kept)',
  format($q$SELECT public.log_audit_event('PRODUCT_EDIT', 't12 other text', 'Product', 'prod-1', NULL, '%s')$q$, :'K2'),
  'IDEMPOTENCY_MISMATCH');
RESET ROLE;

-- 1e. a key row without an organization (legacy row whose actor is
--     unknown) is never replayed to an org caller (fail closed)
INSERT INTO idempotency_keys (key, rpc, actor_id, org_id, request_hash, response)
VALUES (:'K3', 'log_audit_event', NULL, NULL, 'legacy-hash', '{"legacy": true}');
SELECT test.login(:'AA') AS zz \gset
SELECT test.expect_error('t12/074: legacy key row with NULL org is not replayed to an org caller',
  format($q$SELECT public.idem_begin('%s', 'log_audit_event', 'legacy-hash')$q$, :'K3'), 'IDEMPOTENCY_MISMATCH');
SELECT test.logout() AS zz \gset

-- 1f. structural: every idempotent RPC gets replays only through idem_begin
SELECT test.check('t12/074: all 30 p_idempotency_key RPCs call idem_begin(p_idempotency_key, ''<own name>'', ...)',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_function_identity_arguments(p.oid) LIKE '%p_idempotency_key%'
      AND p.prosrc LIKE '%public.idem_begin(p_idempotency_key, ''' || p.proname || '''%') = 30);
SELECT test.check('t12/074: no function other than idem_begin / idem_finish / prune_idempotency_keys reads idempotency_keys',
  (SELECT COALESCE(array_agg(p.proname::text ORDER BY p.proname), '{}') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc LIKE '%idempotency_keys%')
  = ARRAY['idem_begin', 'idem_finish', 'prune_idempotency_keys'],
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc LIKE '%idempotency_keys%'));
SELECT test.check('t12/074: every key row with a known actor carries that actor''s org',
  NOT EXISTS (SELECT 1 FROM idempotency_keys k JOIN users u ON u.id = k.actor_id WHERE k.org_id IS DISTINCT FROM u.org_id));

-- 1g. sweep: every key row committed by t02-t12 (all RPC kinds in the
--     ledger), presented to idem_begin by a caller of ANOTHER organization,
--     must raise IDEMPOTENCY_MISMATCH; presented by its own actor it must
--     replay the stored response.
DO $$
DECLARE
  r record;
  v_resp jsonb;
  v_same uuid;
  n_total int := 0; n_blocked int := 0; n_leaked int := 0;
  n_same int := 0; n_same_ok int := 0;
  v_leaks text := '';
BEGIN
  FOR r IN SELECT k.key, k.rpc, k.request_hash, k.response, k.org_id, k.actor_id
             FROM idempotency_keys k WHERE k.org_id IS NOT NULL ORDER BY k.created_at LOOP
    n_total := n_total + 1;
    -- a caller of a different organization
    PERFORM test.login(CASE WHEN r.org_id = 'org-test'
                            THEN 'a0000000-0000-4000-8000-000000000011'::uuid
                            ELSE 'a0000000-0000-4000-8000-000000000001'::uuid END);
    BEGIN
      v_resp := public.idem_begin(r.key, r.rpc, r.request_hash);
      n_leaked := n_leaked + 1;
      v_leaks := v_leaks || r.rpc || ' ';
    EXCEPTION WHEN unique_violation THEN
      IF SQLERRM LIKE 'IDEMPOTENCY_MISMATCH%' THEN n_blocked := n_blocked + 1; END IF;
    END;
    -- the original actor
    SELECT u.auth_id INTO v_same FROM users u WHERE u.id = r.actor_id;
    IF v_same IS NOT NULL THEN
      n_same := n_same + 1;
      PERFORM test.login(v_same);
      BEGIN
        v_resp := public.idem_begin(r.key, r.rpc, r.request_hash);
        IF v_resp IS NOT DISTINCT FROM COALESCE(r.response, '{}'::jsonb) THEN n_same_ok := n_same_ok + 1; END IF;
      EXCEPTION WHEN OTHERS THEN
        NULL;  -- counted as not replayed
      END;
    END IF;
  END LOOP;
  PERFORM test.logout();
  PERFORM test.setvar('t12_sweep_total', n_total::text);
  PERFORM test.setvar('t12_sweep_blocked', n_blocked::text);
  PERFORM test.setvar('t12_sweep_leaked', n_leaked::text || ' ' || v_leaks);
  PERFORM test.setvar('t12_sweep_same', n_same::text);
  PERFORM test.setvar('t12_sweep_same_ok', n_same_ok::text);
  PERFORM test.setvar('t12_sweep_rpcs', (SELECT count(DISTINCT rpc)::text FROM idempotency_keys WHERE org_id IS NOT NULL));
END $$;
SELECT test.check('t12/074: sweep - no stored key row is replayed to a caller of another organization',
  test.var('t12_sweep_total')::int > 0 AND test.var('t12_sweep_blocked') = test.var('t12_sweep_total'),
  'rows=' || test.var('t12_sweep_total') || ' distinct_rpcs=' || test.var('t12_sweep_rpcs')
  || ' blocked=' || test.var('t12_sweep_blocked') || ' leaked=' || test.var('t12_sweep_leaked'));
SELECT test.check('t12/074: sweep - every key row replays to its own actor',
  test.var('t12_sweep_same_ok') = test.var('t12_sweep_same'),
  'same-actor rows=' || test.var('t12_sweep_same') || ' replayed=' || test.var('t12_sweep_same_ok'));
SELECT 'INFO sweep covered ' || test.var('t12_sweep_total') || ' key rows over '
       || test.var('t12_sweep_rpcs') || ' distinct RPCs: '
       || (SELECT string_agg(DISTINCT rpc, ',') FROM idempotency_keys WHERE org_id IS NOT NULL);

-- ============================================================
-- 2. Expired phone-upload sessions (075)
-- ============================================================
\set url_base 'https://pos.test/storage/v1/object/public/product-images/'
SELECT (SELECT prosrc LIKE '%075%' AND prosrc NOT LIKE '%has expired%'
          FROM pg_proc WHERE proname = 'complete_product_image_upload_session') AS has075 \gset
\if :has075
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS s1 \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS s2 \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS s3 \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS s4 \gset
SELECT public.attach_product_image_upload_session_token(:'s1'::jsonb->>'sessionId', 'signed-t12-s1') AS zz \gset
-- the public URL the phone page sends: getPublicUrl(<session storagePath>)
-- (079 requires it to end with the session's own object path)
SELECT :'url_base' || (:'s1'::jsonb->>'storagePath') AS url_s1, :'url_base' || (:'s3'::jsonb->>'storagePath') AS url_s3,
       :'url_base' || (:'s4'::jsonb->>'storagePath') AS url_s4 \gset
RESET ROLE;
-- s1 / s2 expire (superuser moves the clock of the row, not of the server)
UPDATE product_image_upload_sessions SET expires_at = now() - interval '1 minute'
 WHERE id IN (:'s1'::jsonb->>'sessionId', :'s2'::jsonb->>'sessionId');

SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('t12/075: anon completion of an EXPIRED session is rejected with the common message',
  format($q$SELECT public.complete_product_image_upload_session('%s', '%s', '%s', 1000, 'image/webp')$q$,
         :'s1'::jsonb->>'token', :'s1'::jsonb->>'storagePath', :'url_s1'),
  'Upload link is no longer active');
RESET ROLE;
SELECT test.check('t12/075: rejected completion wrote nothing; the row is derivably expired (PENDING, expires_at past, not completed)',
  (SELECT status = 'PENDING' AND expires_at <= now() AND completed_at IS NULL AND public_url IS NULL
     FROM product_image_upload_sessions WHERE id = :'s1'::jsonb->>'sessionId'));
-- the desktop's status poll derives and PERSISTS the expiry
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status(:'s1'::jsonb->>'sessionId') AS st1 \gset
RESET ROLE;
SELECT test.check('t12/075: status poll reports EXPIRED and the session ends EXPIRED with the signed token cleared',
  :'st1'::jsonb->>'status' = 'EXPIRED'
  AND (SELECT status = 'EXPIRED' AND signed_upload_token IS NULL
         FROM product_image_upload_sessions WHERE id = :'s1'::jsonb->>'sessionId'));
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('t12/075: completion after the session is marked EXPIRED is still rejected (same message)',
  format($q$SELECT public.complete_product_image_upload_session('%s', '%s', '%s', 1000, 'image/webp')$q$,
         :'s1'::jsonb->>'token', :'s1'::jsonb->>'storagePath', :'url_s1'),
  'Upload link is no longer active');
-- the phone page's first call (by token, anon) also persists the expiry
SELECT public.get_product_image_upload_session_by_token(:'s2'::jsonb->>'token') AS bt2 \gset
RESET ROLE;
SELECT test.check('t12/075: by-token read of an expired session reports EXPIRED, hands out no upload token, persists EXPIRED',
  :'bt2'::jsonb->>'status' = 'EXPIRED' AND (:'bt2'::jsonb->'uploadToken') = 'null'::jsonb
  AND (SELECT status FROM product_image_upload_sessions WHERE id = :'s2'::jsonb->>'sessionId') = 'EXPIRED');

-- cancelled session
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.cancel_product_image_upload_session(:'s3'::jsonb->>'sessionId') AS zz \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('t12/075: completion of a CANCELED session is rejected',
  format($q$SELECT public.complete_product_image_upload_session('%s', '%s', '%s', 1000, 'image/webp')$q$,
         :'s3'::jsonb->>'token', :'s3'::jsonb->>'storagePath', :'url_s3'),
  'Upload link is no longer active');

-- valid session completes; completing it again is rejected
SELECT public.complete_product_image_upload_session(:'s4'::jsonb->>'token', :'s4'::jsonb->>'storagePath',
  :'url_s4', 1000, 'image/webp') AS c4 \gset
RESET ROLE;
SELECT test.check('t12/075: a valid (PENDING, unexpired) session still completes',
  :'c4'::jsonb->>'status' = 'COMPLETED'
  AND (SELECT status = 'COMPLETED' AND completed_at IS NOT NULL AND bytes = 1000
         FROM product_image_upload_sessions WHERE id = :'s4'::jsonb->>'sessionId'));
SET ROLE anon;
SELECT test.expect_error('t12/075: completion of an already COMPLETED session is rejected',
  format($q$SELECT public.complete_product_image_upload_session('%s', '%s', '%s', 1000, 'image/webp')$q$,
         :'s4'::jsonb->>'token', :'s4'::jsonb->>'storagePath', :'url_s4'),
  'Upload link is no longer active');
RESET ROLE;
SELECT test.check('t12/075: anon still executes complete_product_image_upload_session (064 grant kept)',
  has_function_privilege('anon', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE'));
\else
SELECT 'SKIP t12 section 2 (075 not applied)';
\endif

-- ============================================================
-- 3. bootstrap_first_admin on a POPULATED install (076)
-- ============================================================
SELECT to_regprocedure('public.bootstrap_first_admin()') IS NOT NULL AS has076 \gset
\if :has076
SELECT count(*) AS orgs_before FROM organizations \gset
SELECT test.check('t12/076: bootstrap_first_admin is SECURITY DEFINER, authenticated-only (not anon)',
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public.bootstrap_first_admin()'::regprocedure)
  AND NOT has_function_privilege('anon', 'public.bootstrap_first_admin()', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.bootstrap_first_admin()', 'EXECUTE'));
SELECT test.check('t12/076: organizations_ins is an explicit deny; users_ins has no app_setup_needed() hatch',
  (SELECT with_check = 'false' FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'organizations_ins')
  AND (SELECT with_check NOT LIKE '%app_setup_needed%' FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_ins'));
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/076: an org ADMIN calling bootstrap_first_admin on a populated install is refused',
  $q$SELECT public.bootstrap_first_admin()$q$, 'SETUP_ALREADY_COMPLETED');
RESET ROLE;
SELECT test.login(:'ORPH') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/076: an orphan auth account calling bootstrap_first_admin on a populated install is refused',
  $q$SELECT public.bootstrap_first_admin()$q$, 'SETUP_ALREADY_COMPLETED');
RESET ROLE;
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('t12/076: anon cannot execute bootstrap_first_admin',
  $q$SELECT public.bootstrap_first_admin()$q$, 'permission denied');
RESET ROLE;
SELECT test.check('t12/076: no organization / user was created by the refused calls',
  (SELECT count(*) FROM organizations) = :orgs_before
  AND NOT EXISTS (SELECT 1 FROM users WHERE auth_id = :'ORPH'));
\else
SELECT 'SKIP t12 section 3 (076 not applied)';
\endif

SELECT test.logout() AS zz \gset
