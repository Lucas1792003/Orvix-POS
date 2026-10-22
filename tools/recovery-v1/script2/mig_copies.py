"""Script 2 (defensive) post-module: database-copy behaviour of owner authorizations.

Runs as `--script2-post`. On its OWN disposable clusters under /private/tmp/s2m.* (short socket paths,
own ports, listen_addresses=''), it shows:
  - CLONE-1 (LIMITATION): a physical copy (pg_basebackup) keeps the same system identifier and install row,
    so the SAME valid owner authorization is accepted on the copy.
  - a logical copy (pg_dump/restore into a freshly initdb'd cluster) has a different system identifier,
    so the install-row target no longer matches and the authorization is refused.
The original harness cluster is only read (pg_basebackup / pg_dump); nothing is applied on it.
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile


def run(ctx):
    ROOT, sql, check, run, env, sock = ctx['ROOT'], ctx['sql'], ctx['check'], ctx['run'], ctx['env'], ctx['sock']
    sim, keydir = str(ctx['sim']), ctx['keydir']

    target = json.loads(sql("SELECT recovery_v1.authorization_target();", 'cp-target.log').strip())
    active = next(k['keyId'] for k in target['ownerKeys'] if not k['retired'])
    head = sql("SELECT recovery_v1.migration_chain_head();", 'cp-head.log').strip()
    Q = "CREATE INDEX zz_s2_clone_probe ON public.loyalty_points (org_id);"
    payload = {'migration': {'id': 'S2-CLONE-0001', 'sqlSha256': hashlib.sha256(Q.encode()).hexdigest(),
                             'predecessor': head, 'allowedCommands': ['CREATE INDEX'], 'newTables': []}}
    (run / 'cp-t.json').write_text(json.dumps(target))
    (run / 'cp-p.json').write_text(json.dumps(payload))
    auth = json.loads(subprocess.run(['node', sim, 'authorize', str(keydir / f'{active}.private.pem'), active, 'migration',
                                      str(run / 'cp-t.json'), str(run / 'cp-p.json'), '--expires-in', '3600'],
                                     text=True, capture_output=True, check=True).stdout)
    a, s = auth['authorization'], auth['signature']
    nonce = json.loads(a)['nonce']

    started = []

    def pgctl(datadir, action, port=None, socketdir=None):
        argv = ['pg_ctl', '-D', str(datadir), '-l', str(run / f'{datadir.name}.log')]
        if action == 'start':
            argv += ['-o', f"-c listen_addresses='' -c unix_socket_directories='{socketdir}' -c port={port}", '-w', 'start']
        else:
            argv += ['-m', 'fast', '-w', 'stop']
        r = subprocess.run(argv, text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / f'cp-{datadir.name}-{action}.log').write_text(r.stdout)
        return r.returncode == 0

    def q(socketdir, port, text, log):
        r = subprocess.run(['psql', '-X', '-q', '-A', '-t', '-h', str(socketdir), '-p', str(port), '-U', 'postgres',
                            '-d', 'postgres', '-v', 'ON_ERROR_STOP=0'], input=text, text=True, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / f'cp-{log}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    try:
        # ---- physical copy (pg_basebackup): same system identifier + install row -> ACCEPTED ------
        phys = pathlib.Path(tempfile.mkdtemp(prefix='s2m.', dir='/private/tmp'))
        pdata = phys / 'd'
        psock = pathlib.Path(tempfile.mkdtemp(prefix='s2m.', dir='/private/tmp'))
        bb = subprocess.run(['pg_basebackup', '-h', str(sock), '-p', '55491', '-U', 'postgres', '-D', str(pdata),
                             '-X', 'stream', '-c', 'fast'], text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / 'cp-basebackup.log').write_text(bb.stdout)
        if bb.returncode != 0:
            check('c01 (LIMITATION CLONE-1) physical copy accepts the same owner authorization', False, 'pg_basebackup failed: ' + bb.stdout[-160:])
        else:
            pdata.chmod(0o700)
            if pgctl(pdata, 'start', 55601, psock):
                started.append((pdata, '55601'))
                same_sys = q(psock, 55601, "SELECT (SELECT system_identifier::text FROM pg_control_system()) = (SELECT system_identifier FROM recovery_v1.install);", 'phys-sys')[1].strip()
                rc, out = q(psock, 55601, f"SELECT recovery_v1.apply_authorized_migration($a${a}$a$, '{s}', $q${Q}$q$);", 'phys-apply')
                applied = '"applied"' in out
                # the original never saw this nonce (still replayable there): one authorization, two live databases
                unused_on_orig = sql(f"SELECT NOT EXISTS(SELECT 1 FROM recovery_v1.owner_authorizations_used WHERE nonce='{nonce}');", 'cp-orig-nonce.log').strip()
                check('c01 (LIMITATION CLONE-1) a physical copy keeps the system identifier + install row, so the SAME valid '
                      'owner authorization is accepted on it (and remains unused/replayable on the original)',
                      same_sys == 't' and applied and unused_on_orig == 't', f'same_sys={same_sys} applied={applied} unused_on_orig={unused_on_orig}')
            else:
                check('c01 (LIMITATION CLONE-1) physical copy accepts the same owner authorization', False, 'clone would not start')

        # ---- logical copy (pg_dump/restore): different system identifier -> REFUSED ---------------
        dump = run / 'cp-logical.dump'
        pd = subprocess.run(['pg_dump', '-h', str(sock), '-p', '55491', '-U', 'postgres', '-d', 'postgres', '-Fc', '-f', str(dump)],
                            text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / 'cp-pgdump.log').write_text(pd.stdout)
        ldata = pathlib.Path(tempfile.mkdtemp(prefix='s2m.', dir='/private/tmp')) / 'd'
        lsock = pathlib.Path(tempfile.mkdtemp(prefix='s2m.', dir='/private/tmp'))
        subprocess.run(['initdb', '-D', str(ldata), '-U', 'postgres', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject'],
                       text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
        if pgctl(ldata, 'start', 55602, lsock):
            started.append((ldata, '55602'))
            # roles the dump's GRANTs reference (pg_dump does not dump roles) + the auth shim
            q(lsock, 55602, "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE orvix_recovery_operator NOLOGIN; "
              "CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;", 'log-roles')
            subprocess.run(['pg_restore', '-h', str(lsock), '-p', '55602', '-U', 'postgres', '-d', 'postgres', '--no-owner', str(dump)],
                           text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            sysid_differs = q(lsock, 55602, "SELECT (SELECT system_identifier::text FROM pg_control_system()) <> (SELECT system_identifier FROM recovery_v1.install);", 'log-sys')[1].strip()
            rc, out = q(lsock, 55602, f"SELECT recovery_v1.apply_authorized_migration($a${a}$a$, '{s}', $q${Q}$q$);", 'log-apply')
            refused = '"applied"' not in out and ('TARGET' in out or 'MIGRATION_REFUSED' in out or 'TARGET_MISMATCH' in out or rc != 0)
            check('c02 a logical copy (pg_dump/restore) has a different system identifier, so the install-row target no longer '
                  'matches and the same authorization is refused',
                  sysid_differs == 't' and refused, f'sysid_differs={sysid_differs} refused={refused} :: {out[-140:]}')
        else:
            check('c02 logical copy refuses the authorization', False, 'logical cluster would not start')
    finally:
        for datadir, _ in started:
            pgctl(datadir, 'stop')
        # remove the private copy clusters/sockets we created under /private/tmp/s2m.*
        for d in [locals().get('phys'), locals().get('psock'),
                  getattr(locals().get('ldata'), 'parent', None), locals().get('lsock')]:
            if d and pathlib.Path(d).exists() and str(d).startswith('/private/tmp/s2m.'):
                shutil.rmtree(d, ignore_errors=True)
