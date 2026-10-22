\set ON_ERROR_STOP on
SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset
SELECT test.check('v1 installs RESTRICTED without automatic release',(SELECT bool_and(state='RESTRICTED') FROM recovery_v1.org_state));
SET ROLE authenticated;
SELECT test.check('same-org status contract returns restricted + required evidence',public.recovery_v1_status('org-test')->>'state'='RESTRICTED' AND (public.recovery_v1_status('org-test')->>'required_evidence')::boolean);
SELECT test.expect_error('status cannot read another tenant', $$SELECT public.recovery_v1_status('org-unrelated')$$,'RECOVERY_V1_CALLER_REQUIRED');
SELECT test.check('ACTIVE transition is explicitly denied',public.recovery_v1_transition('org-test','ACTIVE','restore looked good','synthetic-evidence')->>'outcome'='denied');
SELECT test.check('NULL transition is explicitly denied',public.recovery_v1_transition('org-test',NULL,'reason','synthetic-evidence')->>'outcome'='denied');
SELECT test.check('reconciling transition requires evidence and stays closed',public.recovery_v1_transition('org-test','RECONCILING','synthetic incident','synthetic-evidence')->>'state'='RECONCILING');
SELECT test.expect_error('authenticated cannot edit recovery state', $$UPDATE recovery_v1.org_state SET state='ACTIVE' WHERE org_id='org-test'$$,'permission denied');
SELECT test.expect_error('authenticated cannot invoke fencing helper', $$SELECT recovery_v1.fence_key('x','x','x','x',gen_random_uuid(),'complete_sale','x','x',repeat('a',64),'x')$$,'permission denied');
RESET ROLE;
SELECT test.check('transition attempts and denials committed to audit',(SELECT count(*)=3 FROM recovery_v1.audit WHERE kind='transition_attempt') AND (SELECT count(*)=2 FROM recovery_v1.audit WHERE kind='transition_denied'));
SELECT test.expect_error('direct SQL cannot mutate restricted organization', $$UPDATE public.inventory SET qty_base_units=999 WHERE shop_id='shop-a' AND product_id='prod-1'$$,'ORG_SUSPENDED');
SET ROLE service_role;
SELECT test.expect_error('service role direct supported writes cannot bypass restriction', $$UPDATE public.shops SET address='changed' WHERE id='shop-a'$$,'ORG_SUSPENDED');
RESET ROLE;
SELECT test.expect_error('ownership update is restricted', $$UPDATE public.users SET name='changed' WHERE id='u-admin'$$,'ORG_SUSPENDED');
SELECT test.expect_error('global infrastructure ownership update is restricted', $$UPDATE public.app_config SET value='https://attacker.invalid' WHERE key='supabase_public_url'$$,'ORG_SUSPENDED');
SELECT test.expect_error('TRUNCATE cannot erase evidence', $$TRUNCATE public.idempotency_keys$$,'ORG_SUSPENDED');
SELECT test.expect_error('replica mode still enforces financial guards', $$DO $b$ BEGIN PERFORM set_config('session_replication_role','replica',true); UPDATE public.inventory SET qty_base_units=999 WHERE shop_id='shop-a' AND product_id='prod-1'; END $b$;$$,'ORG_SUSPENDED');
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('legacy actual complete_sale is blocked and retains retryable error', $$SELECT public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{"product_id":"prod-1","qty":1}]'::jsonb,NULL,'99999999-0000-4000-8000-000000000010')$$,'ORG_SUSPENDED');
RESET ROLE;
SELECT test.check('restricted attempted sale leaves no new operation row',NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key='99999999-0000-4000-8000-000000000010'));
SELECT current_database() AS expected_database,(SELECT system_identifier::text FROM pg_control_system()) AS expected_system_identifier \gset
SELECT test.expect_error('wrong target database refused',format($q$SELECT recovery_v1.fence_key('wrong',%L,'org-test','shop-a','99999999-0000-4000-8000-000000000001','complete_sale','u-cash-a1','incident',repeat('a',64),'synthetic-authorization')$q$,:'expected_system_identifier'),'RECOVERY_V1_TARGET_MISMATCH');
SELECT test.expect_error('wrong cluster identifier refused',format($q$SELECT recovery_v1.fence_key(%L,'wrong','org-test','shop-a','99999999-0000-4000-8000-000000000001','complete_sale','u-cash-a1','incident',repeat('a',64),'synthetic-authorization')$q$,:'expected_database'),'RECOVERY_V1_TARGET_MISMATCH');
SELECT test.expect_error('cross-tenant shop fence refused',format($q$SELECT recovery_v1.fence_key(%L,%L,'org-unrelated','shop-a','99999999-0000-4000-8000-000000000001','complete_sale','u-cash-a1','incident',repeat('a',64),'synthetic-authorization')$q$,:'expected_database',:'expected_system_identifier'),'RECOVERY_V1_INVALID_FENCE_TARGET');
SELECT test.expect_error('unknown RPC fence refused',format($q$SELECT recovery_v1.fence_key(%L,%L,'org-test','shop-a','99999999-0000-4000-8000-000000000001','arbitrary_unknown','u-cash-a1','incident',repeat('a',64),'synthetic-authorization')$q$,:'expected_database',:'expected_system_identifier'),'RECOVERY_V1_INVALID_FENCE_TARGET');
SET ROLE orvix_recovery_operator;
SELECT recovery_v1.fence_key(:'expected_database',:'expected_system_identifier','org-test','shop-a','99999999-0000-4000-8000-000000000001','complete_sale','u-cash-a1','incident',repeat('a',64),'synthetic-authorization',ARRAY['99999999-0000-4000-8000-000000000011']::uuid[]) AS f \gset
SELECT recovery_v1.request_unfence(:'expected_database',:'expected_system_identifier','org-test','shop-a','99999999-0000-4000-8000-000000000001','incident',repeat('a',64),'{"operatorClaimsApproved":true}') AS uf \gset
SELECT recovery_v1.fence_key(:'expected_database',:'expected_system_identifier','org-test','shop-a','22222222-0000-4000-8000-000000000001','complete_sale','u-cash-a1','incident',repeat('a',64),'synthetic-authorization') AS existing \gset
RESET ROLE;
SELECT test.check('fencing records unresolved dependencies without executing them',:'f'::jsonb->>'outcome'='fenced' AND (:'f'::jsonb->>'dependencies_unresolved')::int=1);
SELECT test.check('unfence requires independent authority and retains fence',:'uf'::jsonb->>'outcome'='denied' AND (:'uf'::jsonb->>'fence_retained')::boolean);
SELECT test.check('existing completed operation preserved without fence overwrite',:'existing'::jsonb->>'outcome'='existing_record_preserved' AND NOT EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key='22222222-0000-4000-8000-000000000001'));
SELECT test.expect_error('original signed/fenced registry immutable', $$DELETE FROM recovery_v1.fences WHERE key='99999999-0000-4000-8000-000000000001'$$,'RECOVERY_V1_EVIDENCE_IMMUTABLE');
-- Step 5: a superuser can no longer set ACTIVE; the organization is reopened through the genuine owner-signed protocol
-- (synthetic owner key outside the database), as the tests below need an ACTIVE organization.
SELECT test.expect_error('superuser cannot set ACTIVE by hand (Step 5)', $$UPDATE recovery_v1.org_state SET state='ACTIVE' WHERE org_id='org-test'$$,'RECOVERY_V1_REOPEN_AUTHORIZATION_REQUIRED');
\set fx_org org-test
\ir ../step5/fixture-activate.psql
SELECT test.check('unrelated organization remains restricted',(SELECT state='RESTRICTED' FROM recovery_v1.org_state WHERE org_id='org-unrelated'));
UPDATE public.shops SET address='Synthetic active write' WHERE id='shop-a';
SELECT test.check('active org can write independently',(SELECT address='Synthetic active write' FROM public.shops WHERE id='shop-a'));
SELECT test.expect_error('cross-tenant operation identity mutation refused', $$UPDATE public.idempotency_keys SET org_id='org-unrelated',response=NULL WHERE key='22222222-0000-4000-8000-000000000001'$$,'ORG_SUSPENDED');
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('same-key resend on ACTIVE still blocked by real idem_begin sentinel', $$SELECT public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{"product_id":"prod-1","qty":1}]'::jsonb,NULL,'99999999-0000-4000-8000-000000000001')$$,'IDEMPOTENCY_MISMATCH');
SELECT public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{"product_id":"prod-1","qty":1}]'::jsonb,NULL,'99999999-0000-4000-8000-000000000004') AS live_sale \gset
SELECT test.check('ACTIVE fixture executes actual complete_sale and exact replay', :'live_sale'::jsonb=public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{"product_id":"prod-1","qty":1}]'::jsonb,NULL,'99999999-0000-4000-8000-000000000004'));
RESET ROLE;
-- Explicitly synthesize an aged fence, preserving real prune implementation.
INSERT INTO recovery_v1.fences(key,org_id,shop_id,rpc,actor_id,incident,preserved_evidence_sha256,authorization_reference,created_at)
VALUES('99999999-0000-4000-8000-000000000002','org-test','shop-a','complete_sale','u-cash-a1','aged',repeat('a',64),'synthetic-only',now()-interval '31 days');
DO $$ BEGIN
 IF (SELECT stage FROM recovery_v1.install)=85 THEN
  INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash,created_at) VALUES('99999999-0000-4000-8000-000000000002','complete_sale','u-cash-a1','org-test','FENCED:aged',now()-interval '31 days');
 ELSE
  EXECUTE $q$INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash,created_at,state) VALUES('99999999-0000-4000-8000-000000000002','complete_sale','u-cash-a1','org-test','A:',now()-interval '31 days','abandoned')$q$;
 END IF;
