-- ============================================================
-- Migration 069: organization isolation, part 2 of 4 - RLS policies
--   (Phase G backend security audit: docs/selfhost-migration/phase-g/
--    org-isolation-audit.md; requires 068's columns and helpers)
--
-- PURPOSE
--   Every policy in the 2026-10-11 snapshot (58 policies, 29 tables) scopes by
--   shop or not at all. `app_role() = 'ADMIN'` short-circuits to "every row of
--   every organization" on sales, sale_items (via sales), inventory,
--   inventory_movements, shifts, purchase_orders(+items), stock_transfers
--   (+items), refund_void_requests, reprint_logs, supplier_payments,
--   audit_logs and users; shops, organizations, business_profile and the
--   whole catalog (products, product_units, product_barcodes,
--   product_unit_prices, price_tiers, categories, brands, suppliers,
--   supplier_products, unit_types, price_levels) are `USING (true)` for every
--   authenticated user of every organization. Realtime (`postgres_changes` on
--   inventory) is filtered by the same inventory_sel policy, so an org-A ADMIN
--   also receives org-B stock events.
--
-- READ / WRITE MODEL AFTER THIS MIGRATION
--   ADMIN                 -> every row of its OWN organization (all its shops).
--   MANAGER/CASHIER/BUYER -> unchanged: own shop / own rows (a shop belongs to
--                            exactly one org, so these were already org-safe).
--   catalog tables        -> `org_id = app_org_id()` (068 added the column);
--                            children (product_units, product_unit_prices,
--                            price_tiers, supplier_products) readable/writable
--                            iff the parent product/supplier is in the org.
--   shop-derived tables   -> `shop_id IN (SELECT app_org_shop_ids())`
--                            (an uncorrelated sub-select the planner hashes
--                            once per statement - no per-row function call).
--   audit_logs            -> org = the shop's org, or the actor's org for the
--                            shop-less catalog events (051).
--   users                 -> 056 rule AND same org (the `role = 'ADMIN'` clause
--                            used to expose every organization's ADMIN row).
--   organizations         -> own row only. INSERT only while the install has
--                            no users at all (app_setup_needed(), 067) - review
--                            fix, see the policy comment.
--   users INSERT          -> bootstrap hatch also uses app_setup_needed() and
--                            requires auth_id = auth.uid() (review fix).
--   business_profile      -> own org's row (one row per org since 068).
--   Write policies get the same org term in WITH CHECK, so a client cannot
--   insert into / move a row to another organization even when it sends
--   org_id explicitly. Permission terms are byte-for-byte the previous ones.
--   All policies remain PERMISSIVE and `TO authenticated`; no grant changes.
--   platform_admins / admin_login_codes / idempotency_keys: untouched (zero
--   policies, service-role only).
--
-- ROLLBACK
--   Re-run the policy blocks of 010, 011, 015, 018, 019, 025, 026, 030, 031,
--   036, 043, 056, 060 (DROP + CREATE; each file is idempotent). Do this
--   BEFORE dropping 068's helpers.
--
-- VERIFICATION
--   SELECT count(*) FROM pg_policies WHERE schemaname='public'
--     AND (qual LIKE '%app_org%' OR with_check LIKE '%app_org%' OR qual LIKE '%org_id%');
--     -- expect 52 of 58: every policy except organizations_ins (bootstrap),
--     -- product_image_upload_sessions_owner_select (owner-only) and the four
--     -- parent-inherit policies (sale_items, purchase_order_items,
--     -- stock_transfer_items, reprint_logs) carries an org term
--   SELECT count(*) FROM pg_policies WHERE schemaname='public' AND permissive <> 'PERMISSIVE';  -- 0
--   -- as an ADMIN of org A: SELECT count(*) FROM shops WHERE org_id <> app_org_id();  -- 0
--
-- Run AFTER 068. Idempotent (DROP POLICY IF EXISTS + CREATE POLICY).
-- ============================================================

-- ============================================================
-- 1. Organizations / shops / users / business_profile
-- ============================================================
DROP POLICY IF EXISTS "organizations_sel" ON organizations;
CREATE POLICY "organizations_sel" ON organizations FOR SELECT TO authenticated
  USING (id = app_org_id());
-- (review fix) The bootstrap hatch used `NOT EXISTS (SELECT 1 FROM users)`.
-- That sub-select is RLS-filtered by users_sel; once users_sel gained the
-- org term below, a caller with NO active users row (an orphan auth account,
-- a deactivated employee) sees zero users, so the hatch reopened for them on
-- a populated install: they could create an organization + ADMIN, or insert
-- themselves as MANAGER/CASHIER of any known shop of any org. app_setup_needed()
-- (067, SECURITY DEFINER) counts ALL users. The `user:create` branch is gone:
-- an org ADMIN has no business creating other organizations (the platform
-- console does that with the service role, which bypasses RLS).
DROP POLICY IF EXISTS "organizations_ins" ON organizations;
CREATE POLICY "organizations_ins" ON organizations FOR INSERT TO authenticated
  WITH CHECK (public.app_setup_needed());

DROP POLICY IF EXISTS "shops_sel" ON shops;
DROP POLICY IF EXISTS "shops_ins" ON shops;
DROP POLICY IF EXISTS "shops_upd" ON shops;
CREATE POLICY "shops_sel" ON shops FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "shops_ins" ON shops FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('shop:create') AND org_id = app_org_id());
CREATE POLICY "shops_upd" ON shops FOR UPDATE TO authenticated
  USING (app_has_perm('shop:update') AND org_id = app_org_id())
  WITH CHECK (app_has_perm('shop:update') AND org_id = app_org_id());

DROP POLICY IF EXISTS "users_sel" ON users;
DROP POLICY IF EXISTS "users_ins" ON users;
DROP POLICY IF EXISTS "users_upd" ON users;
CREATE POLICY "users_sel" ON users FOR SELECT TO authenticated
  USING (
    org_id = app_org_id()
    AND (
      app_role() = 'ADMIN'
      OR id = app_user_id()
      OR role = 'ADMIN'
      OR (app_shop_id() IS NOT NULL AND shop_id = app_shop_id())
    )
  );
CREATE POLICY "users_ins" ON users FOR INSERT TO authenticated
  WITH CHECK (
    (app_has_perm('user:create') AND org_id = app_org_id())
    -- first-ever user only (unfiltered count, see organizations_ins), and only
    -- the caller's own auth account
    OR (public.app_setup_needed() AND auth_id = auth.uid())
  );
CREATE POLICY "users_upd" ON users FOR UPDATE TO authenticated
  USING (app_has_perm('user:update') AND org_id = app_org_id())
  WITH CHECK (app_has_perm('user:update') AND org_id = app_org_id());

DROP POLICY IF EXISTS "business_profile_sel" ON business_profile;
DROP POLICY IF EXISTS "business_profile_upd" ON business_profile;
CREATE POLICY "business_profile_sel" ON business_profile FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "business_profile_upd" ON business_profile FOR UPDATE TO authenticated
  USING (app_role() = 'ADMIN' AND org_id = app_org_id())
  WITH CHECK (app_role() = 'ADMIN' AND org_id = app_org_id());

-- ============================================================
-- 2. Catalog tables with their own org_id
-- ============================================================
DROP POLICY IF EXISTS "categories_sel" ON categories;
DROP POLICY IF EXISTS "categories_ins" ON categories;
DROP POLICY IF EXISTS "categories_upd" ON categories;
CREATE POLICY "categories_sel" ON categories FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "categories_ins" ON categories FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('product:create') AND org_id = app_org_id());
CREATE POLICY "categories_upd" ON categories FOR UPDATE TO authenticated
  USING (app_has_perm('product:create') AND org_id = app_org_id())
  WITH CHECK (app_has_perm('product:create') AND org_id = app_org_id());

