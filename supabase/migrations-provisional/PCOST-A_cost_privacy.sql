-- ============================================================
-- PROVISIONAL migration PCOST-A: cost privacy (P-4)
-- (no number assigned; see supabase/migrations-provisional/README.md)
--
-- DEFECT
--   Purchase cost and the COGS snapshot are plain columns of tables every
--   signed-in user of the organisation can read through PostgREST:
--     products.cost_mmk                   every active user (products_sel = org)
--     product_units.purchase_price_mmk    every active user (product_units_sel = org)
--     sale_items.unit_cost_mmk_snapshot   whoever can read the sale (cashiers:
--                                          their own sales)
--   and complete_sale returns unitCostMmkSnapshot to the cashier. RLS is
--   ROW security: it cannot hide a column. Column privileges cannot help
--   either: every app user is the same database role (authenticated), so a
--   column REVOKE would hide cost from ADMIN too, and every released client
--   that reads these tables with select=* would fail outright (42501).
--
-- DESIGN (the 1.0.17 plan's 093/095 cost tables, without touching any
-- 086-digested RPC body)
--   1. Cost moves to three side tables whose rows are visible only with
--      report:shop_profit:
--        product_costs        (product_id → cost_mmk)              org scope
--        product_unit_costs   (product_unit_id → purchase_price)   org scope
--        sale_item_costs      (sale_item_id → unit cost snapshot)  shop scope
--                             (ADMIN: any shop of the org; others: own shop)
--      No API role can write them (service_role reads only); only the
--      triggers below (SECURITY DEFINER) do.
--   2. Backfill with count + sum assertions, then the legacy columns are set to
--      NULL. They stay in the tables, so released clients' select=* keeps
--      working; they simply read NULL.
--   3. Redirect triggers keep the legacy columns NULL forever:
--        products / product_units: a non-NULL cost from an API caller holding
--          report:shop_profit (or service_role / a SQL session) is stored in
--          the side table and the column is written NULL; from an API caller
--          without the permission it is refused (42501). NULL = "no change"
--          (a client that cannot see cost never erases it).
--        sale_items: on insert the line's cost snapshot is taken (the
--          engine's value if it had one, else the product's cost in
--          product_costs) into sale_item_costs and the column stored NULL.
--          complete_sale (072, 086-digested) is NOT changed: it reads the
--          now-NULL products.cost_mmk, so its reply carries no cost either.
--        purchase_order_items: receive_purchase_order snapshots the unit's
--          purchase price from product_units (now NULL); the trigger fills
--          the snapshot from product_unit_costs instead (purchase-scoped
--          table, readable only with purchase:view, as before).
--   4. Reports: PFIN-B reads cost only through fin_line_costs, which uses
--      sale_item_costs when it exists (PFIN-B's own permission checks are
--      unchanged).
--
-- NOT DONE HERE (owner decisions, see README)
--   - Stored complete_sale replies in idempotency_keys keep the
--     unitCostMmkSnapshot of sales made BEFORE this migration. 087 signs the
--     reply's sha256 into the till journals (v87_finish), so rewriting them
--     would make replays disagree with the recovery evidence 088 must check.
--     A stored reply is replayable only with its key, in its org, by its
--     actor (or an ADMIN / sync:resolve resolver).
--   - purchase_order_items unit costs stay readable with purchase:view
--     (purchasing duty, unchanged).
--
-- 087
--   products, product_units, sale_items, purchase_order_items are guarded:
--   this file must run as the superuser runner, refuses over unexplained
--   drift, and re-registers the snapshot. The backfill / null-out are writes
--   on guarded tables: they need the server OPEN (a held server refuses them
--   and the whole file rolls back). A re-run moves nothing and is safe while
--   held. The side tables are not 087-guarded; no API role may write them
--   (service_role reads only), and the only writers are the triggers on the
--   guarded tables, so no write reaches them during a hold. The move takes
--   SHARE ROW EXCLUSIVE locks on the four tables (writers wait, readers do
--   not) so no live write falls between the copy and the triggers.
--   Run with --single-transaction (LOCK TABLE requires a transaction).
--
-- Idempotent. Rollback: PCOST-A.rollback.sql (copies the costs back).
-- ============================================================

