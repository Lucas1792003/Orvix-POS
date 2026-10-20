-- f03: PFIN-B's net-line allocation (identical to the fin-ui client's
-- allocateNetLineAmounts) and the over-refund evidence the reports give
-- WITHOUT any refund cap (PFIN-C is not part of this suite; see
-- supabase/tests/fin/held/). Runs before any held migration is applied.
\set ON_ERROR_STOP on
\set ADMIN   '''a0000000-0000-4000-8000-000000000001'''
\set MGRF    '''f0000000-0000-4000-8000-000000000001'''
\set F1      '''f0000000-0000-4000-8000-000000000002'''
\set F2      '''f0000000-0000-4000-8000-000000000003'''

SELECT test.check('f03 precondition: no refund-cap trigger is installed (PFIN-B suite runs without PFIN-C)',
  NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.refund_void_requests'::regclass AND tgname LIKE 'fin\_%'));

-- ---------------------------------------------------------------- ties (fin-ui vector)
-- refundMath.test.ts: three lines of 1,000, sale total 2,998 -> 999 / 999 / 1,000 by line key order.
-- prod-1 x1; prod-2 at 50 % item discount; prod-3 at 66.6667 % (round(999.999) = 1,000);
-- cart 0.0667 % of 3,000 = round(2.001) = 2.
SELECT test.setvar('s14', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 2998, 0.0667,
  '[{"product_id":"prod-1","qty":1},{"product_id":"prod-2","qty":1,"item_discount_pct":50},{"product_id":"prod-3","qty":1,"item_discount_pct":66.6667}]', NULL));
SELECT test.check('f03 tie fixture: three lines of 1,000, total 2,998',
  (SELECT total_mmk FROM sales WHERE id = test.var('s14')) = 2998
  AND (SELECT bool_and(line_total_mmk = 1000) AND count(*) = 3 FROM sale_items WHERE sale_id = test.var('s14')));
SELECT test.check('f03 tie: server nets by item id (C order) are 999, 999, 1,000 exactly as allocateNetLineAmounts',
  (SELECT array_agg(net_mmk ORDER BY item_id COLLATE "C") FROM public.fin_sale_line_net(ARRAY[test.var('s14')])) = ARRAY[999, 999, 1000]::bigint[]);
-- two lines of 1,050, 5 % cart -> total 1,995; client nets 997 (smaller key) / 998
SELECT test.setvar('s15', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 1995, 5,
  '[{"product_id":"prod-2","qty":1,"item_discount_pct":47.5},{"product_id":"prod-3","qty":1,"item_discount_pct":65}]', NULL));
SELECT test.check('f03 tie 2: lines 1,050 + 1,050, total 1,995 -> nets 997 / 998 by item id',
  (SELECT total_mmk FROM sales WHERE id = test.var('s15')) = 1995
  AND (SELECT array_agg(net_mmk ORDER BY item_id COLLATE "C") FROM public.fin_sale_line_net(ARRAY[test.var('s15')])) = ARRAY[997, 998]::bigint[]);
SELECT test.check('f03 several sales at once: Σ net per sale = its total',
  (SELECT bool_and(x.net = s.total_mmk) FROM (SELECT sale_id, sum(net_mmk) AS net FROM public.fin_sale_line_net(ARRAY[test.var('s14'), test.var('s15'), test.var('s2')]) GROUP BY 1) x
     JOIN sales s ON s.id = x.sale_id));

-- ---------------------------------------------------------------- over-refund evidence, no cap
SELECT (now() AT TIME ZONE 'Asia/Yangon')::date AS today \gset
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS e0 \gset
-- s7: 2 x prod-2 + 1 x prod-1, 10 % cart: 4,500 (prod-2 net 3,600). The approver accepts 4,000 for prod-2:
-- 070 alone allows it (its cap is the pre-cart-discount line total) -- the defect PFIN-C (held) addresses.
SELECT test.setvar('s7', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 4500, 10,
  '[{"product_id":"prod-2","qty":2},{"product_id":"prod-1","qty":1}]', NULL));
SELECT test.setvar('q1', test.f_request(:F2, test.var('s7'), 'PARTIAL', 'over-ask',
  '[{"productId":"prod-2","qtyUnits":2,"amountMmk":4000}]'));
SELECT test.check('f03 DEFECT still present without PFIN-C: 070 approves 4,000 for a product the customer paid 3,600 for',
  test.f_approve(:MGRF, test.var('q1'))->'request'->>'status' = 'APPROVED');
