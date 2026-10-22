-- Step 4 Part B: offline capabilities. Synthetic data only. Preconditions (set by db-smoke.py): Recovery V1 installed with a
-- synthetic owner key; an OWNER-SIGNED offline policy for '*' (3 operations, 20,000 MMK); org-test ACTIVE (fixture), shift_a1
-- open. Offline-recorded operations are simulated exactly as PostgREST presents them: header x-orvix-offline on the request.
\set ON_ERROR_STOP on
SELECT test.logout();
SELECT set_config('request.headers', '', false);
SELECT test.check('o00 owner-signed offline policy in force (3 ops, 20000 MMK)',
  (SELECT status = 'OWNER_APPROVED' AND max_ops = 3 AND max_amount_mmk = 20000 FROM recovery_v1.offline_policy WHERE scope = '*'));
SELECT test.login('a0000000-0000-4000-8000-000000000003');   -- cashier A1, shop-a
SET ROLE authenticated;
SELECT public.recovery_v1_offline_capability('org-test', 'shop-a', 'device-test-0001') AS cap \gset
SELECT test.expect_error('o02 a cashier gets no capability for another shop', $$SELECT public.recovery_v1_offline_capability('org-test','shop-b','device-test-0001')$$, 'OFFLINE_SHOP_INVALID');
SELECT test.expect_error('o03 nor for another organization', $$SELECT public.recovery_v1_offline_capability('org-unrelated','shop-unrel','device-test-0001')$$, 'CALLER_REQUIRED');
SELECT test.expect_error('o03b nor with a malformed device id', $$SELECT public.recovery_v1_offline_capability('org-test','shop-a','x')$$, 'OFFLINE_DEVICE_INVALID');
RESET ROLE;
SELECT test.check('o01 ACTIVE organization: capability issued, bound to org / shop / device / user / epoch, policy owner-approved',
  :'cap'::jsonb->>'outcome' = 'issued' AND :'cap'::jsonb->'capability'->>'userId' = 'u-cash-a1' AND :'cap'::jsonb->'capability'->>'deviceId' = 'device-test-0001'
  AND :'cap'::jsonb->'capability'->>'policyStatus' = 'OWNER_APPROVED' AND (:'cap'::jsonb->'capability'->>'maxOps')::int = 3
  AND (:'cap'::jsonb->'capability'->>'expiresAt')::timestamptz > now() AND (:'cap'::jsonb->'capability'->>'expiresAt')::timestamptz <= now() + interval '1 hour');
