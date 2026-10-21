-- PROVISIONAL / UNNUMBERED. LOCAL IMPLEMENTATION ONLY. Not migration 088.
-- Install only in an explicitly isolated database, in ONE transaction as superuser.
-- Preserves all numbered migrations and pinned financial/helper bodies.
-- Supported exact helper contracts: 085 (074) or 086. 087 deliberately refused:
-- its held guards and function registry require a separately reviewed adapter.
-- Fresh install is RESTRICTED for every org. There is NO production ACTIVE release
-- or unfence authority implementation. A restore never constitutes authorization.
-- Run ONLY as:  psql -X -v recovery_v1_install_ack=restrict-every-organization -f RECOVERY_V1_guards.sql
-- The file opens its own transaction and stops at the first error. The acknowledgement
-- comes from a per-invocation psql variable passed as the installer's ARGUMENT, so a stored
-- session-, role- or database-level setting cannot satisfy it (run with -X: a .psqlrc that sets
-- the variable would be a deliberate acknowledgement). Without the variable the
-- next statement is a syntax error, the transaction aborts and NOTHING is created. BEGIN is
-- the very first statement, and every object is created inside ONE session-temporary function
-- call after the acknowledgement check, so neither a client that ignores psql meta-commands nor
-- one that runs each statement on its own connection can create anything.
BEGIN;
\set ON_ERROR_STOP on
SELECT pg_catalog.set_config('orvix.recovery_v1_install_ack', :'recovery_v1_install_ack', true);
-- The entire installation is ONE call of a session-temporary function. Every object is created
-- inside it, after the acknowledgement check, or not at all. A client that runs each statement on
-- its own connection cannot install anything: pg_temp functions exist only in the creating session.
CREATE FUNCTION pg_temp.recovery_v1_install(p_ack text) RETURNS void LANGUAGE plpgsql AS $rv1install$
BEGIN
 -- The acknowledgement is THIS call's argument (from the per-invocation psql variable), never a
 -- stored session/role/database setting; the setting below only records it for the install row.
 IF p_ack IS DISTINCT FROM 'restrict-every-organization' THEN
  RAISE EXCEPTION 'RECOVERY_V1_INSTALL_ACK_REQUIRED: run psql -X -v recovery_v1_install_ack=restrict-every-organization -f RECOVERY_V1_guards.sql';
 END IF;
 PERFORM pg_catalog.set_config('orvix.recovery_v1_install_ack', p_ack, true);
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = pg_catalog, pg_temp;
DO $pre$
DECLARE v text; t text;
BEGIN
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RAISE EXCEPTION 'RECOVERY_V1_INSTALL_SUPERUSER_REQUIRED'; END IF;
 -- Correction pass P5: installing restricts EVERY organization at once, and V1 has no
 -- reopen path (no independent owner-authorization verifier exists). An accidental
 -- install on a live database is a full outage, so the installer requires the explicit
 -- per-invocation acknowledgement set above and refuses without it (nothing is created).
 IF current_setting('orvix.recovery_v1_install_ack', true) IS DISTINCT FROM 'restrict-every-organization' THEN
  RAISE EXCEPTION 'RECOVERY_V1_INSTALL_ACK_REQUIRED: this install restricts every organization immediately and nothing in V1 can reopen one. Only on an isolated database: psql -v recovery_v1_install_ack=restrict-every-organization -f RECOVERY_V1_guards.sql';
 END IF;
 IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_ALREADY_INSTALLED: inspect existing evidence; never replace it'; END IF;
 IF to_regnamespace('recovery') IS NOT NULL OR to_regnamespace('recovery_guard') IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_087_ADAPTER_REQUIRED: existing hold/registry must remain intact'; END IF;
 SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = to_regprocedure('public.idem_begin(uuid,text,text)');
 IF v IS NULL OR v NOT IN ('afca065fea226a0c7a5b9bb56b540a9d','c9f577ed5608de19b25c00c649deaf50') THEN RAISE EXCEPTION 'RECOVERY_V1_UNKNOWN_IDEMPOTENCY_CONTRACT'; END IF;
 IF (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(att,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.att WHERE c.conrelid='public.idempotency_keys'::regclass AND c.contype='p')
    IS DISTINCT FROM (CASE v WHEN 'afca065fea226a0c7a5b9bb56b540a9d' THEN 'key' ELSE 'org_id,key' END) THEN RAISE EXCEPTION 'RECOVERY_V1_UNKNOWN_LEDGER_IDENTITY'; END IF;
 FOREACH t IN ARRAY ARRAY['brands','business_profile','categories','idempotency_keys','price_levels','product_barcodes','products','shops','suppliers','unit_types','users','organizations','audit_logs','inventory','inventory_movements','price_tiers','product_image_upload_sessions','product_unit_prices','purchase_orders','refund_void_requests','sales','shifts','supplier_payments','stock_transfers','stock_transfer_items','product_units','purchase_order_items','sale_items','reprint_logs','supplier_products','app_config','platform_admins'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||t) AND relkind='r') THEN RAISE EXCEPTION 'RECOVERY_V1_UNKNOWN_SCHEMA: required plain table %',t; END IF;
 END LOOP;
 IF to_regrole('orvix_recovery_operator') IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_RESERVED_ROLE_ALREADY_EXISTS'; END IF;
END $pre$;
CREATE ROLE orvix_recovery_operator NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE;
CREATE SCHEMA recovery_v1;
REVOKE ALL ON SCHEMA recovery_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA recovery_v1 TO orvix_recovery_operator;
CREATE TABLE recovery_v1.install (
 one boolean PRIMARY KEY DEFAULT true CHECK(one), database_name text NOT NULL, database_oid oid NOT NULL,
 system_identifier text NOT NULL, idem_body_md5 text NOT NULL, stage int NOT NULL CHECK(stage IN(85,86)), installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 install_ack text NOT NULL DEFAULT current_setting('orvix.recovery_v1_install_ack', true) CHECK(install_ack='restrict-every-organization'));
