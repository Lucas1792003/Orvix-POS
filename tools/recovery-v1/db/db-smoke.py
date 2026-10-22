#!/usr/bin/env python3
"""Private disposable PostgreSQL smoke: full scrubbed schema + real 062..085/086.
No external connection arguments, existing databases, Docker, or data snapshots.
Preserves its temporary run directory (including synthetic dump/log evidence).
"""
import argparse, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[3]

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--schema',type=pathlib.Path,default=ROOT/'tools/recovery-v1/db/fixtures/schema-061.scrubbed.sql'); ap.add_argument('--stage',type=int,choices=[85,86],default=85)
    ap.add_argument('--financial',action='store_true',help='Apply existing PFIN-A/B, PCOST-A and PSAFE-A before recovery v1; never held PFIN-C')
    ap.add_argument('--with-087',action='store_true',help='Stage 86 only: install the real 087 BEFORE recovery v1 and test the 087 adapter (adoption, held/open composition, refusals)')
    ap.add_argument('--with-pfin-c',action='store_true',help='With --financial: also apply the HELD PFIN-C refund cap (migrations-provisional/held) before recovery v1')
    ap.add_argument('--m087-runner',choices=['supabase_admin','postgres'],default='supabase_admin',help='With --with-087: the superuser session that runs 087 (the pinned fingerprint must not depend on it)')
    ap.add_argument('--hold-084',action='store_true',help='Leave 084 unapplied, as on the real server (schema 085 with 084 held)')
    ap.add_argument('--script2-pre',action='append',default=[],type=pathlib.Path,help='Script 2: extra .sql/.py test module run after the financial smoke, BEFORE Recovery V1 (repeatable)')
    ap.add_argument('--script2-post',action='append',default=[],type=pathlib.Path,help='Script 2: extra .sql/.py test module run AFTER Recovery V1 and the Step 4 suite (repeatable)')
    ap.add_argument('--phase-d-regression',choices=['guarded','unguarded'],help='Run the single-session phase-d suites t05-t19 with every organization ACTIVE (guarded) or without V1 (unguarded) and stop; compare the two runs')
    args=ap.parse_args()
    if args.with_087 and args.stage!=86: raise SystemExit('--with-087 needs --stage 86')
    if args.with_pfin_c and not args.financial: raise SystemExit('--with-pfin-c needs --financial')
    # Schema only: reject data sections/COPY/INSERT rather than read a data dump.
    schema=args.schema.read_text()
    if re.search(r'(?im)^COPY\s.*FROM stdin|^-- Data for Name:',schema): raise SystemExit('BLOCKED: input must be schema-only, never business data')
    for binary in ['initdb','pg_ctl','psql','pg_dump','pg_restore']:
        if not shutil.which(binary): raise SystemExit('BLOCKED: missing '+binary)
    run=pathlib.Path(tempfile.mkdtemp(prefix='orvix-recovery-v1-db-',dir='/private/tmp')); run.chmod(0o700)
    (run/'OWNED_DISPOSABLE_CLUSTER').write_text('orvix-recovery-v1 local synthetic data only\n')
    data=run/'pgdata'; sock=run/'socket';sock.mkdir(mode=0o700)
    pgpass=run/'empty.pgpass';pgpass.touch(mode=0o600)
    env={k:v for k,v in os.environ.items() if not k.startswith('PG')}; env.update(PGPASSFILE=str(pgpass),PSQLRC='/dev/null')
    dbargs=['-X','-q','-A','-t','-h',str(sock),'-p','55491','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
    def command(argv, log, text=None):
        p=subprocess.run(argv,input=text,text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (run/log).write_text(p.stdout)
        if p.returncode: raise RuntimeError(f'{log}: exit {p.returncode}\n{p.stdout[-5000:]}')
        return p.stdout
    def sql(text, log='query.log'): return command(['psql',*dbargs],log,text)
    def file(path,log,transaction=False): return command(['psql',*dbargs,*(['--single-transaction'] if transaction else []),'-f',str(path)],log)
    started=False
    def script2(paths, phase):
        # Script 2 adversarial modules: .sql files run like the other smokes; a .py module exposes run(ctx)
        import importlib.util
        for p in paths:
            p=p if p.is_absolute() else ROOT/p
            if p.suffix=='.sql':
                file(p,f'script2-{phase}-{p.stem}.log'); continue
            spec=importlib.util.spec_from_file_location('script2_'+p.stem,p); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
            def check(name,ok,detail=''):
                sql("SELECT test.check(%s, %s, %s);" % ("'"+name.replace("'","''")+"'", 'true' if ok else 'false', "'"+str(detail)[-300:].replace("'","''")+"'"),'script2-record.log')
            ctx=dict(ROOT=ROOT,run=run,dbargs=dbargs,env=env,sql=sql,file=file,command=command,sock=sock,data=data,check=check,args=args,phase=phase,
                     sim=ROOT/'tools/recovery-v1/owner/owner-sim.mjs',keydir=run/'owner-keys',
                     # Step 5: genuine owner-signed reopening (after the V1 install only)
                     activate=(lambda org: activate(org)))
            mod.run(ctx)
    verifier=ROOT/'tools/migration-sequence/verify.py'
    def facts_and_plan(label,expect_violation=None,facts_text=None):
        # READ-ONLY facts (the verifier's own query) and the sequence verifier's evaluation of them
        if facts_text is None:
            q=subprocess.run([sys.executable,'-I',str(verifier),'facts-sql'],text=True,stdout=subprocess.PIPE,check=True).stdout
            facts_text=sql("BEGIN READ ONLY;\n"+q+"\nCOMMIT;\n",'facts-'+label+'.log')
        line=next(l for l in facts_text.splitlines() if l.startswith('{') and 'orvix-migration-facts-v1' in l)
        (run/('facts-'+label+'.json')).write_text(line+'\n')
        r=subprocess.run([sys.executable,'-I',str(verifier),'plan','--facts',str(run/('facts-'+label+'.json'))],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (run/('plan-'+label+'.log')).write_text(r.stdout)
        out={'rc':r.returncode,'violations':[l[11:] for l in r.stdout.splitlines() if l.startswith('VIOLATION: ')],'facts':json.loads(line)}
        if expect_violation is None and r.returncode!=0: raise RuntimeError(f'sequence verifier found violations ({label}): {out}')
        if expect_violation is not None and not (r.returncode==1 and any(expect_violation in v for v in out['violations'])): raise RuntimeError(f'sequence verifier missed the forbidden order ({label}): {out}')
        return out
    try:
        command(['initdb','-D',str(data),'-U','postgres','--no-locale','--encoding=UTF8','--auth-local=trust','--auth-host=reject'],'initdb.log')
        command(['pg_ctl','-D',str(data),'-l',str(run/'postgres.log'),'-o',f"-c listen_addresses='' -c unix_socket_directories='{sock}' -c unix_socket_permissions=0700 -c port=55491 -c log_min_messages=log",'-w','start'],'start.log');started=True
        # Platform-only compatibility shims, not business functions or guards.
        sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA vault; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;",'platform.log')
        file(ROOT/'supabase/tests/phase-d/sql/00_prep.sql','prep.log')
        # Homebrew plain PG has no pg_cron/pg_net/vault; none is used by this
        # financial smoke. PG16 lacks PG17 MAINTAIN grant. No business SQL changed.
        adapted=re.sub(r'CREATE EXTENSION IF NOT EXISTS "(?:pg_cron|pg_net|supabase_vault)"[^;]+;','-- unavailable platform extension omitted in private fixture',schema)
        adapted=adapted.replace(',MAINTAIN','').replace('MAINTAIN,','')
        (run/'schema-plain-pg.sql').write_text(adapted)
        file(run/'schema-plain-pg.sql','baseline.log')
        file(ROOT/'supabase/migrations/016_product_images_storage.sql','storage.log')
        for path in sorted((ROOT/'supabase/migrations').glob('*.sql')):
            try:n=int(path.name.split('_')[0])
            except ValueError:continue
            if args.hold_084 and n==84: continue
            if 61<n<=args.stage:file(path,f'migration-{n}.log',transaction=True)
        file(ROOT/'supabase/tests/phase-d/sql/01_test_schema.sql','test-schema.log')
        file(ROOT/'supabase/tests/phase-d/sql/02_seed.sql','seed.log')
        # Step 5: the test-only FIXTURE device signer (tools/recovery-v1/step5/s5lib.py) is created now, before 087 and V1
        # snapshot the public tables; it does nothing until owner-approved fixture devices are enrolled after the V1 install
        sys.path.insert(0,str(ROOT/'tools/recovery-v1/step5')); import s5lib
        s5lib.install_fixture_signer(sql)
        s5=dict(dev=None)
        # Original focused financial tests, before guard installation, establish
        # actual business execution and replay on this full schema.
        file(ROOT/'supabase/tests/phase-d/sql/t02_shift.sql','baseline-shift.log')
        file(ROOT/'supabase/tests/phase-d/sql/t03_sale_idempotency.sql','baseline-sale.log')
        baseline=json.loads(sql("SELECT json_build_object('passed',count(*) FILTER(WHERE ok),'failed',count(*) FILTER(WHERE NOT ok)) FROM test.results;",'baseline-counts.log'))
        if args.financial:
            for name in ['PSAFE-A_no_086_rerun_after_087.sql','PFIN-A_report_indexes.sql','PFIN-B_financial_reports.sql','PCOST-A_cost_privacy.sql',
                         'PFIN-D_payments_cash.sql','PFIN-E_refund_lines.sql']:   # SEQUENCE.json recommended_order
                file(ROOT/'supabase/migrations-provisional'/name,'financial-'+name+'.log',transaction=True)
            file(ROOT/'tools/recovery-v1/db/psafe-regression.sql','psafe-regression.log')
            if args.with_pfin_c:
                file(ROOT/'supabase/migrations-provisional/held/PFIN-C_refund_net_paid_cap.sql','financial-PFIN-C.log',transaction=True)
        if args.phase_d_regression:
            # Normal-operation regression: do the existing business suites still pass with V1 installed
            # and every organization ACTIVE (synthetic superuser fixture), compared with no V1 at all?
            if args.phase_d_regression=='guarded':
                sim=ROOT/'tools/recovery-v1/owner/owner-sim.mjs'; keydir=run/'owner-keys'
                owner_pub=subprocess.run(['node',str(sim),'keygen',str(keydir),'owner-sim-1'],text=True,capture_output=True,check=True).stdout.strip()
                command(['psql',*dbargs,'-v','recovery_v1_install_ack=restrict-every-organization','-v','recovery_v1_owner_public_key='+owner_pub,'-f',str(ROOT/'supabase/migrations-provisional/RECOVERY_V1_guards.sql')],'install-guards.log')
                # Step 5: every organization that exists is reopened through the GENUINE owner-signed protocol and its shops get
                # owner-approved fixture devices (s5lib). Organizations the suites create mid-run start RESTRICTED (incident 1)
                # and stay so: a superuser can no longer pre-seed them ACTIVE (that was the pre-Step-5 fixture; V1 now refuses it).
                s5['dev']=s5lib.DeviceSim(ROOT); owner=s5lib.Owner(sql,sim,keydir,run/'s5')
                for org,shop,user in [('org-test','shop-a','u-cash-a1'),('org-test','shop-b','u-cash-b')]:
                    s5lib.add_fixture_device(sql,owner,s5['dev'],org,shop,user,label='default:'+shop)
                for org in sql("SELECT string_agg(id,' ' ORDER BY id) FROM public.organizations;",'orgs.log').split():
                    s5lib.reopen(sql,owner,org)
            suites=['t05_stock_supplier','t06_po_transfer_records','t07_multi_terminal','t08_consistency_close','t09_org_isolation','t10_review','t11_second_org','t13_new_org_price_levels','t14_upload_security','t15_anon_audit','t16_completion_url','t19_old_client_compat']
            aborted={}
            for t in suites:
                r=subprocess.run(['psql',*dbargs,'-f',str(ROOT/'supabase/tests/phase-d/sql'/(t+'.sql'))],text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
                (run/f'phase-d-{t}.log').write_text(r.stdout)
                if r.returncode: aborted[t]=(r.stdout.strip().splitlines() or [''])[-1][:300]
            c=json.loads(sql("SELECT json_build_object('passed',count(*) FILTER(WHERE ok),'failed',count(*) FILTER(WHERE NOT ok)) FROM test.results;",'phase-d-counts.log'))
            fails=sql("SELECT string_agg(name, E'\\n' ORDER BY name) FROM test.results WHERE NOT ok;",'phase-d-fails.log')
            result={'phase_d_regression':args.phase_d_regression,'stage':args.stage,'financial_provisionals':args.financial,'counts':c,'aborted_suites':aborted,'failed_checks':fails.strip().splitlines(),'run_directory':str(run)}
            (run/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True)
            return
        sql("INSERT INTO public.organizations(id,name) VALUES('org-unrelated','Unrelated synthetic org');",'second-org.log')
        file(ROOT/'tools/recovery-v1/db/cross-org-seed.sql','cross-org-seed.log')
        if args.financial:
            # Step 4 financial completion: business behaviour before any recovery guard
            file(ROOT/'tools/recovery-v1/db/fin-completion-smoke.sql','fin-completion-smoke.log')
        script2(args.script2_pre,'pre')
        guards=ROOT/'supabase/migrations-provisional/RECOVERY_V1_guards.sql'
        adapter={'applicable':args.with_087}
        if args.with_087:
            # Platform role the real image has (superuser there; 087 creates recovery_guard AUTHORIZATION supabase_admin).
            sql("CREATE ROLE supabase_admin SUPERUSER LOGIN;",'m087-role.log')
            # as the real runner does (apply-migrations.sh DB_USER=supabase_admin): one transaction, session user supabase_admin
            i=dbargs.index('-U'); asadmin=dbargs[:i+1]+[args.m087_runner]+dbargs[i+2:]
            command(['psql',*asadmin,'--single-transaction','-f',str(ROOT/'supabase/migrations/087_recovery_hold.sql')],'m087-install.log')
            # The fingerprint of the FRESH 087 (before any tamper probe), from the installer's own expression.
            body=re.search(r"CREATE FUNCTION recovery_v1\.m087_fingerprint\([^)]*\)[^$]*\$\$(.*?)\$\$;",guards.read_text(),re.S).group(1)
            adapter['fresh_087_fingerprint']=sql("SET search_path=pg_catalog,pg_temp;\n"+re.sub(r'\bp_full\b','false',body)+";",'m087-fingerprint.log').strip()
            adapter['pinned_087_fingerprint']=re.search(r"m087_fingerprint\(\) IS DISTINCT FROM '([0-9a-f]{32}|__M087_FINGERPRINT__)'",guards.read_text()).group(1)
            if adapter['fresh_087_fingerprint']!=adapter['pinned_087_fingerprint']: raise RuntimeError(f"fresh 087 fingerprint {adapter['fresh_087_fingerprint']} is not the pinned {adapter['pinned_087_fingerprint']}")
        # P5/H2: the installer must refuse, creating NOTHING, unless the per-invocation psql
        # variable is given: plain psql defaults (autocommit, no ON_ERROR_STOP on the command
        # line), a session-level SET, and a database-level setting must all be refused.
        i=dbargs.index('ON_ERROR_STOP=1'); plain=dbargs[:i-1]+dbargs[i+1:]   # psql defaults: no ON_ERROR_STOP
        assert 'ON_ERROR_STOP=1' not in plain and '-v' not in plain
        nothing="SELECT to_regnamespace('recovery_v1') IS NULL AND to_regrole('orvix_recovery_operator') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'zz_recovery_v1%') AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='zz_recovery_v1_ddl');"
        refusals={}
        for label,extra,pre in [('plain_psql_f',[],None),
                                ('session_level_set',['-c',"SET orvix.recovery_v1_install_ack='restrict-every-organization'"],None),
                                ('database_level_setting',[],"ALTER DATABASE postgres SET orvix.recovery_v1_install_ack='restrict-every-organization';")]:
            if pre: sql(pre,'install-noack-pre-'+label+'.log')
            r=subprocess.run(['psql',*plain,*extra,'-f',str(guards)],text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (run/('install-without-ack-'+label+'.log')).write_text(r.stdout)
            if pre: sql("ALTER DATABASE postgres RESET orvix.recovery_v1_install_ack;",'install-noack-post-'+label+'.log')
            refusals[label]=sql(nothing,'install-without-ack-check-'+label+'.log').strip()=='t'
        # A client that ignores psql meta-commands and runs EACH statement on its OWN connection,
        # with the strongest wrong-place setting (database level): must still create nothing.
        def split_sql(text):
            out,buf,i,tag=[],[],0,None
            while i<len(text):
                if tag:
                    j=text.find(tag,i)
                    if j<0: buf.append(text[i:]); break
                    buf.append(text[i:j+len(tag)]); i=j+len(tag); tag=None; continue
                m=re.match(r'\$[A-Za-z0-9_]*\$',text[i:])
                if m: tag=m.group(0); buf.append(tag); i+=len(tag); continue
                if text.startswith('--',i):
                    j=text.find('\n',i); i=len(text) if j<0 else j; continue
                if text[i]==';': out.append(''.join(buf).strip()); buf=[]; i+=1; continue
                buf.append(text[i]); i+=1
            if ''.join(buf).strip(): out.append(''.join(buf).strip())
            return [x for x in out if x]
        stripped='\n'.join(l for l in guards.read_text().splitlines() if not l.lstrip().startswith('\\'))
        sql("ALTER DATABASE postgres SET orvix.recovery_v1_install_ack='restrict-every-organization';",'install-perconn-pre.log')
        perconn=[]
        for n,stmt in enumerate(split_sql(stripped)):
            r=subprocess.run(['psql',*plain,'-c',stmt],text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            perconn.append(f'--- statement {n} rc={r.returncode}\n{r.stdout[-400:]}')
        (run/'install-without-ack-per_connection.log').write_text('\n'.join(perconn))
        sql("ALTER DATABASE postgres RESET orvix.recovery_v1_install_ack;",'install-perconn-post.log')
        refusals['per_connection_with_database_setting']=sql(nothing,'install-without-ack-check-per_connection.log').strip()=='t'
        (run/'install-without-ack.log').write_text(json.dumps(refusals,indent=2)+'\n')
        install_ack_enforced=all(refusals.values())
        if not install_ack_enforced: raise RuntimeError(f'installer created objects without the acknowledgement: {refusals}')
        if args.with_087:
            # The adapter must refuse (creating NOTHING) an 087 that is not the reviewed one, a drifted 087
            # backstop, and a disabled 087 DDL guard — each with the acknowledgement given.
            def refused_install(label,pre,post,code):
                sql(pre,'adapter-pre-'+label+'.log')
                r=subprocess.run(['psql',*dbargs,'-v','recovery_v1_install_ack=restrict-every-organization','-f',str(guards)],text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
                (run/('adapter-refusal-'+label+'.log')).write_text(r.stdout)
                sql(post,'adapter-post-'+label+'.log')
                return r.returncode!=0 and code in r.stdout and sql(nothing,'adapter-nothing-'+label+'.log').strip()=='t'
            planted=("CREATE FUNCTION public.zz_planted() RETURNS text LANGUAGE plpgsql AS $p$BEGIN RAISE WARNING 'PLANTED_CODE_RAN as %', current_user; RETURN 'open'; END$p$;"
                     "ALTER TABLE recovery.continuity RENAME TO continuity_real;"
                     "CREATE VIEW recovery.continuity AS SELECT one, public.zz_planted() AS state, sysid, timeline, db_oid FROM recovery.continuity_real;")
            unplant="DROP VIEW recovery.continuity; ALTER TABLE recovery.continuity_real RENAME TO continuity; DROP FUNCTION public.zz_planted();"
            adapter['refusals']={
              'view_swapped_into_087_never_runs':refused_install('viewswap',planted,unplant,'RECOVERY_V1_087_NOT_INTACT') and 'PLANTED_CODE_RAN' not in (run/'adapter-refusal-viewswap.log').read_text(),
              'unknown_087_version':refused_install('version',"ALTER FUNCTION recovery.refuse(text) SET work_mem='1MB';","ALTER FUNCTION recovery.refuse(text) RESET work_mem;",'RECOVERY_V1_087_UNKNOWN_VERSION'),
              'drifted_087_backstop':refused_install('drift',"CREATE ROLE zz_drift_probe NOLOGIN; GRANT SELECT ON public.brands TO zz_drift_probe;","REVOKE SELECT ON public.brands FROM zz_drift_probe; DROP ROLE zz_drift_probe;",'RECOVERY_V1_087_DRIFT'),
              'disabled_087_ddl_guard':refused_install('evt',"ALTER EVENT TRIGGER zz_recovery_ddl_guard DISABLE;","ALTER EVENT TRIGGER zz_recovery_ddl_guard ENABLE ALWAYS;",'RECOVERY_V1_087_NOT_INTACT')}
            if not all(adapter['refusals'].values()): raise RuntimeError(f'087 adapter accepted an unsafe 087: {adapter}')
        # Step 4: a SYNTHETIC owner key (run directory only) is enrolled at install; the offline policy stays unapproved
        sim=ROOT/'tools/recovery-v1/owner/owner-sim.mjs'; keydir=run/'owner-keys'
        owner_pub=subprocess.run(['node',str(sim),'keygen',str(keydir),'owner-sim-1'],text=True,capture_output=True,check=True).stdout.strip()
        command(['psql',*dbargs,'-v','recovery_v1_install_ack=restrict-every-organization','-v','recovery_v1_owner_public_key='+owner_pub,'-f',str(guards)],'install-guards.log')
        # Step 5: owner-approved FIXTURE devices for the shops the pre-Step-5 suites sell in (genuine request + owner approval;
        # their keys are held by the s5fx test signer), and the SQL suites' reopening fixture (fixture-activate.psql)
        s5['dev']=s5lib.DeviceSim(ROOT); s5owner=s5lib.Owner(sql,sim,keydir,run/'s5')
        for org,shop,user in [('org-test','shop-a','u-cash-a1'),('org-test','shop-b','u-cash-b'),('org-unrelated','shop-unrel','u-unrel')]:
            s5lib.add_fixture_device(sql,s5owner,s5['dev'],org,shop,user,label='default:'+shop)
        for label in ['dev1','dev2','dev3','dev4','dev5']:   # the offline smoke's separate tills of shop-a (one enrollment each)
            s5lib.add_fixture_device(sql,s5owner,s5['dev'],'org-test','shop-a','u-cash-a1',label=label)
        env.update(S5FX_PSQL=json.dumps(dbargs),S5FX_SIM=str(sim),S5FX_KEYDIR=str(keydir),S5FX_DIR=str(run/'s5'),S5FX_PYTHON=sys.executable,S5FX_ROOT=str(ROOT))
        def activate(org): return s5lib.reopen(sql,s5owner,org)
        if args.with_087:
            # Interrupted / repeated install: a second run is refused and changes nothing.
            r=subprocess.run(['psql',*dbargs,'-v','recovery_v1_install_ack=restrict-every-organization','-f',str(guards)],text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (run/'adapter-second-install.log').write_text(r.stdout)
            adapter['second_install_refused']=r.returncode!=0 and 'RECOVERY_V1_ALREADY_INSTALLED' in r.stdout
        def step4():
            # Step 4 Part B (offline capabilities) and Part C (owner-authorized migrations), on this private cluster only
            sys.path.insert(0,str(ROOT/'tools/recovery-v1/db'))
            from step4_suite import Suite
            st=Suite(ROOT,run,dbargs,env,sql,command,sim,keydir)
            refused=sql("SELECT test.login('a0000000-0000-4000-8000-000000000003'); SET ROLE authenticated; SELECT public.recovery_v1_offline_capability('org-test','shop-a','device-test-0000')->>'reason'; RESET ROLE; SELECT test.logout();",'s4-unapproved.log')
            st.check('k00 without an owner-signed policy (and no test-defaults flag) no offline capability is issued','offline_policy_not_approved' in refused, refused[-200:])
            activate('org-test')   # Step 5: genuine owner-signed reopening (synthetic owner), no superuser edit
            st.offline_policy('owner-sim-1',{'scope':'*','maxLifetimeSeconds':3600,'maxOps':3,'maxAmountMmk':20000,'syncGraceSeconds':86400,
                                              'orgBudgetMmk':1000000,'shopBudgetMmk':500000,'deviceBudgetMmk':100000})
            file(ROOT/'tools/recovery-v1/db/offline-smoke.sql','offline-smoke.log')
            st.migrations('owner-sim-1')
            st.hardening('owner-sim-1')
            st.rotation('owner-sim-1','owner-sim-2')
            (run/'step4-results.json').write_text(json.dumps(st.results,indent=1)+'\n')
            for name,ok,detail in st.results:
                sql("SELECT test.check(%s, %s, %s);" % ("'"+name.replace("'","''")+"'", 'true' if ok else 'false', "'"+detail.replace("'","''")+"'"),'s4-record.log')
            activate('org-test')
        # Dump an independent tiny synthetic DB, not business records, for Part C.
        sql('CREATE DATABASE recovery_backup_fixture;','backup-db.log')
        original=dbargs[dbargs.index('-d')+1];dbargs[dbargs.index('-d')+1]='recovery_backup_fixture'
        sql("CREATE TABLE recovery_fixture(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO recovery_fixture VALUES(1,'synthetic-only');",'backup-seed.log')
        command(['pg_dump','-h',str(sock),'-p','55491','-U','postgres','-d','recovery_backup_fixture','-Fc','-f',str(run/'synthetic.dump')],'dump.log')
        dbargs[dbargs.index('-d')+1]=original
        command(['node',str(ROOT/'tools/recovery-v1/backup-fixture-roundtrip.mjs'),str(run/'synthetic.dump'),str(run/'synthetic.decrypted.dump'),str(run/'simulated-mailbox'),shutil.which('pg_restore')],'encrypted-roundtrip.log')
        sql('CREATE DATABASE recovery_backup_restored;','restore-db.log')
        command(['pg_restore','-h',str(sock),'-p','55491','-U','postgres','-d','recovery_backup_restored','--exit-on-error',str(run/'synthetic.decrypted.dump')],'restore.log')
        dbargs[dbargs.index('-d')+1]='recovery_backup_restored'
        restored=sql("SELECT count(*)=1 AND min(value)='synthetic-only' FROM recovery_fixture;",'restore-check.log').strip()=='t'
        dbargs[dbargs.index('-d')+1]=original
        if args.with_087:
            file(ROOT/'tools/recovery-v1/db/adapter-087-smoke.sql','adapter-087-smoke.log')
            if args.financial:
                # RE-apply only (already installed before V1): proves an idempotent re-run is harmless after V1 adopted 087.
                # A FIRST application after V1 is unsupported (SEQUENCE.json; verify.py plan refuses it).
                for name in ['PFIN-A_report_indexes.sql','PFIN-B_financial_reports.sql']:
                    file(ROOT/'supabase/migrations-provisional'/name,'financial-reapply-'+name+'.log',transaction=True)
                file(ROOT/'tools/recovery-v1/db/financial-smoke.sql','financial-smoke.log')
            file(ROOT/'tools/recovery-v1/db/cross-org-smoke.sql','cross-org-smoke.log')
            if args.financial:file(ROOT/'tools/recovery-v1/db/cross-org-cost-smoke.sql','cross-org-cost-smoke.log')
            # The real 087 rollback (through its own runner gates) is refused while V1 is installed: it drops
            # every zz_recovery_* trigger (V1's included) and restores pre-V1 grants.
            rb=("BEGIN;\nCREATE SCHEMA IF NOT EXISTS supabase_migrations;\nCREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);\n"
                "INSERT INTO supabase_migrations.schema_migrations VALUES('087',ARRAY['sha256:synthetic'],'recovery_hold') ON CONFLICT DO NOTHING;\n"
                "SELECT set_config('orvix.rollback_gate','till-queues-empty-confirmed-by-owner',true), set_config('orvix.runner_txid',txid_current()::text,true);\nSET LOCAL lock_timeout='5s';\n"
                f"\\i {ROOT/'supabase/rollbacks/087_recovery_hold.rollback.sql'}\nCOMMIT;\n")
            r=subprocess.run(['psql',*dbargs],input=rb,text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (run/'adapter-087-rollback.log').write_text(r.stdout)
            adapter['rollback_087_refused']=r.returncode!=0 and ('RECOVERY_V1_087_CHANGE_BLOCKED' in r.stdout or 'RECOVERY_V1_GUARD_CHANGE_BLOCKED' in r.stdout)
            adapter['rollback_left_everything']=sql("SELECT to_regnamespace('recovery') IS NOT NULL AND to_regnamespace('supabase_migrations') IS NULL AND recovery_v1.integrity_problem() IS NULL AND recovery_v1.m087_fingerprint()=(SELECT fingerprint FROM recovery_v1.adapter_087) AND (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'zz\\_recovery\\_v1\\_%' AND tgenabled='A')>=60;",'adapter-087-rollback-check.log').strip()=='t'
            step4()
            script2(args.script2_post,'post')
            file(ROOT/'tools/recovery-v1/db/adapter-087-final.sql','adapter-087-final.log')
            if not (adapter['second_install_refused'] and adapter['rollback_087_refused'] and adapter['rollback_left_everything']): raise RuntimeError(f'087 adapter failure: {adapter}')
        else:
            file(ROOT/'tools/recovery-v1/db/smoke.sql','smoke.log')
            if args.financial:file(ROOT/'tools/recovery-v1/db/financial-smoke.sql','financial-smoke.log')
            file(ROOT/'tools/recovery-v1/db/cross-org-smoke.sql','cross-org-smoke.log')
            if args.financial:file(ROOT/'tools/recovery-v1/db/cross-org-cost-smoke.sql','cross-org-cost-smoke.log')
            file(ROOT/'tools/recovery-v1/db/retention-smoke.sql','retention-smoke.log')
            step4()
            script2(args.script2_post,'post')
        counts=json.loads(sql("SELECT json_build_object('passed',count(*) FILTER(WHERE ok),'failed',count(*) FILTER(WHERE NOT ok)) FROM test.results;",'counts.log'))
        race_ok=None
        if not args.with_087:
          # Independent two-session race: a resend holds the real advisory lock;
          # fencing must wait and preserve its committed completion unchanged.
          actor="SELECT test.login('a0000000-0000-4000-8000-000000000003');"
          key='99999999-0000-4000-8000-000000000099'
          sender=actor+f"BEGIN; SELECT public.idem_begin('{key}','complete_sale',md5('race')); SELECT pg_sleep(1.0); SELECT public.idem_finish('{key}','{{\"synthetic_race\":true}}'); COMMIT;"
          # Stage85 hashes key; stage86 hashes org:key. Wait for pg_locks visibility.
          proc=subprocess.Popen(['psql',*dbargs],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=env)
          proc.stdin.write(sender);proc.stdin.close()
          import time
          for _ in range(100):
              if sql("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted);",'race-wait.log').strip()=='t':break
              time.sleep(.01)
          race=sql(f"SELECT recovery_v1.fence_key(current_database(),(SELECT system_identifier::text FROM pg_control_system()),'org-test','shop-a','{key}','complete_sale','u-cash-a1','race',repeat('a',64),'synthetic-authorization');",'race-fence.log')
          sender_output=proc.stdout.read();rc=proc.wait();(run/'race-sender.log').write_text(sender_output)
          race_ok=rc==0 and 'existing_record_preserved' in race and sql(f"SELECT response='{{\"synthetic_race\":true}}'::jsonb FROM public.idempotency_keys WHERE key='{key}';",'race-check.log').strip()=='t'
        # Re-running source that changes idem stage must fail atomically.
        drift=sql("SELECT test.expect_error('DDL cannot replace pinned idempotency contract', $q$CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid,p_rpc text,p_request_hash text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'$q$, 'RECOVERY_V1_IDEMPOTENCY_STAGE_CHANGE_BLOCKED');",'drift-check.log')
        m087={'applicable':args.stage==86 and not args.with_087}
        if m087['applicable']:
            # The real 087 first DISABLES every event trigger (so the V1 DDL guard cannot stop it).
            # V1 must still make the combination incompatible: either 087 aborts, or afterwards every
            # guarded write is refused and status reports QUARANTINED. Rolled back either way.
            script=("BEGIN;\nCREATE ROLE supabase_admin; -- platform role that real Supabase has and plain PostgreSQL lacks\n"
                    f"\\i {ROOT/'supabase/migrations/087_recovery_hold.sql'}\n"
                    "SELECT 'RV1-087 integrity='||coalesce(recovery_v1.integrity_problem(),'none');\n"
                    "DO $$BEGIN UPDATE public.shops SET address=address WHERE id='shop-a'; RAISE NOTICE 'RV1-087 write=ALLOWED'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RV1-087 write=REFUSED %', SQLERRM; END$$;\n"
                    "SELECT test.login('a0000000-0000-4000-8000-000000000001');\nSET ROLE authenticated;\n"
                    "SELECT 'RV1-087 status='||(public.recovery_v1_status('org-test')->>'state');\nRESET ROLE;\n"
                    +subprocess.run([sys.executable,'-I',str(verifier),'facts-sql'],text=True,stdout=subprocess.PIPE,check=True).stdout+"\nROLLBACK;\n")
            r=subprocess.run(['psql',*dbargs],input=script,text=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (run/'m087-with-v1.log').write_text(r.stdout)
            out=r.stdout
            m087['087_aborted']=r.returncode!=0
            m087['integrity']=re.search(r'RV1-087 integrity=(\S+)',out).group(1) if 'RV1-087 integrity=' in out else None
            m087['guarded_write_refused']='RV1-087 write=REFUSED' in out
            m087['status']=re.search(r'RV1-087 status=(\S+)',out).group(1) if 'RV1-087 status=' in out else None
            m087['incompatible']=m087['087_aborted'] or (m087['guarded_write_refused'] and m087['status']=='QUARANTINED' and m087['integrity'] not in (None,'none'))
            m087['rolled_back']=sql("SELECT to_regnamespace('recovery') IS NULL AND to_regrole('supabase_admin') IS NULL;",'m087-rolled-back.log').strip()=='t'
            if not (m087['incompatible'] and m087['rolled_back']): raise RuntimeError(f'087 ran alongside V1 unrestricted: {m087}')
            m087['sequence_verifier']=facts_and_plan('v1-then-087',expect_violation='applied AFTER V1',facts_text=out)['violations']
        sequence=facts_and_plan('final')
        counts=json.loads(sql("SELECT json_build_object('passed',count(*) FILTER(WHERE ok),'failed',count(*) FILTER(WHERE NOT ok)) FROM test.results;",'final-counts.log'))
        result={'install_without_ack_refused':refusals,'migration_087_with_v1':m087,'adapter_087':adapter,'sequence_final':{'rc':sequence['rc'],'installed':{k:v for k,v in sequence['facts'].items() if v is True}},'hold_084':args.hold_084,'m087_runner':args.m087_runner if args.with_087 else None,'pfin_c':args.with_pfin_c,'stage':args.stage,'financial_provisionals':args.financial,'schema':'actual scrubbed schema-only baseline + actual numbered migrations','schema_sha256':hashlib.sha256(schema.encode()).hexdigest(),'plain_pg_shims':['auth/storage/publication','omit unavailable pg_cron/pg_net/vault extensions','remove PG17 MAINTAIN privilege on PG16'],'baseline':baseline,'total_sql_assertions':counts,'race_completion_preserved':race_ok,'synthetic_authenticated_encrypted_logical_restore':restored,'run_directory':str(run),'dump':str(run/'synthetic.dump'),'production_authorized':False}
        (run/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True)
        if counts['failed'] or race_ok is False or not restored:raise RuntimeError('Smoke assertion failure')
    finally:
        if 's5' in locals() and s5.get('dev'): s5['dev'].close()
        if started and (run/'OWNED_DISPOSABLE_CLUSTER').is_file():
            command(['pg_ctl','-D',str(data),'-m','fast','-w','stop'],'stop.log')
        print('Preserved private disposable evidence at '+str(run),flush=True)
if __name__=='__main__':main()
