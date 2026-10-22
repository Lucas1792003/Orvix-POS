-- Step 4 Part B: offline capabilities. Synthetic data only. Preconditions (set by db-smoke.py): Recovery V1 installed with a
-- synthetic owner key; an OWNER-SIGNED offline policy for '*' (3 operations, 20,000 MMK; Step 5 aggregate budgets); org-test
-- reopened through the genuine owner-signed protocol; shift_a1 open. Offline-recorded operations are simulated exactly as
-- PostgREST presents them: header x-orvix-offline on the request.
-- Step 5: every till here is an owner-approved FIXTURE device of shop-a (s5fx labels dev1..dev5, one enrollment each); a
-- capability is requested with a device-signed request (s5fx.capability) and an offline sale is signed by the capability's own
-- device (s5fx.device names it for the fixture signer). The assertions are the Step 4 ones.
\set ON_ERROR_STOP on
SELECT test.logout();
SELECT set_config('request.headers', '', false);
SELECT set_config('s5fx.device', '', false);
SELECT device_id AS d1 FROM s5fx.device_ids WHERE org_id = 'org-test' AND label = 'dev1' \gset
SELECT device_id AS d2 FROM s5fx.device_ids WHERE org_id = 'org-test' AND label = 'dev2' \gset
SELECT device_id AS d3 FROM s5fx.device_ids WHERE org_id = 'org-test' AND label = 'dev3' \gset
SELECT device_id AS d4 FROM s5fx.device_ids WHERE org_id = 'org-test' AND label = 'dev4' \gset
SELECT device_id AS d5, enrollment_id AS e5 FROM s5fx.device_ids WHERE org_id = 'org-test' AND label = 'dev5' \gset
SELECT test.check('o00 owner-signed offline policy in force (3 ops, 20000 MMK)',
  (SELECT status = 'OWNER_APPROVED' AND max_ops = 3 AND max_amount_mmk = 20000 FROM recovery_v1.offline_policy WHERE scope = '*'));
SELECT test.login('a0000000-0000-4000-8000-000000000003');   -- cashier A1, shop-a
SET ROLE authenticated;
SELECT s5fx.capability('org-test', 'shop-a', 'dev1') AS cap \gset
SELECT test.expect_error('o02 a cashier gets no capability for another shop', format($q$SELECT public.recovery_v1_offline_capability('org-test','shop-b',%L)$q$, :'d1'), 'OFFLINE_SHOP_INVALID');
SELECT test.expect_error('o03 nor for another organization', format($q$SELECT public.recovery_v1_offline_capability('org-unrelated','shop-unrel',%L)$q$, :'d1'), 'CALLER_REQUIRED');
SELECT test.expect_error('o03b nor with a malformed device id', $$SELECT public.recovery_v1_offline_capability('org-test','shop-a','x')$$, 'OFFLINE_DEVICE_INVALID');
RESET ROLE;
SELECT test.check('o01 ACTIVE organization: capability issued, bound to org / shop / device / user / epoch, policy owner-approved',
  :'cap'::jsonb->>'outcome' = 'issued' AND :'cap'::jsonb->'capability'->>'userId' = 'u-cash-a1' AND :'cap'::jsonb->'capability'->>'deviceId' = :'d1'
  AND :'cap'::jsonb->'capability'->>'policyStatus' = 'OWNER_APPROVED' AND (:'cap'::jsonb->'capability'->>'maxOps')::int = 3
  AND (:'cap'::jsonb->'capability'->>'expiresAt')::timestamptz > now() AND (:'cap'::jsonb->'capability'->>'expiresAt')::timestamptz <= now() + interval '1 hour');
SELECT :'cap'::jsonb->'capability'->>'id' AS cap_id \gset
-- ---------------------------------------------------------------- an offline-recorded sale, synced with its capability
SELECT set_config('s5fx.device', 'dev1', false);   -- the operations below were recorded on dev1, the capability's device
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap_id', 'deviceSeq', 1)::text)::text, false);
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000001') AS os1 \gset
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000001') AS os1b \gset
RESET ROLE;
SELECT test.check('o04 an offline sale is accepted within its capability; usage recorded (1 operation, 1000 MMK)',
  (SELECT count(*) = 1 AND sum(amount_mmk) = 1000 FROM recovery_v1.offline_usage WHERE capability_id = :'cap_id'::uuid));
SELECT test.check('o05 a duplicate resend replays the same sale and is counted once',
  :'os1b'::jsonb->'sale'->>'id' = :'os1'::jsonb->'sale'->>'id' AND (SELECT count(*) = 1 FROM recovery_v1.offline_usage WHERE capability_id = :'cap_id'::uuid));