DROP POLICY IF EXISTS "brands_sel" ON brands;
DROP POLICY IF EXISTS "brands_ins" ON brands;
DROP POLICY IF EXISTS "brands_upd" ON brands;
CREATE POLICY "brands_sel" ON brands FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "brands_ins" ON brands FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('product:create') AND org_id = app_org_id());
CREATE POLICY "brands_upd" ON brands FOR UPDATE TO authenticated
  USING (app_has_perm('product:create') AND org_id = app_org_id())
  WITH CHECK (app_has_perm('product:create') AND org_id = app_org_id());

DROP POLICY IF EXISTS "products_sel" ON products;
DROP POLICY IF EXISTS "products_ins" ON products;
DROP POLICY IF EXISTS "products_upd" ON products;
CREATE POLICY "products_sel" ON products FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "products_ins" ON products FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('product:create') AND org_id = app_org_id());
CREATE POLICY "products_upd" ON products FOR UPDATE TO authenticated
  USING (app_has_perm('product:update') AND org_id = app_org_id())
  WITH CHECK (app_has_perm('product:update') AND org_id = app_org_id());

DROP POLICY IF EXISTS "suppliers_sel" ON suppliers;
DROP POLICY IF EXISTS "suppliers_ins" ON suppliers;
DROP POLICY IF EXISTS "suppliers_upd" ON suppliers;
CREATE POLICY "suppliers_sel" ON suppliers FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "suppliers_ins" ON suppliers FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('supplier:create') AND org_id = app_org_id());
CREATE POLICY "suppliers_upd" ON suppliers FOR UPDATE TO authenticated
  USING (app_has_perm('supplier:update') AND org_id = app_org_id())
  WITH CHECK (app_has_perm('supplier:update') AND org_id = app_org_id());

