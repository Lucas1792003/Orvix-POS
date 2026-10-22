"""Script 2 (defensive) post-module: repeat install, provisional files after V1, and the workstation
sequence/runner planners (verify.py, migration_plan.py) WITHOUT Docker.

Runs as `--script2-post`. Live-cluster parts (repeat install, applying a provisional file after V1) are
wrapped so nothing is committed. The planner parts are pure subprocess over crafted TSV / JSON facts.
No Docker, no shared DB, no product code changed.
"""
import hashlib
import json
import os
import re
import subprocess
import sys


def run(ctx):
    ROOT, sql, check, run, env, dbargs = ctx['ROOT'], ctx['sql'], ctx['check'], ctx['run'], ctx['env'], ctx['dbargs']
    guards = ROOT / 'supabase/migrations-provisional/RECOVERY_V1_guards.sql'

    def psql_in(text, label):
        r = subprocess.run(['psql', *dbargs], input=text, text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / f'script2-seq-{label}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    # ---- repeat install attempt: refused, nothing changed ----------------------------------------
    before = sql("SELECT (SELECT count(*) FROM recovery_v1.install)||'|'||coalesce(recovery_v1.integrity_problem(),'none')||'|'||recovery_v1.v1_catalog_state();", 'seq-before.log').strip()
    r = subprocess.run(['psql', *dbargs, '-v', 'recovery_v1_install_ack=restrict-every-organization', '-f', str(guards)],
                       text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (run / 'script2-seq-reinstall.log').write_text(r.stdout)
    after = sql("SELECT (SELECT count(*) FROM recovery_v1.install)||'|'||coalesce(recovery_v1.integrity_problem(),'none')||'|'||recovery_v1.v1_catalog_state();", 'seq-after.log').strip()
    check('s01 a second install attempt is refused (RECOVERY_V1_ALREADY_INSTALLED) and changes nothing',
          r.returncode != 0 and 'RECOVERY_V1_ALREADY_INSTALLED' in r.stdout and before == after, r.stdout[-160:])

    # ---- provisional files applied directly after V1 (wrapped so nothing commits) ----------------
    def apply_file_rolledback(relpath, label):
        p = ROOT / relpath
        return psql_in(f"BEGIN;\n\\i {p}\nROLLBACK;\n", label)

    # PCOST-A relies on V1's DDL guard refusing its NEW public tables (it carries no recovery_v1 preflight).
    # In the --financial scenario PCOST-A is already applied before V1 and is idempotent, so demonstrate the
    # guard directly: any new public table after V1 is refused (the path PCOST-A's product_costs/sale_item_costs hit).
    rc, out = psql_in("BEGIN;\nCREATE TABLE public.zz_s2_unguarded_probe (id int);\nROLLBACK;\n", 'pcost-a')
    check('s02 a new public table after V1 (e.g. PCOST-A cost tables) is refused by the DDL guard (UNGUARDED_TABLE_BLOCKED)',
          rc != 0 and 'UNGUARDED_TABLE_BLOCKED' in out, out[-160:])
    # PFIN-D / PFIN-E carry an explicit recovery_v1 preflight
    rc, out = apply_file_rolledback('supabase/migrations-provisional/PFIN-D_payments_cash.sql', 'pfin-d')
    check('s03 PFIN-D after V1 is refused by its own recovery_v1 preflight',
          rc != 0 and 'PFIN-D: Recovery V1 is installed' in out, out[-160:])
    rc, out = apply_file_rolledback('supabase/migrations-provisional/PFIN-E_refund_lines.sql', 'pfin-e')
    check('s04 PFIN-E after V1 is refused by its own recovery_v1 preflight',
          rc != 0 and 'PFIN-E: Recovery V1 is installed' in out, out[-160:])
    # held PFIN-C: creates a function + trigger on an existing table, NO new public table, and NO
    # recovery_v1 preflight -> the in-database guards do NOT refuse it. Record the actual outcome.
    rc, out = apply_file_rolledback('supabase/migrations-provisional/held/PFIN-C_refund_net_paid_cap.sql', 'pfin-c')
    pfin_c_refused_in_db = rc != 0 and 'recovery_v1' in out.lower()
    (run / 'script2-seq-pfin-c-outcome.txt').write_text(f'rc={rc} refused_in_db={pfin_c_refused_in_db}\n{out[-400:]}')

    # ---- workstation sequence verifier (verify.py plan) with crafted facts -----------------------
    verifier = ROOT / 'tools/migration-sequence/verify.py'

    def plan(facts, label):
        fp = run / f'script2-seq-facts-{label}.json'
        fp.write_text(json.dumps(facts))
        r = subprocess.run([sys.executable, '-I', str(verifier), 'plan', '--facts', str(fp)],
                           text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / f'script2-seq-plan-{label}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    base = {'schema': 'orvix-migration-facts-v1', 'ledger': '062,063,064,065,066,067,068,069,070,071,072,073,074,075,076,077,078,079,080,081,082,083,085',
            'has_086': False, 'has_087': False, 'PSAFE-A': False, 'PFIN-A': False, 'PFIN-B': False, 'PCOST-A': False,
            'PFIN-C': False, 'PFIN-D': False, 'PFIN-E': False, 'RECOVERY_V1': True, 'adapter_087': None,
            'v1_integrity': 'none', 'm087_state': None, 'm087_fingerprint': None}
    rc, out = plan(dict(base), 'v1')
    refused = {sid for sid in ('PCOST-A', 'PFIN-C', 'PFIN-D', 'PFIN-E', '087') if re.search(rf'^\s*{re.escape(sid)}\s+REFUSED', out, re.M)}
    check('s05 verify.py plan with V1 installed refuses PCOST-A, PFIN-C, PFIN-D, PFIN-E and 087',
          refused == {'PCOST-A', 'PFIN-C', 'PFIN-D', 'PFIN-E', '087'}, 'refused=' + ','.join(sorted(refused)))
    # PFIN-C conclusion: no in-db guard, but verify.py plan + owner review refuse it
    check('s06 (LIMITATION) PFIN-C after V1 has no in-database guard; it relies on verify.py plan + owner review',
          (not pfin_c_refused_in_db) and 'PFIN-C' in refused, f'in_db_refused={pfin_c_refused_in_db}')

    # crafted drift / forbidden-order facts -> violations
    drift = dict(base); drift.update({'has_086': True, 'has_087': True, 'adapter_087': '0', 'm087_fingerprint': 'deadbeef' * 4, 'm087_state': 'held'})
    rc, out = plan(drift, 'drift')
    check('s07 verify.py plan flags a drifted 087 fingerprint and 087-applied-after-V1 as violations',
          rc == 1 and 'not the reviewed 087' in out and 'applied AFTER V1' in out, out[-200:])

    # ---- runner/planner (migration_plan.py) checksum + rollback refusals, WITHOUT Docker ---------
    mp = ROOT / 'deploy/lucashome/migration_plan.py'
    real_mig = ROOT / 'supabase/migrations'
    real_rb = ROOT / 'supabase/rollbacks'
    files = {}
    for f in os.listdir(real_mig):
        m = re.match(r'^(\d{3})_.+\.sql$', f)
        if m:
            files[m.group(1)] = f
    recorded = sorted(v for v in files if v <= '086')

    def sha(v):
        return 'sha256:' + hashlib.sha256((real_mig / files[v]).read_bytes()).hexdigest()

    def write_ledger(path, bad086=False):
        lines = []
        for v in recorded:
            s = ('sha256:' + '0' * 64) if (bad086 and v == '086') else sha(v)
            lines.append(f'{v}\t{s}\t1')
        path.write_text('\n'.join(lines) + '\n')

    def write_facts(path, v1=False):
        f = {'ledger_md5': '0' * 32, 'ledger_cols': 'name,statements,version', 'has_op_execute': 't',
             'has_v87': 'f', 'has_recovery_v1': 't' if v1 else 'f', 'idem_pk': 'org_id,key'}
        path.write_text(''.join(f'{k}\t{v}\n' for k, v in f.items()))

    lp, fp, outd = run / 'script2-mp-ledger.tsv', run / 'script2-mp-facts.tsv', run / 'script2-mp-out'
    # checksum mismatch: 086 recorded with a sha that differs from the repo file
    write_ledger(lp, bad086=True)
    write_facts(fp, v1=False)
    r = subprocess.run([sys.executable, '-I', str(mp), 'forward', '--migrations', str(real_mig), '--ledger', str(lp),
                        '--facts', str(fp), '--from', '087', '--to', '087', '--out', str(outd)], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (run / 'script2-mp-checksum.log').write_text(r.stdout)
    check('s08 migration_plan.py refuses a forward plan when a recorded checksum differs from the repo file (CHECKSUM MISMATCH)',
          r.returncode == 2 and 'CHECKSUM MISMATCH' in r.stdout and not outd.exists(), r.stdout[-160:])
    # rollback refused while Recovery V1 is installed
    write_ledger(lp, bad086=False)
    write_facts(fp, v1=True)
    r = subprocess.run([sys.executable, '-I', str(mp), 'rollback', '--migrations', str(real_mig), '--rollbacks', str(real_rb),
                        '--ledger', str(lp), '--facts', str(fp), '--version', '086', '--owner-confirmed-till-queues-empty', '--out', str(outd)],
                       text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (run / 'script2-mp-rollback.log').write_text(r.stdout)
    check('s09 migration_plan.py refuses any rollback while Recovery V1 is installed',
          r.returncode == 2 and 'Recovery V1 is installed' in r.stdout and not outd.exists(), r.stdout[-160:])

    # the committed unit suite exercises the same refusals end to end, without Docker
    r = subprocess.run([sys.executable, '-I', str(ROOT / 'deploy/lucashome/tests/migration-plan-test.py')],
                       text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (run / 'script2-mp-unit.log').write_text(r.stdout)
    check('s10 deploy/lucashome migration_plan unit suite passes without Docker (checksum/gap/order/rollback refusals)',
          r.returncode == 0 and re.search(r'OK', r.stdout) is not None, r.stdout[-160:])

    sql("UPDATE recovery_v1.org_state SET state='ACTIVE' WHERE org_id='org-test';", 'seq-leave-active.log')
