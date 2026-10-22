"""Script 2 / RECOVERY tester (pre-V1 phase). Run as:
  python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial \
     --script2-pre tools/recovery-v1/script2/rec_db_pre.py --script2-post tools/recovery-v1/script2/rec_db_post.py
Runs on the harness's private disposable cluster only, BEFORE Recovery V1 is installed. Synthetic data only.

r60 idempotency retention hazards (pre-V1, stage 86): what prune_idempotency_keys / op_purge_responses do to a
resend, measured on the real functions. Aging is simulated by a superuser fixture write (labelled), never a product change.
Also seeds a synthetic ADMIN of org-unrelated (for the cross-organization authorization tests in rec_db_post.py).
"""
import json, re, subprocess, time, uuid

CASH_A1 = 'a0000000-0000-4000-8000-000000000003'


def _psql(ctx, text, label, db='postgres'):
    args = list(ctx['dbargs']); args[args.index('-d') + 1] = db
    p = subprocess.run(['psql', *args], input=text, text=True, env=ctx['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (ctx['run'] / f'rec-pre-{label}.log').write_text(p.stdout)
    return p.returncode, p.stdout


def _val(out, tag='R'):
    m = re.findall(rf'^{tag}=(.*)$', out, re.M)
    return m[-1] if m else None


def _v7(ms):
    h = f'{ms:012x}' + '7' + uuid.uuid4().hex[:3] + '8' + uuid.uuid4().hex[:15]
    return str(uuid.UUID(h))


def record(ctx, rid, scenario, expected, actual, status):
    res = ctx.setdefault('_rec', [])
    res.append({'id': rid, 'scenario': scenario, 'expected': expected, 'actual': actual, 'status': status})
    if status in ('PASS', 'FAIL'):
        ctx['check'](f'{rid} {scenario}', status == 'PASS', actual)


def run(ctx):
    results = []
    ctx['_rec'] = results
    # ---- seed: a synthetic ADMIN of org-unrelated (org-unrelated has no ADMIN in the fixture)
    rc, out = _psql(ctx, """
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-4000-8000-0000000000f3', 'unrel-admin@test.local');
SET ROLE service_role;   -- fixture identity: the trusted platform role may create an ADMIN (guard_user_privilege_columns)
INSERT INTO public.users SELECT (jsonb_populate_record(NULL::public.users, to_jsonb(u)
  || jsonb_build_object('id','u-unrel-admin','org_id','org-unrelated','auth_id','a0000000-0000-4000-8000-0000000000f3','email','unrel-admin@test.local','name','Unrelated admin'))).*
  FROM public.users u WHERE id='u-admin';
RESET ROLE;
SELECT 'R='||(SELECT role||':'||org_id FROM public.users WHERE id='u-unrel-admin');""", 'seed-unrel-admin')
    record(ctx, 'r00', 'fixture: synthetic ADMIN of org-unrelated seeded (pre-V1)', 'ADMIN:org-unrelated', _val(out) or out[-200:],
           'PASS' if _val(out) == 'ADMIN:org-unrelated' else 'FAIL')

    # ---- r60a: a UUIDv7 operation older than the 12-month execution window, pruned after 13 months -> resend refused
    old_ms = int((time.time() - 400 * 86400) * 1000)
    k7 = _v7(old_ms)
    rc, out = _psql(ctx, f"""
-- FIXTURE (superuser): a committed 13+-month-old UUIDv7 ledger row, as it would look after time passes
INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash,response,state,decided_at,created_at)
 VALUES('{k7}','complete_sale','u-cash-a1','org-test','x','{{"sale":{{"id":"sale-fixture-aged"}}}}','committed',now()-interval '400 days',now()-interval '400 days');
SELECT 'PRUNED='||public.prune_idempotency_keys();
SELECT 'GONE='||NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key='{k7}');
SELECT count(*) AS sales_before FROM public.sales \\gset
SELECT test.login('{CASH_A1}');
SET ROLE authenticated;
\\set ON_ERROR_STOP off
SELECT public.op_execute('{k7}','complete_sale',jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a1'),'p_payment_method','CASH','p_paid_mmk',1000,'p_cart_discount_pct',0,'p_items','[{{"product_id":"prod-1","qty":1}}]'::jsonb),'u-cash-a1');
\\set ON_ERROR_STOP on
RESET ROLE;
SELECT 'NEWSALES='||((SELECT count(*) FROM public.sales)-:sales_before);""", 'r60a-prune-v7')
    ok = 'OP_KEY_OUTSIDE_WINDOW' in out and _val(out, 'GONE') == 'true' and _val(out, 'NEWSALES') == '0'
    record(ctx, 'r60a', 'pre-V1: a pruned (13-month) UUIDv7 key resent after prune is refused, no second sale',
           'prune deletes the aged row; op_execute refuses OP_KEY_OUTSIDE_WINDOW; 0 new sales',
           f"pruned={_val(out,'PRUNED')} gone={_val(out,'GONE')} refusal={'OP_KEY_OUTSIDE_WINDOW' in out} new_sales={_val(out,'NEWSALES')}",
           'PASS' if ok else 'FAIL')

    # ---- r60b: legacy (UUIDv4) key: never pruned by the 086 prune; resend replays
    k4 = str(uuid.uuid4())
    rc, out = _psql(ctx, f"""
SELECT test.login('{CASH_A1}');
SET ROLE authenticated;
SELECT public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{{"product_id":"prod-1","qty":1}}]'::jsonb,NULL,'{k4}') AS first \\gset
RESET ROLE;
-- FIXTURE (superuser): age the completed legacy row by 400 days
UPDATE public.idempotency_keys SET created_at=now()-interval '400 days', decided_at=now()-interval '400 days' WHERE key='{k4}';
SELECT 'PRUNED='||public.prune_idempotency_keys();
SELECT 'KEPT='||EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key='{k4}');
SELECT count(*) AS sales_before FROM public.sales \\gset
SET ROLE authenticated;
SELECT 'SAME='||(public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{{"product_id":"prod-1","qty":1}}]'::jsonb,NULL,'{k4}')=:'first'::jsonb);
RESET ROLE;
SELECT 'NEWSALES='||((SELECT count(*) FROM public.sales)-:sales_before);""", 'r60b-prune-v4')
    ok = _val(out, 'KEPT') == 'true' and _val(out, 'SAME') == 'true' and _val(out, 'NEWSALES') == '0'
    record(ctx, 'r60b', 'pre-V1: an aged legacy (v4) completed key survives prune; resend replays the original reply',
           'row kept; identical replay; 0 new sales', f"kept={_val(out,'KEPT')} same_reply={_val(out,'SAME')} new_sales={_val(out,'NEWSALES')}",
           'PASS' if ok else 'FAIL')

    # ---- r60c: op_purge_responses (owner-only, unscheduled) then a legacy resend of the same key
    rc, out = _psql(ctx, f"""
SELECT 'PURGED='||public.op_purge_responses(interval '90 days');
SELECT 'RESP_NULL='||(SELECT response IS NULL FROM public.idempotency_keys WHERE key='{k4}');
SELECT count(*) AS sales_before FROM public.sales \\gset
SELECT test.login('{CASH_A1}');
SET ROLE authenticated;
SELECT 'REPLY='||public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{{"product_id":"prod-1","qty":1}}]'::jsonb,NULL,'{k4}')::text;
RESET ROLE;
SELECT 'NEWSALES='||((SELECT count(*) FROM public.sales)-:sales_before);
SELECT 'CRON='||(to_regnamespace('cron') IS NOT NULL);""", 'r60c-purge')
    record(ctx, 'r60c', 'pre-V1: after op_purge_responses a legacy resend gets an EMPTY reply ({}) for a completed sale (no duplicate)',
           'no second execution; legacy client receives {} (no sale data) -- documented 086 Stage-1 hazard; purge/prune unscheduled',
           f"purged={_val(out,'PURGED')} response_null={_val(out,'RESP_NULL')} reply={_val(out,'REPLY')} new_sales={_val(out,'NEWSALES')} cron_schema={_val(out,'CRON')}",
           'LIMITATION' if _val(out, 'NEWSALES') == '0' else 'FAIL')
    if _val(out, 'NEWSALES') != '0':
        ctx['check']('r60c purge must not cause re-execution', False, out[-300:])
    # ---- fixtures for r61 (under V1): an aged committed legacy row WITH its response, and an aged committed UUIDv7 row
    k5 = str(uuid.uuid4()); k7b = _v7(old_ms + 1)
    rc, out = _psql(ctx, f"""
SELECT test.login('{CASH_A1}');
SET ROLE authenticated;
SELECT public.complete_sale('shop-a',test.var('shift_a1'),'CASH',1000,0,'[{{"product_id":"prod-1","qty":1}}]'::jsonb,NULL,'{k5}');
RESET ROLE;
-- FIXTURE (superuser, pre-V1): age them by 400 days so that prune / purge would select them
UPDATE public.idempotency_keys SET created_at=now()-interval '400 days', decided_at=now()-interval '400 days' WHERE key='{k5}';
INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash,response,state,decided_at,created_at)
 VALUES('{k7b}','complete_sale','u-cash-a1','org-test','x','{{"sale":{{"id":"sale-fixture-aged-2"}}}}','committed',now()-interval '400 days',now()-interval '400 days');
SELECT 'R='||count(*) FROM public.idempotency_keys WHERE key IN ('{k5}','{k7b}') AND response IS NOT NULL;""", 'r61-fixtures')
    (ctx['run'] / 'rec-r61-keys.json').write_text(json.dumps({'legacy_aged_with_response': k5, 'v7_aged': k7b}))
    record(ctx, 'r61f', 'fixture: two aged completed ledger rows with responses for the under-V1 retention test', '2', _val(out) or out[-200:], 'PASS' if _val(out) == '2' else 'FAIL')
    (ctx['run'] / 'rec-pre-results.json').write_text(json.dumps(results, indent=1) + '\n')
