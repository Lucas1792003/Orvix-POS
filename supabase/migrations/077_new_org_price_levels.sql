-- ============================================================
-- Migration 077: every organization gets the default price levels
--                (Phase G follow-up, docs/selfhost-migration/phase-g/
--                upload-security-and-077.md §1)
--
-- PURPOSE
--   Root cause of "No active price level available" at checkout in an
--   organization created by the platform console:
--     * 030 seeded the three price levels (plv-retail DEFAULT / plv-wholesale
--       / plv-special, sort 10/20/30, all active) ONCE, globally.
--     * 068 made price_levels per-organization (org_id NOT NULL, per-org
--       unique code, per-org "one active default") and assigned those three
--       rows to the one existing organization.
--     * 072 made complete_sale look up the default level ONLY inside the
--       caller's organization (`... AND org_id = v_user.org_id`).
--     * Nothing creates levels for an organization created later (console
--       `create_organization`, 076 bootstrap_first_admin): complete_sale finds
--       no default -> v_level is NULL -> RAISE 'No active price level
--       available' for every cart line without an explicit price_level_id
--       (i.e. every sale; the POS sends none for the default level).
--   The production organization has exactly these three rows (data snapshot
--   2026-10-11: plv-retail/retail/Retail/default, plv-wholesale, plv-special).
--
-- WHAT IT DOES
--   1. public.app_seed_default_price_levels(p_org_id) - SECURITY DEFINER,
--      inserts the SAME default set as 030 for ONE organization:
--        retail/Retail (is_default, sort 10), wholesale/Wholesale (sort 20),
--        special/Special (sort 30), all active, org_id = p_org_id,
--        id = 'plv-' || random hex (ids are globally unique; never derived
--        from the org id, so no PK collision with any existing row).
--      ON CONFLICT (org_id, lower(btrim(code))) DO NOTHING on the 068 per-org
--      unique index, and the default row is skipped when the org already has
--      an active default (the other per-org unique index) - so a retry, a
--      re-run or a concurrent call never duplicates and never raises.
--      Returns the number of rows inserted. EXECUTE: service_role only (it
--      takes an org id; an authenticated caller must not seed another org).
--   2. public.organizations_seed_price_levels() - AFTER INSERT trigger
--      function on organizations (SECURITY DEFINER, like 068's
--      organizations_seed_business_profile): seeds NEW.id. Covers every
--      creation path: console (service_role), 076 bootstrap, SQL.
--      No cross-org reference is created: only price_levels rows with
--      org_id = NEW.id (068's enforce_same_org_refs triggers are on
--      products / brands / product_unit_prices / price_tiers /
--      supplier_products and are not involved).
--   3. price_levels.org_id FK -> ON DELETE CASCADE (was NO ACTION). The
--      console deletes a just-created organization again when its ADMIN
--      insert fails (platform-console create_organization rollback); with
--      seeded levels a NO ACTION FK would make that DELETE fail and leave an
--      orphan org. CASCADE only removes the levels of the org being deleted;
--      an org that has product_unit_prices (RESTRICT on price_level_id) or
--      products/shops/users (NO ACTION) still cannot be deleted. Same choice
--      as 068 made for business_profile.
--   4. One-time backfill: every EXISTING organization with ZERO price levels
--      gets the default set. Organizations that already have any level are
--      not touched (production: one org with 3 levels -> 0 rows inserted).
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS organizations_seed_price_levels ON public.organizations;
--   DROP FUNCTION IF EXISTS public.organizations_seed_price_levels();
--   DROP FUNCTION IF EXISTS public.app_seed_default_price_levels(text);
--   (optional) restore the FK without CASCADE:
--   ALTER TABLE public.price_levels DROP CONSTRAINT price_levels_org_id_fkey,
--     ADD CONSTRAINT price_levels_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);
--   Seeded rows can stay (they are ordinary, editable levels); removing them
--   from an org that already sold through them is blocked by sale history
--   only logically (sale_items keeps a snapshot, no FK) - do not delete.
-- FORWARD RECOVERY
--   Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, the FK is only
--   rebuilt when it is not already CASCADE, the backfill only touches orgs
--   with zero levels. Re-run the file.
--
-- VERIFICATION
--   SELECT o.id, count(l.*) AS levels, count(*) FILTER (WHERE l.is_default AND l.is_active) AS defaults
--     FROM organizations o LEFT JOIN price_levels l ON l.org_id = o.id GROUP BY o.id;
--     -- every org: levels >= 1, defaults = 1 (production org: 3 / 1, unchanged)
--   SELECT md5(string_agg(id||code||name||is_default||is_active||sort_order, ',' ORDER BY id))
--     FROM price_levels WHERE org_id = '<production org>';   -- same before and after
--   SELECT confdeltype FROM pg_constraint WHERE conname = 'price_levels_org_id_fkey';  -- c
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.organizations'::regclass AND NOT tgisinternal;
--     -- organizations_seed_business_profile, organizations_seed_price_levels
--   -- harness: bash supabase/tests/phase-d/run.sh   (t13_new_org_price_levels)
--
-- Run AFTER 068 (per-org indexes) and 072. NOT applied anywhere by this change.
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_seed_default_price_levels(p_org_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_org_id IS NULL THEN
    RETURN 0;
  END IF;

  -- The same set 030 seeded for the first organization.
  INSERT INTO price_levels (id, code, name, is_default, is_active, sort_order, org_id)
  SELECT 'plv-' || replace(gen_random_uuid()::text, '-', ''), d.code, d.name, d.is_default, true, d.sort_order, p_org_id
    FROM (VALUES ('retail',    'Retail',    true,  10),
                 ('wholesale', 'Wholesale', false, 20),
                 ('special',   'Special',   false, 30)) AS d(code, name, is_default, sort_order)
   WHERE NOT (d.is_default AND EXISTS (
           SELECT 1 FROM price_levels l
            WHERE l.org_id = p_org_id AND l.is_default AND l.is_active))
   ORDER BY d.sort_order
  ON CONFLICT (org_id, lower(btrim(code))) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.app_seed_default_price_levels(text) IS
  'Seeds the default price levels (Retail default / Wholesale / Special) for one organization; idempotent. Migration 077.';

CREATE OR REPLACE FUNCTION public.organizations_seed_price_levels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.app_seed_default_price_levels(NEW.id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.app_seed_default_price_levels(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_seed_default_price_levels(text) TO service_role;
-- trigger function: same grant shape as 068's organizations_seed_business_profile
REVOKE ALL ON FUNCTION public.organizations_seed_price_levels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organizations_seed_price_levels() TO authenticated, service_role;

-- 3. FK: ON DELETE CASCADE (console rollback of a just-created org)
DO $$
DECLARE
  v_con text;
  v_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO v_con, v_del
    FROM pg_constraint c
   WHERE c.conrelid = 'public.price_levels'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.organizations'::regclass
   LIMIT 1;
  IF v_con IS NOT NULL AND v_del = 'c' THEN
    RAISE NOTICE '077: price_levels -> organizations FK already ON DELETE CASCADE';
    RETURN;
  END IF;
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.price_levels DROP CONSTRAINT %I', v_con);
  END IF;
  ALTER TABLE public.price_levels
    ADD CONSTRAINT price_levels_org_id_fkey FOREIGN KEY (org_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE;
END $$;

-- 2. trigger (after the FK so a failure above aborts before it exists)
DROP TRIGGER IF EXISTS organizations_seed_price_levels ON public.organizations;
CREATE TRIGGER organizations_seed_price_levels
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_seed_price_levels();

-- 4. one-time backfill: only organizations that have NO price level at all
DO $$
DECLARE
  v_orgs integer := 0;
  v_rows integer := 0;
  r record;
BEGIN
  FOR r IN SELECT o.id FROM public.organizations o
            WHERE NOT EXISTS (SELECT 1 FROM public.price_levels l WHERE l.org_id = o.id)
            ORDER BY o.id
  LOOP
    v_orgs := v_orgs + 1;
    v_rows := v_rows + public.app_seed_default_price_levels(r.id);
  END LOOP;
  RAISE NOTICE '077 backfill: % organization(s) without price levels, % level row(s) inserted', v_orgs, v_rows;
END $$;

NOTIFY pgrst, 'reload schema';
