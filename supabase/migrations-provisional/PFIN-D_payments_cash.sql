-- ============================================================
-- PROVISIONAL migration PFIN-D: split / mixed sale payments, register cash movements, authoritative
-- shift cash (no number assigned; supabase/migrations/NUMBERING.md; order in SEQUENCE.json)
--
-- WHY ADDITIVE (no pinned body changes)
--   086 pins the bodies of complete_sale and close_shift by MD5 and is declared re-runnable; 087 reaches
--   complete_sale / close_shift only through its static executor allow-list. Nothing here replaces either
--   body, signature, request hash or stored response. New behaviour is added as tables, triggers and NEW
--   RPC names (the PFIN-C approach).
--
-- WHAT
--   1. public.sale_payments: every sale has payment rows whose applied amounts add up to its total.
--      - single-payment sales (every existing client, every legacy path): one row synthesized from
--        sales.payment_method (CASH -> CASH, OTHER -> OTHER) by an AFTER INSERT trigger on sales;
--      - split / mixed sales: public.fin_complete_sale_split() validates the payment list, hands it to the
--        sales trigger through a transaction-local setting, and calls the SAME complete_sale through the route
--        the server requires (direct 085/086 path, 086 op_execute, or 087 op_execute_v87). The sales row
--        records payment_method CASH when any cash is present (else OTHER) and paid = sum of tendered.
--      - money is integer MMK; applied sum = total; only cash may be tendered above its applied amount and
--        the sale's change equals exactly that excess; at most one row per method; up to 10 rows.
--      - the canonical payment list's sha256 is stored on every row: re-sending the same operation key with a
--        different split is refused (FIN_PAYMENTS_MISMATCH), the same split replays the original sale.
--      - rows are immutable (no UPDATE / DELETE / TRUNCATE).
--   2. public.cash_movements + public.fin_record_cash_movement(): register cash IN / OUT on an OPEN shift,
--      keyed (idempotency ledger), audited (audit_logs), immutable, corrected only by an explicit REVERSAL row.
--      Kinds: FLOAT_IN, PAY_IN (cashier on own shift or manager); PAY_OUT, DEPOSIT_OUT (manager);
--      CORRECTION_IN, CORRECTION_OUT, REVERSAL (manager). A cash-out never exceeds the drawer's expected cash.
--      WHO MAY APPROVE WHICH MOVEMENT IS AN OWNER DECISION (P-8, SEQUENCE.json): these defaults are the
--      conservative ones (manager for every outflow and correction).
--   3. public.fin_shift_cash(): the authoritative expected cash of a shift = opening + cash applied to non-void
--      sales of the shift - cash refund payouts attributed to the shift + movements in - movements out.
--      Refund attribution keeps the existing rule (a refund is paid from its sale's shift; P-3 unresolved).
--   4. public.fin_close_shift(): closes a shift with the authoritative figures (same checks, permissions and
--      response shape as close_shift, plus a 'cash' breakdown). A guard trigger on shifts refuses a legacy
--      close_shift whose expected cash differs from the authoritative one (FIN_CLOSE_SHIFT_UPGRADE_REQUIRED):
--      it never silently rewrites a figure an old till computed.
--   5. public.fin_payment_summary(): per-method payments and cash movements for a report scope (refund payouts: PFIN-E rows).
--   6. public.fin_capabilities(): lets a till detect these server features (absent on 085/086 servers).
--
-- DEPENDS ON 086 (idem_begin with per-organization identity) and PFIN-B (fin_report_scope). Refuses after
-- Recovery V1 (its DDL guard would refuse the new tables anyway). With 087 installed: superuser runner, no
-- pre-existing drift, re-registers 087's snapshot at the end.
-- ROLLBACK: PFIN-D.rollback.sql (refuses while any payment or movement row exists).
-- ============================================================

SET lock_timeout = '3s';

DO $pfin_d_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  IF to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'PFIN-D: migration 086 is required (per-organization idempotency, op_execute)';
  END IF;
  IF to_regprocedure('public.fin_report_scope(text)') IS NULL THEN
    RAISE EXCEPTION 'PFIN-D: apply PFIN-B first (fin_report_scope)';
  END IF;
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'PFIN-D: Recovery V1 is installed; financial schema changes after V1 need an owner-authorized migration (recovery_v1.apply_authorized_migration)';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PFIN-D: migration 087 is installed: run as the superuser migration runner';
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
      RAISE EXCEPTION 'PFIN-D: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pfin_d_pre$;

-- ------------------------------------------------------------ 1. sale payments
CREATE TABLE IF NOT EXISTS public.sale_payments (
  id             text PRIMARY KEY,
  sale_id        text NOT NULL REFERENCES public.sales(id),
  org_id         text NOT NULL,
  shop_id        text NOT NULL,
  seq            smallint NOT NULL CHECK (seq BETWEEN 1 AND 10),
  method         text NOT NULL CHECK (method IN ('CASH', 'BANK_TRANSFER', 'MOBILE_WALLET', 'CARD', 'OTHER')),
  amount_mmk     integer NOT NULL CHECK (amount_mmk > 0),
  tendered_mmk   integer NOT NULL CHECK (tendered_mmk >= amount_mmk),
  reference      text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 120),
  source         text NOT NULL CHECK (source IN ('single', 'split')),
  payments_sha256 text NOT NULL CHECK (payments_sha256 ~ '^[0-9a-f]{64}$'),
  -- the operation key of a split sale (fin_complete_sale_split): a replay is checked against it before anything runs
  op_key         uuid,
  created_at     timestamptz NOT NULL,
  UNIQUE (sale_id, seq),
  UNIQUE (sale_id, method),
  -- only cash can be over-tendered in a split; a legacy single OTHER sale keeps whatever paid amount it recorded
  CHECK (method = 'CASH' OR tendered_mmk = amount_mmk OR source = 'single')
);
CREATE INDEX IF NOT EXISTS sale_payments_shop_created_idx ON public.sale_payments (shop_id, created_at);
CREATE INDEX IF NOT EXISTS sale_payments_op_key_idx ON public.sale_payments (org_id, op_key) WHERE op_key IS NOT NULL;
ALTER TABLE public.sale_payments OWNER TO postgres;
ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sale_payments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sale_payments TO authenticated, service_role;
DROP POLICY IF EXISTS sale_payments_sel ON public.sale_payments;
-- exactly the visibility of the sale the payment belongs to (sales_sel, 069)
CREATE POLICY sale_payments_sel ON public.sale_payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales s WHERE s.id = sale_payments.sale_id));

