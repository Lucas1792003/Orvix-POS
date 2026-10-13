-- t17 part 2: outcome of the parallel calls fired by run.sh (t17 concurrency)
-- and the per-user session-creation limit (sequential).
-- Variables from run.sh: bsecs (wall time of the burst race, whose session
-- row was held FOR UPDATE for 2 s by another session while the claims queued).
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set AX  'a0000000-0000-4000-8000-000000000011'
SELECT test.logout() AS zz \gset

-- ============================================================
-- 1. Burst race: 40 parallel claims for ONE session (row lock held 2 s first)
-- ============================================================
SELECT count(*) AS b_rows,
       count(*) FILTER (WHERE (result->>'allowed')::boolean) AS b_ok,
       count(*) FILTER (WHERE result->>'scope' = 'session_burst') AS b_burst,
       COALESCE(string_agg(DISTINCT (result->>'issued'), ',' ORDER BY (result->>'issued')), '') AS b_issued
  FROM test.t17_conc WHERE k = 'burst' \gset
SELECT test.check('t17/081 concurrent burst: 40 parallel claims -> exactly 5 allowed (issued 1..5 each once), 35 rate_limited/session_burst',
  :b_rows = 40 AND :b_ok = 5 AND :b_burst = 35 AND :'b_issued' = '1,2,3,4,5',
  'rows=' || :b_rows || ' allowed=' || :b_ok || ' burst=' || :b_burst || ' issued={' || :'b_issued' || '}');
SELECT test.check('t17/081 concurrent burst: the claims queued behind the held row lock (race wall time >= 1 s)',
  :bsecs >= 1, 'wall ' || :bsecs || ' s');
SELECT test.check('t17/081 concurrent burst: session counters = 5 / window 5 (no lost or extra increment)',
  (SELECT token_issue_count = 5 AND token_window_count = 5 FROM product_image_upload_sessions WHERE id = test.var('t17_burst_sid')));

-- ============================================================
-- 2. Org race: 14 sessions x 5 parallel claims = 70 -> exactly 60 (org window)
-- ============================================================
SELECT count(*) AS o_rows,
       count(*) FILTER (WHERE (result->>'allowed')::boolean) AS o_ok,
       count(*) FILTER (WHERE result->>'scope' = 'org') AS o_org,
       count(*) FILTER (WHERE result->>'scope' = 'session_burst') AS o_burst
  FROM test.t17_conc WHERE k = 'org' \gset
SELECT sum(token_issue_count) AS o_sum, max(token_issue_count) AS o_max
  FROM product_image_upload_sessions
 WHERE token_hash IN (SELECT product_image_upload_token_hash(test.var('t17_org_tok_' || i)) FROM generate_series(1, 14) i) \gset
SELECT test.check('t17/081 concurrent org: 70 parallel claims over 14 sessions -> exactly 60 allowed, 10 rate_limited/org',
  :o_rows = 70 AND :o_ok = 60 AND :o_org = 10 AND :o_burst = 0,
  'rows=' || :o_rows || ' allowed=' || :o_ok || ' org=' || :o_org || ' burst=' || :o_burst);
SELECT test.check('t17/081 concurrent org: org counter = 60 = sum of the sessions'' counters; no session above its burst of 5',
  (SELECT issued FROM phone_upload_org_rate WHERE org_id = 'org-test') = 60 AND :o_sum = 60 AND :o_max <= 5,
  'org=' || (SELECT issued FROM phone_upload_org_rate WHERE org_id = 'org-test') || ' sum=' || :o_sum || ' max=' || :o_max);
SELECT test.check('t17/081 concurrent org: every org refusal carries retry_after 1..60 s',
  NOT EXISTS (SELECT 1 FROM test.t17_conc WHERE k = 'org' AND result->>'scope' = 'org'
               AND (result->>'retry_after_seconds')::int NOT BETWEEN 1 AND 60));