END $$;
SELECT public.prune_idempotency_keys();
SELECT test.check('original pruning cannot expire aged recovery fence',EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key='99999999-0000-4000-8000-000000000002'));
SELECT test.expect_error('sentinel cannot be finished/overwritten', $$SELECT public.idem_finish('99999999-0000-4000-8000-000000000002','{"sale":"fabricated"}')$$,'ORG_SUSPENDED');
SELECT test.expect_error('completed reply cannot be overwritten', $$UPDATE public.idempotency_keys SET response='{}' WHERE key='22222222-0000-4000-8000-000000000001'$$,'ORG_SUSPENDED');
SELECT test.expect_error('guard cannot be disabled by supported DDL', $$ALTER TABLE public.sales DISABLE TRIGGER zz_recovery_v1_write$$,'RECOVERY_V1_GUARD_CHANGE_BLOCKED');
-- Opaque evidence persists original bytes during restriction. These synthetic
-- strings intentionally are NOT trusted cryptographic evidence.
SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset
SET ROLE authenticated;
SELECT public.recovery_v1_transition('org-test','QUARANTINED','synthetic-evidence-test','preserved-fixture');
SELECT jsonb_build_object('body',jsonb_build_object('protocol','orvix-device-evidence-v1','orgId','org-test','shopId','shop-a','deviceId','synthetic-device','keyId','synthetic-key','operationId','99999999-0000-4000-8000-000000000003','rpc','complete_sale','payloadHash',repeat('b',64),'sequence',1,'authorization',jsonb_build_object('actorId','u-admin')),'hash',repeat('c',64),'signature','SYNTHETIC_UNVERIFIED') AS envelope \gset
SELECT test.check('signed-envelope storage explicitly unverified',public.recovery_v1_store_evidence(:'envelope'::jsonb)='{"outcome":"stored","verified":false}'::jsonb);
SELECT test.check('exact signed-envelope retries immutable/idempotent',public.recovery_v1_store_evidence(:'envelope'::jsonb)->>'outcome'='already_stored');
SELECT test.check('rotated key may start a distinct device/key evidence stream',public.recovery_v1_store_evidence(jsonb_set(jsonb_set(:'envelope'::jsonb,'{body,keyId}','"rotated-synthetic-key"'),'{hash}',to_jsonb(repeat('f',64))))->>'outcome'='stored');
SELECT test.check('same-org ADMIN may preserve historical actor envelope opaquely',public.recovery_v1_store_evidence(jsonb_set(jsonb_set(jsonb_set(:'envelope'::jsonb,'{body,authorization,actorId}','"u-cash-a1"'),'{body,sequence}','2'),'{hash}',to_jsonb(repeat('9',64))))->>'outcome'='stored');
SELECT test.expect_error('same device-sequence tamper rejected',format($q$SELECT public.recovery_v1_store_evidence(jsonb_set(%L::jsonb,'{body,rpc}','"void_supplier_payment"'))$q$,:'envelope'),'RECOVERY_V1_IMMUTABLE_EVIDENCE_CONFLICT');
SELECT test.expect_error('evidence cross-tenant replay refused',format($q$SELECT public.recovery_v1_store_evidence(jsonb_set(%L::jsonb,'{body,orgId}','"org-unrelated"'))$q$,:'envelope'),'RECOVERY_V1_INVALID_EVIDENCE');
SELECT test.expect_error('stored evidence cannot be read through client grants', $$SELECT envelope FROM recovery_v1.untrusted_evidence$$,'permission denied');
SELECT jsonb_build_object('body',jsonb_build_object('protocol','orvix-witness-receipt-v1','witnessId','local-test-only','keyId','synthetic-key','checkpoint',jsonb_build_object('protocol','orvix-checkpoint-v1','orgId','org-test','shopId','shop-a','streamId','synthetic-device/key','sequence',1,'digest',repeat('d',64),'previousReceiptHash',NULL)),'hash',repeat('e',64),'signature','SYNTHETIC_UNVERIFIED') AS receipt \gset
SELECT test.check('witness receipt storage explicitly unverified',public.recovery_v1_store_checkpoint(:'receipt'::jsonb)->>'verified'='false');
SELECT test.check('witness receipt retry immutable/idempotent',public.recovery_v1_store_checkpoint(:'receipt'::jsonb)->>'outcome'='already_stored');
SELECT test.expect_error('same witness boundary tamper rejected',format($q$SELECT public.recovery_v1_store_checkpoint(jsonb_set(%L::jsonb,'{body,checkpoint,digest}',to_jsonb(repeat('f',64))))$q$,:'receipt'),'RECOVERY_V1_IMMUTABLE_CHECKPOINT_CONFLICT');
SELECT test.check('evidence + checkpoint storage never releases quarantine',public.recovery_v1_status('org-test')->>'state'='QUARANTINED');
RESET ROLE;
-- Restore ACTIVE for the independent two-session lock-race smoke (Step 5: genuine owner-signed reopening).
\set fx_org org-test
\ir ../step5/fixture-activate.psql