INSERT INTO recovery_v1.install SELECT true,current_database(),(SELECT oid FROM pg_database WHERE datname=current_database()),
 (SELECT system_identifier::text FROM pg_control_system()),md5(prosrc),CASE md5(prosrc) WHEN 'afca065fea226a0c7a5b9bb56b540a9d' THEN 85 ELSE 86 END FROM pg_proc WHERE oid='public.idem_begin(uuid,text,text)'::regprocedure;
CREATE TABLE recovery_v1.org_state (
 org_id text PRIMARY KEY, state text NOT NULL DEFAULT 'RESTRICTED' CHECK(state IN('ACTIVE','RESTRICTED','RECONCILING','QUARANTINED')),
 recovered_as_of timestamptz, uncertainties jsonb NOT NULL DEFAULT '["Independent recovery authorization and completeness evidence are unavailable"]'::jsonb CHECK(jsonb_typeof(uncertainties)='array'),
 reason text NOT NULL DEFAULT 'Recovery evidence not independently established', changed_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO recovery_v1.org_state(org_id) SELECT id FROM public.organizations;
CREATE TABLE recovery_v1.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id text, kind text NOT NULL, detail jsonb NOT NULL,
 actor text NOT NULL DEFAULT session_user, at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO recovery_v1.audit(org_id,kind,detail) SELECT NULL,'installed',jsonb_build_object('organizations_restricted',(SELECT count(*) FROM recovery_v1.org_state),
 'install_ack',current_setting('orvix.recovery_v1_install_ack', true),'stage',(SELECT stage FROM recovery_v1.install),'reopen_path','none: independent owner authorization not provisioned');
CREATE INDEX audit_org_kind_at ON recovery_v1.audit(org_id,kind,at);
CREATE TABLE recovery_v1.fences (
 key uuid PRIMARY KEY, org_id text NOT NULL, shop_id text NOT NULL, rpc text NOT NULL, actor_id text NOT NULL,
 incident text NOT NULL, preserved_evidence_sha256 text NOT NULL CHECK(preserved_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 authorization_reference text NOT NULL, dependencies uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE recovery_v1.untrusted_evidence (
 org_id text NOT NULL, shop_id text NOT NULL, device_id text NOT NULL, key_id text NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), operation_id uuid NOT NULL, envelope jsonb NOT NULL,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id,hash), UNIQUE(org_id,device_id,key_id,sequence));
CREATE TABLE recovery_v1.untrusted_checkpoints (
 org_id text NOT NULL, shop_id text NOT NULL, witness_id text NOT NULL, stream_id text NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), receipt jsonb NOT NULL,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id,hash), UNIQUE(org_id,witness_id,stream_id,sequence));
COMMENT ON TABLE recovery_v1.untrusted_evidence IS 'Opaque original signed evidence; storage is NOT signature verification, enrollment, completeness or owner authority. Never log raw payloads.';
COMMENT ON TABLE recovery_v1.untrusted_checkpoints IS 'Opaque witness receipts; trust, independent verification and latest-boundary checks happen outside infrastructure. Storage never authorizes reopen.';

CREATE FUNCTION recovery_v1.immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'RECOVERY_V1_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END $$;
DO $immut$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['install','audit','fences','untrusted_evidence','untrusted_checkpoints'] LOOP
  EXECUTE format('CREATE TRIGGER recovery_v1_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON recovery_v1.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.immutable()',t);
  EXECUTE format('ALTER TABLE recovery_v1.%I ENABLE ALWAYS TRIGGER recovery_v1_immutable',t);
 END LOOP;
END $immut$;
-- 087 disables EVERY event trigger before it runs (087_recovery_hold.sql:63-75), so the DDL
-- event trigger alone cannot keep 087 out. Every guarded row write and every status read
-- therefore re-checks the installation itself and fails closed when it is broken: event
-- trigger not enabled ALWAYS, an 087 recovery schema present, or the install record missing.
CREATE FUNCTION recovery_v1.integrity_problem() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE
  WHEN NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='zz_recovery_v1_ddl' AND evtenabled='A') THEN 'ddl_guard_not_enabled'
  WHEN to_regnamespace('recovery') IS NOT NULL OR to_regnamespace('recovery_guard') IS NOT NULL THEN 'migration_087_present_adapter_required'
  WHEN NOT EXISTS(SELECT 1 FROM recovery_v1.install) THEN 'install_record_missing'
 END $$;
CREATE FUNCTION recovery_v1.require_target(p_database text,p_system_identifier text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM recovery_v1.install i WHERE i.database_name=current_database() AND i.database_name=p_database AND i.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND i.system_identifier=p_system_identifier AND i.system_identifier=(SELECT system_identifier::text FROM pg_control_system())) THEN RAISE EXCEPTION 'RECOVERY_V1_TARGET_MISMATCH' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION recovery_v1.caller() RETURNS public.users LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.users WHERE auth_id=auth.uid() AND is_active;
 IF u.id IS NULL OR u.org_id IS NULL THEN RAISE EXCEPTION 'RECOVERY_V1_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN u;
