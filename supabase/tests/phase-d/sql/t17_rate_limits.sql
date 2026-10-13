-- t17: 081 - phone-upload rate limits (docs/selfhost-migration/phase-f/rate-limiting.md).
-- Gated by run.sh on migrations >= 081; runs after t16 (org-test + org-two
-- exist) and before the t12 bootstrap prep (which empties users).
--
-- Part 1 (this file): static grants/ownership, sequential limiter semantics
-- (session burst + window reset, session lifetime cap, organization window +
-- reset, inactive / invalid tokens, refusals write nothing), and the sessions
-- the concurrency step in run.sh uses (tokens kept in test.vars).
-- Part 2: run.sh fires parallel psql sessions (t17 concurrency), then
-- t17_rate_limits_b.sql checks them and the per-user creation limit.
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set AX  'a0000000-0000-4000-8000-000000000011'
SELECT test.logout() AS zz \gset

-- results of the parallel calls (written by service_role / authenticated sessions)
CREATE TABLE IF NOT EXISTS test.t17_conc (k text NOT NULL, result jsonb, at timestamptz DEFAULT clock_timestamp());
GRANT INSERT, SELECT ON test.t17_conc TO service_role, authenticated;

-- claim as service_role; returns the jsonb answer
CREATE OR REPLACE FUNCTION test.t17_claim(p_token text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.claim_phone_upload_token_issue(p_token);
$$;
-- create a session as the CURRENT role; 'OK' or '<SQLSTATE>:<message>'
CREATE OR REPLACE FUNCTION test.t17_try_create(p_shop text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.create_product_image_upload_session(p_shop, NULL);
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ':' || SQLERRM;
END $$;
-- rows touched by a DML as the CURRENT role; -1 = permission denied
CREATE OR REPLACE FUNCTION test.t17_rows(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
EXCEPTION WHEN insufficient_privilege THEN RETURN -1;
END $$;
GRANT EXECUTE ON FUNCTION test.t17_claim(text), test.t17_try_create(text), test.t17_rows(text) TO service_role, authenticated;

-- ============================================================
-- 0. Static: grants, ownership, anon surface, bodies
-- ============================================================
SELECT test.check('t17/081: claim_phone_upload_token_issue is SECURITY DEFINER, owned by postgres, search_path pinned',
  (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig::text LIKE '%search_path=public%'
     FROM pg_proc WHERE oid = 'public.claim_phone_upload_token_issue(text)'::regprocedure));
SELECT test.check('t17/081: claim_ is executable by service_role ONLY (not PUBLIC / anon / authenticated)',
  has_function_privilege('service_role', 'public.claim_phone_upload_token_issue(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_phone_upload_token_issue(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.claim_phone_upload_token_issue(text)', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                   WHERE p.oid = 'public.claim_phone_upload_token_issue(text)'::regprocedure AND a.grantee = 0));
SELECT test.check('t17/081: anon still executes exactly 3 public functions (app_setup_needed + the two token-scoped phone RPCs)',
  (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
  = ARRAY['app_setup_needed', 'complete_product_image_upload_session', 'get_product_image_upload_session_by_token']);
SELECT test.check('t17/081: phone_upload_org_rate has NO table privileges for anon / authenticated / service_role / PUBLIC, RLS on, owner postgres',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
               WHERE table_schema = 'public' AND table_name = 'phone_upload_org_rate'
                 AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC'))
  AND (SELECT relrowsecurity AND pg_get_userbyid(relowner) = 'postgres' FROM pg_class WHERE oid = 'public.phone_upload_org_rate'::regclass));
SELECT test.check('t17/081: create_product_image_upload_session carries 081, signature/definer/grants unchanged (authenticated yes, anon no)',
  (SELECT prosrc LIKE '%081%' AND prosrc LIKE '%PT429%' AND prosecdef FROM pg_proc
    WHERE oid = 'public.create_product_image_upload_session(text,text)'::regprocedure)
  AND has_function_privilege('authenticated', 'public.create_product_image_upload_session(text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_product_image_upload_session(text,text)', 'EXECUTE'));
SELECT test.check('t17/081: session counter columns exist with NOT NULL defaults',
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_image_upload_sessions'
     AND column_name IN ('token_issue_count', 'token_window_start', 'token_window_count')) = 3
  AND (SELECT is_nullable = 'NO' AND column_default = '0' FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'product_image_upload_sessions' AND column_name = 'token_issue_count'));
SET ROLE anon;
SELECT test.expect_error('t17/081: anon cannot call claim_', $q$SELECT public.claim_phone_upload_token_issue(repeat('a', 64))$q$, 'permission denied');
SELECT test.expect_error('t17/081: anon cannot read phone_upload_org_rate', 'SELECT count(*) FROM public.phone_upload_org_rate', 'permission denied');
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t17/081: an org ADMIN (authenticated) cannot call claim_', $q$SELECT public.claim_phone_upload_token_issue(repeat('a', 64))$q$, 'permission denied');
SELECT test.expect_error('t17/081: an org ADMIN cannot reset the org window', $q$DELETE FROM public.phone_upload_org_rate$q$, 'permission denied');
SELECT test.t17_rows($q$UPDATE public.product_image_upload_sessions SET token_issue_count = 0, token_window_count = 0$q$) AS adm_upd \gset
SELECT test.check('t17/081: an org ADMIN cannot reset session counters directly (permission denied or RLS: 0 rows)', :adm_upd <= 0, 'rows=' || :adm_upd);
RESET ROLE;
SET ROLE service_role;
SELECT test.expect_error('t17/081: even service_role cannot touch phone_upload_org_rate directly (only through claim_)',
  'SELECT count(*) FROM public.phone_upload_org_rate', 'permission denied');
RESET ROLE;

-- ============================================================
-- 1. Sessions for this file and for the concurrency step
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS s1  \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS cap \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS o1  \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS o2  \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS can \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS exp \gset
-- concurrency step: one session for the burst race, 16 for the org race
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS cb  \gset
DO $$
BEGIN
  FOR i IN 1..16 LOOP
    PERFORM test.setvar('t17_org_tok_' || i, public.create_product_image_upload_session('shop-a', 'prod-1')->>'token');
  END LOOP;
END $$;
SELECT public.cancel_product_image_upload_session(:'can'::jsonb->>'sessionId') AS zz \gset
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-x', NULL) AS x1 \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.setvar('t17_burst_tok', :'cb'::jsonb->>'token') AS zz \gset
SELECT test.setvar('t17_burst_sid', :'cb'::jsonb->>'sessionId') AS zz \gset

SELECT :'s1'::jsonb->>'token' AS t_s1, :'s1'::jsonb->>'sessionId' AS id_s1,
       :'cap'::jsonb->>'token' AS t_cap, :'cap'::jsonb->>'sessionId' AS id_cap,
       :'o1'::jsonb->>'token' AS t_o1, :'o1'::jsonb->>'sessionId' AS id_o1,
       :'o2'::jsonb->>'token' AS t_o2, :'o2'::jsonb->>'sessionId' AS id_o2,
       :'can'::jsonb->>'token' AS t_can, :'exp'::jsonb->>'token' AS t_exp, :'exp'::jsonb->>'sessionId' AS id_exp,
       :'x1'::jsonb->>'token' AS t_x1 \gset
DELETE FROM phone_upload_org_rate WHERE org_id IN ('org-test', 'org-two');

SELECT test.check('t17/081: new sessions start with zero counters',
  (SELECT bool_and(token_issue_count = 0 AND token_window_count = 0 AND token_window_start IS NULL)
     FROM product_image_upload_sessions WHERE id IN (:'id_s1', :'id_cap', :'id_o1', :'id_o2')));

-- ============================================================
-- 2. Per-session burst: 5 per 10 s window, then 429; refusals write nothing
-- ============================================================
SET ROLE service_role;
SELECT test.t17_claim(:'t_s1') AS c1 \gset
SELECT test.t17_claim(:'t_s1') AS c2 \gset
SELECT test.t17_claim(:'t_s1') AS c3 \gset
SELECT test.t17_claim(:'t_s1') AS c4 \gset
SELECT test.t17_claim(:'t_s1') AS c5 \gset
RESET ROLE;
SELECT md5(to_jsonb(s)::text) AS s1_md5 FROM product_image_upload_sessions s WHERE id = :'id_s1' \gset
SELECT issued AS org_issued_before FROM phone_upload_org_rate WHERE org_id = 'org-test' \gset
SET ROLE service_role;
SELECT test.t17_claim(:'t_s1') AS c6 \gset
SELECT test.t17_claim(:'t_s1') AS c7 \gset
RESET ROLE;
SELECT test.check('t17/081 burst: claims 1..5 allowed with issued 1..5 / remaining 19..15',
  (:'c1'::jsonb->>'allowed')::boolean AND (:'c5'::jsonb->>'allowed')::boolean
  AND (:'c1'::jsonb->>'issued')::int = 1 AND (:'c5'::jsonb->>'issued')::int = 5
  AND (:'c5'::jsonb->>'remaining')::int = 15
  AND (:'c2'::jsonb->>'allowed')::boolean AND (:'c3'::jsonb->>'allowed')::boolean AND (:'c4'::jsonb->>'allowed')::boolean,
  :'c5');
SELECT test.check('t17/081 burst: the 6th and 7th claim within 10 s -> rate_limited/session_burst, retry_after 1..10 s',
  NOT (:'c6'::jsonb->>'allowed')::boolean AND :'c6'::jsonb->>'reason' = 'rate_limited' AND :'c6'::jsonb->>'scope' = 'session_burst'
  AND (:'c6'::jsonb->>'retry_after_seconds')::int BETWEEN 1 AND 10
  AND :'c7'::jsonb->>'scope' = 'session_burst',
  :'c6');
SELECT test.check('t17/081 burst: refused claims wrote nothing (session row md5 identical, org counter unchanged)',
  (SELECT md5(to_jsonb(s)::text) FROM product_image_upload_sessions s WHERE id = :'id_s1') = :'s1_md5'
  AND (SELECT issued FROM phone_upload_org_rate WHERE org_id = 'org-test') = :org_issued_before
  AND (SELECT token_issue_count = 5 AND token_window_count = 5 FROM product_image_upload_sessions WHERE id = :'id_s1'));
SELECT test.check('t17/081 burst: the answer carries only allowed/reason/scope/retry_after_seconds (no ids, paths, org)',
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(:'c6'::jsonb) k) = ARRAY['allowed', 'reason', 'retry_after_seconds', 'scope']
  AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(:'c1'::jsonb) k) = ARRAY['allowed', 'issued', 'remaining']);
-- window reset: the window started more than 10 s ago
UPDATE product_image_upload_sessions SET token_window_start = clock_timestamp() - interval '10.5 seconds' WHERE id = :'id_s1';
SET ROLE service_role;
SELECT test.t17_claim(:'t_s1') AS c8 \gset
RESET ROLE;
SELECT test.check('t17/081 burst: after the 10 s window the next claim is allowed and opens a new window (count 1, lifetime 6)',
  (:'c8'::jsonb->>'allowed')::boolean AND (:'c8'::jsonb->>'issued')::int = 6
  AND (SELECT token_window_count = 1 AND token_window_start > clock_timestamp() - interval '5 seconds' AND token_issue_count = 6
         FROM product_image_upload_sessions WHERE id = :'id_s1'),
  :'c8');
-- window still open at 9 s: refused
UPDATE product_image_upload_sessions SET token_window_start = clock_timestamp() - interval '9 seconds', token_window_count = 5 WHERE id = :'id_s1';
SET ROLE service_role;
SELECT test.t17_claim(:'t_s1') AS c9 \gset
RESET ROLE;
SELECT test.check('t17/081 burst: a window 9 s old and full is still closed (retry_after 1..2 s)',
  :'c9'::jsonb->>'scope' = 'session_burst' AND (:'c9'::jsonb->>'retry_after_seconds')::int BETWEEN 1 AND 2, :'c9');

-- ============================================================
-- 3. Per-session lifetime cap: 20 tokens, then 429 until the session expires
-- ============================================================
UPDATE product_image_upload_sessions SET token_issue_count = 19, token_window_start = NULL, token_window_count = 0 WHERE id = :'id_cap';
SET ROLE service_role;
SELECT test.t17_claim(:'t_cap') AS k20 \gset
SELECT test.t17_claim(:'t_cap') AS k21 \gset
RESET ROLE;
UPDATE product_image_upload_sessions SET token_window_start = clock_timestamp() - interval '1 hour' WHERE id = :'id_cap';
SET ROLE service_role;
SELECT test.t17_claim(:'t_cap') AS k22 \gset
RESET ROLE;
SELECT test.check('t17/081 cap: the 20th token is allowed (remaining 0)',
  (:'k20'::jsonb->>'allowed')::boolean AND (:'k20'::jsonb->>'issued')::int = 20 AND (:'k20'::jsonb->>'remaining')::int = 0, :'k20');
SELECT test.check('t17/081 cap: the 21st -> rate_limited/session with retry_after = time until the session expires (<= 600 s)',
  :'k21'::jsonb->>'scope' = 'session'
  AND abs((:'k21'::jsonb->>'retry_after_seconds')::int
          - extract(epoch FROM (SELECT expires_at FROM product_image_upload_sessions WHERE id = :'id_cap') - clock_timestamp())) <= 2
  AND (:'k21'::jsonb->>'retry_after_seconds')::int BETWEEN 1 AND 600, :'k21');
SELECT test.check('t17/081 cap: still refused after the burst window resets (hard cap, not a window)',
  :'k22'::jsonb->>'scope' = 'session'
  AND (SELECT token_issue_count FROM product_image_upload_sessions WHERE id = :'id_cap') = 20, :'k22');
UPDATE product_image_upload_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = :'id_cap';
SET ROLE service_role;
SELECT test.t17_claim(:'t_cap') AS k23 \gset
RESET ROLE;
SELECT test.check('t17/081 cap: once the session has expired the answer is inactive/EXPIRED (no token ever again)',
  :'k23'::jsonb->>'reason' = 'inactive' AND :'k23'::jsonb->>'status' = 'EXPIRED', :'k23');

-- ============================================================
-- 4. Inactive / invalid tokens: refused, nothing counted
-- ============================================================
UPDATE product_image_upload_sessions SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = :'id_exp';
SET ROLE service_role;
SELECT test.t17_claim(:'t_can') AS i_can \gset
SELECT test.t17_claim(:'t_exp') AS i_exp \gset
SELECT test.t17_claim(repeat('f', 128)) AS i_rand \gset
SELECT test.t17_claim('short') AS i_short \gset
SELECT test.t17_claim(NULL) AS i_null \gset
SELECT test.t17_claim(repeat('a', 600)) AS i_long \gset
SELECT test.t17_claim((SELECT token_hash FROM product_image_upload_sessions WHERE id = :'id_o1')) AS i_hash \gset
SELECT test.t17_claim(:'id_o1') AS i_sid \gset
RESET ROLE;
SELECT test.check('t17/081 inactive: CANCELED -> inactive/CANCELED; expired PENDING -> inactive/EXPIRED',
  :'i_can'::jsonb = '{"allowed": false, "reason": "inactive", "status": "CANCELED"}'::jsonb
  AND :'i_exp'::jsonb = '{"allowed": false, "reason": "inactive", "status": "EXPIRED"}'::jsonb);
SELECT test.check('t17/081 invalid: random / short / NULL / oversized / stored hash / session id -> {allowed:false, reason:invalid}',
  :'i_rand'::jsonb = '{"allowed": false, "reason": "invalid"}'::jsonb AND :'i_short'::jsonb = :'i_rand'::jsonb
  AND :'i_null'::jsonb = :'i_rand'::jsonb AND :'i_long'::jsonb = :'i_rand'::jsonb
  AND :'i_hash'::jsonb = :'i_rand'::jsonb AND :'i_sid'::jsonb = :'i_rand'::jsonb);
SELECT test.check('t17/081 inactive/invalid: nothing counted on those sessions',
  (SELECT bool_and(token_issue_count = 0) FROM product_image_upload_sessions
    WHERE id IN (:'id_exp', :'id_o1') OR token_hash = product_image_upload_token_hash(:'t_can')));

-- ============================================================
-- 5. Per-organization window: 60 per 60 s; other org unaffected; reset
-- ============================================================
UPDATE phone_upload_org_rate SET window_start = clock_timestamp() - interval '5 seconds', issued = 59 WHERE org_id = 'org-test';
SET ROLE service_role;
SELECT test.t17_claim(:'t_o1') AS g60 \gset
SELECT test.t17_claim(:'t_o2') AS g61 \gset
SELECT test.t17_claim(:'t_x1') AS gx \gset
RESET ROLE;
SELECT test.check('t17/081 org: the 60th token in the window is allowed',
  (:'g60'::jsonb->>'allowed')::boolean AND (SELECT issued FROM phone_upload_org_rate WHERE org_id = 'org-test') = 60, :'g60');
SELECT test.check('t17/081 org: the 61st (a different, fresh session) -> rate_limited/org, retry_after 1..60 s (~55)',
  :'g61'::jsonb->>'scope' = 'org' AND (:'g61'::jsonb->>'retry_after_seconds')::int BETWEEN 50 AND 60, :'g61');
SELECT test.check('t17/081 org: the refused session was not counted (token_issue_count 0) and the org stays at 60',
  (SELECT token_issue_count FROM product_image_upload_sessions WHERE id = :'id_o2') = 0
  AND (SELECT issued FROM phone_upload_org_rate WHERE org_id = 'org-test') = 60);
SELECT test.check('t17/081 org: another organization is unaffected (org-two allowed, own counter = 1)',
  (:'gx'::jsonb->>'allowed')::boolean AND (SELECT issued FROM phone_upload_org_rate WHERE org_id = 'org-two') = 1, :'gx');
UPDATE phone_upload_org_rate SET window_start = clock_timestamp() - interval '61 seconds' WHERE org_id = 'org-test';
SET ROLE service_role;
SELECT test.t17_claim(:'t_o2') AS g1 \gset
RESET ROLE;
SELECT test.check('t17/081 org: after 60 s a new window opens (allowed, org issued = 1)',
  (:'g1'::jsonb->>'allowed')::boolean AND (SELECT issued = 1 AND window_start > clock_timestamp() - interval '5 seconds'
                                              FROM phone_upload_org_rate WHERE org_id = 'org-test'), :'g1');

-- ============================================================
-- 6. Deleting an organization drops its counter row
-- ============================================================
SELECT test.check('t17/081: phone_upload_org_rate rows reference organizations ON DELETE CASCADE (QA cleanup leaves no counter)',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phone_upload_org_rate'::regclass AND contype = 'f'
           AND confrelid = 'public.organizations'::regclass AND confdeltype = 'c'));

-- leave org windows empty for the concurrency step
DELETE FROM phone_upload_org_rate WHERE org_id IN ('org-test', 'org-two');
