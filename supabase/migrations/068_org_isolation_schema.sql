-- ============================================================
-- Migration 068: organization isolation, part 1 of 4 - schema + helpers
--   (Phase G backend security audit: docs/selfhost-migration/phase-g/
--    org-isolation-audit.md)
--
-- PURPOSE
--   The owner's design (docs/09-roadmap-todo.md "Future Vision - Multi-Tenant
--   SaaS") is one organization per account: an ADMIN of org A must never see
--   or touch org B. Migration 059 added organizations / shops.org_id /
--   users.org_id and app_org_id(), but nothing used them: every RLS policy
--   still says `app_role() = 'ADMIN' OR shop_id = app_shop_id()` (an ADMIN of
--   ANY org reads and acts on EVERY org's shops), and the catalog tables
--   (products, categories, brands, suppliers, unit_types, price_levels and
--   their children) have no org dimension at all - `USING (true)`.
--
--   This file adds the org dimension and the helpers; 069 rewrites the RLS
--   policies, 070 adds the org guard to every mutating RPC, 071 scopes the
--   storage policies. Apply all four together (apply-migrations.sh runs them in
--   one transaction).
--
-- WHAT IT DOES
--   1. Helpers (all SECURITY DEFINER, read `users`/`shops` without RLS):
--        app_org_shop_ids()            SETOF text  shops of the caller's org
--        app_org_user_ids()            SETOF text  users of the caller's org
--        app_shop_in_org(shop_id)      boolean     shop belongs to caller's org
--        app_require_org(kind, id)     void        raises if <kind> <id> exists
--                                                  in ANOTHER org (no-op for
--                                                  NULL / unknown ids, so every
--                                                  existing 'not found' message
--                                                  is unchanged)
--        app_require_org_items(jsonb)  void        same for item arrays
--        app_can_for_shop(perm, shop)  REPLACED: ADMIN now also requires the
--                                      shop to be in the caller's org
--      Grants: authenticated may execute the three read helpers (RLS policies
--      evaluate as the caller); app_require_org* are owner/service_role only
--      (they are called from inside the SECURITY DEFINER RPCs and would
--      otherwise be an existence oracle for foreign ids).
--   2. `org_id text NOT NULL REFERENCES organizations(id)` on products,
--      categories, brands, suppliers, unit_types, price_levels,
--      business_profile and product_barcodes (barcodes carry it so the
--      barcode uniqueness index can be per-org - the same EAN sold by two
--      organizations MUST be allowed). Backfilled - see DATA MIGRATION.
--      product_units, product_unit_prices, price_tiers, supplier_products
--      stay without a column and are scoped through their parent in 069.
--   3. BEFORE INSERT triggers fill org_id from the caller (app_org_id()) when
--      the client did not send it - the frontend inserts products / barcodes /
--      shops directly and knows nothing about org_id. This ALSO fixes a
--      defect of the same class as 066: `shops.org_id` has been NOT NULL with
--      no default since 059 and shopSlice.addShop() never sends it, so adding
--      a shop through the app has failed since 059 was applied.
--      product_barcodes.org_id is copied from the parent product.
--      (review fix) enforce_same_org_refs() BEFORE INSERT/UPDATE triggers keep
--      catalog cross-references inside one org: products.brand_id,
--      brands.category_id, product_unit_prices.price_level_id/shop_id,
--      price_tiers.shop_id and supplier_products (supplier + product same
--      org). product_barcodes.product_unit_id is already bound to the same
--      product by a pre-existing trigger.
--   4. business_profile becomes one row PER ORGANIZATION: primary key moves
--      from (id) to (org_id); id stays 'default' (CHECK kept) so the frontend's
--      `.eq("id","default")` keeps returning exactly its own org's row under
--      the 069 policy. An AFTER INSERT trigger on organizations seeds the row
--      for every new org (the platform console and the first-login bootstrap
--      need no change); existing orgs are backfilled.
--   5. Global uniqueness indexes become per-organization (strictly relaxing,
--      cannot fail on existing data): shops name/code, suppliers code,
--      unit_types name/abbreviation, price_levels code and one-active-default,
--      product_barcodes value.
--   6. ensure_inventory_rows_for_product/_shop only pair products and shops
--      of the SAME org (they used to create inventory rows for every org's
--      shops x every org's products). Existing cross-org rows with zero stock
--      and no movements are deleted; anything else is reported with a NOTICE
--      and left for the operator.
--   7. rbac_assignment_violations: security_invoker = on (it ran as the
--      bypassrls owner and listed every org's violating users to any
--      authenticated caller - flagged by 065) and 'multiple_admins' counted
--      per org, matching 059's per-org constraint.
--
-- DATA MIGRATION IMPACT
--   The backfill assigns every existing catalog row to ONE organization: the
--   only org when exactly one exists (production snapshot 2026-10-11: exactly
--   one, org-shwe-pha-lar); the chosen org is printed as a NOTICE. If MORE
--   than one organization exists and catalog rows have a NULL org_id the
--   migration RAISES instead of guessing (review fix: an earlier draft picked
--   "the org with most shops") - set the GUC `phase_g.backfill_org` to the
--   owning org id in the same session and re-run. Verify before applying:
--     SELECT o.id, (SELECT count(*) FROM shops s WHERE s.org_id = o.id) shops
--       FROM organizations o ORDER BY o.created_at;
--
-- ROLLBACK
--   Columns, triggers and helpers are additive; to revert: DROP the triggers
--   and helper functions created here, restore app_can_for_shop from 003
--   (`SELECT app_has_perm(p_perm) AND (app_role() = 'ADMIN' OR app_shop_id()
--   IS NOT DISTINCT FROM p_shop_id)`), restore the ensure_inventory_rows_*
--   bodies from 046, recreate the global unique indexes from 022/023/025/030/
--   035 and, if wanted, `ALTER TABLE ... DROP COLUMN org_id`. The
--   business_profile PK change reverts with DROP CONSTRAINT
--   business_profile_pkey; ADD PRIMARY KEY (id) only while one org exists.
--   Restore 069-071 first (their policies/RPC bodies reference these helpers).
--
-- VERIFICATION
--   SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
--     AND column_name='org_id';                                   -- 10
--   SELECT count(*) FROM products WHERE org_id IS NULL;           -- 0
--   SELECT conname FROM pg_constraint WHERE conrelid='business_profile'::regclass
--     AND contype='p';                                            -- business_profile_pkey on (org_id)
--   SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_per_org';  -- 8 rows
--   SELECT prosrc LIKE '%app_shop_in_org%' FROM pg_proc WHERE proname='app_can_for_shop';  -- t
--
-- Run AFTER 001-067. Idempotent throughout (IF NOT EXISTS / IF EXISTS /
-- CREATE OR REPLACE / NULL-only backfills / constraint checks).
-- ============================================================

-- ============================================================
-- 1. Helpers
-- ============================================================
CREATE OR REPLACE FUNCTION app_org_shop_ids()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id FROM shops s WHERE s.org_id = app_org_id();
$$;

CREATE OR REPLACE FUNCTION app_org_user_ids()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT u.id FROM users u WHERE u.org_id = app_org_id();
$$;

CREATE OR REPLACE FUNCTION app_shop_in_org(p_shop_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_shop_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM shops s WHERE s.id = p_shop_id AND s.org_id = app_org_id());
$$;

-- ADMIN keeps "all shops" semantics, but only inside their own organization.
-- Non-admin branch unchanged (own shop, which is in the org by construction).
CREATE OR REPLACE FUNCTION app_can_for_shop(p_perm text, p_shop_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT app_has_perm(p_perm)
     AND (
       (app_role() = 'ADMIN' AND (p_shop_id IS NULL OR app_shop_in_org(p_shop_id)))
       OR app_shop_id() IS NOT DISTINCT FROM p_shop_id
     );
$$;

-- Raise iff the entity exists and belongs to another organization. NULL ids
-- and unknown ids are deliberately a no-op so the RPCs' own validation
-- messages ('Shop is required', 'Purchase order not found', ...) are unchanged.
CREATE OR REPLACE FUNCTION app_require_org(p_kind text, p_id text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org   text;
  v_org2  text;
  v_label text;
BEGIN
  IF p_id IS NULL OR btrim(p_id) = '' THEN RETURN; END IF;
  CASE p_kind
    WHEN 'shop' THEN
      v_label := 'Shop';
      SELECT org_id INTO v_org FROM shops WHERE id = p_id;
    WHEN 'product' THEN
      v_label := 'Product';
      SELECT org_id INTO v_org FROM products WHERE id = p_id;
    WHEN 'supplier' THEN
      v_label := 'Supplier';
      SELECT org_id INTO v_org FROM suppliers WHERE id = p_id;
    WHEN 'user' THEN
      v_label := 'User';
      SELECT org_id INTO v_org FROM users WHERE id = p_id;
    WHEN 'purchase_order' THEN
      v_label := 'Purchase order';
      SELECT s.org_id INTO v_org FROM purchase_orders po JOIN shops s ON s.id = po.shop_id WHERE po.id = p_id;
    WHEN 'stock_transfer' THEN
      v_label := 'Stock transfer';
      SELECT sf.org_id, st.org_id INTO v_org, v_org2
        FROM stock_transfers t
        LEFT JOIN shops sf ON sf.id = t.from_shop_id
        LEFT JOIN shops st ON st.id = t.to_shop_id
       WHERE t.id = p_id;
    WHEN 'sale' THEN
      v_label := 'Sale';
      SELECT s.org_id INTO v_org FROM sales sa JOIN shops s ON s.id = sa.shop_id WHERE sa.id = p_id;
    WHEN 'shift' THEN
      v_label := 'Shift';
      SELECT s.org_id INTO v_org FROM shifts sh JOIN shops s ON s.id = sh.shop_id WHERE sh.id = p_id;
    WHEN 'refund_void_request' THEN
      v_label := 'Request';
      SELECT s.org_id INTO v_org FROM refund_void_requests r JOIN shops s ON s.id = r.shop_id WHERE r.id = p_id;
    WHEN 'supplier_payment' THEN
      v_label := 'Supplier payment';
      SELECT s.org_id INTO v_org FROM supplier_payments sp JOIN shops s ON s.id = sp.shop_id WHERE sp.id = p_id;
    ELSE
      RAISE EXCEPTION 'app_require_org: unknown kind %', p_kind;
  END CASE;

  IF (v_org IS NOT NULL AND v_org IS DISTINCT FROM app_org_id())
     OR (v_org2 IS NOT NULL AND v_org2 IS DISTINCT FROM app_org_id()) THEN
    RAISE EXCEPTION '% not found in your organization', v_label USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Item arrays of complete_sale / create_purchase_order / create_stock_transfer:
-- every `product_id` must be in the caller's org. Non-arrays are ignored (the
-- RPC's own validation handles them).
CREATE OR REPLACE FUNCTION app_require_org_items(p_items jsonb)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RETURN; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) = 'object' THEN
      PERFORM app_require_org('product', v_item->>'product_id');
    END IF;
  END LOOP;
END;
$$;

-- Fill org_id from the caller when a direct insert omits it.
CREATE OR REPLACE FUNCTION set_org_id_from_caller()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    NEW.org_id := app_org_id();
  END IF;
  RETURN NEW;
END;
$$;

-- product_barcodes.org_id always mirrors the parent product. Not SECURITY
-- DEFINER on purpose: for an authenticated caller the lookup is RLS-filtered,
-- so a barcode for another org's product resolves to NULL and fails NOT NULL.
CREATE OR REPLACE FUNCTION product_barcodes_set_org_id()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  SELECT p.org_id INTO NEW.org_id FROM products p WHERE p.id = NEW.product_id;
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'Product not found in your organization' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Every organization gets its own business_profile row (one per org, id =
-- 'default'). SECURITY DEFINER: authenticated has no INSERT on business_profile
-- (043) and the first-login bootstrap inserts the org as `authenticated`.
CREATE OR REPLACE FUNCTION organizations_seed_business_profile()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO business_profile (id, org_id) VALUES ('default', NEW.id)
  ON CONFLICT (org_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_org_shop_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_org_user_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_shop_in_org(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_can_for_shop(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_require_org(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_require_org_items(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION set_org_id_from_caller() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION product_barcodes_set_org_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION organizations_seed_business_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_org_shop_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_org_user_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_shop_in_org(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_can_for_shop(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_require_org(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION app_require_org_items(jsonb) TO service_role;
-- trigger functions: same grant shape as the existing *_set_updated_at ones (064)
GRANT EXECUTE ON FUNCTION set_org_id_from_caller() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION product_barcodes_set_org_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION organizations_seed_business_profile() TO authenticated, service_role;

-- ============================================================
-- 2. org_id columns (nullable first; backfilled and NOT NULL in §3)
-- ============================================================
ALTER TABLE products         ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
ALTER TABLE categories       ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
ALTER TABLE brands           ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
ALTER TABLE suppliers        ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
ALTER TABLE unit_types       ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
ALTER TABLE price_levels     ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
-- ON DELETE CASCADE (review fix): the row is seeded by a trigger on every new
-- org, so without it the platform console's rollback (DELETE the org when the
-- ADMIN insert fails) is blocked and leaves an orphan organization. Orgs with
-- shops/users/catalog rows are still protected by those tables' FKs.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS products_org_idx         ON products (org_id);
CREATE INDEX IF NOT EXISTS categories_org_idx       ON categories (org_id);
CREATE INDEX IF NOT EXISTS brands_org_idx           ON brands (org_id);
CREATE INDEX IF NOT EXISTS suppliers_org_idx        ON suppliers (org_id);
CREATE INDEX IF NOT EXISTS unit_types_org_idx       ON unit_types (org_id);
CREATE INDEX IF NOT EXISTS price_levels_org_idx     ON price_levels (org_id);
CREATE INDEX IF NOT EXISTS product_barcodes_org_idx ON product_barcodes (org_id);
CREATE INDEX IF NOT EXISTS shops_org_idx            ON shops (org_id);
CREATE INDEX IF NOT EXISTS users_org_idx            ON users (org_id);

-- ============================================================
-- 3. Backfill. Decides the owning org ONCE (session GUC phase_g.backfill_org),
--    only when some row actually needs it; NULL-only updates => idempotent.
-- ============================================================
DO $$
DECLARE
  v_needed  bigint;
  v_org     text := NULLIF(current_setting('phase_g.backfill_org', true), '');
  v_orgs    int;
  v_shop_orgs int;
BEGIN
  SELECT (SELECT count(*) FROM products WHERE org_id IS NULL)
       + (SELECT count(*) FROM categories WHERE org_id IS NULL)
       + (SELECT count(*) FROM brands WHERE org_id IS NULL)
       + (SELECT count(*) FROM suppliers WHERE org_id IS NULL)
       + (SELECT count(*) FROM unit_types WHERE org_id IS NULL)
       + (SELECT count(*) FROM price_levels WHERE org_id IS NULL)
       + (SELECT count(*) FROM business_profile WHERE org_id IS NULL)
       + (SELECT count(*) FROM product_barcodes b WHERE b.org_id IS NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = b.product_id))
    INTO v_needed;
  IF v_needed = 0 THEN
    RAISE NOTICE '068: no catalog rows need an org_id backfill';
    RETURN;
  END IF;

  IF v_org IS NULL THEN
    SELECT count(*) INTO v_orgs FROM organizations;
    IF v_orgs = 0 THEN
      RAISE EXCEPTION '068: % catalog rows have no org_id but no organization exists - run 059 first', v_needed;
    ELSIF v_orgs = 1 THEN
      SELECT id INTO v_org FROM organizations;
    ELSE
      -- Review fix: never guess. The catalog tables carry no relationship to
      -- an org (no created_by/org column), so with several organizations any
      -- heuristic (e.g. "the org with most shops") could hand one tenant's
      -- products to another. The operator must name the owner explicitly.
      SELECT count(DISTINCT org_id) INTO v_shop_orgs FROM shops;
      RAISE EXCEPTION '068: % catalog rows have no org_id and % organizations exist (% own shops) - refusing to guess the owner; SET phase_g.backfill_org = ''<org id>'' in this session and re-run',
        v_needed, v_orgs, v_shop_orgs;
    END IF;
  END IF;
  PERFORM 1 FROM organizations WHERE id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION '068: phase_g.backfill_org = % is not an organization id', v_org; END IF;
  PERFORM set_config('phase_g.backfill_org', v_org, false);
  RAISE NOTICE '068: backfilling % catalog rows with org_id = %', v_needed, v_org;

  UPDATE products         SET org_id = v_org WHERE org_id IS NULL;
  UPDATE categories       SET org_id = v_org WHERE org_id IS NULL;
  UPDATE brands           SET org_id = v_org WHERE org_id IS NULL;
  UPDATE suppliers        SET org_id = v_org WHERE org_id IS NULL;
  UPDATE unit_types       SET org_id = v_org WHERE org_id IS NULL;
  UPDATE price_levels     SET org_id = v_org WHERE org_id IS NULL;
  UPDATE business_profile SET org_id = v_org WHERE org_id IS NULL;
END $$;

-- barcodes follow their product (covers both the first run and re-runs)
UPDATE product_barcodes b
   SET org_id = p.org_id
  FROM products p
 WHERE p.id = b.product_id AND b.org_id IS DISTINCT FROM p.org_id;

ALTER TABLE products         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE categories       ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE brands           ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE suppliers        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE unit_types       ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE price_levels     ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE business_profile ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE product_barcodes ALTER COLUMN org_id SET NOT NULL;

-- ============================================================
-- 4. business_profile: one row per organization (PK (id) -> PK (org_id)).
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
              WHERE c.conrelid = 'business_profile'::regclass AND c.contype = 'p' AND a.attname = 'id') THEN
    ALTER TABLE business_profile DROP CONSTRAINT business_profile_pkey;
    ALTER TABLE business_profile ADD CONSTRAINT business_profile_pkey PRIMARY KEY (org_id);
  END IF;
END $$;

-- every existing org gets its row (new orgs: trigger below)
INSERT INTO business_profile (id, org_id)
SELECT 'default', o.id FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM business_profile b WHERE b.org_id = o.id);

DROP TRIGGER IF EXISTS organizations_seed_business_profile ON organizations;
CREATE TRIGGER organizations_seed_business_profile
  AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_seed_business_profile();

-- ============================================================
-- 5. Fill-from-caller triggers (direct client inserts omit org_id).
-- ============================================================
DROP TRIGGER IF EXISTS products_set_org_id ON products;
CREATE TRIGGER products_set_org_id BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_caller();
DROP TRIGGER IF EXISTS categories_set_org_id ON categories;
CREATE TRIGGER categories_set_org_id BEFORE INSERT ON categories
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_caller();
DROP TRIGGER IF EXISTS brands_set_org_id ON brands;
CREATE TRIGGER brands_set_org_id BEFORE INSERT ON brands
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_caller();
DROP TRIGGER IF EXISTS suppliers_set_org_id ON suppliers;
CREATE TRIGGER suppliers_set_org_id BEFORE INSERT ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_caller();
DROP TRIGGER IF EXISTS unit_types_set_org_id ON unit_types;
CREATE TRIGGER unit_types_set_org_id BEFORE INSERT ON unit_types
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_caller();
DROP TRIGGER IF EXISTS price_levels_set_org_id ON price_levels;
CREATE TRIGGER price_levels_set_org_id BEFORE INSERT ON price_levels
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_caller();
-- shops: fixes addShop() (no org_id sent since 059 made the column NOT NULL)
DROP TRIGGER IF EXISTS shops_set_org_id ON shops;
CREATE TRIGGER shops_set_org_id BEFORE INSERT ON shops
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_caller();
-- barcodes: always the parent product's org
DROP TRIGGER IF EXISTS product_barcodes_set_org_id ON product_barcodes;
CREATE TRIGGER product_barcodes_set_org_id BEFORE INSERT OR UPDATE OF product_id ON product_barcodes
  FOR EACH ROW EXECUTE FUNCTION product_barcodes_set_org_id();

-- ------------------------------------------------------------
-- 5b. (review fix) Cross-references between catalog rows stay inside one
--     organization. The FKs below only prove the target EXISTS; without this
--     an org-A writer could point its rows at org B's brand / category /
--     price level / shop (an existence oracle and a pin that blocks
--     org B from deleting its own row). The org of the written row is
--     compared with the org of every referenced row; an unknown id and a
--     foreign id raise the SAME message. Not SECURITY DEFINER: for an
--     authenticated caller the lookups are RLS-filtered as well, and the
--     explicit org comparison makes the check exact for service_role and
--     for SECURITY DEFINER RPCs. Trigger names sort after *_set_org_id so
--     the row's org_id is already filled in.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_same_org_refs()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  v_org text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'products' THEN
      IF NEW.brand_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM brands b WHERE b.id = NEW.brand_id AND b.org_id = NEW.org_id) THEN
        RAISE EXCEPTION 'Brand not found in your organization' USING ERRCODE = 'P0001';
      END IF;
    WHEN 'brands' THEN
      IF NEW.category_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM categories c WHERE c.id = NEW.category_id AND c.org_id = NEW.org_id) THEN
        RAISE EXCEPTION 'Category not found in your organization' USING ERRCODE = 'P0001';
      END IF;
    WHEN 'product_unit_prices' THEN
      SELECT p.org_id INTO v_org FROM product_units pu JOIN products p ON p.id = pu.product_id
       WHERE pu.id = NEW.product_unit_id;
      IF v_org IS NULL THEN
        RAISE EXCEPTION 'Product not found in your organization' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.price_level_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM price_levels l WHERE l.id = NEW.price_level_id AND l.org_id = v_org) THEN
        RAISE EXCEPTION 'Price level not found in your organization' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.shop_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM shops s WHERE s.id = NEW.shop_id AND s.org_id = v_org) THEN
        RAISE EXCEPTION 'Shop not found in your organization' USING ERRCODE = 'P0001';
      END IF;
    WHEN 'price_tiers' THEN
      SELECT p.org_id INTO v_org FROM products p WHERE p.id = NEW.product_id;
      IF v_org IS NULL THEN
        RAISE EXCEPTION 'Product not found in your organization' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.shop_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM shops s WHERE s.id = NEW.shop_id AND s.org_id = v_org) THEN
        RAISE EXCEPTION 'Shop not found in your organization' USING ERRCODE = 'P0001';
      END IF;
    WHEN 'supplier_products' THEN
      IF NOT EXISTS (SELECT 1 FROM suppliers s JOIN products p ON p.org_id = s.org_id
                      WHERE s.id = NEW.supplier_id AND p.id = NEW.product_id) THEN
        RAISE EXCEPTION 'Supplier or product not found in your organization' USING ERRCODE = 'P0001';
      END IF;
    ELSE
      RAISE EXCEPTION 'enforce_same_org_refs: unexpected table %', TG_TABLE_NAME;
  END CASE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_same_org_refs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION enforce_same_org_refs() TO authenticated, service_role;

DROP TRIGGER IF EXISTS products_xorg_refs ON products;
CREATE TRIGGER products_xorg_refs BEFORE INSERT OR UPDATE OF brand_id, org_id ON products
  FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs();
DROP TRIGGER IF EXISTS brands_xorg_refs ON brands;
CREATE TRIGGER brands_xorg_refs BEFORE INSERT OR UPDATE OF category_id, org_id ON brands
  FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs();
DROP TRIGGER IF EXISTS product_unit_prices_xorg_refs ON product_unit_prices;
CREATE TRIGGER product_unit_prices_xorg_refs BEFORE INSERT OR UPDATE OF product_unit_id, price_level_id, shop_id ON product_unit_prices
  FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs();
DROP TRIGGER IF EXISTS price_tiers_xorg_refs ON price_tiers;
CREATE TRIGGER price_tiers_xorg_refs BEFORE INSERT OR UPDATE OF product_id, shop_id ON price_tiers
  FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs();
DROP TRIGGER IF EXISTS supplier_products_xorg_refs ON supplier_products;
CREATE TRIGGER supplier_products_xorg_refs BEFORE INSERT OR UPDATE ON supplier_products
  FOR EACH ROW EXECUTE FUNCTION enforce_same_org_refs();

-- ============================================================
-- 6. Uniqueness per organization (replaces the global indexes; relaxing only).
-- ============================================================
DROP INDEX IF EXISTS shops_unique_normalized_name;
CREATE UNIQUE INDEX IF NOT EXISTS shops_unique_normalized_name_per_org
  ON shops (org_id, lower(btrim(name)));
DROP INDEX IF EXISTS shops_unique_normalized_code;
CREATE UNIQUE INDEX IF NOT EXISTS shops_unique_normalized_code_per_org
  ON shops (org_id, lower(btrim(code))) WHERE NULLIF(btrim(code), '') IS NOT NULL;

DROP INDEX IF EXISTS suppliers_unique_normalized_code;
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_unique_normalized_code_per_org
  ON suppliers (org_id, lower(btrim(code))) WHERE NULLIF(btrim(code), '') IS NOT NULL;

DROP INDEX IF EXISTS unit_types_unique_normalized_name;
CREATE UNIQUE INDEX IF NOT EXISTS unit_types_unique_normalized_name_per_org
  ON unit_types (org_id, lower(btrim(name)));
DROP INDEX IF EXISTS unit_types_unique_normalized_abbrev;
CREATE UNIQUE INDEX IF NOT EXISTS unit_types_unique_normalized_abbrev_per_org
  ON unit_types (org_id, lower(btrim(abbreviation)))
  WHERE abbreviation IS NOT NULL AND length(btrim(abbreviation)) > 0;

DROP INDEX IF EXISTS price_levels_code_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS price_levels_code_normalized_per_org
  ON price_levels (org_id, lower(btrim(code)));
DROP INDEX IF EXISTS price_levels_one_active_default;
CREATE UNIQUE INDEX IF NOT EXISTS price_levels_one_active_default_per_org
  ON price_levels (org_id) WHERE is_default = true AND is_active = true;

DROP INDEX IF EXISTS product_barcodes_unique_normalized_value;
CREATE UNIQUE INDEX IF NOT EXISTS product_barcodes_unique_normalized_value_per_org
  ON product_barcodes (org_id, lower(btrim(value))) WHERE NULLIF(btrim(value), '') IS NOT NULL;

-- ============================================================
-- 7. Inventory auto-rows stay inside one organization (046 bodies + org join).
-- ============================================================
CREATE OR REPLACE FUNCTION ensure_inventory_rows_for_product()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    SELECT s.id, NEW.id, 0
    FROM shops s
    WHERE s.is_active = true
      AND s.org_id = NEW.org_id
    ON CONFLICT (shop_id, product_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_inventory_rows_for_shop()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    SELECT NEW.id, p.id, 0
    FROM products p
    WHERE p.is_active = true
      AND p.org_id = NEW.org_id
    ON CONFLICT (shop_id, product_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_deleted bigint;
  v_left    bigint;
BEGIN
  WITH gone AS (
    DELETE FROM inventory i
     USING shops s, products p
     WHERE s.id = i.shop_id AND p.id = i.product_id AND s.org_id <> p.org_id
       AND i.qty_base_units = 0
       AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.shop_id = i.shop_id AND m.product_id = i.product_id)
    RETURNING 1)
  SELECT count(*) INTO v_deleted FROM gone;
  SELECT count(*) INTO v_left
    FROM inventory i JOIN shops s ON s.id = i.shop_id JOIN products p ON p.id = i.product_id
   WHERE s.org_id <> p.org_id;
  RAISE NOTICE '068: removed % empty cross-org inventory rows; % cross-org rows with stock/movements left for the operator', v_deleted, v_left;
END $$;

-- ============================================================
-- 8. rbac_assignment_violations: run as the caller, admins counted per org.
-- ============================================================
CREATE OR REPLACE VIEW rbac_assignment_violations AS
SELECT 'multiple_admins' AS kind,
       NULL::text         AS shop_id,
       u.id               AS user_id,
       u.name             AS user_name,
       u.role,
       u.is_active
  FROM users u
 WHERE u.role = 'ADMIN'
   AND (SELECT count(*) FROM users a WHERE a.role = 'ADMIN' AND a.org_id = u.org_id) > 1
UNION ALL
SELECT 'shop_with_multiple_active_managers',
       u.shop_id, u.id, u.name, u.role, u.is_active
  FROM users u
 WHERE u.role = 'MANAGER'
   AND u.is_active = true
   AND u.shop_id IN (
     SELECT shop_id FROM users
      WHERE role = 'MANAGER' AND is_active = true AND shop_id IS NOT NULL
      GROUP BY shop_id HAVING count(*) > 1
   )
UNION ALL
SELECT 'active_manager_without_shop',
       u.shop_id, u.id, u.name, u.role, u.is_active
  FROM users u
 WHERE u.role = 'MANAGER' AND u.is_active = true AND u.shop_id IS NULL
UNION ALL
SELECT 'active_cashier_without_shop',
       u.shop_id, u.id, u.name, u.role, u.is_active
  FROM users u
 WHERE u.role = 'CASHIER' AND u.is_active = true AND u.shop_id IS NULL
UNION ALL
SELECT 'active_cashier_without_manager',
       u.shop_id, u.id, u.name, u.role, u.is_active
  FROM users u
 WHERE u.role = 'CASHIER'
   AND u.is_active = true
   AND u.shop_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM users m
      WHERE m.role = 'MANAGER' AND m.is_active = true AND m.shop_id = u.shop_id
   );
ALTER VIEW rbac_assignment_violations SET (security_invoker = on);

NOTIFY pgrst, 'reload schema';
