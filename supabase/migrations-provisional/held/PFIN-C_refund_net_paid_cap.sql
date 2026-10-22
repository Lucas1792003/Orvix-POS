-- ============================================================
-- PROVISIONAL migration PFIN-C: a refund can never exceed what the customer
-- paid after discounts (no number assigned; see README.md in this folder)
--
-- DEFECT
--   approve_refund_request (070) caps each product's cumulative refund at
--   sale_items.line_total_mmk, which is AFTER the item discount but BEFORE
--   the cart discount (072: total = Σ line_total − round(Σ line_total ×
--   cart%)). On a cart-discounted sale the approver can refund more than the
--   customer paid: a 10% cart discount on a 10,000 sale (paid 9,000) still
--   allows a 10,000 refund. Cash refunds of that excess come out of the
--   drawer and are deducted from expected cash by close_shift, so the excess
--   is invisible. The amount is chosen by the requesting client: the fin-ui
--   client allocates the cart discount (refundMath.ts); RC3 / 1.0.16 and
--   direct RPC calls do not. The same 070 check reads only the FIRST line of
--   a product that appears on several lines (SELECT INTO), so its cap is
--   also wrong for multi-line products (left to 090's refund line model).
--
-- WHY A SEPARATE MIGRATION AND A TRIGGER
--   086's preflight pins the MD5 of approve_refund_request's body (and 086
--   is declared re-runnable); 087 lists it as an executor RPC. Replacing the
--   body would break 086's forward-recovery contract and must wait for the
--   coordinated 090 rewrite. BEFORE triggers enforce the invariant without
--   touching any digested body, any signature or any response shape.
--
-- RULE (hard invariant only)
--   For every product of an APPROVED partial refund: Σ amountMmk of all
--   APPROVED partial refunds of the sale (this one included) <= that
--   product's net paid amount (fin_sale_line_net, identical to the fin-ui
--   client's allocation), and Σ over all products <= sales.total_mmk.
--   Checked when a row becomes APPROVED (UPDATE), when an APPROVED row's
--   items / sale / type change, and when a row is INSERTED as APPROVED
--   (privileged paths only; API roles have no table writes).
--   NOT enforced: per-unit proportional pricing (refunding 1 of 10 units for
--   more than a tenth). That is a pricing policy for the owner (README P-2).
--
-- ROLLOUT (README P-6)
--   RC3 / 1.0.16 tills compute refund amounts from the pre-cart-discount line
--   total; their refund requests on cart-discounted sales will be refused at
--   approval (and cannot be re-entered with a lower amount on those clients).
--   Apply PFIN-C only when every till runs the fin-ui refund math, or accept
--   that such requests are rejected and re-filed from an up-to-date till.
--
-- REFUSAL
--   'Refund amount exceeds ...' (SQLSTATE P0001): 086 op_classify_refusal
--   classifies it as a definitive 'rejected' outcome. That is correct: the
--   cap's inputs never shrink (approved refunds have no un-approve path;
--   totals and lines are immutable), so a refused approval cannot succeed
--   later. The approval's transaction rolls back (no stock movement, no
--   status change, no audit row, no idempotency row). Product names are cut
--   to 40 characters so the client's 160-character friendly-message limit
--   (errors.ts) is never exceeded.
--
-- DEPENDS ON PFIN-B (fin_sale_line_net, fin_items). Existing approved
-- refunds are NOT re-checked or changed; fin_report_summary counts them in
-- evidence.refundsAboveNetPaid. The triggers are ENABLE (origin): they do
-- not fire under session_replication_role = replica (logical restore).
-- Idempotent. Rollback: PFIN-C.rollback.sql.
-- ============================================================

SET lock_timeout = '3s';

DO $pfin_pfin_c_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  IF to_regprocedure('public.fin_sale_line_net(text[])') IS NULL OR to_regprocedure('public.fin_items(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PFIN-C: apply PFIN-B first (fin_sale_line_net / fin_items are missing)';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    -- evaluate exactly as recovery_guard.ddl_guard does (regprocedure text depends on search_path)
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PFIN-C: migration 087 is installed: run as the superuser migration runner';
    END IF;
    -- the whole 087 backstop condition (recovery_guard.ddl_guard): register_guards() below re-blesses
    -- tables AND the public 087 function registry, so neither may already differ from the snapshot
    IF EXISTS (SELECT 1 FROM recovery_guard.snapshot g
                WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = g.relid)
                   OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
       OR EXISTS (SELECT 1 FROM recovery_guard.functions f
                   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn
                                       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')))
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                    AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                    AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)) THEN
      RAISE EXCEPTION 'PFIN-C: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pfin_pfin_c_pre$;