END $$;
CREATE FUNCTION recovery_v1.deny(p_org text,p_kind text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 -- PostgreSQL table writes in an aborted transaction roll back. Server LOG is
 -- the durable denial channel; independent log shipping remains a prerequisite.
 RAISE LOG 'ORVIX_RECOVERY_V1_DENIED %',jsonb_build_object('org_id',p_org,'kind',p_kind,'session_user',session_user,'at',clock_timestamp());
 RAISE EXCEPTION 'ORG_SUSPENDED: recovery evidence unresolved [%]',p_kind USING ERRCODE='PT503';
END $$;
CREATE FUNCTION public.recovery_v1_status(p_org_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; s recovery_v1.org_state;
BEGIN
 u:=recovery_v1.caller();
 IF p_org_id IS DISTINCT FROM u.org_id THEN RAISE EXCEPTION 'RECOVERY_V1_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM recovery_v1.org_state WHERE org_id=u.org_id;
 IF recovery_v1.integrity_problem() IS NOT NULL THEN
  RETURN jsonb_build_object('protocol','orvix-recovery-v1','org_id',u.org_id,'state','QUARANTINED','recovered_as_of',NULL,
   'uncertainties',jsonb_build_array('Recovery protection is not intact on this server ('||recovery_v1.integrity_problem()||')'),'required_evidence',true);
 END IF;
 RETURN jsonb_build_object('protocol','orvix-recovery-v1','org_id',u.org_id,'state',coalesce(s.state,'RESTRICTED'),
 'recovered_as_of',s.recovered_as_of,'uncertainties',coalesce(s.uncertainties,'["Recovery state unavailable"]'::jsonb),'required_evidence',true);
END $$;
-- The infrastructure can contain an incident; it cannot manufacture independent
-- owner authorization. All attempts to ACTIVE return an audited denial.
CREATE FUNCTION public.recovery_v1_transition(p_org_id text,p_state text,p_reason text,p_evidence_reference text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; s text; allowed boolean;
BEGIN
 -- An active app user is required before anything is written (no anonymous audit flooding);
 -- every attempt is recorded under the CALLER's organization, with every input capped.
 u:=recovery_v1.caller();
 -- Bounded audit growth: at most 60 transition attempts per user per hour are recorded;
 -- beyond that the call is refused WITHOUT writing (the audit table is append-only forever).
 -- Per USER, so one user (e.g. a cashier whose attempts are always denied) cannot use up the
 -- organization's quota and block its ADMIN's containment transition.
 IF (SELECT count(*) FROM recovery_v1.audit WHERE org_id=u.org_id AND kind='transition_attempt' AND detail->>'actor_id'=u.id AND at > clock_timestamp()-interval '1 hour') >= 60 THEN
  RAISE EXCEPTION 'RECOVERY_V1_TRANSITION_RATE_LIMITED' USING ERRCODE='54000';
 END IF;
 allowed:=u.org_id IS NOT DISTINCT FROM p_org_id AND u.role='ADMIN' AND p_org_id IS NOT NULL;
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(u.org_id,'transition_attempt',jsonb_build_object('requested_org',left(p_org_id,200),'requested_state',left(p_state,40),'reason',left(p_reason,500),'evidence_reference',left(p_evidence_reference,500),'actor_id',u.id));
 IF NOT coalesce(allowed,false) OR p_state IS NULL OR p_state NOT IN('RESTRICTED','RECONCILING','QUARANTINED') OR nullif(btrim(p_reason),'') IS NULL OR nullif(btrim(p_evidence_reference),'') IS NULL THEN
  INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(u.org_id,'transition_denied',jsonb_build_object('requested_org',left(p_org_id,200),'requested_state',left(p_state,40),'reason','Independent owner release is unimplemented; authority/arguments must be valid'));
  RETURN jsonb_build_object('outcome','denied','reopen_authorized',false);
 END IF;
 INSERT INTO recovery_v1.org_state(org_id) SELECT id FROM public.organizations WHERE id=p_org_id ON CONFLICT DO NOTHING;
 SELECT state INTO s FROM recovery_v1.org_state WHERE org_id=p_org_id FOR UPDATE;
 UPDATE recovery_v1.org_state SET state=p_state,reason=left(p_reason,500),changed_at=clock_timestamp() WHERE org_id=p_org_id;
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org_id,'transition_applied',jsonb_build_object('from',s,'to',p_state,'evidence_reference',left(p_evidence_reference,500)));
 RETURN jsonb_build_object('outcome','applied','state',p_state,'reopen_authorized',false);
END $$;

-- Every touched org is collected from both OLD and NEW, including EVERY financial
-- parent the row references (shop, shift, sale, purchase order, supplier, product,
-- unit, price level, transfer, acting users, polymorphic movement references).
-- Most of these columns have no foreign key, so they are resolved explicitly.
-- guard_write then requires exactly ONE organization: a row that links two
-- organizations is refused even when both are ACTIVE (isolation), and a row that
-- touches a restricted organization through any parent is refused (recovery).
-- This is a recovery boundary in addition to existing RLS/permission checks.
CREATE FUNCTION recovery_v1.org_of_shop(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT org_id FROM public.shops WHERE id=p $$;
CREATE FUNCTION recovery_v1.org_of_user(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT org_id FROM public.users WHERE id=p $$;
CREATE FUNCTION recovery_v1.org_of_product(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT org_id FROM public.products WHERE id=p $$;
CREATE FUNCTION recovery_v1.org_of_unit(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT x.org_id FROM public.product_units u JOIN public.products x ON x.id=u.product_id WHERE u.id=p $$;
CREATE FUNCTION recovery_v1.org_of_sale(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT s.org_id FROM public.sales x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p $$;
CREATE FUNCTION recovery_v1.org_of_shift(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT s.org_id FROM public.shifts x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p $$;
CREATE FUNCTION recovery_v1.org_of_po(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT s.org_id FROM public.purchase_orders x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p $$;
CREATE FUNCTION recovery_v1.org_of_movement_ref(p text) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT ARRAY[recovery_v1.org_of_sale(p),recovery_v1.org_of_shift(p),recovery_v1.org_of_po(p),
  (SELECT s.org_id FROM public.refund_void_requests x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p),
  (SELECT s.org_id FROM public.stock_transfers x JOIN public.shops s ON s.id=x.from_shop_id WHERE x.id=p),
  (SELECT s.org_id FROM public.stock_transfers x JOIN public.shops s ON s.id=x.to_shop_id WHERE x.id=p),
  (SELECT s.org_id FROM public.supplier_payments x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p)] $$;
CREATE FUNCTION recovery_v1.orgs(p_table text,r jsonb) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v text[]; u text[]; c text[];
BEGIN
 -- acting/approving users on any row: EVERY column named *_by, plus cashier_id/actor_id/user_id
 -- (derived from the row itself, so a new *_by column is covered without editing this list)
 SELECT coalesce(array_agg(recovery_v1.org_of_user(e.value)),'{}') INTO u FROM jsonb_each_text(r) e
  WHERE e.value IS NOT NULL AND (e.key LIKE '%\_by' OR e.key IN('cashier_id','actor_id','user_id'));
 v:=CASE
 WHEN p_table='organizations' THEN ARRAY[r->>'id']
 WHEN p_table IN('brands','business_profile','categories','price_levels','suppliers','unit_types','idempotency_keys') THEN ARRAY[r->>'org_id']
 WHEN p_table='product_costs' THEN ARRAY[r->>'org_id',recovery_v1.org_of_product(r->>'product_id')]
 WHEN p_table='products' THEN ARRAY[r->>'org_id',(SELECT org_id FROM public.brands WHERE id=r->>'brand_id')]
 WHEN p_table='product_barcodes' THEN ARRAY[r->>'org_id',recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='product_unit_costs' THEN ARRAY[r->>'org_id',recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='sale_item_costs' THEN ARRAY[r->>'org_id',recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_sale(r->>'sale_id'),
   (SELECT recovery_v1.org_of_sale(i.sale_id) FROM public.sale_items i WHERE i.id=r->>'sale_item_id')]
 WHEN p_table='shops' THEN ARRAY[r->>'org_id']
 WHEN p_table='users' THEN ARRAY[r->>'org_id',recovery_v1.org_of_shop(r->>'shop_id')]
 WHEN p_table='audit_logs' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_user(r->>'actor_id'),
   recovery_v1.org_of_product(r->>'entity_id'),recovery_v1.org_of_unit(r->>'entity_id'),recovery_v1.org_of_user(r->>'entity_id'),recovery_v1.org_of_shop(r->>'entity_id'),
   (SELECT org_id FROM public.suppliers WHERE id=r->>'entity_id'),(SELECT org_id FROM public.categories WHERE id=r->>'entity_id'),
   (SELECT org_id FROM public.brands WHERE id=r->>'entity_id'),(SELECT org_id FROM public.unit_types WHERE id=r->>'entity_id'),
   (SELECT org_id FROM public.price_levels WHERE id=r->>'entity_id'),(SELECT id FROM public.organizations WHERE id=r->>'entity_id')]
   ||recovery_v1.org_of_movement_ref(r->>'entity_id')
 WHEN p_table IN('inventory','price_tiers','product_image_upload_sessions') THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_product(r->>'product_id')]
 WHEN p_table='inventory_movements' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
   ||recovery_v1.org_of_movement_ref(r->>'reference_id')
 WHEN p_table='product_unit_prices' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_unit(r->>'product_unit_id'),(SELECT org_id FROM public.price_levels WHERE id=r->>'price_level_id')]
 WHEN p_table='purchase_orders' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),(SELECT org_id FROM public.suppliers WHERE id=r->>'supplier_id')]
 WHEN p_table='supplier_payments' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),(SELECT org_id FROM public.suppliers WHERE id=r->>'supplier_id'),recovery_v1.org_of_po(r->>'purchase_order_id')]
 WHEN p_table='refund_void_requests' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_sale(r->>'sale_id')]
   ||coalesce((SELECT array_agg(x) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r->'items')='array' THEN r->'items' ELSE '[]'::jsonb END) i,
      LATERAL unnest(ARRAY[recovery_v1.org_of_product(coalesce(i->>'productId',i->>'product_id')),
        (SELECT recovery_v1.org_of_sale(si.sale_id) FROM public.sale_items si WHERE si.id=coalesce(i->>'saleItemId',i->>'sale_item_id'))]) x),'{}')
 WHEN p_table='sales' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_shift(r->>'shift_id')]
 WHEN p_table='shifts' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id')]
 WHEN p_table='stock_transfers' THEN ARRAY[recovery_v1.org_of_shop(r->>'from_shop_id'),recovery_v1.org_of_shop(r->>'to_shop_id')]
 WHEN p_table='stock_transfer_items' THEN ARRAY[(SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id=t.from_shop_id WHERE t.id=r->>'transfer_id'),(SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id=t.to_shop_id WHERE t.id=r->>'transfer_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='product_units' THEN ARRAY[recovery_v1.org_of_product(r->>'product_id')]
 WHEN p_table='purchase_order_items' THEN ARRAY[recovery_v1.org_of_po(r->>'purchase_order_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='sale_items' THEN ARRAY[recovery_v1.org_of_sale(r->>'sale_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id'),(SELECT org_id FROM public.price_levels WHERE id=r->>'price_level_id')]
 WHEN p_table='reprint_logs' THEN ARRAY[recovery_v1.org_of_sale(r->>'sale_id')]
 WHEN p_table='supplier_products' THEN ARRAY[(SELECT org_id FROM public.suppliers WHERE id=r->>'supplier_id'),recovery_v1.org_of_product(r->>'product_id')]
 END;
 -- PCOST-A cost rows may be written before their parent (deferred FKs). A parent row must
 -- therefore also agree with the organization of any cost row that already names its id,
 -- or one organization could pre-write a cost row for an id another organization creates.
 IF p_table='products' AND to_regclass('public.product_costs') IS NOT NULL THEN
  EXECUTE 'SELECT array_agg(org_id) FROM public.product_costs WHERE product_id=$1' INTO c USING r->>'id'; v:=v||coalesce(c,'{}');
 ELSIF p_table='product_units' AND to_regclass('public.product_unit_costs') IS NOT NULL THEN
  EXECUTE 'SELECT array_agg(org_id) FROM public.product_unit_costs WHERE product_unit_id=$1' INTO c USING r->>'id'; v:=v||coalesce(c,'{}');
 ELSIF p_table='sale_items' AND to_regclass('public.sale_item_costs') IS NOT NULL THEN
  EXECUTE 'SELECT array_agg(org_id) FROM public.sale_item_costs WHERE sale_item_id=$1' INTO c USING r->>'id'; v:=v||coalesce(c,'{}');
 END IF;
 RETURN ARRAY(SELECT DISTINCT x FROM unnest(v||u) x WHERE x IS NOT NULL ORDER BY 1);
END $$;
-- A non-NULL reference that resolves to NO organization (a dangling id) would let a later
-- insert of that id in another organization re-link the row; strict parent references must
-- therefore resolve. Returns the first dangling column, or NULL.
CREATE FUNCTION recovery_v1.dangling(p_table text,r jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e record; o text;
BEGIN
 -- PCOST-A cost side rows are written by BEFORE triggers before their parent row exists
 -- (deferred FKs): their parent ids are not strict; their own org_id is, and is resolved.
 FOR e IN SELECT key,value FROM jsonb_each_text(r) WHERE value IS NOT NULL AND key IN('shop_id','from_shop_id','to_shop_id','shift_id','sale_id','purchase_order_id','supplier_id','product_id','product_unit_id','transfer_id')
   AND NOT (p_table IN('product_costs','product_unit_costs','sale_item_costs') AND key IN('product_id','product_unit_id')) LOOP
  -- sale_item_id is NOT strict: PCOST-A snapshots a line's cost (sale_item_costs) BEFORE the line
  -- row exists; that row's sale_id and org_id are strict and resolved instead.
  o:=CASE e.key
   WHEN 'shop_id' THEN recovery_v1.org_of_shop(e.value) WHEN 'from_shop_id' THEN recovery_v1.org_of_shop(e.value) WHEN 'to_shop_id' THEN recovery_v1.org_of_shop(e.value)
   WHEN 'shift_id' THEN recovery_v1.org_of_shift(e.value) WHEN 'sale_id' THEN recovery_v1.org_of_sale(e.value) WHEN 'purchase_order_id' THEN recovery_v1.org_of_po(e.value)
   WHEN 'supplier_id' THEN (SELECT org_id FROM public.suppliers WHERE id=e.value) WHEN 'product_id' THEN recovery_v1.org_of_product(e.value)
   WHEN 'product_unit_id' THEN recovery_v1.org_of_unit(e.value)
   WHEN 'transfer_id' THEN (SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id=t.from_shop_id WHERE t.id=e.value) END;
  IF o IS NULL THEN RETURN e.key; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION recovery_v1.guard_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE orgs text[]:='{}'; o text; st text;
BEGIN
 IF recovery_v1.integrity_problem() IS NOT NULL THEN PERFORM recovery_v1.deny(NULL,'integrity:'||recovery_v1.integrity_problem()); END IF;
 IF TG_TABLE_NAME IN('app_config','platform_admins') THEN PERFORM recovery_v1.deny(NULL,'global_ownership_write'); END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(OLD)->'id') IS DISTINCT FROM (to_jsonb(NEW)->'id') THEN PERFORM recovery_v1.deny(NULL,'row_identity_change'); END IF;
 IF TG_OP<>'DELETE' AND recovery_v1.dangling(TG_TABLE_NAME,to_jsonb(NEW)) IS NOT NULL THEN PERFORM recovery_v1.deny(NULL,'dangling_reference:'||recovery_v1.dangling(TG_TABLE_NAME,to_jsonb(NEW))); END IF;
 IF TG_OP<>'INSERT' THEN orgs:=orgs||recovery_v1.orgs(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN orgs:=orgs||recovery_v1.orgs(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 orgs:=ARRAY(SELECT DISTINCT x FROM unnest(orgs) x ORDER BY 1);
 IF cardinality(orgs)<>1 THEN PERFORM recovery_v1.deny(NULL,'unknown_or_cross_tenant_write'); END IF;
 FOREACH o IN ARRAY orgs LOOP
  SELECT state INTO st FROM recovery_v1.org_state WHERE org_id=o FOR SHARE;
  IF st IS DISTINCT FROM 'ACTIVE' THEN PERFORM recovery_v1.deny(o,TG_TABLE_NAME||':'||TG_OP); END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION recovery_v1.deny_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM recovery_v1.deny(NULL,'truncate:'||TG_TABLE_NAME); RETURN NULL; END $$;
-- Ledger writes must remain allowed for a narrowly checked sentinel insertion
-- during restriction. Its registry entry is installed first, inside the same txn.
CREATE FUNCTION recovery_v1.guard_ledger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE f recovery_v1.fences; r jsonb;
BEGIN
 IF recovery_v1.integrity_problem() IS NOT NULL THEN PERFORM recovery_v1.deny(NULL,'integrity:'||recovery_v1.integrity_problem()); END IF;
 IF TG_OP='INSERT' THEN r:=to_jsonb(NEW); ELSE r:=to_jsonb(OLD); END IF;
 SELECT * INTO f FROM recovery_v1.fences WHERE key=(r->>'key')::uuid;
 IF FOUND THEN
  IF TG_OP='DELETE' THEN RETURN NULL; END IF; -- original 30d prune skips, retaining sentinel forever
  IF TG_OP='UPDATE' THEN PERFORM recovery_v1.deny(f.org_id,'fence_immutable'); END IF;
  IF NEW.org_id IS DISTINCT FROM f.org_id OR NEW.rpc IS DISTINCT FROM f.rpc OR NEW.actor_id IS DISTINCT FROM f.actor_id OR NEW.response IS NOT NULL
   OR NEW.request_hash IS DISTINCT FROM (CASE (SELECT stage FROM recovery_v1.install) WHEN 85 THEN 'FENCED:'||f.incident ELSE 'A:' END) THEN PERFORM recovery_v1.deny(f.org_id,'fence_binding_mismatch'); END IF;
  RETURN NEW;
 END IF;
 -- Preserve every pre-existing completion/tombstone through recovery retention.
 IF TG_OP='DELETE' THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'response') IS DISTINCT FROM (to_jsonb(OLD)-'response') THEN PERFORM recovery_v1.deny(OLD.org_id,'operation_identity_immutable'); END IF;
 IF TG_OP='UPDATE' AND OLD.response IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN PERFORM recovery_v1.deny(OLD.org_id,'completed_operation_immutable'); END IF;
 IF NOT EXISTS(SELECT 1 FROM recovery_v1.org_state WHERE org_id=r->>'org_id' AND state='ACTIVE' FOR SHARE) THEN PERFORM recovery_v1.deny(r->>'org_id','operation_write'); END IF;
 IF TG_OP='UPDATE' THEN RETURN NEW; END IF; RETURN NEW;
END $$;
CREATE FUNCTION recovery_v1.fence_key(p_database text,p_system_identifier text,p_org text,p_shop text,p_key uuid,p_rpc text,p_actor text,p_incident text,p_evidence_sha256 text,p_authorization_reference text,p_dependencies uuid[] DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v record; stage int; unresolved int;
BEGIN
 PERFORM recovery_v1.require_target(p_database,p_system_identifier);
 IF p_key IS NULL OR p_rpc IS NULL OR p_rpc !~ '^[a-z][a-z0-9_]{1,80}$' OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=p_rpc AND p.prosrc LIKE '%idem_begin(%')
 OR nullif(btrim(p_incident),'') IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' OR p_evidence_sha256 IS NULL OR nullif(btrim(p_authorization_reference),'') IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.shops WHERE id=p_shop AND org_id=p_org) OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor AND org_id=p_org)
 OR p_dependencies IS NULL OR p_key=ANY(p_dependencies) OR array_position(p_dependencies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_FENCE_TARGET' USING ERRCODE='22023'; END IF;
 SELECT i.stage INTO stage FROM recovery_v1.install i;
 -- Exactly the real 074/086 idem_begin lock, including its key namespace.
 PERFORM pg_advisory_xact_lock(hashtext(CASE stage WHEN 85 THEN 'idem:'||p_key::text ELSE 'idem:'||p_org||':'||p_key::text END));
 IF EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key=p_key) THEN
  IF NOT EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key=p_key AND org_id=p_org AND shop_id=p_shop AND rpc=p_rpc AND actor_id=p_actor) THEN RAISE EXCEPTION 'RECOVERY_V1_FENCE_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('outcome','already_fenced','key',p_key,'same_key_only',true);
 END IF;
 -- On either schema, an existing row of ANY org means no overwrite/no attribution.
 IF EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key=p_key) THEN
  INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org,'fence_not_applied_existing_record',jsonb_build_object('key',p_key,'rpc',p_rpc,'incident',p_incident));
  RETURN jsonb_build_object('outcome','existing_record_preserved','key',p_key,'execution_history_proven',false);
 END IF;
 -- Same org-state lock order as regular writes; a transition waits for txn end.
 PERFORM 1 FROM recovery_v1.org_state WHERE org_id=p_org FOR SHARE;
 INSERT INTO recovery_v1.fences(key,org_id,shop_id,rpc,actor_id,incident,preserved_evidence_sha256,authorization_reference,dependencies)
 VALUES(p_key,p_org,p_shop,p_rpc,p_actor,p_incident,p_evidence_sha256,p_authorization_reference,p_dependencies);
 IF stage=85 THEN
  INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash) VALUES(p_key,p_rpc,p_actor,p_org,'FENCED:'||p_incident);
 ELSE
  EXECUTE 'INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash,state,outcome_code,outcome_message,decided_at) VALUES($1,$2,$3,$4,''A:'',''abandoned'',''FENCED'',''Recovery fence; history unresolved'',clock_timestamp())' USING p_key,p_rpc,p_actor,p_org;
 END IF;
 SELECT count(*) INTO unresolved FROM unnest(p_dependencies) d WHERE NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key=d AND org_id=p_org);
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org,'key_fenced',jsonb_build_object('key',p_key,'rpc',p_rpc,'incident',p_incident,'dependencies_unresolved',unresolved,'preserved_evidence_sha256',p_evidence_sha256,'authorization_reference',p_authorization_reference));
 RETURN jsonb_build_object('outcome','fenced','key',p_key,'same_key_only',true,'dependencies_unresolved',unresolved,'execution_history_proven',false);
