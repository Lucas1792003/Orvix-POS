#!/usr/bin/env python3
"""Private disposable PostgreSQL smoke: full scrubbed schema + real 062..085/086.
No external connection arguments, existing databases, Docker, or data snapshots.
Preserves its temporary run directory (including synthetic dump/log evidence).
"""
import argparse, hashlib, json, os, pathlib, re, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[3]

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--schema',type=pathlib.Path,default=ROOT/'tools/recovery-v1/db/fixtures/schema-061.scrubbed.sql'); ap.add_argument('--stage',type=int,choices=[85,86],default=85)
    ap.add_argument('--financial',action='store_true',help='Apply existing PFIN-A/B, PCOST-A and PSAFE-A before recovery v1; never held PFIN-C')
    ap.add_argument('--phase-d-regression',choices=['guarded','unguarded'],help='Run the single-session phase-d suites t05-t19 with every organization ACTIVE (guarded) or without V1 (unguarded) and stop; compare the two runs')
    args=ap.parse_args()
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
            if 61<n<=args.stage:file(path,f'migration-{n}.log',transaction=True)
        file(ROOT/'supabase/tests/phase-d/sql/01_test_schema.sql','test-schema.log')
        file(ROOT/'supabase/tests/phase-d/sql/02_seed.sql','seed.log')
        # Original focused financial tests, before guard installation, establish
        # actual business execution and replay on this full schema.
        file(ROOT/'supabase/tests/phase-d/sql/t02_shift.sql','baseline-shift.log')
        file(ROOT/'supabase/tests/phase-d/sql/t03_sale_idempotency.sql','baseline-sale.log')
        baseline=json.loads(sql("SELECT json_build_object('passed',count(*) FILTER(WHERE ok),'failed',count(*) FILTER(WHERE NOT ok)) FROM test.results;",'baseline-counts.log'))
        if args.financial:
            for name in ['PFIN-A_report_indexes.sql','PFIN-B_financial_reports.sql','PCOST-A_cost_privacy.sql','PSAFE-A_no_086_rerun_after_087.sql']:
                file(ROOT/'supabase/migrations-provisional'/name,'financial-'+name+'.log',transaction=True)
            file(ROOT/'tools/recovery-v1/db/psafe-regression.sql','psafe-regression.log')
        if args.phase_d_regression:
            # Normal-operation regression: do the existing business suites still pass with V1 installed
            # and every organization ACTIVE (synthetic superuser fixture), compared with no V1 at all?
            if args.phase_d_regression=='guarded':
                command(['psql',*dbargs,'-v','recovery_v1_install_ack=restrict-every-organization','-f',str(ROOT/'supabase/migrations-provisional/RECOVERY_V1_guards.sql')],'install-guards.log')
                sql("UPDATE recovery_v1.org_state SET state='ACTIVE';",'force-active.log')
                # Synthetic fixture ONLY: the suites create these organizations mid-run. In V1 a new
                # organization has no recovery state and is refused (onboarding is closed). Pre-seeding
                # ACTIVE states isolates the question 'does V1 break legitimate ACTIVE flows?' and lets
                # the native RLS/business refusals surface for the ones the suites expect refused.
                ids=sorted(set(re.findall(r"'(org-[a-z0-9-]+)'",''.join((ROOT/'supabase/tests/phase-d/sql'/f).read_text() for f in os.listdir(ROOT/'supabase/tests/phase-d/sql') if f.startswith('t')))))
                sql("INSERT INTO recovery_v1.org_state(org_id,state) SELECT unnest(ARRAY["+','.join("'"+i+"'" for i in ids)+"]),'ACTIVE' ON CONFLICT DO NOTHING;",'force-active-new-orgs.log')
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
        guards=ROOT/'supabase/migrations-provisional/RECOVERY_V1_guards.sql'
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
        command(['psql',*dbargs,'-v','recovery_v1_install_ack=restrict-every-organization','-f',str(guards)],'install-guards.log')
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
        file(ROOT/'tools/recovery-v1/db/smoke.sql','smoke.log')
        if args.financial:file(ROOT/'tools/recovery-v1/db/financial-smoke.sql','financial-smoke.log')
        file(ROOT/'tools/recovery-v1/db/cross-org-smoke.sql','cross-org-smoke.log')
        if args.financial:file(ROOT/'tools/recovery-v1/db/cross-org-cost-smoke.sql','cross-org-cost-smoke.log')
        file(ROOT/'tools/recovery-v1/db/retention-smoke.sql','retention-smoke.log')
        counts=json.loads(sql("SELECT json_build_object('passed',count(*) FILTER(WHERE ok),'failed',count(*) FILTER(WHERE NOT ok)) FROM test.results;",'counts.log'))
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
        m087={'applicable':args.stage==86}
        if args.stage==86:
            # The real 087 first DISABLES every event trigger (so the V1 DDL guard cannot stop it).
            # V1 must still make the combination incompatible: either 087 aborts, or afterwards every
            # guarded write is refused and status reports QUARANTINED. Rolled back either way.
            script=("BEGIN;\nCREATE ROLE supabase_admin; -- platform role that real Supabase has and plain PostgreSQL lacks\n"
                    f"\\i {ROOT/'supabase/migrations/087_recovery_hold.sql'}\n"
                    "SELECT 'RV1-087 integrity='||coalesce(recovery_v1.integrity_problem(),'none');\n"
                    "DO $$BEGIN UPDATE public.shops SET address=address WHERE id='shop-a'; RAISE NOTICE 'RV1-087 write=ALLOWED'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RV1-087 write=REFUSED %', SQLERRM; END$$;\n"
                    "SELECT test.login('a0000000-0000-4000-8000-000000000001');\nSET ROLE authenticated;\n"
                    "SELECT 'RV1-087 status='||(public.recovery_v1_status('org-test')->>'state');\nRESET ROLE;\nROLLBACK;\n")
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
        counts=json.loads(sql("SELECT json_build_object('passed',count(*) FILTER(WHERE ok),'failed',count(*) FILTER(WHERE NOT ok)) FROM test.results;",'final-counts.log'))
        result={'install_without_ack_refused':refusals,'migration_087_with_v1':m087,'stage':args.stage,'financial_provisionals':args.financial,'schema':'actual scrubbed schema-only baseline + actual numbered migrations','schema_sha256':hashlib.sha256(schema.encode()).hexdigest(),'plain_pg_shims':['auth/storage/publication','omit unavailable pg_cron/pg_net/vault extensions','remove PG17 MAINTAIN privilege on PG16'],'baseline':baseline,'total_sql_assertions':counts,'race_completion_preserved':race_ok,'synthetic_authenticated_encrypted_logical_restore':restored,'run_directory':str(run),'dump':str(run/'synthetic.dump'),'production_authorized':False}
        (run/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True)
        if counts['failed'] or not race_ok or not restored:raise RuntimeError('Smoke assertion failure')
    finally:
        if started and (run/'OWNED_DISPOSABLE_CLUSTER').is_file():
            command(['pg_ctl','-D',str(data),'-m','fast','-w','stop'],'stop.log')
        print('Preserved private disposable evidence at '+str(run),flush=True)
if __name__=='__main__':main()