CREATE OR REPLACE FUNCTION public.fin_payments_canonical(p_payments jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE e jsonb; out jsonb := '[]'; m text; a numeric; t numeric; seen text[] := '{}'; r text;
BEGIN
  IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: between 1 and 10 payments are required';
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    IF jsonb_typeof(e) <> 'object' THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: a payment is not an object'; END IF;
    m := e->>'method';
    IF m IS NULL OR m NOT IN ('CASH', 'BANK_TRANSFER', 'MOBILE_WALLET', 'CARD', 'OTHER') THEN
      RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: unsupported payment method %', coalesce(m, '(none)');
    END IF;
    IF m = ANY (seen) THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: % appears more than once; combine it', m; END IF;
    seen := seen || m;
    IF jsonb_typeof(e->'amountMmk') <> 'number' THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: amountMmk must be a whole number of MMK'; END IF;
    a := (e->>'amountMmk')::numeric;
    t := CASE WHEN e ? 'tenderedMmk' AND jsonb_typeof(e->'tenderedMmk') <> 'null' THEN (e->>'tenderedMmk')::numeric ELSE a END;
    IF jsonb_typeof(coalesce(e->'tenderedMmk', 'null'::jsonb)) NOT IN ('number', 'null') THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: tenderedMmk must be a whole number of MMK'; END IF;
    IF a <> trunc(a) OR t <> trunc(t) OR a <= 0 OR a > 2000000000 OR t > 2000000000 THEN
      RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: amounts must be positive whole MMK';
    END IF;
    IF t < a THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: the tendered amount for % is less than its amount', m; END IF;
    IF m <> 'CASH' AND t <> a THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: only cash can be tendered above its amount (change)'; END IF;
    r := nullif(btrim(coalesce(e->>'reference', '')), '');
    IF r IS NOT NULL AND length(r) > 120 THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: a payment reference is longer than 120 characters'; END IF;
    out := out || jsonb_build_array(jsonb_build_object('method', m, 'amountMmk', a::bigint, 'tenderedMmk', t::bigint, 'reference', r));
  END LOOP;
  -- canonical order: by method name (the client's order is not part of the payment's identity)
  RETURN (SELECT jsonb_agg(x ORDER BY x->>'method') FROM jsonb_array_elements(out) x);
END $$;

CREATE OR REPLACE FUNCTION public.fin_sale_payments_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_raw text := current_setting('orvix.fin_split_payments', true);
  v_list jsonb; v_org text; v_sha text; v_sum_a bigint := 0; v_sum_t bigint := 0; v_cash boolean := false;
  v_change bigint := 0; e jsonb; i int := 0;
BEGIN
  SELECT org_id INTO v_org FROM shops WHERE id = NEW.shop_id;
  IF v_raw IS NULL OR v_raw = '' THEN
    -- single payment: every existing path; nothing to validate beyond what complete_sale did
    IF NEW.total_mmk > 0 THEN
      v_list := jsonb_build_array(jsonb_build_object('method', CASE WHEN NEW.payment_method = 'CASH' THEN 'CASH' ELSE 'OTHER' END,
                  'amountMmk', NEW.total_mmk, 'tenderedMmk', NEW.paid_mmk, 'reference', NULL));
      v_sha := encode(sha256(convert_to(v_list::text, 'UTF8')), 'hex');
      INSERT INTO sale_payments (id, sale_id, org_id, shop_id, seq, method, amount_mmk, tendered_mmk, reference, source, payments_sha256, created_at)
      VALUES ('pay-' || replace(gen_random_uuid()::text, '-', ''), NEW.id, v_org, NEW.shop_id, 1,
              CASE WHEN NEW.payment_method = 'CASH' THEN 'CASH' ELSE 'OTHER' END, NEW.total_mmk, greatest(NEW.paid_mmk, NEW.total_mmk), NULL,
              'single', v_sha, NEW.created_at);
    END IF;
    RETURN NULL;
  END IF;
  -- a split list is consumed by exactly ONE sale insert of this transaction
  PERFORM set_config('orvix.fin_split_payments', '', true);
  v_list := public.fin_payments_canonical(v_raw::jsonb);
  FOR e IN SELECT value FROM jsonb_array_elements(v_list) LOOP
    v_sum_a := v_sum_a + (e->>'amountMmk')::bigint;
    v_sum_t := v_sum_t + (e->>'tenderedMmk')::bigint;
    IF e->>'method' = 'CASH' THEN v_cash := true; v_change := (e->>'tenderedMmk')::bigint - (e->>'amountMmk')::bigint; END IF;
  END LOOP;
  IF v_sum_a <> NEW.total_mmk THEN
    RAISE EXCEPTION 'FIN_PAYMENTS_TOTAL: the payments add up to % MMK but the sale total is % MMK', v_sum_a, NEW.total_mmk;
  END IF;
  IF v_sum_t <> NEW.paid_mmk OR v_change <> NEW.change_mmk THEN
    RAISE EXCEPTION 'FIN_PAYMENTS_TOTAL: the paid amount and change do not match the payments';
  END IF;
  IF (NEW.payment_method = 'CASH') IS DISTINCT FROM v_cash THEN
    RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: a sale with a cash part is recorded as CASH, otherwise as OTHER';
  END IF;
  v_sha := encode(sha256(convert_to(v_list::text, 'UTF8')), 'hex');
  FOR e IN SELECT value FROM jsonb_array_elements(v_list) LOOP
    i := i + 1;
    INSERT INTO sale_payments (id, sale_id, org_id, shop_id, seq, method, amount_mmk, tendered_mmk, reference, source, payments_sha256, op_key, created_at)
    VALUES ('pay-' || replace(gen_random_uuid()::text, '-', ''), NEW.id, v_org, NEW.shop_id, i, e->>'method',
            (e->>'amountMmk')::int, (e->>'tenderedMmk')::int, e->>'reference', 'split', v_sha,
            nullif(current_setting('orvix.fin_split_key', true), '')::uuid, NEW.created_at);
  END LOOP;
  RETURN NULL;
END $$;
ALTER FUNCTION public.fin_sale_payments_record() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_sale_payments_record() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.fin_payments_canonical(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_payments_canonical(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_payments_canonical(jsonb) TO authenticated, service_role;
DROP TRIGGER IF EXISTS zzf_sale_payments ON public.sales;
CREATE TRIGGER zzf_sale_payments AFTER INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION public.fin_sale_payments_record();

CREATE OR REPLACE FUNCTION public.fin_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN RAISE EXCEPTION 'FIN_RECORD_IMMUTABLE: % rows are never changed or deleted; record a reversal instead', TG_TABLE_NAME USING ERRCODE = '42501'; END $$;
ALTER FUNCTION public.fin_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_immutable() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzf_immutable ON public.sale_payments;
CREATE TRIGGER zzf_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.sale_payments FOR EACH STATEMENT EXECUTE FUNCTION public.fin_immutable();

-- the split-sale entry point: same complete_sale, chosen route, payment list bound to this one sale
-- A replay of a split sale's key is checked BEFORE anything runs, from the server's own rows (never from the reply,
-- which 086 withholds from another actor or after a purge): the split committed with this key must be the same split;
-- a key that already committed WITHOUT a split (a single-payment original) never becomes a split sale.
CREATE OR REPLACE FUNCTION public.fin_split_replay_problem(p_key uuid, p_sha text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org text := (current_app_user()).org_id; v_stored text;
BEGIN
  IF v_org IS NULL OR p_key IS NULL THEN RETURN NULL; END IF;
  SELECT min(payments_sha256) INTO v_stored FROM sale_payments WHERE org_id = v_org AND op_key = p_key;
  IF v_stored IS NOT NULL THEN RETURN CASE WHEN v_stored = p_sha THEN NULL ELSE 'mismatch' END; END IF;
  IF EXISTS (SELECT 1 FROM idempotency_keys WHERE org_id = v_org AND key = p_key AND rpc = 'complete_sale' AND state = 'committed') THEN
    RETURN 'mismatch';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION public.fin_split_replay_problem(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_split_replay_problem(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_split_replay_problem(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fin_complete_sale_split(p_route text, p_key uuid, p_args jsonb, p_payments jsonb,
  p_actor_id text DEFAULT NULL, p_ctx jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_list jsonb; v_sum_t bigint := 0; v_cash boolean := false; e jsonb; r jsonb; v_sale text; v_sha text; v_stored text;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF p_route IS NULL OR p_route NOT IN ('direct', 'op_execute', 'v87') THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: unknown route'; END IF;
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: sale arguments are required'; END IF;
  v_list := public.fin_payments_canonical(p_payments);
  FOR e IN SELECT value FROM jsonb_array_elements(v_list) LOOP
    v_sum_t := v_sum_t + (e->>'tenderedMmk')::bigint;
    IF e->>'method' = 'CASH' THEN v_cash := true; END IF;
  END LOOP;
  -- the sale's own (hashed) arguments must say exactly what the payment list says
  IF (p_args->>'p_payment_method') IS DISTINCT FROM (CASE WHEN v_cash THEN 'CASH' ELSE 'OTHER' END)
     OR (p_args->>'p_paid_mmk')::bigint IS DISTINCT FROM v_sum_t THEN
    RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: p_payment_method / p_paid_mmk must match the payment list';
  END IF;
  IF p_args ? 'p_idempotency_key' AND (p_args->>'p_idempotency_key') IS DISTINCT FROM p_key::text THEN
    RAISE EXCEPTION 'FIN_PAYMENTS_INVALID: the operation key differs from the sale''s key';
  END IF;
  v_sha := encode(sha256(convert_to(v_list::text, 'UTF8')), 'hex');
  IF public.fin_split_replay_problem(p_key, v_sha) IS NOT NULL THEN
    RAISE EXCEPTION 'FIN_PAYMENTS_MISMATCH: this operation key was already used with a different payment split';
  END IF;
  PERFORM set_config('orvix.fin_split_payments', v_list::text, true);
  PERFORM set_config('orvix.fin_split_key', p_key::text, true);
  IF p_route = 'direct' THEN
    r := public.complete_sale(p_args->>'p_shop_id', p_args->>'p_shift_id', p_args->>'p_payment_method', (p_args->>'p_paid_mmk')::int,
           (p_args->>'p_cart_discount_pct')::numeric, p_args->'p_items', (p_args->>'p_created_at')::timestamptz, p_key);
  ELSIF p_route = 'op_execute' THEN
    r := public.op_execute(p_key, 'complete_sale', p_args, p_actor_id);
  ELSE
    EXECUTE 'SELECT public.op_execute_v87($1, ''complete_sale'', $2, $3, $4)' INTO r USING p_key, p_args, p_actor_id, p_ctx;
  END IF;
  PERFORM set_config('orvix.fin_split_payments', '', true);
  PERFORM set_config('orvix.fin_split_key', '', true);
  v_sale := coalesce(r->'response'->'sale'->>'id', r->'sale'->>'id');
  IF v_sale IS NOT NULL THEN
    SELECT min(payments_sha256) INTO v_stored FROM public.sale_payments WHERE sale_id = v_sale;
    IF v_stored IS DISTINCT FROM v_sha THEN
      -- a replay of this key that names a different split (or a single-payment original): never silently accepted
      RAISE EXCEPTION 'FIN_PAYMENTS_MISMATCH: this operation key was already used with a different payment split';
    END IF;
  END IF;
  RETURN r;
END $$;
ALTER FUNCTION public.fin_complete_sale_split(text, uuid, jsonb, jsonb, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_complete_sale_split(text, uuid, jsonb, jsonb, text, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_complete_sale_split(text, uuid, jsonb, jsonb, text, jsonb) TO authenticated;

-- ------------------------------------------------------------ 2. cash movements
CREATE TABLE IF NOT EXISTS public.cash_movements (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  shop_id         text NOT NULL,
  shift_id        text NOT NULL REFERENCES public.shifts(id),
  kind            text NOT NULL CHECK (kind IN ('FLOAT_IN', 'PAY_IN', 'PAY_OUT', 'DEPOSIT_OUT', 'CORRECTION_IN', 'CORRECTION_OUT', 'REVERSAL')),
  direction       smallint NOT NULL CHECK (direction IN (1, -1)),
  amount_mmk      integer NOT NULL CHECK (amount_mmk > 0),
  reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  created_by      text NOT NULL,
  approved_by     text,
  reverses_id     text UNIQUE REFERENCES public.cash_movements(id),
  business_date   date NOT NULL,
  created_at      timestamptz NOT NULL,
  CHECK ((kind = 'REVERSAL') = (reverses_id IS NOT NULL)),
  CHECK (kind IN ('FLOAT_IN', 'PAY_IN', 'CORRECTION_IN') AND direction = 1
      OR kind IN ('PAY_OUT', 'DEPOSIT_OUT', 'CORRECTION_OUT') AND direction = -1
      OR kind = 'REVERSAL')
);
CREATE INDEX IF NOT EXISTS cash_movements_shift_idx ON public.cash_movements (shift_id);
CREATE INDEX IF NOT EXISTS cash_movements_shop_created_idx ON public.cash_movements (shop_id, created_at);
ALTER TABLE public.cash_movements OWNER TO postgres;
ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_movements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.cash_movements TO authenticated, service_role;
DROP POLICY IF EXISTS cash_movements_sel ON public.cash_movements;
-- exactly the visibility of the shift (shifts_sel, 069)
CREATE POLICY cash_movements_sel ON public.cash_movements FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = cash_movements.shift_id));
DROP TRIGGER IF EXISTS zzf_immutable ON public.cash_movements;
CREATE TRIGGER zzf_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cash_movements FOR EACH STATEMENT EXECUTE FUNCTION public.fin_immutable();

-- ------------------------------------------------------------ 3. authoritative shift cash
CREATE OR REPLACE FUNCTION public.fin_shift_cash(p_shift_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_shift shifts; v_sales bigint; v_refunds bigint; v_refunds_payout bigint := 0; v_in bigint; v_out bigint; v_has_payouts boolean;
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id;
  IF v_shift.id IS NULL THEN RETURN NULL; END IF;
  -- cash applied to the shift's non-void sales (change already netted: applied, not tendered)
  SELECT coalesce(sum(p.amount_mmk), 0) INTO v_sales
    FROM sales s JOIN sale_payments p ON p.sale_id = s.id
   WHERE s.shift_id = v_shift.id AND s.status <> 'VOID' AND p.method = 'CASH';
  -- refunds keep the existing attribution (the sale's shift, P-3): explicit cash payouts when the refund
  -- recorded them (PFIN-E refund_payouts), otherwise the legacy rule (a refund of a CASH sale is paid in cash).
  -- For a SPLIT sale the legacy rule is capped by the cash that sale actually took (less cash already paid back);
  -- a single-payment sale keeps the legacy figure exactly (what a released till's close_shift computes).
  v_has_payouts := to_regclass('public.refund_payouts') IS NOT NULL;
  IF v_has_payouts THEN
    EXECUTE 'SELECT coalesce(sum(p.amount_mmk), 0) FROM public.refund_payouts p JOIN public.sales s ON s.id = p.sale_id
              WHERE s.shift_id = $1 AND p.method = ''CASH''' INTO v_refunds_payout USING v_shift.id;
  END IF;
  EXECUTE format($q$
    SELECT coalesce(sum(CASE WHEN x.split THEN least(x.legacy, greatest(x.cash_part - x.cash_paid_back, 0)) ELSE x.legacy END), 0)
      FROM (SELECT s.id,
                   sum((coalesce(item->>'amountMmk', item->>'amount_mmk'))::bigint) AS legacy,
                   EXISTS (SELECT 1 FROM public.sale_payments sp WHERE sp.sale_id = s.id AND sp.source = 'split') AS split,
                   (SELECT coalesce(sum(sp.amount_mmk), 0) FROM public.sale_payments sp WHERE sp.sale_id = s.id AND sp.method = 'CASH') AS cash_part,
                   %s AS cash_paid_back
              FROM public.refund_void_requests r JOIN public.sales s ON s.id = r.sale_id
             CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) item
             WHERE s.shift_id = $1 AND s.payment_method = 'CASH' AND r.type = 'PARTIAL' AND r.status = 'APPROVED' %s
             GROUP BY s.id) x $q$,
    CASE WHEN v_has_payouts THEN '(SELECT coalesce(sum(rp.amount_mmk), 0) FROM public.refund_payouts rp WHERE rp.sale_id = s.id AND rp.method = ''CASH'')' ELSE '0' END,
    CASE WHEN v_has_payouts THEN 'AND NOT EXISTS (SELECT 1 FROM public.refund_payouts p WHERE p.request_id = r.id)' ELSE '' END)
  INTO v_refunds USING v_shift.id;
  SELECT coalesce(sum(m.amount_mmk) FILTER (WHERE m.direction = 1), 0), coalesce(sum(m.amount_mmk) FILTER (WHERE m.direction = -1), 0)
    INTO v_in, v_out FROM cash_movements m WHERE m.shift_id = v_shift.id;
  RETURN jsonb_build_object('shiftId', v_shift.id, 'openingCashMmk', v_shift.opening_cash_mmk, 'cashSalesMmk', v_sales,
    'cashRefundsMmk', v_refunds + v_refunds_payout, 'movementsInMmk', v_in, 'movementsOutMmk', v_out,
    'expectedCashMmk', v_shift.opening_cash_mmk + v_sales - v_refunds - v_refunds_payout + v_in - v_out);
END $$;
ALTER FUNCTION public.fin_shift_cash(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_shift_cash(text) FROM PUBLIC, anon, authenticated, service_role;

-- caller-facing read (same visibility as the shift row)
CREATE OR REPLACE FUNCTION public.fin_shift_cash_summary(p_shift_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user users; v_shift shifts;
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.app_require_org('shift', p_shift_id);
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id;
  IF v_shift.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF NOT ((v_shift.cashier_id = v_user.id AND app_can_for_shop('shift:manage_own', v_shift.shop_id))
          OR app_can_for_shop('shift:manage_all', v_shift.shop_id)) THEN
    RAISE EXCEPTION 'You are not permitted to view this shift';
  END IF;
  RETURN public.fin_shift_cash(p_shift_id) || jsonb_build_object('movements', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'kind', m.kind, 'direction', m.direction, 'amountMmk', m.amount_mmk, 'reason', m.reason, 'createdBy', m.created_by,
      'approvedBy', m.approved_by, 'reversesId', m.reverses_id, 'createdAt', m.created_at) ORDER BY m.created_at, m.id)
    FROM cash_movements m WHERE m.shift_id = p_shift_id), '[]'::jsonb));
END $$;
ALTER FUNCTION public.fin_shift_cash_summary(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_shift_cash_summary(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_shift_cash_summary(text) TO authenticated;

-- ------------------------------------------------------------ 2b. record a cash movement (keyed, audited)
CREATE OR REPLACE FUNCTION public.fin_record_cash_movement(p_shift_id text, p_kind text, p_amount_mmk integer, p_reason text,
  p_reverses_id text DEFAULT NULL, p_created_at timestamptz DEFAULT NULL, p_idempotency_key uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user users; v_shift shifts; v_now timestamptz := resolve_event_time(p_created_at); v_hash text; v_replay jsonb;
  v_rev cash_movements; v_dir smallint; v_amount integer := p_amount_mmk; v_id text; v_audit text; v_cash jsonb; v_result jsonb;
  v_privileged boolean;
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.app_require_org('shift', p_shift_id);
  v_hash := md5(jsonb_build_object('p_shift_id', p_shift_id, 'p_kind', p_kind, 'p_amount_mmk', p_amount_mmk,
                                   'p_reason', p_reason, 'p_reverses_id', p_reverses_id)::text);
  v_replay := public.idem_begin(p_idempotency_key, 'fin_record_cash_movement', v_hash);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('FLOAT_IN', 'PAY_IN', 'PAY_OUT', 'DEPOSIT_OUT', 'CORRECTION_IN', 'CORRECTION_OUT', 'REVERSAL') THEN
    RAISE EXCEPTION 'Unsupported cash movement';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'A reason of 3 to 300 characters is required for every cash movement';
  END IF;
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id FOR UPDATE;
  IF v_shift.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF v_shift.ended_at IS NOT NULL THEN RAISE EXCEPTION 'Shift is already closed'; END IF;
  -- P-8 (owner decision, conservative default): every outflow, correction and reversal needs a manager
  v_privileged := p_kind NOT IN ('FLOAT_IN', 'PAY_IN');
  IF v_privileged THEN
    IF NOT app_can_for_shop('shift:manage_all', v_shift.shop_id) THEN
      RAISE EXCEPTION 'Only a manager may record this cash movement';
    END IF;
  ELSIF NOT ((v_shift.cashier_id = v_user.id AND app_can_for_shop('shift:manage_own', v_shift.shop_id))
             OR app_can_for_shop('shift:manage_all', v_shift.shop_id)) THEN
    RAISE EXCEPTION 'You are not permitted to record cash movements on this shift';
  END IF;
  IF p_kind = 'REVERSAL' THEN
    SELECT * INTO v_rev FROM cash_movements WHERE id = p_reverses_id FOR UPDATE;
    IF v_rev.id IS NULL OR v_rev.shift_id <> v_shift.id THEN RAISE EXCEPTION 'The movement to reverse is not part of this shift'; END IF;
    IF v_rev.kind = 'REVERSAL' THEN RAISE EXCEPTION 'A reversal cannot itself be reversed; record a new movement'; END IF;
    IF EXISTS (SELECT 1 FROM cash_movements WHERE reverses_id = v_rev.id) THEN RAISE EXCEPTION 'This movement is already reversed'; END IF;
    v_dir := -v_rev.direction; v_amount := v_rev.amount_mmk;
    IF p_amount_mmk IS NOT NULL AND p_amount_mmk <> v_rev.amount_mmk THEN RAISE EXCEPTION 'A reversal is always for the full amount'; END IF;
  ELSE
    IF p_reverses_id IS NOT NULL THEN RAISE EXCEPTION 'Only a REVERSAL names a movement to reverse'; END IF;
    IF p_amount_mmk IS NULL OR p_amount_mmk <= 0 THEN RAISE EXCEPTION 'The amount must be greater than zero'; END IF;
    v_dir := CASE WHEN p_kind IN ('FLOAT_IN', 'PAY_IN', 'CORRECTION_IN') THEN 1 ELSE -1 END;
  END IF;
  IF v_dir = -1 THEN
    v_cash := public.fin_shift_cash(v_shift.id);
    IF v_amount > (v_cash->>'expectedCashMmk')::bigint THEN
      RAISE EXCEPTION 'The drawer is expected to hold % MMK; % MMK cannot be taken out', v_cash->>'expectedCashMmk', v_amount;
    END IF;
  END IF;
  v_id := 'cm-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO cash_movements (id, org_id, shop_id, shift_id, kind, direction, amount_mmk, reason, created_by, approved_by, reverses_id, business_date, created_at)
  VALUES (v_id, (SELECT org_id FROM shops WHERE id = v_shift.shop_id), v_shift.shop_id, v_shift.id, p_kind, v_dir, v_amount, btrim(p_reason),
          v_user.id, CASE WHEN v_privileged THEN v_user.id END, CASE WHEN p_kind = 'REVERSAL' THEN v_rev.id END,
          (v_now AT TIME ZONE 'Asia/Yangon')::date, v_now);
  v_audit := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit, v_shift.shop_id, v_user.id, 'CASH_MOVEMENT',
          p_kind || ' ' || CASE WHEN v_dir = 1 THEN '+' ELSE '-' END || v_amount || ' MMK: ' || left(btrim(p_reason), 200), 'Shift', v_shift.id, v_now);
  v_result := jsonb_build_object('movement', jsonb_build_object('id', v_id, 'shiftId', v_shift.id, 'shopId', v_shift.shop_id, 'kind', p_kind,
      'direction', v_dir, 'amountMmk', v_amount, 'reason', btrim(p_reason), 'createdBy', v_user.id,
      'approvedBy', CASE WHEN v_privileged THEN v_user.id END, 'reversesId', CASE WHEN p_kind = 'REVERSAL' THEN v_rev.id END, 'createdAt', v_now),
    'cash', public.fin_shift_cash(v_shift.id));
  PERFORM public.idem_finish(p_idempotency_key, v_result);
  RETURN v_result;
END $$;
ALTER FUNCTION public.fin_record_cash_movement(text, text, integer, text, text, timestamptz, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_record_cash_movement(text, text, integer, text, text, timestamptz, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_record_cash_movement(text, text, integer, text, text, timestamptz, uuid) TO authenticated;

-- ------------------------------------------------------------ 4. closing a shift with the authoritative figures
CREATE OR REPLACE FUNCTION public.fin_close_shift(p_shift_id text, p_closing_cash_mmk integer, p_variance_reason text DEFAULT NULL,
  p_created_at timestamptz DEFAULT NULL, p_expected_actor_id text DEFAULT NULL, p_idempotency_key uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user users; v_shift shifts; v_now timestamptz := resolve_event_time(p_created_at); v_hash text; v_replay jsonb;
  v_cash jsonb; v_expected integer; v_variance integer; v_audit text; v_result jsonb; v_msg text;
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.app_require_org('shift', p_shift_id);
  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This action belongs to another user; sign in as that user to retry it';
  END IF;
  v_hash := md5(jsonb_build_object('p_shift_id', p_shift_id, 'p_closing_cash_mmk', p_closing_cash_mmk,
                                   'p_variance_reason', p_variance_reason, 'p_expected_actor_id', p_expected_actor_id)::text);
  v_replay := public.idem_begin(p_idempotency_key, 'fin_close_shift', v_hash);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF p_shift_id IS NULL OR btrim(p_shift_id) = '' THEN RAISE EXCEPTION 'Shift is required'; END IF;
  IF p_closing_cash_mmk IS NULL OR p_closing_cash_mmk < 0 THEN RAISE EXCEPTION 'Closing cash must be zero or greater'; END IF;
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id FOR UPDATE;
  IF v_shift.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF v_shift.ended_at IS NOT NULL THEN RAISE EXCEPTION 'Shift is already closed'; END IF;
  IF NOT ((v_shift.cashier_id = v_user.id AND app_can_for_shop('shift:manage_own', v_shift.shop_id))
          OR app_can_for_shop('shift:manage_all', v_shift.shop_id)) THEN
    RAISE EXCEPTION 'You are not permitted to close this shift';
  END IF;
  v_cash := public.fin_shift_cash(v_shift.id);
  v_expected := (v_cash->>'expectedCashMmk')::integer;
  v_variance := p_closing_cash_mmk - v_expected;
  IF v_variance <> 0 AND coalesce(btrim(p_variance_reason), '') = '' THEN
    RAISE EXCEPTION 'Variance reason is required when closing cash does not match expected cash';
  END IF;
  -- the guard re-computes expected cash in its own statement; a sale committed in between must not turn this close
  -- into a false FIN_CLOSE_SHIFT_UPGRADE_REQUIRED: the figure this function just used is trusted for this shift
  PERFORM set_config('orvix.fin_close_shift', v_shift.id || ':' || v_expected, true);
  UPDATE shifts SET ended_at = v_now, closing_cash_mmk = p_closing_cash_mmk, expected_cash_mmk = v_expected,
         variance_mmk = v_variance, variance_reason = nullif(btrim(p_variance_reason), '')
   WHERE id = v_shift.id RETURNING * INTO v_shift;
  v_msg := 'Closed shift. Expected cash ' || v_expected || ' MMK, closing cash ' || p_closing_cash_mmk || ' MMK, variance ' || v_variance || ' MMK';
  v_audit := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit, v_shift.shop_id, v_user.id, 'SHIFT_CLOSED', v_msg, 'Shift', v_shift.id, v_now);
  v_result := jsonb_build_object(
    'shift', jsonb_build_object('id', v_shift.id, 'shopId', v_shift.shop_id, 'cashierId', v_shift.cashier_id, 'startedAt', v_shift.started_at,
      'endedAt', v_shift.ended_at, 'openingCashMmk', v_shift.opening_cash_mmk, 'closingCashMmk', v_shift.closing_cash_mmk,
      'expectedCashMmk', v_shift.expected_cash_mmk, 'varianceMmk', v_shift.variance_mmk, 'varianceReason', v_shift.variance_reason),
    'auditLogs', jsonb_build_array(jsonb_build_object('id', v_audit, 'shopId', v_shift.shop_id, 'actorId', v_user.id, 'actionType', 'SHIFT_CLOSED',
      'message', v_msg, 'entityType', 'Shift', 'entityId', v_shift.id, 'createdAt', v_now)),
    'cash', v_cash);
  PERFORM public.idem_finish(p_idempotency_key, v_result);
  RETURN v_result;
END $$;
ALTER FUNCTION public.fin_close_shift(text, integer, text, timestamptz, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_close_shift(text, integer, text, timestamptz, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_close_shift(text, integer, text, timestamptz, text, uuid) TO authenticated;

-- a legacy close_shift (pinned body) whose expected cash differs from the authoritative one is refused:
-- the shift then contains split payments, cash movements or recorded refund payouts an old till cannot see
CREATE OR REPLACE FUNCTION public.fin_guard_shift_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_expected bigint;
BEGIN
  IF current_setting('orvix.fin_close_shift', true) = OLD.id || ':' || NEW.expected_cash_mmk THEN RETURN NEW; END IF;
  v_expected := (public.fin_shift_cash(OLD.id)->>'expectedCashMmk')::bigint;
  IF NEW.expected_cash_mmk IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'FIN_CLOSE_SHIFT_UPGRADE_REQUIRED: this shift has split payments, cash movements or refund payouts; close it from an updated till (expected cash % MMK). Nothing was changed.', v_expected;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.fin_guard_shift_close() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_guard_shift_close() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzf_shift_close_guard ON public.shifts;
CREATE TRIGGER zzf_shift_close_guard BEFORE UPDATE ON public.shifts FOR EACH ROW
  WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL) EXECUTE FUNCTION public.fin_guard_shift_close();

-- ------------------------------------------------------------ 5. payment / cash report
CREATE OR REPLACE FUNCTION public.fin_payment_summary(p_shop_id text, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_scope jsonb; v_shops text[]; v_cashier text; v_lo timestamptz; v_hi timestamptz;
BEGIN
  -- the same period limits as the PFIN-B reports: one shop up to 367 days, all shops up to 93
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 OR (p_shop_id IS NULL AND p_to - p_from > 92) THEN
    RAISE EXCEPTION 'Invalid report period';
  END IF;
  v_scope := public.fin_report_scope(p_shop_id);
  v_shops := ARRAY(SELECT jsonb_array_elements_text(v_scope->'shopIds'));
  v_cashier := v_scope->>'cashierId';            -- report:own_shift: the caller's own sales and movements only
  v_lo := p_from::timestamp AT TIME ZONE 'Asia/Yangon';
  v_hi := (p_to + 1)::timestamp AT TIME ZONE 'Asia/Yangon';
  RETURN jsonb_build_object('scope', v_scope, 'from', p_from, 'to', p_to,
    'payments', coalesce((SELECT jsonb_object_agg(method, total) FROM (SELECT p.method, sum(p.amount_mmk) AS total
        FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.shop_id = ANY (v_shops) AND (v_cashier IS NULL OR s.cashier_id = v_cashier) AND s.status <> 'VOID'
         AND s.created_at >= v_lo AND s.created_at < v_hi GROUP BY 1) x), '{}'::jsonb),
    'splitSales', (SELECT count(DISTINCT p.sale_id) FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE p.source = 'split' AND s.status <> 'VOID' AND s.shop_id = ANY (v_shops) AND (v_cashier IS NULL OR s.cashier_id = v_cashier)
         AND s.created_at >= v_lo AND s.created_at < v_hi),
    -- a reversal is counted under the kind it reverses (a reversed PAY_OUT nets to zero)
    'cashMovements', coalesce((SELECT jsonb_object_agg(kind, total) FROM (
        SELECT coalesce(o.kind, m.kind) AS kind, sum(m.amount_mmk * m.direction) AS total
          FROM cash_movements m LEFT JOIN cash_movements o ON o.id = m.reverses_id
         WHERE m.shop_id = ANY (v_shops) AND (v_cashier IS NULL OR m.created_by = v_cashier)
           AND m.created_at >= v_lo AND m.created_at < v_hi GROUP BY 1) y), '{}'::jsonb));
END $$;
ALTER FUNCTION public.fin_payment_summary(text, date, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_payment_summary(text, date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_payment_summary(text, date, date) TO authenticated;

-- ------------------------------------------------------------ 6. capability probe
CREATE OR REPLACE FUNCTION public.fin_capabilities()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('protocol', 'orvix-fin-capabilities-v1', 'splitPayments', true, 'cashMovements', true,
    'paymentMethods', jsonb_build_array('CASH', 'BANK_TRANSFER', 'MOBILE_WALLET', 'CARD', 'OTHER'),
    'refundLines', to_regprocedure('public.fin_refund_lines_state(text)') IS NOT NULL) $$;
REVOKE ALL ON FUNCTION public.fin_capabilities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_capabilities() TO authenticated, service_role;

-- every existing sale gets its single-payment row (backfill; asserted)
INSERT INTO public.sale_payments (id, sale_id, org_id, shop_id, seq, method, amount_mmk, tendered_mmk, reference, source, payments_sha256, created_at)
SELECT 'pay-' || replace(gen_random_uuid()::text, '-', ''), s.id, sh.org_id, s.shop_id, 1,
       CASE WHEN s.payment_method = 'CASH' THEN 'CASH' ELSE 'OTHER' END, s.total_mmk, greatest(s.paid_mmk, s.total_mmk), NULL, 'single',
       encode(sha256(convert_to(jsonb_build_array(jsonb_build_object('method', CASE WHEN s.payment_method = 'CASH' THEN 'CASH' ELSE 'OTHER' END,
         'amountMmk', s.total_mmk, 'tenderedMmk', s.paid_mmk, 'reference', NULL))::text, 'UTF8')), 'hex'), s.created_at
  FROM public.sales s JOIN public.shops sh ON sh.id = s.shop_id
 WHERE s.total_mmk > 0 AND NOT EXISTS (SELECT 1 FROM public.sale_payments p WHERE p.sale_id = s.id);
DO $pfin_d_check$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales s WHERE s.total_mmk > 0
              AND s.total_mmk IS DISTINCT FROM (SELECT sum(amount_mmk) FROM public.sale_payments p WHERE p.sale_id = s.id)) THEN
    RAISE EXCEPTION 'PFIN-D: backfill check failed (a sale''s payments do not add up to its total)';
  END IF;
END $pfin_d_check$;

DO $pfin_d_post$
BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF;
END $pfin_d_post$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