DROP POLICY IF EXISTS "unit_types_sel" ON unit_types;
DROP POLICY IF EXISTS "unit_types_ins" ON unit_types;
DROP POLICY IF EXISTS "unit_types_upd" ON unit_types;
CREATE POLICY "unit_types_sel" ON unit_types FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "unit_types_ins" ON unit_types FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('product:create') AND org_id = app_org_id());
CREATE POLICY "unit_types_upd" ON unit_types FOR UPDATE TO authenticated
  USING (app_has_perm('product:create') AND org_id = app_org_id())
  WITH CHECK (app_has_perm('product:create') AND org_id = app_org_id());

DROP POLICY IF EXISTS "price_levels_sel" ON price_levels;
DROP POLICY IF EXISTS "price_levels_ins" ON price_levels;
DROP POLICY IF EXISTS "price_levels_upd" ON price_levels;
CREATE POLICY "price_levels_sel" ON price_levels FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "price_levels_ins" ON price_levels FOR INSERT TO authenticated
  WITH CHECK ((app_has_perm('product:create') OR app_has_perm('pricing:manage')) AND org_id = app_org_id());
CREATE POLICY "price_levels_upd" ON price_levels FOR UPDATE TO authenticated
  USING ((app_has_perm('product:create') OR app_has_perm('pricing:manage')) AND org_id = app_org_id())
  WITH CHECK ((app_has_perm('product:create') OR app_has_perm('pricing:manage')) AND org_id = app_org_id());

DROP POLICY IF EXISTS "product_barcodes_sel" ON product_barcodes;
DROP POLICY IF EXISTS "product_barcodes_ins" ON product_barcodes;
DROP POLICY IF EXISTS "product_barcodes_del" ON product_barcodes;
CREATE POLICY "product_barcodes_sel" ON product_barcodes FOR SELECT TO authenticated
  USING (org_id = app_org_id());
CREATE POLICY "product_barcodes_ins" ON product_barcodes FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('barcode:manage') AND org_id = app_org_id());
CREATE POLICY "product_barcodes_del" ON product_barcodes FOR DELETE TO authenticated
  USING (app_has_perm('barcode:manage') AND org_id = app_org_id());

-- ============================================================
-- 3. Catalog children scoped through their parent
-- ============================================================
DROP POLICY IF EXISTS "product_units_sel" ON product_units;
DROP POLICY IF EXISTS "product_units_ins" ON product_units;
DROP POLICY IF EXISTS "product_units_upd" ON product_units;
CREATE POLICY "product_units_sel" ON product_units FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_units.product_id AND p.org_id = app_org_id()));
CREATE POLICY "product_units_ins" ON product_units FOR INSERT TO authenticated
  WITH CHECK (
    (app_has_perm('product:create') OR app_has_perm('product:update'))
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_units.product_id AND p.org_id = app_org_id())
  );
CREATE POLICY "product_units_upd" ON product_units FOR UPDATE TO authenticated
  USING (app_has_perm('product:update')
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_units.product_id AND p.org_id = app_org_id()))
  WITH CHECK (app_has_perm('product:update')
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_units.product_id AND p.org_id = app_org_id()));

DROP POLICY IF EXISTS "product_unit_prices_sel" ON product_unit_prices;
DROP POLICY IF EXISTS "product_unit_prices_ins" ON product_unit_prices;
DROP POLICY IF EXISTS "product_unit_prices_upd" ON product_unit_prices;
CREATE POLICY "product_unit_prices_sel" ON product_unit_prices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM product_units pu JOIN products p ON p.id = pu.product_id
                  WHERE pu.id = product_unit_prices.product_unit_id AND p.org_id = app_org_id()));