END $$;
CREATE FUNCTION recovery_v1.request_unfence(p_database text,p_system_identifier text,p_org text,p_shop text,p_key uuid,p_incident text,p_preserved_evidence_sha256 text,p_independent_authorization jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM recovery_v1.require_target(p_database,p_system_identifier);
 IF NOT EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key=p_key AND org_id=p_org AND shop_id=p_shop) OR nullif(btrim(p_incident),'') IS NULL OR p_preserved_evidence_sha256 IS NULL OR p_preserved_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_UNFENCE_TARGET'; END IF;
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org,'unfence_denied',jsonb_build_object('key',p_key,'incident',p_incident,'preserved_evidence_sha256',p_preserved_evidence_sha256,'reason','Independent authorization verifier not provisioned','authorization_supplied',p_independent_authorization IS NOT NULL));
 RETURN jsonb_build_object('outcome','denied','fence_retained',true,'reason','independent_authorization_verifier_not_provisioned');
END $$;

-- Correction pass P5: while V1 is installed the original 30-day prune (062/074) and
-- the 086 response purge delete nothing (guard_ledger). This READ-ONLY report gives the
-- operator the numbers needed to size storage and to design an evidence-aware retention
-- policy; it changes nothing and deletes nothing.
CREATE FUNCTION recovery_v1.ledger_retention_report() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'protocol','orvix-recovery-v1-retention-report',
  'generated_at',clock_timestamp(),
  'deletes_performed',0,
  'ledger_total_bytes',pg_total_relation_size('public.idempotency_keys'),
  'evidence_total_bytes',pg_total_relation_size('recovery_v1.untrusted_evidence')+pg_total_relation_size('recovery_v1.untrusted_checkpoints'),
  'audit_rows',(SELECT count(*) FROM recovery_v1.audit),
  'organizations',coalesce((SELECT jsonb_agg(jsonb_build_object(
     'org_id',o.org_id,'state',o.state,
     'ledger_rows',(SELECT count(*) FROM public.idempotency_keys k WHERE k.org_id=o.org_id),
     'ledger_rows_retained_beyond_30d_prune',(SELECT count(*) FROM public.idempotency_keys k WHERE k.org_id=o.org_id AND k.created_at < now()-interval '30 days'),
     'oldest_ledger_row',(SELECT min(k.created_at) FROM public.idempotency_keys k WHERE k.org_id=o.org_id),
     'ledger_row_bytes',(SELECT coalesce(sum(pg_column_size(k.*)),0) FROM public.idempotency_keys k WHERE k.org_id=o.org_id),
     'fenced_keys',(SELECT count(*) FROM recovery_v1.fences f WHERE f.org_id=o.org_id),
     'evidence_records',(SELECT count(*) FROM recovery_v1.untrusted_evidence e WHERE e.org_id=o.org_id),
     'evidence_bytes',(SELECT coalesce(sum(octet_length(e.envelope::text)),0) FROM recovery_v1.untrusted_evidence e WHERE e.org_id=o.org_id),
     'checkpoint_receipts',(SELECT count(*) FROM recovery_v1.untrusted_checkpoints c WHERE c.org_id=o.org_id)
   ) ORDER BY o.org_id) FROM recovery_v1.org_state o),'[]'::jsonb))
