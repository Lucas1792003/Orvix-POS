"""Step 6 finalization -- Recovery V1 compatibility of PFIN-F / PDISC-A / PNET-A (post-install hook).

Run (private disposable cluster only; synthetic data only):
  python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial --script2-post tools/recovery-v1/step6f/v1_policy.py
  (also with --with-087)

Checks, after Recovery V1 is installed over the finalization provisionals:
  v1 integrity is none; fin_approvals and refund_payout_confirmations are V1-GUARDED tables (registry + enabled-ALWAYS write
  trigger); a write naming a RESTRICTED organization is refused even for the superuser; a cross-organization row is refused;
  the PNET-A event trigger is superuser-owned (V1's foreign-event-trigger rule) and the PDISC-A / PFIN-F triggers survive.
Nothing is left mutated (every probe write is refused or rolled back).
"""
import subprocess


def run(ctx):
    sql, check, run, env, dbargs = ctx['sql'], ctx['check'], ctx['run'], ctx['env'], ctx['dbargs']

    def attempt(statement, label):
        r = subprocess.run(['psql', *dbargs, '-v', 'ON_ERROR_STOP=1'], input='BEGIN;\n' + statement + '\nROLLBACK;\n', text=True, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / f'v1p-{label}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    integ = sql("SELECT coalesce(recovery_v1.integrity_problem(), 'none');", 'v1p-integrity.log').strip()
    check('v1p01 Recovery V1 installs over PFIN-F, PDISC-A and PNET-A; integrity none', integ == 'none', integ)
    g = sql("SELECT string_agg(g.relname || ':' || t.tgenabled::text, ',' ORDER BY g.relname) FROM recovery_v1.guarded_tables g "
            "JOIN pg_trigger t ON t.tgrelid = g.relid AND t.tgname = 'zz_recovery_v1_write' "
            "WHERE g.relname IN ('fin_approvals', 'refund_payout_confirmations', 'refund_cash_drawer');", 'v1p-guarded.log').strip()
    check('v1p02 fin_approvals, refund_payout_confirmations and refund_cash_drawer are V1-guarded (registry + write trigger enabled ALWAYS)',
          g == 'fin_approvals:A,refund_cash_drawer:A,refund_payout_confirmations:A', g)
    restricted = sql("SELECT coalesce((SELECT o.org_id || '|' || (SELECT min(id) FROM public.shops WHERE org_id = o.org_id) FROM recovery_v1.org_state o "
                     "WHERE o.state <> 'ACTIVE' AND EXISTS (SELECT 1 FROM public.shops s WHERE s.org_id = o.org_id) ORDER BY o.org_id LIMIT 1), '');",
                     'v1p-restricted.log').strip()
    if restricted:
        org, shop = restricted.split('|')
        rc, out = attempt("INSERT INTO public.fin_approvals (id, org_id, shop_id, kind, details, reason, requested_by, requested_at) "
                          f"VALUES ('fa-v1p-1', '{org}', '{shop}', 'DISCOUNT', '{{}}', 'v1 probe', 'u-v1p', now());", 'restricted')
        check('v1p03 a discount approval for a RESTRICTED organization is refused by V1 (even as superuser)',
              rc != 0 and 'ERROR' in out and 'recovery' in out.lower(), out.strip().splitlines()[-1][:200] if out.strip() else out)
    else:
        check('v1p03 a RESTRICTED organization with a shop exists to probe', False, 'none found')
    shops = sql("SELECT string_agg(id || '@' || org_id, ',' ORDER BY id) FROM (SELECT DISTINCT ON (org_id) id, org_id FROM public.shops ORDER BY org_id, id) x;",
                'v1p-shops.log').strip().split(',')
    if len(shops) >= 2:
        (s1, o1), (s2, o2) = shops[0].split('@'), shops[1].split('@')
        rc, out = attempt("INSERT INTO public.fin_approvals (id, org_id, shop_id, kind, details, reason, requested_by, requested_at) "
                          f"VALUES ('fa-v1p-2', '{o1}', '{s2}', 'DISCOUNT', '{{}}', 'v1 probe', 'u-v1p', now());", 'cross')
        check('v1p04 an approval row naming one organization and another organization\'s shop is refused (cross-tenant)',
              rc != 0 and ('cross_tenant' in out or 'recovery' in out.lower()), out.strip().splitlines()[-1][:200] if out.strip() else out)
    evt = sql("SELECT coalesce((SELECT (SELECT rolsuper FROM pg_roles WHERE oid = e.evtowner)::text || '/' || (SELECT rolsuper FROM pg_roles r JOIN pg_proc p ON p.proowner = r.oid WHERE p.oid = e.evtfoid)::text "
              "FROM pg_event_trigger e WHERE e.evtname = 'zz_orvix_net_lockdown'), 'absent');", 'v1p-evt.log').strip()
    check('v1p05 the PNET-A event trigger exists and is superuser-owned (event trigger and function)', evt == 'true/true', evt)
    trg = sql("SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgname IN ('zzd_discount_guard', 'zzg_refund_policy_ins', 'zzg_refund_policy_upd', "
              "'zzg_refund_exceptions', 'zzg_refund_default_payout', 'zzf_sale_change_guard') AND tgenabled <> 'D';", 'v1p-trg.log').strip()
    check('v1p06 the PDISC-A and PFIN-F triggers are present and enabled after V1',
          trg == 'zzd_discount_guard,zzf_sale_change_guard,zzg_refund_default_payout,zzg_refund_exceptions,zzg_refund_policy_ins,zzg_refund_policy_upd', trg)
