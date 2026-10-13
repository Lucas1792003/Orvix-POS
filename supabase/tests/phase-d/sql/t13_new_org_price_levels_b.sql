-- t13 (part B): runs after run.sh RE-APPLIED 077 to a populated database.
-- The one-time backfill must give the pre-077 org with ZERO levels
-- (org-q-zero) the default set and must not touch any org that has levels.
\set ON_ERROR_STOP on
\set QZ 'c0000000-0000-4000-8000-0000000000c1'
SELECT test.logout() AS zz \gset

SELECT test.check('t13/077 backfill: the org with zero levels got exactly the default set',
  test.pl_is_default_set('org-q-zero'), test.pl_fingerprint('org-q-zero'));
SELECT test.check('t13/077 backfill: every org that already had levels is unchanged (count + checksum)',
  (SELECT bool_and(test.pl_fingerprint(o) = test.var('t13b_fp_' || o))
     FROM unnest(string_to_array(test.var('t13b_orgs'), ',')) AS o),
  'orgs=' || test.var('t13b_orgs'));
SELECT test.check('t13/077 backfill: exactly 3 rows were added in total',
  (SELECT count(*) FROM price_levels) = test.var('t13b_levels_before')::int + 3,
  'before=' || test.var('t13b_levels_before') || ' after=' || (SELECT count(*) FROM price_levels));

SELECT test.login(:'QZ') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-qz', test.var('t13_shift_qz'), 'CASH', 1500, 0,
  '[{"product_id":"prod-qz","qty":1}]'::jsonb, NULL, 'cccccccc-0000-4000-8000-0000000000c4') AS salez \gset
RESET ROLE;
SELECT test.check('t13/077 backfill: the formerly level-less org can now complete a sale (its own Retail default)',
  (:'salez'::jsonb->'sale'->>'shopId') = 'shop-qz'
  AND (SELECT l.org_id = 'org-q-zero' AND l.code = 'retail'
         FROM sale_items si JOIN price_levels l ON l.id = si.price_level_id
        WHERE si.sale_id = :'salez'::jsonb->'sale'->>'id' LIMIT 1));
SELECT test.logout() AS zz \gset
