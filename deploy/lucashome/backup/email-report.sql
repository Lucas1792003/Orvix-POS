-- email-report.sql — one organization's business day as a single JSON document.
-- psql variables: org (organizations.id), day (YYYY-MM-DD, local business date), tz (IANA zone).
-- READ ONLY: runs in a read-only, repeatable-read transaction; every row is scoped to the
-- organization through shops.org_id (transactions) or <table>.org_id (catalog), matching the
-- org isolation of migrations 068-080. No personal data: staff/customer names, emails and phone
-- numbers are never selected; shops are identified by code + name, products by name.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

WITH
b AS (
  SELECT (:'day'::date)::timestamp AT TIME ZONE :'tz'       AS t0,
         ((:'day'::date) + 1)::timestamp AT TIME ZONE :'tz' AS t1
),
org AS (SELECT o.id, o.name FROM organizations o WHERE o.id = :'org'),
shp AS (SELECT s.id, s.code, s.name, s.is_active FROM shops s JOIN org ON s.org_id = org.id),
sal AS (
  SELECT sa.* FROM sales sa JOIN shp ON shp.id = sa.shop_id, b
  WHERE sa.created_at >= b.t0 AND sa.created_at < b.t1
),
live AS (SELECT * FROM sal WHERE status IS DISTINCT FROM 'VOID'),
itm AS (
  SELECT si.* FROM sale_items si JOIN live ON live.id = si.sale_id
),
rvr AS (
  SELECT r.* FROM refund_void_requests r JOIN shp ON shp.id = r.shop_id, b
  WHERE r.created_at >= b.t0 AND r.created_at < b.t1
),
inv AS (
  SELECT i.shop_id, i.product_id, i.qty_base_units AS qty, p.name, p.cost_mmk, p.price_mmk,
         p.low_stock_threshold, p.is_active, p.is_non_stock
  FROM inventory i
  JOIN shp ON shp.id = i.shop_id
  JOIN products p ON p.id = i.product_id
  JOIN org ON p.org_id = org.id
),
po AS (SELECT p.* FROM purchase_orders p JOIN shp ON shp.id = p.shop_id),
spay AS (
  SELECT sp.* FROM supplier_payments sp JOIN shp ON shp.id = sp.shop_id, b
  WHERE sp.created_at >= b.t0 AND sp.created_at < b.t1 AND sp.voided_at IS NULL
),
sft AS (SELECT sh.* FROM shifts sh JOIN shp ON shp.id = sh.shop_id),
mov AS (
  SELECT m.* FROM inventory_movements m JOIN shp ON shp.id = m.shop_id, b
  WHERE m.created_at >= b.t0 AND m.created_at < b.t1
),
trf AS (
  SELECT t.* FROM stock_transfers t
  WHERE t.from_shop_id IN (SELECT id FROM shp) OR t.to_shop_id IN (SELECT id FROM shp)
)
SELECT json_build_object(
  'schema', 1,
  'org', (SELECT json_build_object('id', id, 'name', name) FROM org),
  'day', :'day',
  'tz', :'tz',
  'window', (SELECT json_build_object('from', t0, 'to', t1) FROM b),
  'generated_at', now(),
  'shops', (SELECT count(*) FROM shp WHERE is_active IS DISTINCT FROM false),
  'sales', json_build_object(
    -- sales.status: NORMAL (complete_sale), REFUNDED (after an approved partial refund), VOID
    'completed_count', (SELECT count(*) FROM sal WHERE coalesce(status, 'NORMAL') = 'NORMAL'),
    'refunded_count',  (SELECT count(*) FROM sal WHERE status = 'REFUNDED'),
    'void_count',      (SELECT count(*) FROM sal WHERE status = 'VOID'),
    'void_total_mmk',  (SELECT coalesce(sum(total_mmk), 0) FROM sal WHERE status = 'VOID'),
    'revenue_mmk',     (SELECT coalesce(sum(total_mmk), 0) FROM live),
    'subtotal_mmk',    (SELECT coalesce(sum(subtotal_mmk), 0) FROM live),
    'discount_mmk',    (SELECT coalesce(sum(discount_mmk), 0) FROM live),
    'refunded_sales_total_mmk', (SELECT coalesce(sum(total_mmk), 0) FROM sal WHERE status = 'REFUNDED'),
    'avg_ticket_mmk',  (SELECT coalesce(round(avg(total_mmk)), 0) FROM live),
    'units_sold',      (SELECT coalesce(sum(qty_units), 0) FROM itm),
    'cogs_est_mmk',    (SELECT coalesce(sum(coalesce(si.unit_cost_mmk_snapshot, p.cost_mmk, 0)::bigint
                                            * coalesce(si.base_quantity_sold, si.qty_units)), 0)
                        FROM itm si LEFT JOIN products p ON p.id = si.product_id),
    'lines_without_cost', (SELECT count(*) FROM itm si LEFT JOIN products p ON p.id = si.product_id
                           WHERE si.unit_cost_mmk_snapshot IS NULL AND p.cost_mmk IS NULL),
    'by_payment', (SELECT coalesce(json_agg(x ORDER BY x.total_mmk DESC), '[]') FROM (
                     SELECT payment_method AS method, count(*) AS count, sum(total_mmk) AS total_mmk
                     FROM live GROUP BY payment_method) x),
    'by_shop', (SELECT coalesce(json_agg(x ORDER BY x.code), '[]') FROM (
                  SELECT shp.code, shp.name, count(live.id) AS count, coalesce(sum(live.total_mmk), 0) AS total_mmk
                  FROM shp LEFT JOIN live ON live.shop_id = shp.id
                  WHERE shp.is_active IS DISTINCT FROM false OR live.id IS NOT NULL
                  GROUP BY shp.code, shp.name) x),
    'top_products', (SELECT coalesce(json_agg(x ORDER BY x.revenue_mmk DESC, x.name), '[]') FROM (
                       SELECT p.name, sum(si.qty_units) AS qty, sum(si.line_total_mmk) AS revenue_mmk
                       FROM itm si JOIN products p ON p.id = si.product_id
                       GROUP BY p.name ORDER BY sum(si.line_total_mmk) DESC, p.name LIMIT 5) x)
  ),
  'refund_void_requests', json_build_object(
    'created', (SELECT coalesce(json_agg(x ORDER BY x.type, x.status), '[]') FROM (
                  SELECT type, coalesce(status, 'PENDING') AS status, count(*) AS count FROM rvr GROUP BY 1, 2) x),
    'pending_total', (SELECT count(*) FROM refund_void_requests r JOIN shp ON shp.id = r.shop_id
                      WHERE coalesce(r.status, 'PENDING') = 'PENDING')
  ),
  'expenses', json_build_object('supported', false,
    'note', 'the app has no expenses table; supplier purchases and payments are reported below'),
  'inventory', json_build_object(
    'tracked_items', (SELECT count(*) FROM inv WHERE is_active IS DISTINCT FROM false AND is_non_stock IS NOT TRUE),
    'low_stock_count', (SELECT count(*) FROM inv WHERE is_active IS DISTINCT FROM false AND is_non_stock IS NOT TRUE
                          AND low_stock_threshold IS NOT NULL AND qty <= low_stock_threshold),
    'low_stock', (SELECT coalesce(json_agg(x ORDER BY x.qty, x.name), '[]') FROM (
                    SELECT shp.code AS shop, inv.name, inv.qty, inv.low_stock_threshold AS threshold
                    FROM inv JOIN shp ON shp.id = inv.shop_id
                    WHERE inv.is_active IS DISTINCT FROM false AND inv.is_non_stock IS NOT TRUE
                      AND inv.low_stock_threshold IS NOT NULL AND inv.qty <= inv.low_stock_threshold
                    ORDER BY inv.qty, inv.name LIMIT 15) x),
    'negative_stock_count', (SELECT count(*) FROM inv WHERE qty < 0),
    'valuation_cost_mmk', (SELECT coalesce(sum(qty::bigint * cost_mmk), 0) FROM inv
                            WHERE qty > 0 AND cost_mmk IS NOT NULL AND is_non_stock IS NOT TRUE),
    'valuation_retail_mmk', (SELECT coalesce(sum(qty::bigint * price_mmk), 0) FROM inv
                              WHERE qty > 0 AND is_non_stock IS NOT TRUE),
    'items_without_cost', (SELECT count(*) FROM inv WHERE qty > 0 AND cost_mmk IS NULL AND is_non_stock IS NOT TRUE),
    'movements_today', (SELECT coalesce(json_agg(x ORDER BY x.type), '[]') FROM (
                          SELECT type, count(*) AS count, sum(qty_change) AS qty_change FROM mov GROUP BY type) x)
  ),
  'purchases', json_build_object(
    'created_count', (SELECT count(*) FROM po, b WHERE po.created_at >= b.t0 AND po.created_at < b.t1),
    'created_total_mmk', (SELECT coalesce(sum(total_mmk), 0) FROM po, b WHERE po.created_at >= b.t0 AND po.created_at < b.t1),
    'received_count', (SELECT count(*) FROM po, b WHERE po.received_at >= b.t0 AND po.received_at < b.t1),
    'received_total_mmk', (SELECT coalesce(sum(total_mmk), 0) FROM po, b WHERE po.received_at >= b.t0 AND po.received_at < b.t1),
    'open_orders', (SELECT count(*) FROM po WHERE status IN ('PENDING', 'APPROVED')),
    'supplier_debt_mmk', (SELECT coalesce(sum(total_mmk - coalesce(paid_mmk, 0)), 0) FROM po
                           WHERE status = 'RECEIVED' AND coalesce(payment_status, 'UNPAID') <> 'PAID'),
    'unpaid_received_orders', (SELECT count(*) FROM po WHERE status = 'RECEIVED' AND coalesce(payment_status, 'UNPAID') <> 'PAID'),
    'supplier_payments_count', (SELECT count(*) FROM spay),
    'supplier_payments_mmk', (SELECT coalesce(sum(amount_mmk), 0) FROM spay)
  ),
  'shifts', json_build_object(
    'opened', (SELECT count(*) FROM sft, b WHERE sft.started_at >= b.t0 AND sft.started_at < b.t1),
    'closed', (SELECT count(*) FROM sft, b WHERE sft.ended_at >= b.t0 AND sft.ended_at < b.t1),
    'open_now', (SELECT count(*) FROM sft WHERE ended_at IS NULL),
    'open_now_by_shop', (SELECT coalesce(json_agg(x ORDER BY x.shop), '[]') FROM (
                           SELECT shp.code AS shop, count(*) AS count, min(sft.started_at) AS oldest_start
                           FROM sft JOIN shp ON shp.id = sft.shop_id WHERE sft.ended_at IS NULL GROUP BY shp.code) x),
    'variance_total_mmk', (SELECT coalesce(sum(variance_mmk), 0) FROM sft, b WHERE sft.ended_at >= b.t0 AND sft.ended_at < b.t1),
    'closed_with_variance', (SELECT coalesce(json_agg(x ORDER BY x.shop, x.variance_mmk), '[]') FROM (
                               SELECT shp.code AS shop, sft.variance_mmk FROM sft JOIN shp ON shp.id = sft.shop_id, b
                               WHERE sft.ended_at >= b.t0 AND sft.ended_at < b.t1 AND coalesce(sft.variance_mmk, 0) <> 0) x)
  ),
  'transfers', json_build_object(
    'created', (SELECT count(*) FROM trf, b WHERE trf.created_at >= b.t0 AND trf.created_at < b.t1),
    'received', (SELECT count(*) FROM trf, b WHERE coalesce(trf.received_at, trf.completed_at) >= b.t0
                                              AND coalesce(trf.received_at, trf.completed_at) < b.t1),
    'in_transit', (SELECT count(*) FROM trf WHERE status = 'IN_TRANSIT')
  ),
  'audit_events', (SELECT count(*) FROM audit_logs a JOIN shp ON shp.id = a.shop_id, b
                   WHERE a.created_at >= b.t0 AND a.created_at < b.t1)
);
COMMIT;