CREATE POLICY "product_unit_prices_ins" ON product_unit_prices FOR INSERT TO authenticated
  WITH CHECK (
    (app_has_perm('product:create') OR app_has_perm('product:update') OR app_has_perm('pricing:manage'))
    AND EXISTS (SELECT 1 FROM product_units pu JOIN products p ON p.id = pu.product_id
                 WHERE pu.id = product_unit_prices.product_unit_id AND p.org_id = app_org_id())
  );
CREATE POLICY "product_unit_prices_upd" ON product_unit_prices FOR UPDATE TO authenticated
  USING (
    (app_has_perm('product:update') OR app_has_perm('pricing:manage'))
    AND EXISTS (SELECT 1 FROM product_units pu JOIN products p ON p.id = pu.product_id
                 WHERE pu.id = product_unit_prices.product_unit_id AND p.org_id = app_org_id())
  )
  WITH CHECK (
    (app_has_perm('product:update') OR app_has_perm('pricing:manage'))
    AND EXISTS (SELECT 1 FROM product_units pu JOIN products p ON p.id = pu.product_id
                 WHERE pu.id = product_unit_prices.product_unit_id AND p.org_id = app_org_id())
  );

DROP POLICY IF EXISTS "price_tiers_sel" ON price_tiers;
DROP POLICY IF EXISTS "price_tiers_ins" ON price_tiers;
DROP POLICY IF EXISTS "price_tiers_upd" ON price_tiers;
DROP POLICY IF EXISTS "price_tiers_del" ON price_tiers;
CREATE POLICY "price_tiers_sel" ON price_tiers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = price_tiers.product_id AND p.org_id = app_org_id()));
CREATE POLICY "price_tiers_ins" ON price_tiers FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('pricing:manage')
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = price_tiers.product_id AND p.org_id = app_org_id()));
CREATE POLICY "price_tiers_upd" ON price_tiers FOR UPDATE TO authenticated
  USING (app_has_perm('pricing:manage')
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = price_tiers.product_id AND p.org_id = app_org_id()))
  WITH CHECK (app_has_perm('pricing:manage')
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = price_tiers.product_id AND p.org_id = app_org_id()));
CREATE POLICY "price_tiers_del" ON price_tiers FOR DELETE TO authenticated
  USING (app_has_perm('pricing:manage')
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = price_tiers.product_id AND p.org_id = app_org_id()));

DROP POLICY IF EXISTS "supplier_products_sel" ON supplier_products;
DROP POLICY IF EXISTS "supplier_products_ins" ON supplier_products;
DROP POLICY IF EXISTS "supplier_products_del" ON supplier_products;
CREATE POLICY "supplier_products_sel" ON supplier_products FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_products.supplier_id AND s.org_id = app_org_id())
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = supplier_products.product_id AND p.org_id = app_org_id())
  );
CREATE POLICY "supplier_products_ins" ON supplier_products FOR INSERT TO authenticated
  WITH CHECK (
    (app_has_perm('product:create') OR app_has_perm('product:update'))
    AND EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_products.supplier_id AND s.org_id = app_org_id())
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = supplier_products.product_id AND p.org_id = app_org_id())
  );
CREATE POLICY "supplier_products_del" ON supplier_products FOR DELETE TO authenticated
  USING (
    (app_has_perm('product:create') OR app_has_perm('product:update'))
    AND EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_products.supplier_id AND s.org_id = app_org_id())
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = supplier_products.product_id AND p.org_id = app_org_id())
  );

-- ============================================================
-- 4. Shop-derived operational tables (SELECT only - writes are RPC-only
--    since 010/013; the ADMIN branch gains the org term, the permission +
--    own-shop / own-row branches are unchanged).
-- ============================================================
DROP POLICY IF EXISTS "sales_sel" ON sales;
CREATE POLICY "sales_sel" ON sales FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN' AND shop_id IN (SELECT app_org_shop_ids()))
    OR (app_has_perm('sale:view') AND shop_id = app_shop_id())
    OR (
      app_has_perm('sales:view_own_shift')
      AND (
        cashier_id = app_user_id()
        OR shift_id IN (SELECT s.id FROM shifts s WHERE s.cashier_id = app_user_id())
      )
    )
  );

DROP POLICY IF EXISTS "sale_items_sel" ON sale_items;
CREATE POLICY "sale_items_sel" ON sale_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM sales s WHERE s.id = sale_items.sale_id));