-- ============================================================
-- 3. Per-user creation race: AX at 118 sessions in the hour, 6 parallel creates -> exactly 2
-- ============================================================
SELECT count(*) AS c_rows,
       count(*) FILTER (WHERE result #>> '{}' = 'OK') AS c_ok,
       count(*) FILTER (WHERE result #>> '{}' LIKE 'PT429:Too many phone upload links were created. Try again in % minutes.') AS c_429
  FROM test.t17_conc WHERE k = 'create' \gset
SELECT test.check('t17/081 concurrent create: 6 parallel creates at 118/120 -> exactly 2 succeed, 4 refused with PT429 (HTTP 429)',
  :c_rows = 6 AND :c_ok = 2 AND :c_429 = 4,
  'rows=' || :c_rows || ' ok=' || :c_ok || ' 429=' || :c_429 || ' ' || COALESCE((SELECT min(result #>> '{}') FROM test.t17_conc WHERE k = 'create' AND result #>> '{}' <> 'OK'), ''));
SELECT test.check('t17/081 concurrent create: AX has exactly 120 sessions in the last hour',
  (SELECT count(*) FROM product_image_upload_sessions WHERE created_by = 'u-admin-x' AND created_at > now() - interval '1 hour') = 120);

-- ============================================================
-- 4. Per-user creation limit, sequential (AA): fill to 120, refuse, reset by age
-- ============================================================
SELECT count(*) AS aa_before FROM product_image_upload_sessions
 WHERE created_by = (SELECT id FROM users WHERE auth_id = :'AA') AND created_at > now() - interval '1 hour' \gset
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.t17_try_create('shop-a') AS aa_first \gset
DO $$
BEGIN
  WHILE (SELECT count(*) FROM product_image_upload_sessions
          WHERE created_by = (current_app_user()).id AND created_at > now() - interval '1 hour') < 120 LOOP
    PERFORM public.create_product_image_upload_session('shop-a', NULL);
  END LOOP;
END $$;
SELECT test.t17_try_create('shop-a') AS aa_121 \gset
SELECT test.t17_try_create('shop-a') AS aa_122 \gset
RESET ROLE;
SELECT test.check('t17/081 user: below the limit creation works (AA had ' || :aa_before || ' sessions this hour)',
  :'aa_first' = 'OK' AND :aa_before < 119, :'aa_first');
SELECT test.check('t17/081 user: the 121st session in an hour -> PT429 "Too many phone upload links were created. Try again in N minutes." (N 1..60)',
  :'aa_121' ~ '^PT429:Too many phone upload links were created\. Try again in ([1-9]|[1-5][0-9]|60) minutes\.$'
  AND :'aa_122' = :'aa_121', :'aa_121');
SELECT test.check('t17/081 user: refused creations wrote no session row (still 120 in the hour)',
  (SELECT count(*) FROM product_image_upload_sessions
    WHERE created_by = (SELECT id FROM users WHERE auth_id = :'AA') AND created_at > now() - interval '1 hour') = 120);
-- age the oldest of AX's sessions out of the window: AX gets room for one, AA (another user) is still refused
UPDATE product_image_upload_sessions SET created_at = now() - interval '61 minutes'
 WHERE id = (SELECT id FROM product_image_upload_sessions WHERE created_by = 'u-admin-x'
              AND created_at > now() - interval '1 hour' ORDER BY created_at LIMIT 1);
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.t17_try_create('shop-x') AS ax_after \gset
SELECT test.t17_try_create('shop-x') AS ax_after2 \gset
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.t17_try_create('shop-a') AS aa_still \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t17/081 user: rolling hour - once one session ages past 60 min the user may create exactly one more',
  :'ax_after' = 'OK' AND :'ax_after2' LIKE 'PT429:%', :'ax_after' || ' / ' || :'ax_after2');
SELECT test.check('t17/081 user: the limit is per creating user (AA still refused while AX got room)',
  :'aa_still' LIKE 'PT429:%', :'aa_still');