$$;
CREATE FUNCTION public.recovery_v1_store_evidence(p_envelope jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; b jsonb:=p_envelope->'body'; old jsonb; seq bigint;
BEGIN
 u:=recovery_v1.caller();
 IF octet_length(p_envelope::text)>262144 OR b->>'protocol' IS DISTINCT FROM 'orvix-device-evidence-v1' OR b->>'orgId' IS DISTINCT FROM u.org_id
 OR NOT EXISTS(SELECT 1 FROM public.shops WHERE id=b->>'shopId' AND org_id=u.org_id) OR (u.role<>'ADMIN' AND u.shop_id IS DISTINCT FROM b->>'shopId')
 OR b#>>'{authorization,actorId}' IS NULL OR (u.role<>'ADMIN' AND b#>>'{authorization,actorId}' IS DISTINCT FROM u.id) OR p_envelope->>'hash' IS NULL OR p_envelope->>'hash' !~ '^[a-f0-9]{64}$'
 OR b->>'keyId' IS NULL OR length(b->>'keyId') NOT BETWEEN 1 AND 200 OR b->>'deviceId' IS NULL OR length(b->>'deviceId') NOT BETWEEN 1 AND 200 OR b->>'sequence' IS NULL OR b->>'sequence' !~ '^[1-9][0-9]{0,14}$'
 OR b->>'operationId' IS NULL OR b->>'rpc' IS NULL OR b->>'payloadHash' IS NULL OR b->>'payloadHash' !~ '^[a-f0-9]{64}$' OR p_envelope->>'signature' IS NULL THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_EVIDENCE' USING ERRCODE='22023'; END IF;
 seq:=(b->>'sequence')::bigint;
 PERFORM pg_advisory_xact_lock(hashtext('recovery-evidence:'||u.org_id));
 SELECT envelope INTO old FROM recovery_v1.untrusted_evidence WHERE org_id=u.org_id AND (hash=p_envelope->>'hash' OR (device_id=b->>'deviceId' AND key_id=b->>'keyId' AND sequence=seq));
 IF FOUND THEN
  IF old IS DISTINCT FROM p_envelope THEN RAISE EXCEPTION 'RECOVERY_V1_IMMUTABLE_EVIDENCE_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('outcome','already_stored','verified',false);
 END IF;
 IF coalesce((SELECT sum(octet_length(envelope::text)) FROM recovery_v1.untrusted_evidence WHERE org_id=u.org_id),0)+octet_length(p_envelope::text)>52428800 THEN RETURN jsonb_build_object('outcome','quota_exceeded','stored',false,'verified',false); END IF;
 INSERT INTO recovery_v1.untrusted_evidence(org_id,shop_id,device_id,key_id,sequence,hash,operation_id,envelope) VALUES(u.org_id,b->>'shopId',b->>'deviceId',b->>'keyId',seq,p_envelope->>'hash',(b->>'operationId')::uuid,p_envelope);
 RETURN jsonb_build_object('outcome','stored','verified',false);
END $$;
CREATE FUNCTION public.recovery_v1_store_checkpoint(p_receipt jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; b jsonb:=p_receipt->'body'; c jsonb:=p_receipt#>'{body,checkpoint}'; old jsonb; seq bigint;
BEGIN
 u:=recovery_v1.caller();
 IF octet_length(p_receipt::text)>262144 OR b->>'protocol' IS DISTINCT FROM 'orvix-witness-receipt-v1' OR c->>'protocol' IS DISTINCT FROM 'orvix-checkpoint-v1'
 OR c->>'orgId' IS DISTINCT FROM u.org_id OR NOT EXISTS(SELECT 1 FROM public.shops WHERE id=c->>'shopId' AND org_id=u.org_id)
 OR (u.role<>'ADMIN' AND u.shop_id IS DISTINCT FROM c->>'shopId') OR b->>'witnessId' IS NULL OR c->>'streamId' IS NULL OR c->>'sequence' IS NULL OR c->>'sequence' !~ '^[1-9][0-9]{0,14}$'
 OR c->>'digest' IS NULL OR c->>'digest' !~ '^[a-f0-9]{64}$' OR p_receipt->>'hash' IS NULL OR p_receipt->>'hash' !~ '^[a-f0-9]{64}$' OR p_receipt->>'signature' IS NULL THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_CHECKPOINT' USING ERRCODE='22023'; END IF;
 seq:=(c->>'sequence')::bigint;
 PERFORM pg_advisory_xact_lock(hashtext('recovery-checkpoint:'||u.org_id));
 SELECT receipt INTO old FROM recovery_v1.untrusted_checkpoints WHERE org_id=u.org_id AND (hash=p_receipt->>'hash' OR(witness_id=b->>'witnessId' AND stream_id=c->>'streamId' AND sequence=seq));
 IF FOUND THEN
  IF old IS DISTINCT FROM p_receipt THEN RAISE EXCEPTION 'RECOVERY_V1_IMMUTABLE_CHECKPOINT_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('outcome','already_stored','verified',false);
 END IF;
 IF coalesce((SELECT sum(octet_length(receipt::text)) FROM recovery_v1.untrusted_checkpoints WHERE org_id=u.org_id),0)+octet_length(p_receipt::text)>52428800 THEN RETURN jsonb_build_object('outcome','quota_exceeded','stored',false,'verified',false); END IF;
 INSERT INTO recovery_v1.untrusted_checkpoints(org_id,shop_id,witness_id,stream_id,sequence,hash,receipt) VALUES(u.org_id,c->>'shopId',b->>'witnessId',c->>'streamId',seq,p_receipt->>'hash',p_receipt);
 RETURN jsonb_build_object('outcome','stored','verified',false);
END $$;

DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['brands','business_profile','categories','price_levels','product_barcodes','products','shops','suppliers','unit_types','users','organizations','audit_logs','inventory','inventory_movements','price_tiers','product_image_upload_sessions','product_unit_prices','purchase_orders','refund_void_requests','sales','shifts','supplier_payments','stock_transfers','stock_transfer_items','product_units','purchase_order_items','sale_items','reprint_logs','supplier_products','app_config','platform_admins','product_costs','product_unit_costs','sale_item_costs'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN
   EXECUTE format('CREATE TRIGGER zz_recovery_v1_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION recovery_v1.guard_write()',t);
   EXECUTE format('CREATE TRIGGER zz_recovery_v1_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.deny_truncate()',t);
   EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER zz_recovery_v1_write, ENABLE ALWAYS TRIGGER zz_recovery_v1_truncate',t);
  END IF;
 END LOOP;
END $triggers$;
CREATE TRIGGER zz_recovery_v1_ledger BEFORE INSERT OR UPDATE OR DELETE ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION recovery_v1.guard_ledger();
CREATE TRIGGER zz_recovery_v1_truncate BEFORE TRUNCATE ON public.idempotency_keys FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.deny_truncate();
ALTER TABLE public.idempotency_keys ENABLE ALWAYS TRIGGER zz_recovery_v1_ledger, ENABLE ALWAYS TRIGGER zz_recovery_v1_truncate;
-- No supported API or service_role may edit internal state/evidence, nor bypass
-- row guards using TRUNCATE/TRIGGER. Existing financial RPC ACLs stay intact.
REVOKE ALL ON ALL TABLES IN SCHEMA recovery_v1 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA recovery_v1 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA recovery_v1 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION recovery_v1.fence_key(text,text,text,text,uuid,text,text,text,text,text,uuid[]),recovery_v1.request_unfence(text,text,text,text,uuid,text,text,jsonb),recovery_v1.ledger_retention_report() TO orvix_recovery_operator;
REVOKE ALL ON FUNCTION public.recovery_v1_status(text),public.recovery_v1_transition(text,text,text,text),public.recovery_v1_store_evidence(jsonb),public.recovery_v1_store_checkpoint(jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.recovery_v1_status(text),public.recovery_v1_transition(text,text,text,text),public.recovery_v1_store_evidence(jsonb),public.recovery_v1_store_checkpoint(jsonb) TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON public.idempotency_keys FROM anon,authenticated,service_role;
REVOKE TRUNCATE,TRIGGER ON ALL TABLES IN SCHEMA public FROM anon,authenticated,service_role;
-- Preserve stage/guards across migration reruns. There is no approval-free
-- bypass GUC: applying 086/087 or future DDL needs a separately reviewed adapter.
CREATE FUNCTION recovery_v1.ddl_guard() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text;
BEGIN
 IF to_regnamespace('recovery') IS NOT NULL OR to_regnamespace('recovery_guard') IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_087_ADAPTER_REQUIRED'; END IF;
 IF (SELECT idem_body_md5 FROM recovery_v1.install) IS DISTINCT FROM (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.idem_begin(uuid,text,text)'))
 OR (SELECT string_agg(a.attname,',' ORDER BY k.n) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(att,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.att WHERE c.conrelid='public.idempotency_keys'::regclass AND c.contype='p')
 IS DISTINCT FROM (SELECT CASE stage WHEN 85 THEN 'key' ELSE 'org_id,key' END FROM recovery_v1.install) THEN RAISE EXCEPTION 'RECOVERY_V1_IDEMPOTENCY_STAGE_CHANGE_BLOCKED'; END IF;
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('idempotency_keys','brands','business_profile','categories','price_levels','product_barcodes','products','shops','suppliers','unit_types','users','organizations','audit_logs','inventory','inventory_movements','price_tiers','product_image_upload_sessions','product_unit_prices','purchase_orders','refund_void_requests','sales','shifts','supplier_payments','stock_transfers','stock_transfer_items','product_units','purchase_order_items','sale_items','reprint_logs','supplier_products','app_config','platform_admins','product_costs','product_unit_costs','sale_item_costs') LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||t) AND tgname=CASE t WHEN 'idempotency_keys' THEN 'zz_recovery_v1_ledger' ELSE 'zz_recovery_v1_write' END AND tgenabled='A') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||t) AND tgname='zz_recovery_v1_truncate' AND tgenabled='A') THEN RAISE EXCEPTION 'RECOVERY_V1_GUARD_CHANGE_BLOCKED: %',t; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION recovery_v1.ddl_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE EVENT TRIGGER zz_recovery_v1_ddl ON ddl_command_end EXECUTE FUNCTION recovery_v1.ddl_guard();
ALTER EVENT TRIGGER zz_recovery_v1_ddl ENABLE ALWAYS;
END $rv1install$;
SELECT pg_temp.recovery_v1_install(:'recovery_v1_install_ack');
DROP FUNCTION pg_temp.recovery_v1_install(text);
COMMIT;