SET lock_timeout = '3s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pcost_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PCOST-A: migration 087 is installed: run as the superuser migration runner';
    END IF;
    IF EXISTS (SELECT 1 FROM recovery_guard.snapshot g
                WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = g.relid)
                   OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
       OR EXISTS (SELECT 1 FROM recovery_guard.functions f
                   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn
                                       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')))
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                    AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                    AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)) THEN
      RAISE EXCEPTION 'PCOST-A: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pcost_pre$;

-- ------------------------------------------------------------ 1. side tables
CREATE TABLE IF NOT EXISTS public.product_costs (
  product_id text PRIMARY KEY REFERENCES public.products (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  org_id     text NOT NULL REFERENCES public.organizations (id),
  cost_mmk   integer NOT NULL CHECK (cost_mmk >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
CREATE TABLE IF NOT EXISTS public.product_unit_costs (
  product_unit_id    text PRIMARY KEY REFERENCES public.product_units (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  product_id         text NOT NULL,
  org_id             text NOT NULL REFERENCES public.organizations (id),
  purchase_price_mmk integer NOT NULL CHECK (purchase_price_mmk >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text
);
CREATE TABLE IF NOT EXISTS public.sale_item_costs (
  sale_item_id  text PRIMARY KEY REFERENCES public.sale_items (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  sale_id       text NOT NULL,
  shop_id       text NOT NULL,
  org_id        text NOT NULL,
  unit_cost_mmk integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_costs_org_idx ON public.product_costs (org_id);
CREATE INDEX IF NOT EXISTS product_unit_costs_org_idx ON public.product_unit_costs (org_id);
CREATE INDEX IF NOT EXISTS sale_item_costs_sale_idx ON public.sale_item_costs (sale_id);
CREATE INDEX IF NOT EXISTS sale_item_costs_shop_idx ON public.sale_item_costs (shop_id);

ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_unit_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_item_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_costs_sel ON public.product_costs;
CREATE POLICY product_costs_sel ON public.product_costs FOR SELECT TO authenticated
  USING (org_id = public.app_org_id() AND public.app_has_perm('report:shop_profit'));
DROP POLICY IF EXISTS product_unit_costs_sel ON public.product_unit_costs;
CREATE POLICY product_unit_costs_sel ON public.product_unit_costs FOR SELECT TO authenticated
  USING (org_id = public.app_org_id() AND public.app_has_perm('report:shop_profit'));
DROP POLICY IF EXISTS sale_item_costs_sel ON public.sale_item_costs;
CREATE POLICY sale_item_costs_sel ON public.sale_item_costs FOR SELECT TO authenticated
  USING (
    public.app_has_perm('report:shop_profit')
    AND ((public.app_role() = 'ADMIN' AND shop_id IN (SELECT public.app_org_shop_ids()))
         OR shop_id = public.app_shop_id())
  );

REVOKE ALL ON public.product_costs, public.product_unit_costs, public.sale_item_costs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.product_costs, public.product_unit_costs, public.sale_item_costs TO authenticated;
-- service_role reads only: every write goes through the redirect triggers on
-- the 087-guarded parent tables, so a held server stops cost writes too.
GRANT SELECT ON public.product_costs, public.product_unit_costs, public.sale_item_costs TO service_role;
ALTER TABLE public.product_costs OWNER TO postgres;
ALTER TABLE public.product_unit_costs OWNER TO postgres;
ALTER TABLE public.sale_item_costs OWNER TO postgres;

-- ------------------------------------------------------------ 2. who may set cost
-- An API request (JWT role anon / authenticated) needs report:shop_profit.
-- service_role and SQL sessions (migrations, owner) are trusted.
CREATE OR REPLACE FUNCTION public.cost_write_allowed()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                  nullif(current_setting('request.jwt.claim.role', true), '')) IN ('anon', 'authenticated')
      THEN app_has_perm('report:shop_profit')
    ELSE true
  END;
$$;

-- ------------------------------------------------------------ 3. redirect triggers
CREATE OR REPLACE FUNCTION public.cost_redirect_products()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.cost_mmk IS NULL THEN RETURN NEW; END IF;          -- NULL = no change (never erases a cost)
  IF NOT cost_write_allowed() THEN
    RAISE EXCEPTION 'You are not permitted to set product cost' USING ERRCODE = '42501';
  END IF;
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'Product organization is not set' USING ERRCODE = '23502';
  END IF;
  -- A BEFORE INSERT trigger runs before the primary-key conflict is seen: an
  -- upsert naming ANOTHER organisation's product id (ignore-duplicates turns
  -- the conflict into a no-op) must not reach that product's cost row.
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM products WHERE id = NEW.id AND org_id IS DISTINCT FROM NEW.org_id) THEN
    RAISE EXCEPTION 'You are not permitted to set product cost' USING ERRCODE = '42501';
  END IF;
  INSERT INTO product_costs AS pc (product_id, org_id, cost_mmk, updated_at, updated_by)
  VALUES (NEW.id, NEW.org_id, NEW.cost_mmk, now(), (SELECT id FROM current_app_user()))
  ON CONFLICT (product_id) DO UPDATE
    SET cost_mmk = EXCLUDED.cost_mmk, updated_at = now(), updated_by = EXCLUDED.updated_by
    WHERE pc.org_id = EXCLUDED.org_id;           -- a cost row never changes organisation
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are not permitted to set product cost' USING ERRCODE = '42501';
  END IF;
  NEW.cost_mmk := NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_redirect_product_units()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_org text;
BEGIN
  IF NEW.purchase_price_mmk IS NULL THEN RETURN NEW; END IF;
  IF NOT cost_write_allowed() THEN
    RAISE EXCEPTION 'You are not permitted to set purchase prices' USING ERRCODE = '42501';
  END IF;
  SELECT org_id INTO v_org FROM products WHERE id = NEW.product_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Product not found for this unit' USING ERRCODE = '23503';
  END IF;
  -- as for products: an insert naming another organisation's unit id
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM product_units u JOIN products p ON p.id = u.product_id
                                   WHERE u.id = NEW.id AND p.org_id IS DISTINCT FROM v_org) THEN
    RAISE EXCEPTION 'You are not permitted to set purchase prices' USING ERRCODE = '42501';
  END IF;
  INSERT INTO product_unit_costs AS pu (product_unit_id, product_id, org_id, purchase_price_mmk, updated_at, updated_by)
  VALUES (NEW.id, NEW.product_id, v_org, NEW.purchase_price_mmk, now(), (SELECT id FROM current_app_user()))
  ON CONFLICT (product_unit_id) DO UPDATE
    SET purchase_price_mmk = EXCLUDED.purchase_price_mmk, product_id = EXCLUDED.product_id,
        updated_at = now(), updated_by = EXCLUDED.updated_by
    WHERE pu.org_id = EXCLUDED.org_id;           -- a cost row never changes organisation
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are not permitted to set purchase prices' USING ERRCODE = '42501';
  END IF;
  NEW.purchase_price_mmk := NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_redirect_sale_items()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_cost integer; v_shop text; v_org text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.unit_cost_mmk_snapshot IS NULL THEN RETURN NEW; END IF;
  -- The engine's snapshot when it had one, else the product's confidential
  -- cost -- the value complete_sale read from products.cost_mmk before this
  -- migration. Only inside an API request (complete_sale): a SQL-session
  -- insert (data-only restore, import, backfill) of a line without a
  -- snapshot stays uncosted rather than taking today's cost.
  v_cost := COALESCE(NEW.unit_cost_mmk_snapshot,
    CASE WHEN nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
              OR nullif(current_setting('request.jwt.claim.role', true), '') IS NOT NULL
         THEN (SELECT cost_mmk FROM product_costs WHERE product_id = NEW.product_id) END);
  IF v_cost IS NOT NULL THEN
    SELECT s.shop_id, sh.org_id INTO v_shop, v_org FROM sales s JOIN shops sh ON sh.id = s.shop_id WHERE s.id = NEW.sale_id;
    IF v_shop IS NULL THEN
      RAISE EXCEPTION 'Sale not found for this line' USING ERRCODE = '23503';
    END IF;
    INSERT INTO sale_item_costs AS c (sale_item_id, sale_id, shop_id, org_id, unit_cost_mmk)
    VALUES (NEW.id, NEW.sale_id, v_shop, v_org, v_cost)
    ON CONFLICT (sale_item_id) DO UPDATE SET unit_cost_mmk = EXCLUDED.unit_cost_mmk;
  END IF;
  NEW.unit_cost_mmk_snapshot := NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_fill_po_unit_price()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- receive_purchase_order (070) snapshots product_units.purchase_price_mmk, now
  -- always NULL: take the unit's price from product_unit_costs instead.
  IF NEW.unit_purchase_price_snapshot IS NULL AND NEW.product_unit_id IS NOT NULL
     AND NEW.received_qty IS DISTINCT FROM OLD.received_qty THEN
    NEW.unit_purchase_price_snapshot := (SELECT purchase_price_mmk FROM product_unit_costs WHERE product_unit_id = NEW.product_unit_id);
  END IF;
  RETURN NEW;
END;
$$;

DO $pcost_fns$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.cost_write_allowed()', 'public.cost_redirect_products()', 'public.cost_redirect_product_units()',
                           'public.cost_redirect_sale_items()', 'public.cost_fill_po_unit_price()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $pcost_fns$;

-- ------------------------------------------------------------ 4. backfill (asserted), then null-out
-- The server is OPEN while this runs (087), so tills may be writing. Block
-- writes (not reads) to the four tables until commit: otherwise a sale line
-- or cost edit committed between the copy and the null-out would be nulled
-- without being copied, and one committed after the null-out but before the
-- triggers would stay readable to everyone. lock_timeout (3s) makes a busy
-- server fail the file cleanly rather than queue behind long transactions.
LOCK TABLE public.products, public.product_units, public.sale_items, public.purchase_order_items
  IN SHARE ROW EXCLUSIVE MODE;
DO $pcost_move$
DECLARE
  v_src_n bigint; v_src_s bigint; v_dst_n bigint; v_dst_s bigint;
BEGIN
  -- products.cost_mmk
  SELECT count(*), COALESCE(sum(cost_mmk), 0) INTO v_src_n, v_src_s FROM public.products WHERE cost_mmk IS NOT NULL;
  INSERT INTO public.product_costs (product_id, org_id, cost_mmk, updated_at, updated_by)
  SELECT p.id, p.org_id, p.cost_mmk, now(), NULL FROM public.products p WHERE p.cost_mmk IS NOT NULL
  ON CONFLICT (product_id) DO UPDATE SET cost_mmk = EXCLUDED.cost_mmk, org_id = EXCLUDED.org_id, updated_at = now();
  SELECT count(*), COALESCE(sum(c.cost_mmk), 0) INTO v_dst_n, v_dst_s
    FROM public.product_costs c JOIN public.products p ON p.id = c.product_id WHERE p.cost_mmk IS NOT NULL;
  IF (v_src_n, v_src_s) IS DISTINCT FROM (v_dst_n, v_dst_s) THEN
    RAISE EXCEPTION 'PCOST-A: product cost copy mismatch (% / % vs % / %)', v_src_n, v_src_s, v_dst_n, v_dst_s;
  END IF;

  -- product_units.purchase_price_mmk
  SELECT count(*), COALESCE(sum(purchase_price_mmk), 0) INTO v_src_n, v_src_s FROM public.product_units WHERE purchase_price_mmk IS NOT NULL;
  INSERT INTO public.product_unit_costs (product_unit_id, product_id, org_id, purchase_price_mmk, updated_at)
  SELECT u.id, u.product_id, p.org_id, u.purchase_price_mmk, now()
    FROM public.product_units u JOIN public.products p ON p.id = u.product_id WHERE u.purchase_price_mmk IS NOT NULL
  ON CONFLICT (product_unit_id) DO UPDATE SET purchase_price_mmk = EXCLUDED.purchase_price_mmk, updated_at = now();
  SELECT count(*), COALESCE(sum(c.purchase_price_mmk), 0) INTO v_dst_n, v_dst_s
    FROM public.product_unit_costs c JOIN public.product_units u ON u.id = c.product_unit_id WHERE u.purchase_price_mmk IS NOT NULL;
  IF (v_src_n, v_src_s) IS DISTINCT FROM (v_dst_n, v_dst_s) THEN
    RAISE EXCEPTION 'PCOST-A: unit purchase price copy mismatch (% / % vs % / %)', v_src_n, v_src_s, v_dst_n, v_dst_s;
  END IF;

  -- sale_items.unit_cost_mmk_snapshot
  SELECT count(*), COALESCE(sum(unit_cost_mmk_snapshot), 0) INTO v_src_n, v_src_s FROM public.sale_items WHERE unit_cost_mmk_snapshot IS NOT NULL;
  INSERT INTO public.sale_item_costs (sale_item_id, sale_id, shop_id, org_id, unit_cost_mmk)
  SELECT si.id, si.sale_id, s.shop_id, sh.org_id, si.unit_cost_mmk_snapshot
    FROM public.sale_items si JOIN public.sales s ON s.id = si.sale_id JOIN public.shops sh ON sh.id = s.shop_id
   WHERE si.unit_cost_mmk_snapshot IS NOT NULL
  ON CONFLICT (sale_item_id) DO UPDATE SET unit_cost_mmk = EXCLUDED.unit_cost_mmk;
  SELECT count(*), COALESCE(sum(c.unit_cost_mmk), 0) INTO v_dst_n, v_dst_s
    FROM public.sale_item_costs c JOIN public.sale_items si ON si.id = c.sale_item_id WHERE si.unit_cost_mmk_snapshot IS NOT NULL;
  IF (v_src_n, v_src_s) IS DISTINCT FROM (v_dst_n, v_dst_s) THEN
    RAISE EXCEPTION 'PCOST-A: sale line cost copy mismatch (% / % vs % / %)', v_src_n, v_src_s, v_dst_n, v_dst_s;
  END IF;

  -- null-out (before the triggers exist, so it is a plain update)
  UPDATE public.products SET cost_mmk = NULL WHERE cost_mmk IS NOT NULL;
  UPDATE public.product_units SET purchase_price_mmk = NULL WHERE purchase_price_mmk IS NOT NULL;
  UPDATE public.sale_items SET unit_cost_mmk_snapshot = NULL WHERE unit_cost_mmk_snapshot IS NOT NULL;
END $pcost_move$;

-- ------------------------------------------------------------ 5. triggers (after the move)
-- BEFORE triggers fire in name order: "zzc_" runs after the org-fill trigger
-- of products (068), so NEW.org_id is set.
DROP TRIGGER IF EXISTS zzc_cost_redirect ON public.products;
CREATE TRIGGER zzc_cost_redirect BEFORE INSERT OR UPDATE OF cost_mmk ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.cost_redirect_products();
DROP TRIGGER IF EXISTS zzc_cost_redirect ON public.product_units;
CREATE TRIGGER zzc_cost_redirect BEFORE INSERT OR UPDATE OF purchase_price_mmk ON public.product_units
  FOR EACH ROW EXECUTE FUNCTION public.cost_redirect_product_units();
DROP TRIGGER IF EXISTS zzc_cost_redirect ON public.sale_items;
CREATE TRIGGER zzc_cost_redirect BEFORE INSERT OR UPDATE OF unit_cost_mmk_snapshot ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public.cost_redirect_sale_items();
DROP TRIGGER IF EXISTS zzc_cost_po_unit_price ON public.purchase_order_items;
CREATE TRIGGER zzc_cost_po_unit_price BEFORE UPDATE ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.cost_fill_po_unit_price();

DO $pcost_post$
BEGIN
  -- nothing readable is left behind in the legacy columns
  IF EXISTS (SELECT 1 FROM public.products WHERE cost_mmk IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.product_units WHERE purchase_price_mmk IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.sale_items WHERE unit_cost_mmk_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'PCOST-A: a legacy cost column still holds a value after the move';
  END IF;
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN
    PERFORM recovery_guard.register_guards();
  END IF;
END $pcost_post$;

NOTIFY pgrst, 'reload schema';   -- the API sees the new tables at once (else: PGRST205 = "old server" on clients)
RESET lock_timeout;
RESET search_path;