SET ROLE authenticated;
SELECT test.expect_error('o06 a reused device sequence number is held for review', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000002')$$, 'offline_device_sequence_reused');
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap_id', 'deviceSeq', 2)::text)::text, false);
SELECT test.expect_error('o07 value beyond the capability is held for review (1000 + 20000 > 20000)', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 20000, 0, '[{"product_id":"prod-2","qty":10}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000003')$$, 'offline_exposure_amount');
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap_id', 'deviceSeq', 3)::text)::text, false);
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000004') AS os4 \gset
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap_id', 'deviceSeq', 4)::text)::text, false);
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000005') AS os5 \gset
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap_id', 'deviceSeq', 5)::text)::text, false);
SELECT test.expect_error('o08 a fourth operation under a 3-operation capability is held for review', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000006')$$, 'offline_exposure_ops');
RESET ROLE;
SELECT test.check('o09 refused operations left nothing behind (3 usage rows, no sale for the refused keys)',
  (SELECT count(*) = 3 FROM recovery_v1.offline_usage WHERE capability_id = :'cap_id'::uuid)
  AND NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE key IN ('66666666-0000-4000-8000-000000000002','66666666-0000-4000-8000-000000000003','66666666-0000-4000-8000-000000000006')));
-- another user presenting A1's capability
SELECT test.login('a0000000-0000-4000-8000-000000000004');   -- cashier A2
SET ROLE authenticated;
SELECT test.expect_error('o10 a capability is bound to its cashier', $$SELECT public.complete_sale('shop-a', 'nope', 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000007')$$, 'offline_capability_binding');
RESET ROLE;
-- an online operation (no header) is unaffected
SELECT set_config('request.headers', '', false);
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000008') AS on1 \gset
SELECT set_config('request.headers', '{"x-orvix-offline":"{\"capabilityId\":\"00000000-0000-4000-8000-000000000000\",\"deviceSeq\":1}"}', false);
SELECT test.expect_error('o12 an unknown capability is held for review', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000009')$$, 'offline_capability_unknown');
SELECT set_config('request.headers', '{"x-orvix-offline":"not json"}', false);
SELECT test.expect_error('o13 a malformed offline header is held for review', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000010')$$, 'offline_header_invalid');
RESET ROLE;
SELECT set_config('request.headers', '', false);
SELECT test.check('o11 an online sale (no header) records no offline usage', :'on1'::jsonb->'sale'->>'id' IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recovery_v1.offline_usage WHERE op_key = '66666666-0000-4000-8000-000000000008'));
-- ---------------------------------------------------------------- recovery response: epoch, revocation, deadline
SET ROLE authenticated;
SELECT s5fx.capability('org-test', 'shop-a', 'dev2') AS cap2 \gset
RESET ROLE;
SELECT offline_epoch AS epoch_before FROM recovery_v1.org_state WHERE org_id = 'org-test' \gset
SELECT test.login('a0000000-0000-4000-8000-000000000001');   -- admin restricts the organization (a recovery event)
SET ROLE authenticated;
SELECT public.recovery_v1_transition('org-test', 'RESTRICTED', 'synthetic recovery event', 'synthetic-evidence') AS tr \gset
SELECT test.check('o15 no capability is issued while the organization is not ACTIVE', public.recovery_v1_offline_capability('org-test','shop-a',:'d3')->>'reason' = 'organization_not_active');
RESET ROLE;
SELECT test.check('o14 leaving ACTIVE starts a new offline epoch', (SELECT offline_epoch = :epoch_before + 1 FROM recovery_v1.org_state WHERE org_id = 'org-test'));
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SELECT set_config('s5fx.device', 'dev2', false);
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap2'::jsonb->'capability'->>'id', 'deviceSeq', 1)::text)::text, false);
SET ROLE authenticated;
SELECT test.expect_error('o16 while RESTRICTED an offline sale is refused (kept on the till, retried later)', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000011')$$, 'ORG_SUSPENDED');
RESET ROLE;
-- Step 5: genuine owner-signed reopening of the NEW incident (synthetic owner), not a superuser edit
\set fx_org org-test
\ir ../step5/fixture-activate.psql
SET ROLE authenticated;
SELECT test.expect_error('o17 after the recovery event an operation under an OLDER-epoch capability is never accepted as verified', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000011')$$, 'offline_capability_stale_epoch');
RESET ROLE;
SELECT set_config('request.headers', '', false);
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SET ROLE authenticated;
SELECT s5fx.capability('org-test', 'shop-a', 'dev4') AS cap3 \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT public.recovery_v1_revoke_device('org-test', :'d4', 'Synthetic: till reported stolen') AS rv \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SET ROLE authenticated;
SELECT test.check('o19 a revoked device receives no new capability', s5fx.capability('org-test','shop-a','dev4')->>'reason' = 'device_revoked');
SELECT set_config('s5fx.device', 'dev4', false);
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap3'::jsonb->'capability'->>'id', 'deviceSeq', 1)::text)::text, false);
-- Step 5: the revoked device's signature is refused by the device-trust check itself (device_revoked), before the offline check
SELECT test.expect_error('o20 operations of a revoked device are held for review at reconnect', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000012')$$, 'device_revoked');
SELECT test.expect_error('o21 a cashier cannot revoke devices', format($q$SELECT public.recovery_v1_revoke_device('org-test',%L,'not mine to revoke')$q$, :'d1'), 'CALLER_REQUIRED');
RESET ROLE;
SELECT set_config('request.headers', '', false);
-- a capability whose sync deadline passed (inserted directly as a fixture: lifetimes are minutes, not test-time), issued to dev5
SELECT gen_random_uuid() AS cap_old \gset
INSERT INTO recovery_v1.offline_capabilities SELECT :'cap_old'::uuid, c.org_id, c.shop_id, :'d5', c.user_id, x.ep, c.policy_scope, c.policy_status,
  now() - interval '3 days', now() - interval '2 days', x.dl, c.max_ops, c.max_amount_mmk, c.allowed_ops, x.doc::text,
  encode(recovery_v1.hmac_sha256(convert_to(x.doc::text, 'UTF8'), (SELECT k FROM recovery_v1.keys WHERE name = 'offline-mac')), 'hex'), :'e5'::uuid
  FROM recovery_v1.offline_capabilities c,
  LATERAL (SELECT (SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id = c.org_id) AS ep, date_trunc('milliseconds', now() - interval '1 day') AS dl) y,
  LATERAL (SELECT y.ep, y.dl, jsonb_build_object('id', :'cap_old', 'orgId', c.org_id, 'shopId', c.shop_id, 'deviceId', :'d5', 'userId', c.user_id, 'enrollmentId', :'e5',
     'offlineEpoch', y.ep, 'maxOps', c.max_ops, 'maxAmountMmk', c.max_amount_mmk, 'syncDeadline', to_char(y.dl AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS doc) x
 WHERE c.id = :'cap_id'::uuid;
-- a copied row: another capability's document and MAC re-bound to a new id
-- (Step 5: expired row-column so this integrity fixture does not hold aggregate budget; its document still says otherwise)
INSERT INTO recovery_v1.offline_capabilities SELECT '00000000-0000-4000-8000-0000000000c0'::uuid, org_id, shop_id, device_id, user_id, offline_epoch, policy_scope, policy_status,
  issued_at, now() - interval '1 day', sync_deadline, 100, 100000000, allowed_ops, document, mac, enrollment_id FROM recovery_v1.offline_capabilities WHERE id = :'cap_id'::uuid;
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SELECT set_config('s5fx.device', 'dev5', false);
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap_old', 'deviceSeq', 1)::text)::text, false);
SET ROLE authenticated;
SELECT test.expect_error('o22 an operation synced after its capability''s sync deadline is held for review', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000013')$$, 'offline_capability_sync_deadline');
RESET ROLE;
SELECT set_config('s5fx.device', 'dev1', false);
SELECT set_config('request.headers', '{"x-orvix-offline":"{\"capabilityId\":\"00000000-0000-4000-8000-0000000000c0\",\"deviceSeq\":1}"}', false);
SET ROLE authenticated;
SELECT test.expect_error('o26 a row re-bound to another capability''s document (raised limits) is refused as an integrity failure', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000014')$$, 'offline_capability_integrity');
RESET ROLE;
SELECT set_config('request.headers', '', false);
SELECT set_config('s5fx.device', '', false);
SELECT test.expect_error('o23 issued capabilities are immutable (no extension of an expiry)', $$UPDATE recovery_v1.offline_capabilities SET expires_at = expires_at + interval '1 day'$$, 'IMMUTABLE');
SELECT test.expect_error('o24 recorded usage is never deleted', $$DELETE FROM recovery_v1.offline_usage$$, 'IMMUTABLE');
SET ROLE authenticated;
SELECT test.expect_error('o25 the capability tables are not readable by API roles', $$SELECT * FROM recovery_v1.offline_capabilities$$, 'permission denied');
RESET ROLE;
SELECT test.logout();