SELECT :'cap'::jsonb->'capability'->>'id' AS cap_id \gset
-- ---------------------------------------------------------------- an offline-recorded sale, synced with its capability
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
SELECT public.recovery_v1_offline_capability('org-test', 'shop-a', 'device-test-0002') AS cap2 \gset
RESET ROLE;
SELECT offline_epoch AS epoch_before FROM recovery_v1.org_state WHERE org_id = 'org-test' \gset
SELECT test.login('a0000000-0000-4000-8000-000000000001');   -- admin restricts the organization (a recovery event)
SET ROLE authenticated;
SELECT public.recovery_v1_transition('org-test', 'RESTRICTED', 'synthetic recovery event', 'synthetic-evidence') AS tr \gset
SELECT test.check('o15 no capability is issued while the organization is not ACTIVE', public.recovery_v1_offline_capability('org-test','shop-a','device-test-0003')->>'reason' = 'organization_not_active');
RESET ROLE;
SELECT test.check('o14 leaving ACTIVE starts a new offline epoch', (SELECT offline_epoch = :epoch_before + 1 FROM recovery_v1.org_state WHERE org_id = 'org-test'));
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap2'::jsonb->'capability'->>'id', 'deviceSeq', 1)::text)::text, false);
SET ROLE authenticated;
SELECT test.expect_error('o16 while RESTRICTED an offline sale is refused (kept on the till, retried later)', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000011')$$, 'ORG_SUSPENDED');
RESET ROLE;
UPDATE recovery_v1.org_state SET state = 'ACTIVE' WHERE org_id = 'org-test';   -- synthetic fixture only: no production reopen exists
SET ROLE authenticated;
SELECT test.expect_error('o17 after the recovery event an operation under an OLDER-epoch capability is never accepted as verified', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000011')$$, 'offline_capability_stale_epoch');
RESET ROLE;
SELECT set_config('request.headers', '', false);
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SET ROLE authenticated;
SELECT public.recovery_v1_offline_capability('org-test', 'shop-a', 'device-test-0004') AS cap3 \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT public.recovery_v1_revoke_device('org-test', 'device-test-0004', 'Synthetic: till reported stolen') AS rv \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SET ROLE authenticated;
SELECT test.check('o19 a revoked device receives no new capability', public.recovery_v1_offline_capability('org-test','shop-a','device-test-0004')->>'reason' = 'device_revoked');
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap3'::jsonb->'capability'->>'id', 'deviceSeq', 1)::text)::text, false);
SELECT test.expect_error('o20 operations of a revoked device are held for review at reconnect', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000012')$$, 'offline_device_revoked');
SELECT test.expect_error('o21 a cashier cannot revoke devices', $$SELECT public.recovery_v1_revoke_device('org-test','device-test-0001','not mine to revoke')$$, 'CALLER_REQUIRED');
RESET ROLE;
SELECT set_config('request.headers', '', false);
-- a capability whose sync deadline passed (inserted directly as a fixture: lifetimes are minutes, not test-time)
SELECT gen_random_uuid() AS cap_old \gset
INSERT INTO recovery_v1.offline_capabilities SELECT :'cap_old'::uuid, c.org_id, c.shop_id, 'device-test-0005', c.user_id, x.ep, c.policy_scope, c.policy_status,
  now() - interval '3 days', now() - interval '2 days', x.dl, c.max_ops, c.max_amount_mmk, c.allowed_ops, x.doc::text,
  encode(recovery_v1.hmac_sha256(convert_to(x.doc::text, 'UTF8'), (SELECT k FROM recovery_v1.keys WHERE name = 'offline-mac')), 'hex')
  FROM recovery_v1.offline_capabilities c,
  LATERAL (SELECT (SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id = c.org_id) AS ep, date_trunc('milliseconds', now() - interval '1 day') AS dl) y,
  LATERAL (SELECT y.ep, y.dl, jsonb_build_object('id', :'cap_old', 'orgId', c.org_id, 'shopId', c.shop_id, 'deviceId', 'device-test-0005', 'userId', c.user_id,
     'offlineEpoch', y.ep, 'maxOps', c.max_ops, 'maxAmountMmk', c.max_amount_mmk, 'syncDeadline', to_char(y.dl AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS doc) x
 WHERE c.id = :'cap_id'::uuid;
-- a copied row: another capability's document and MAC re-bound to a new id
INSERT INTO recovery_v1.offline_capabilities SELECT '00000000-0000-4000-8000-0000000000c0'::uuid, org_id, shop_id, device_id, user_id, offline_epoch, policy_scope, policy_status,
  issued_at, expires_at, sync_deadline, 100, 100000000, allowed_ops, document, mac FROM recovery_v1.offline_capabilities WHERE id = :'cap_id'::uuid;
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'cap_old', 'deviceSeq', 1)::text)::text, false);
SET ROLE authenticated;
SELECT test.expect_error('o22 an operation synced after its capability''s sync deadline is held for review', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000013')$$, 'offline_capability_sync_deadline');
SELECT set_config('request.headers', '{"x-orvix-offline":"{\"capabilityId\":\"00000000-0000-4000-8000-0000000000c0\",\"deviceSeq\":1}"}', false);
SELECT test.expect_error('o26 a row re-bound to another capability''s document (raised limits) is refused as an integrity failure', $$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000014')$$, 'offline_capability_integrity');
RESET ROLE;
SELECT set_config('request.headers', '', false);
SELECT test.expect_error('o23 issued capabilities are immutable (no extension of an expiry)', $$UPDATE recovery_v1.offline_capabilities SET expires_at = expires_at + interval '1 day'$$, 'IMMUTABLE');
SELECT test.expect_error('o24 recorded usage is never deleted', $$DELETE FROM recovery_v1.offline_usage$$, 'IMMUTABLE');
SET ROLE authenticated;
SELECT test.expect_error('o25 the capability tables are not readable by API roles', $$SELECT * FROM recovery_v1.offline_capabilities$$, 'permission denied');
RESET ROLE;
SELECT test.logout();
