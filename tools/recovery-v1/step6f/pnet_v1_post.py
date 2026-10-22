"""Step 6 finalization (review 3, M3) -- PNET-A's revoke part on an installation that ALREADY has Recovery V1: applied only
through recovery_v1.apply_authorized_migration with a (synthetic) owner-signed authorization bound to the exact SQL.

Run: python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial \
       --script2-pre tools/recovery-v1/step6f/pnet_v1_pre.sql --script2-post tools/recovery-v1/step6f/pnet_v1_post.py
"""
import hashlib
import json
import subprocess


def run(ctx):
    sql, check, run, env, dbargs = ctx['sql'], ctx['check'], ctx['run'], ctx['env'], ctx['dbargs']
    sim, keydir = str(ctx['sim']), ctx['keydir']
    Q = (ctx['ROOT'] / 'supabase/migrations-provisional/PNET-A_post_v1_revoke.sql').read_text()

    def psql(statement, label, **vars):
        argv = ['psql', *dbargs]
        for k, v in vars.items():
            argv += ['-v', f'{k}={v}']
        r = subprocess.run(argv, input=statement, text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / f'pnetv1-{label}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    target = json.loads(sql("SELECT recovery_v1.authorization_target();", 'pnetv1-target.log').strip())
    active = next(k['keyId'] for k in target['ownerKeys'] if not k['retired'])

    def authorize(payload, label):
        (run / f'pnetv1-{label}-t.json').write_text(json.dumps(target))
        (run / f'pnetv1-{label}-p.json').write_text(json.dumps(payload))
        out = subprocess.run(['node', sim, 'authorize', str(keydir / f'{active}.private.pem'), active, 'migration',
                              str(run / f'pnetv1-{label}-t.json'), str(run / f'pnetv1-{label}-p.json')],
                             text=True, capture_output=True, check=True).stdout
        a = json.loads(out)
        return a['authorization'], a['signature']

    def payload(text, mid):
        return {'migration': {'id': mid, 'sqlSha256': hashlib.sha256(text.encode()).hexdigest(),
                              'predecessor': sql("SELECT recovery_v1.migration_chain_head();", 'pnetv1-head.log').strip(),
                              'allowedCommands': ['REVOKE', 'GRANT'], 'newTables': []}}

    def exposed():
        return sql("SELECT coalesce(string_agg(x, '; '), '') FROM orvix_netguard.exposure_problems() x;",
                   'pnetv1-exposure.log').strip()

    before = exposed()
    check('pnetv1-01 after V1 the (mock) pg_net objects are still exposed (the drift this path repairs)', before != '', before[:200])
    # a direct superuser revoke would not be blocked by V1's DDL guard (GRANT/REVOKE are not watched outside an authorized
    # migration); the PROCESS is: owner-signed, exact SQL, recorded in the applied-migration chain
    a, s = authorize(payload(Q + ' ', 'PNET-A-POST-V1-WRONGSHA'), 'wrong')
    rc, out = psql("SELECT recovery_v1.apply_authorized_migration(:'a', :'s', :'q');", 'wrong', a=a, s=s, q=Q)
    check('pnetv1-02 an authorization for different SQL text is refused (checksum)', rc != 0 and 'ERROR' in out, out.strip().splitlines()[-1][:200] if out.strip() else out)
    a, s = authorize(payload(Q, 'PNET-A-POST-V1'), 'ok')
    rc, out = psql("SELECT recovery_v1.apply_authorized_migration(:'a', :'s', :'q');", 'apply', a=a, s=s, q=Q)
    check('pnetv1-03 PNET-A_post_v1_revoke.sql applies through recovery_v1.apply_authorized_migration (owner-signed, GRANT/REVOKE only)',
          rc == 0, out.strip().splitlines()[-1][:200] if out.strip() else out)
    after = exposed()
    check('pnetv1-04 afterwards nothing in schema net is exposed (PUBLIC / anon / authenticated / service_role)', after == '', after[:200])
    rec = sql("SELECT count(*) FROM recovery_v1.applied_migrations WHERE migration_id = 'PNET-A-POST-V1';", 'pnetv1-recorded.log').strip()
    integ = sql("SELECT coalesce(recovery_v1.integrity_problem(), 'none');", 'pnetv1-integrity.log').strip()
    check('pnetv1-05 the migration is recorded in the applied-migration chain and V1 integrity stays none', rec == '1' and integ == 'none', f'recorded={rec} integrity={integ}')