-- s11: 1 x prod-1, 10 % cart (900); a HISTORICAL direct row refunding 1,000 (above the sale total)
SELECT test.setvar('s11', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 900, 10, '[{"product_id":"prod-1","qty":1}]', NULL));
INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, created_at, items, status)
VALUES ('refund-legacy-over', test.var('s11'), 'shop-f', 'PARTIAL', 'legacy over-refund', 'u-cash-f2', now(),
        '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]', 'APPROVED');
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS e1 \gset
SELECT test.check('f03 evidence: both over-refunds flagged (2 above net paid, 1 sale above its total); amounts reported as approved, not capped',
  (:'e1'::jsonb->'evidence'->>'refundsAboveNetPaid')::int - (:'e0'::jsonb->'evidence'->>'refundsAboveNetPaid')::int = 2
  AND (:'e1'::jsonb->'evidence'->>'salesRefundedAboveTotal')::int - (:'e0'::jsonb->'evidence'->>'salesRefundedAboveTotal')::int = 1
  AND (:'e1'::jsonb->'totals'->>'refundMmk')::bigint - (:'e0'::jsonb->'totals'->>'refundMmk')::bigint = 5000,
  (:'e1'::jsonb->'evidence')::text);
-- only the request whose cumulative refund of a product FIRST passes the net paid is flagged:
-- s18: 3 x prod-2, 10 % cart -> net 5,400 (line total 6,000). A: 2 units for 5,500 (crosses 5,400);
-- B: the last unit for 500 (070 allows: 6,000 <= 6,000; cumulative already above net -> not flagged again)
SELECT test.setvar('s18', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 5400, 10, '[{"product_id":"prod-2","qty":3}]', NULL));
SELECT test.setvar('qa', test.f_request(:F2, test.var('s18'), 'PARTIAL', 'A', '[{"productId":"prod-2","qtyUnits":2,"amountMmk":5500}]'));
SELECT test.f_approve(:MGRF, test.var('qa')) AS aqa \gset
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS e2 \gset
SELECT test.setvar('qb', test.f_request(:F2, test.var('s18'), 'PARTIAL', 'B', '[{"productId":"prod-2","qtyUnits":1,"amountMmk":500}]'));
SELECT test.f_approve(:MGRF, test.var('qb')) AS aqb \gset
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS e3 \gset
SELECT test.check('f03 evidence flags only the crossing request: +1 for A (5,500 > 5,400), +0 for the later B of the same product',
  (:'e2'::jsonb->'evidence'->>'refundsAboveNetPaid')::int - (:'e1'::jsonb->'evidence'->>'refundsAboveNetPaid')::int = 1
  AND (:'e3'::jsonb->'evidence'->>'refundsAboveNetPaid') = (:'e2'::jsonb->'evidence'->>'refundsAboveNetPaid'),
  (:'e1'::jsonb->'evidence')::text || ' -> ' || (:'e2'::jsonb->'evidence')::text || ' -> ' || (:'e3'::jsonb->'evidence')::text);
SELECT test.check('f03 fin_items accepts what 070''s ::integer accepts ("+500", " 500 ") and nothing looser',
  (SELECT sum(amount) FROM public.fin_items('[{"productId":"p","qtyUnits":" 1 ","amountMmk":"+500"},{"productId":"p","qtyUnits":1,"amountMmk":" 500 "}]'::jsonb)) = 1000
  AND (SELECT bool_and(NOT ok) FROM public.fin_items('[{"productId":"p","qtyUnits":1,"amountMmk":"-5"},{"productId":"p","qtyUnits":1,"amountMmk":"5e2"}]'::jsonb)));
-- very large sale (a direct historical row, outside every report range): line a's remainder is exactly
-- S - 1, where numeric '/' would round the share up. fin-ui allocateNetLineAmounts (BigInt) gives
-- 338,536,069 / 196,706,298 / 115,501.
INSERT INTO sales (id, shop_id, shift_id, receipt_no, cashier_id, status, subtotal_mmk, discount_mmk, total_mmk, payment_method, paid_mmk, change_mmk, created_at)
VALUES ('zz-big', 'shop-f', test.var('S1'), 'SF-ZZ-BIG', 'u-cash-f1', 'NORMAL', 1075365019, 540007151, 535357868, 'CASH', 535357868, 0, now() - interval '400 days');
INSERT INTO sale_items (id, sale_id, product_id, qty_units, unit_price_mmk, line_total_mmk) VALUES
  ('zz-big-a', 'zz-big', 'prod-1', 1, 680012134, 680012134),
  ('zz-big-b', 'zz-big', 'prod-2', 1, 395120880, 395120880),
  ('zz-big-c', 'zz-big', 'prod-3', 1, 232005, 232005);
SELECT test.check('f03 exact allocation for a very large sale equals the client (no numeric rounding of the share)',
  (SELECT array_agg(net_mmk ORDER BY item_id COLLATE "C") FROM public.fin_sale_line_net(ARRAY['zz-big'])) = ARRAY[338536069, 196706298, 115501]::bigint[],
  (SELECT array_agg(net_mmk ORDER BY item_id COLLATE "C")::text FROM public.fin_sale_line_net(ARRAY['zz-big'])));
SELECT test.logout() AS zz \gset