DROP POLICY IF EXISTS "inventory_sel" ON inventory;
CREATE POLICY "inventory_sel" ON inventory FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN' AND shop_id IN (SELECT app_org_shop_ids()))
    OR (app_has_perm('inventory:view_stock') AND shop_id = app_shop_id())
  );

DROP POLICY IF EXISTS "inventory_movements_sel" ON inventory_movements;
CREATE POLICY "inventory_movements_sel" ON inventory_movements FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN' AND shop_id IN (SELECT app_org_shop_ids()))
    OR (app_has_perm('inventory:view_movements') AND shop_id = app_shop_id())
  );

DROP POLICY IF EXISTS "shifts_sel" ON shifts;
CREATE POLICY "shifts_sel" ON shifts FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN' AND shop_id IN (SELECT app_org_shop_ids()))
    OR (
      (app_has_perm('shift:manage_all') OR app_has_perm('report:shop_sales'))
      AND shop_id = app_shop_id()
    )
    OR (
      (app_has_perm('shift:manage_own') OR app_has_perm('report:own_shift'))
      AND cashier_id = app_user_id()
    )
  );

DROP POLICY IF EXISTS "purchase_orders_sel" ON purchase_orders;
CREATE POLICY "purchase_orders_sel" ON purchase_orders FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN' AND shop_id IN (SELECT app_org_shop_ids()))
    OR (app_has_perm('purchase:view') AND shop_id = app_shop_id())
  );

DROP POLICY IF EXISTS "purchase_order_items_sel" ON purchase_order_items;
CREATE POLICY "purchase_order_items_sel" ON purchase_order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_items.purchase_order_id));

DROP POLICY IF EXISTS "supplier_payments_sel" ON supplier_payments;
CREATE POLICY "supplier_payments_sel" ON supplier_payments FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN' AND shop_id IN (SELECT app_org_shop_ids()))
    OR (
      shop_id = app_shop_id()
      AND (app_has_perm('supplier:debt_view') OR app_has_perm('purchase:view'))
    )
  );

DROP POLICY IF EXISTS "stock_transfers_sel" ON stock_transfers;
CREATE POLICY "stock_transfers_sel" ON stock_transfers FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN'
      AND (from_shop_id IN (SELECT app_org_shop_ids()) OR to_shop_id IN (SELECT app_org_shop_ids())))
    OR (
      app_has_perm('transfer:view')
      AND (from_shop_id = app_shop_id() OR to_shop_id = app_shop_id())
    )
  );

DROP POLICY IF EXISTS "stock_transfer_items_sel" ON stock_transfer_items;
CREATE POLICY "stock_transfer_items_sel" ON stock_transfer_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM stock_transfers t WHERE t.id = stock_transfer_items.transfer_id));

DROP POLICY IF EXISTS "refund_void_requests_sel" ON refund_void_requests;
CREATE POLICY "refund_void_requests_sel" ON refund_void_requests FOR SELECT TO authenticated
  USING (
    (app_role() = 'ADMIN' AND shop_id IN (SELECT app_org_shop_ids()))
    OR (
      (app_has_perm('pos:refund') OR app_has_perm('pos:void_sale'))
      AND shop_id = app_shop_id()
    )
    OR created_by = app_user_id()
  );

DROP POLICY IF EXISTS "reprint_logs_sel" ON reprint_logs;
CREATE POLICY "reprint_logs_sel" ON reprint_logs FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM sales s WHERE s.id = reprint_logs.sale_id)
    OR printed_by = app_user_id()
  );

-- audit_logs: the org is the shop's org, or the actor's org for the shop-less
-- catalog events that 051 forces to shop_id = NULL.
DROP POLICY IF EXISTS "audit_logs_sel" ON audit_logs;
CREATE POLICY "audit_logs_sel" ON audit_logs FOR SELECT TO authenticated
  USING (
    (
      (app_role() = 'ADMIN' OR app_has_perm('audit:view_global'))
      AND (
        shop_id IN (SELECT app_org_shop_ids())
        OR (shop_id IS NULL AND actor_id IN (SELECT app_org_user_ids()))
      )
    )
    OR (app_has_perm('audit:view_shop') AND shop_id = app_shop_id())
  );

-- product_image_upload_sessions_owner_select (019): owner-only, already
-- org-safe; the create RPC gains the shop/product org guard in 070.

NOTIFY pgrst, 'reload schema';