CREATE OR REPLACE FUNCTION public.fin_guard_refund_net_paid()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_total integer;
  v_bad   record;
  v_this  bigint;
  v_other bigint;
BEGIN
  -- Serialise every approval of this sale. approve_refund_request already
  -- holds the row FOR UPDATE (070), so this is a no-op there; it covers
  -- privileged paths that do not.
  SELECT total_mmk INTO v_total FROM sales WHERE id = NEW.sale_id FOR UPDATE;

  IF NOT EXISTS (SELECT 1 FROM fin_items(NEW.items) f WHERE f.ok)
     OR EXISTS (SELECT 1 FROM fin_items(NEW.items) f WHERE NOT f.ok) THEN
    RAISE EXCEPTION 'Invalid refund amount for refund request % (unusable items)', NEW.id;
  END IF;

  WITH this_req AS (
    SELECT f.product_id, sum(f.amount) AS amount FROM fin_items(NEW.items) f GROUP BY 1
  ),
  approved AS (
    SELECT f.product_id, sum(f.amount) AS amount
      FROM refund_void_requests r CROSS JOIN LATERAL fin_items(r.items) f
     WHERE r.sale_id = NEW.sale_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED' AND r.id <> NEW.id AND f.ok
     GROUP BY 1
  ),
  net AS (
    SELECT n.product_id, sum(n.net_mmk)::bigint AS net FROM fin_sale_line_net(ARRAY[NEW.sale_id]) n GROUP BY 1
  )
  SELECT t.product_id, left(COALESCE(p.name, t.product_id), 40) AS label,
         COALESCE(n.net, 0) - COALESCE(a.amount, 0) AS remaining
    INTO v_bad
    FROM this_req t
    LEFT JOIN approved a ON a.product_id = t.product_id
    LEFT JOIN net n      ON n.product_id = t.product_id
    LEFT JOIN products p ON p.id = t.product_id
   WHERE COALESCE(a.amount, 0) + t.amount > COALESCE(n.net, 0)
   ORDER BY t.product_id
   LIMIT 1;

  IF v_bad.product_id IS NOT NULL THEN
    RAISE EXCEPTION 'Refund amount exceeds what the customer paid for % after discounts (% MMK refundable)',
      v_bad.label, greatest(v_bad.remaining, 0);
  END IF;

  -- only reachable after an older over-refund of another product: the
  -- per-product nets add up to the sale total
  SELECT COALESCE(sum(f.amount), 0) INTO v_this FROM fin_items(NEW.items) f WHERE f.ok;
  SELECT COALESCE(sum(f.amount), 0) INTO v_other
    FROM refund_void_requests r CROSS JOIN LATERAL fin_items(r.items) f
   WHERE r.sale_id = NEW.sale_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED' AND r.id <> NEW.id AND f.ok;
  IF v_other + v_this > COALESCE(v_total, 0) THEN
    RAISE EXCEPTION 'Refund amount exceeds the sale total after discounts (% MMK refundable)',
      greatest(COALESCE(v_total, 0) - v_other, 0);
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fin_guard_refund_net_paid() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_guard_refund_net_paid() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS fin_guard_refund_net_paid ON public.refund_void_requests;
DROP TRIGGER IF EXISTS fin_guard_refund_net_paid_ins ON public.refund_void_requests;
DROP TRIGGER IF EXISTS fin_guard_refund_net_paid_upd ON public.refund_void_requests;
CREATE TRIGGER fin_guard_refund_net_paid_ins
  BEFORE INSERT ON public.refund_void_requests
  FOR EACH ROW
  WHEN (NEW.status = 'APPROVED' AND NEW.type = 'PARTIAL')
  EXECUTE FUNCTION public.fin_guard_refund_net_paid();
CREATE TRIGGER fin_guard_refund_net_paid_upd
  BEFORE UPDATE ON public.refund_void_requests
  FOR EACH ROW
  WHEN (NEW.status = 'APPROVED' AND NEW.type = 'PARTIAL'
        AND (OLD.status IS DISTINCT FROM 'APPROVED' OR OLD.type IS DISTINCT FROM NEW.type
             OR OLD.items IS DISTINCT FROM NEW.items OR OLD.sale_id IS DISTINCT FROM NEW.sale_id))
  EXECUTE FUNCTION public.fin_guard_refund_net_paid();

DO $pfin_c_post$
BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN
    PERFORM recovery_guard.register_guards();
  END IF;
END $pfin_c_post$;

RESET lock_timeout;
