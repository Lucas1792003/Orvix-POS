-- Assertions for the two-session run. run.sh passes: ra, rb (the two
-- responses), before (sales count before), bsecs (wall seconds session B
-- spent, must be >= 2 to prove it blocked behind A's open transaction).
\set ON_ERROR_STOP on
SELECT test.check('concurrent same key: session A got a sale', (:'ra'::jsonb->'sale'->>'id') LIKE 'sale-%');
SELECT test.check('concurrent same key: both sessions got identical responses', :'ra'::jsonb = :'rb'::jsonb);
SELECT test.check('concurrent same key: exactly one new sale',
  (SELECT count(*) FROM sales WHERE shop_id = 'shop-a') = :before + 1,
  'before=' || :before || ' after=' || (SELECT count(*) FROM sales WHERE shop_id = 'shop-a'));
SELECT test.check('concurrent same key: exactly one movement for that sale',
  (SELECT count(*) FROM inventory_movements WHERE reference_id = (:'ra'::jsonb->'sale'->>'id')) = 1);
SELECT test.check('concurrent same key: session B blocked on the advisory lock until A committed',
  :bsecs >= 2, 'session B wall time = ' || :bsecs || 's');
SELECT test.check('concurrent same key: prod-1 deducted once (97)',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-1') = 97);
