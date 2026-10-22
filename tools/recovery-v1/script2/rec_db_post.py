"""Script 2 / RECOVERY tester (post-V1 phase, after the Step 4 suite). Run as:
  python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial \
     --script2-pre tools/recovery-v1/script2/rec_db_pre.py --script2-post tools/recovery-v1/script2/rec_db_post.py
Private disposable harness cluster ONLY (its own socket/port). Synthetic data and synthetic owner keys only.

Covers: r01/r02 process termination mid financial transaction; r21-r24 restore of a snapshot taken BEFORE a committed sale
(physical copy and logical dump); r30-r39 authorization / owner-key / reopening attempts; r40-r46 restricted and quarantined
financial refusals; r50-r56 evidence store gaps, forks, replays, immutability; r57 nothing invented; r61 prune/purge under V1.

Honesty rules: a superuser UPDATE of recovery_v1.org_state is used ONLY to restore the harness's ACTIVE fixture at the very
end (the harness's own race test needs it). It is labelled a fixture and is never counted as a recovery. Owner-authorized
reopening is not implemented in V1; tests for it are BLOCKED.
"""
import json, os, re, signal, subprocess, time, uuid

ADMIN, MGR_A, CASH_A1 = 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003'
UNREL_CASH, UNREL_MGR, UNREL_ADMIN = 'a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-0000000000f3'
SALE_ARGS = "'shop-a',test.var('shift_a1'),'CASH',1000,0,'[{\"product_id\":\"prod-1\",\"qty\":1}]'::jsonb,NULL"
FIN_TABLES = ['sales', 'sale_items', 'sale_payments', 'cash_movements', 'refund_void_requests', 'refund_lines', 'refund_payouts',
              'inventory', 'inventory_movements', 'shifts', 'supplier_payments', 'purchase_orders']


class Ctx:
    def __init__(self, ctx):
        self.c = ctx; self.run = ctx['run']; self.results = []

    def psql(self, text, label, db='postgres', check=False):
        args = list(self.c['dbargs']); args[args.index('-d') + 1] = db
        p = subprocess.run(['psql', *args], input=text, text=True, env=self.c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (self.run / f'rec-{label}.log').write_text(p.stdout)
        if check and p.returncode: raise RuntimeError(f'{label}: {p.stdout[-800:]}')
        return p.returncode, p.stdout

    def record(self, rid, scenario, expected, actual, status):
        self.results.append({'id': rid, 'scenario': scenario, 'expected': expected, 'actual': actual, 'status': status})
        (self.run / 'rec-post-results.json').write_text(json.dumps(self.results, indent=1) + '\n')
        if status in ('PASS', 'FAIL'):
            self.c['check'](f'{rid} {scenario}', status == 'PASS', actual)


def val(out, tag='R'):
    m = re.findall(rf'^{tag}=(.*)$', out, re.M)
    return m[-1] if m else None


def err(out):
    m = re.findall(r'ERROR:\s+(.*)', out)
    return m[-1][:160] if m else None


def as_user(auth, body):
    return f"SELECT test.login('{auth}');\nSET ROLE authenticated;\n\\set ON_ERROR_STOP off\n{body}\n\\set ON_ERROR_STOP on\nRESET ROLE;\nSELECT test.logout();\n"


def fin_digest(x, db='postgres', label='digest'):
    q = ' UNION ALL '.join(f"SELECT '{t}' t, (SELECT count(*) FROM public.{t})::text||':'||coalesce((SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY to_jsonb(r)::text)) FROM public.{t} r),'-') d"
                           for t in FIN_TABLES)
    _, out = x.psql(f"SELECT 'R='||json_object_agg(t,d)::text FROM ({q}) z;", label, db)
    return json.loads(val(out))


def ledger_row(x, key, db='postgres'):
    _, out = x.psql(f"SELECT 'R='||coalesce((SELECT to_jsonb(k)-'created_at' FROM public.idempotency_keys k WHERE key='{key}')::text,'null');", 'ledger-' + key[:8], db)
    return json.loads(val(out))


def count_sales(x, db='postgres'):
    _, out = x.psql("SELECT 'R='||count(*) FROM public.sales;", 'count-sales', db)
    return int(val(out))


# ------------------------------------------------------------------------------------------------ cluster control
def pg_restart(x):
    c = x.c
    opts = f"-c listen_addresses='' -c unix_socket_directories='{c['sock']}' -c unix_socket_permissions=0700 -c port=55491 -c log_min_messages=log"
    p = subprocess.run(['pg_ctl', '-D', str(c['data']), '-l', str(c['run'] / 'postgres.log'), '-o', opts, '-w', 'start'],
                       text=True, env=c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (x.run / 'rec-r01-restart.log').write_text(p.stdout)
    return p.returncode == 0


def alive(pid):
    try: os.kill(pid, 0); return True
    except OSError: return False


def wait_for(x, query, label, tries=200):
    for _ in range(tries):
        _, out = x.psql(query, label)
        if val(out) not in (None, '', 'null'): return val(out)
        time.sleep(0.05)
    return None


# ------------------------------------------------------------------------------------------------ r01 / r02
def r01_kill_postmaster(x):
    key = str(uuid.uuid4())
    before = count_sales(x)
    script = as_user(CASH_A1, f"BEGIN;\nSELECT public.complete_sale({SALE_ARGS},'{key}');\nSELECT pg_sleep(120);\nCOMMIT;")
    sess = subprocess.Popen(['psql', *x.c['dbargs']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=x.c['env'])
    sess.stdin.write(script); sess.stdin.close()
    bpid = wait_for(x, "SELECT 'R='||coalesce((SELECT pid FROM pg_stat_activity WHERE query LIKE '%pg_sleep(120)%' AND state='active' AND pid<>pg_backend_pid())::text,'');", 'r01-wait')
    held = wait_for(x, f"SELECT 'R='||coalesce((SELECT string_agg(locktype,',') FROM pg_locks WHERE pid={bpid or 0} AND locktype IN('advisory','transactionid'))::text,'');", 'r01-locks') if bpid else None
    _, out = x.psql("SELECT 'R='||string_agg(pid::text,',') FROM pg_stat_activity WHERE pid<>pg_backend_pid();", 'r01-pids')
    children = [int(p) for p in (val(out) or '').split(',') if p]
    pm = int((x.c['data'] / 'postmaster.pid').read_text().splitlines()[0])
    os.kill(pm, signal.SIGKILL)
    forced = []
    for _ in range(300):
        if not any(alive(p) for p in children + [pm]): break
        time.sleep(0.05)
    for p in children:
        if alive(p): os.kill(p, signal.SIGKILL); forced.append(p)
    for _ in range(100):
        if not any(alive(p) for p in children + [pm]): break
        time.sleep(0.05)
    sess_out = sess.stdout.read(); sess.wait(); (x.run / 'rec-r01-session.log').write_text(sess_out)
    restarted = pg_restart(x)
    log = (x.c['run'] / 'postgres.log').read_text()
    crash_recovery = 'was interrupted' in log or 'not properly shut down' in log
    row = ledger_row(x, key); after_crash = count_sales(x)
    _, o1 = x.psql(as_user(CASH_A1, f"SELECT 'R='||public.complete_sale({SALE_ARGS},'{key}')::text;"), 'r01-retry1')
    _, o2 = x.psql(as_user(CASH_A1, f"SELECT 'R='||public.complete_sale({SALE_ARGS},'{key}')::text;"), 'r01-retry2')
    after_retry = count_sales(x); row2 = ledger_row(x, key)
    ok = (bpid and held and restarted and row is None and after_crash == before and val(o1) and val(o1) == val(o2)
          and after_retry == before + 1 and row2 and row2.get('response') is not None)
    x.record('r01', 'kill -9 of the postmaster while a complete_sale transaction is open; restart; retry the same key',
             'crash recovery; no partial sale/ledger row; first retry executes once; second retry replays the same reply',
             f"backend={bpid} locks_held={held} postmaster_killed={pm} children_force_killed={forced} restarted={restarted} crash_recovery_logged={crash_recovery} "
             f"ledger_after_crash={row} sales_delta_after_crash={after_crash-before} retry_equal={val(o1)==val(o2)} sales_delta_after_2_retries={after_retry-before} "
             f"ledger_after_retry_committed={bool(row2 and row2.get('response') is not None)}", 'PASS' if ok else 'FAIL')
    return restarted


def r02_terminate_approval(x):
    sale_key, req_key, appr_key = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    _, out = x.psql(as_user(CASH_A1, f"SELECT public.complete_sale({SALE_ARGS},'{sale_key}') AS s \\gset\n"
                    f"SELECT 'R='||(public.create_refund_void_request(:'s'::jsonb->'sale'->>'id','PARTIAL','rec r02',"
                    f"'[{{\"productId\":\"prod-1\",\"qtyUnits\":1,\"amountMmk\":1000}}]'::jsonb,NULL,NULL,'{req_key}')->'request'->>'id');"), 'r02-setup')
    req = val(out)
    snap = fin_digest(x, label='r02-before')
    script = as_user(MGR_A, f"BEGIN;\nSELECT public.approve_refund_request('{req}','{appr_key}');\nSELECT pg_sleep(121);\nCOMMIT;")
    sess = subprocess.Popen(['psql', *x.c['dbargs']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=x.c['env'])
    sess.stdin.write(script); sess.stdin.close()
    bpid = wait_for(x, "SELECT 'R='||coalesce((SELECT pid FROM pg_stat_activity WHERE query LIKE '%pg_sleep(121)%' AND state='active' AND pid<>pg_backend_pid())::text,'');", 'r02-wait')
    _, t = x.psql(f"SELECT 'R='||pg_terminate_backend({bpid or 0});", 'r02-terminate')
    sess_out = sess.stdout.read(); sess.wait(); (x.run / 'rec-r02-session.log').write_text(sess_out)
    after = fin_digest(x, label='r02-after'); row = ledger_row(x, appr_key)
    _, st = x.psql(f"SELECT 'R='||(SELECT status FROM public.refund_void_requests WHERE id='{req}');", 'r02-status')
    _, o1 = x.psql(as_user(MGR_A, f"SELECT 'R='||public.approve_refund_request('{req}','{appr_key}')::text;"), 'r02-retry1')
    mid = fin_digest(x, label='r02-mid')
    _, o2 = x.psql(as_user(MGR_A, f"SELECT 'R='||public.approve_refund_request('{req}','{appr_key}')::text;"), 'r02-retry2')
    end = fin_digest(x, label='r02-end')
    ok = (req and bpid and val(t) == 'true' and after == snap and row is None and val(o1) and val(o1) == val(o2) and mid == end and mid != snap)
    x.record('r02', 'pg_terminate_backend of a session holding an open approve_refund_request transaction; retry the same key',
             'nothing of the approval survives; request still pending; retry approves once; second retry replays',
             f"request={req} terminated={val(t)} financial_tables_unchanged={after==snap} ledger_after_kill={row} status_after_kill={val(st)} "
             f"retry1_ok={bool(val(o1))} retry_equal={val(o1)==val(o2)} second_retry_changed_nothing={mid==end}", 'PASS' if ok else 'FAIL')


# ------------------------------------------------------------------------------------------------ r21-r24 restore
def r2x_restore(x):
    sock = str(x.c['sock'])
    t1 = list(x.c['dbargs']); t1[t1.index('-d') + 1] = 'template1'
    def admin(sqltext, label):
        p = subprocess.run(['psql', *t1], input=sqltext, text=True, env=x.c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (x.run / f'rec-{label}.log').write_text(p.stdout); return p.returncode, p.stdout
    # snapshot taken BEFORE the sale (file-level copy of the database: same catalog OIDs / row versions as a physical restore)
    rc, out = admin("DROP DATABASE IF EXISTS rec_snap; CREATE DATABASE rec_snap TEMPLATE postgres;", 'r21-snapshot')
    dump = x.run / 'rec-before-sale.dump'
    pd = subprocess.run(['pg_dump', '-h', sock, '-p', '55491', '-U', 'postgres', '-d', 'postgres', '-Fc', '-f', str(dump)], text=True, env=x.c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (x.run / 'rec-r24-dump.log').write_text(pd.stdout)
    key = str(uuid.uuid4())
    _, o = x.psql(as_user(CASH_A1, f"SELECT 'R='||public.complete_sale({SALE_ARGS},'{key}')::text;"), 'r21-original-sale')
    original = json.loads(val(o)) if val(o) else None
    # the "restored" database: the pre-sale snapshot
    st_before = count_sales(x, 'rec_snap')
    _, s = x.psql(as_user(ADMIN, "SELECT 'R='||(public.recovery_v1_status('org-test')->>'state');"), 'r22-status', 'rec_snap')
    _, ip = x.psql("SELECT 'R='||coalesce(recovery_v1.integrity_problem(),'none');", 'r22-integrity', 'rec_snap')
    _, o2 = x.psql(as_user(CASH_A1, f"SELECT 'R='||public.complete_sale({SALE_ARGS},'{key}')::text;"), 'r21-resend-on-restored', 'rec_snap')
    resent = json.loads(val(o2)) if val(o2) else None
    st_after = count_sales(x, 'rec_snap')
    executed_again = bool(original and resent and resent.get('sale', {}).get('id') != original.get('sale', {}).get('id') and st_after == st_before + 1)
    # Script 2 fix r22: the copy is not the installed database -> quarantined -> the resend can never run again
    x.record('r21', 'restore a snapshot taken BEFORE a committed sale (into another database), resend the same idempotency key',
             'refused: the copy is quarantined (database identity differs), so the lost ledger row cannot cause a second execution',
             f"original_sale={original and original.get('sale',{}).get('id')} resent_reply={str(val(o2))[:120]} restored_sales_delta={st_after-st_before}",
             'PASS' if not executed_again and st_after == st_before else 'FAIL')
    x.record('r22', 'restored copy (database name/oid differ from recovery_v1.install) is restricted before any write',
             'V1 notices the restore (identity differs from its install record) and refuses writes until owner authorization',
             f"status_on_restored={val(s)} integrity_problem={val(ip)} resend_executed={executed_again}",
             'FAIL' if val(s) == 'ACTIVE' else 'PASS')
    opfence = (f"SET ROLE orvix_recovery_operator;\n\\set ON_ERROR_STOP off\nSELECT 'R='||recovery_v1.fence_key(current_database(),(SELECT system_identifier::text FROM pg_control_system()),"
               f"'org-test','shop-a','{key}','complete_sale','u-cash-a1','rec-r23-incident',repeat('a',64),'synthetic-authorization')::text;\n\\set ON_ERROR_STOP on\nRESET ROLE;")
    _, f1 = x.psql(opfence, 'r23-fence-restored', 'rec_snap')
    _, f2 = x.psql(opfence, 'r23-fence-original', 'postgres')
    x.record('r23', 'operator fences the uncertain key with the V1 tool (dr-fence-keys) on the restored copy and on the original',
             'fence refused on a copy with another identity (RECOVERY_V1_TARGET_MISMATCH); on the original the completed row is preserved, never overwritten',
             f"restored_copy={err(f1) or val(f1)} original={val(f2) or err(f2)}",
             'PASS' if ('TARGET_MISMATCH' in (err(f1) or '') and 'existing_record_preserved' in (val(f2) or '')) else 'FAIL')
    # r24 logical restore of the pre-sale dump into a new database
    rc, out = admin("DROP DATABASE IF EXISTS rec_logical; CREATE DATABASE rec_logical;", 'r24-createdb')
    pr = subprocess.run(['pg_restore', '-h', sock, '-p', '55491', '-U', 'postgres', '-d', 'rec_logical', str(dump)], text=True, env=x.c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (x.run / 'rec-r24-restore.log').write_text(pr.stdout)
    _, ip2 = x.psql("SELECT 'R='||coalesce(recovery_v1.integrity_problem(),'none');", 'r24-integrity', 'rec_logical')
    _, s2 = x.psql(as_user(ADMIN, "SELECT 'R='||(public.recovery_v1_status('org-test')->>'state');"), 'r24-status', 'rec_logical')
    _, w2 = x.psql(as_user(CASH_A1, f"SELECT 'R='||public.complete_sale({SALE_ARGS},'{key}')::text;"), 'r24-resend', 'rec_logical')
    _, su = x.psql("\\set ON_ERROR_STOP off\nUPDATE public.shops SET address=address WHERE id='shop-a';\nSELECT 'R=done';", 'r24-superuser-write', 'rec_logical')
    errors = len(re.findall(r'error:', pr.stdout, re.I))
    x.record('r24', 'logical pg_dump/pg_restore of the pre-sale database into a new database (incomplete/unsupported restore)',
             'restored V1 fails closed (QUARANTINED), resend refused',
             f"pg_restore_rc={pr.returncode} pg_restore_error_lines={errors} integrity_problem={val(ip2)} status={val(s2)} resend={'refused: '+str(err(w2)) if not val(w2) else 'EXECUTED'} superuser_write={err(su) or 'allowed'}",
             'PASS' if (val(s2) == 'QUARANTINED' and not val(w2)) else 'FAIL')
    x.record('r24b', 'repair path for a fail-closed restored V1 database',
             'an owner-authorized repair/re-pin exists', 'none: install row/pins are immutable, no re-pin function; the restored DB stays QUARANTINED forever (outage), only a superuser drop/reinstall helps',
             'LIMITATION')
    admin("DROP DATABASE IF EXISTS rec_snap; DROP DATABASE IF EXISTS rec_logical;", 'r2x-drop')


# ------------------------------------------------------------------------------------------------ r30-r39 authorization
def r3x_authorization(x):
    def tr(auth, org, state, label):
        _, out = x.psql(as_user(auth, f"SELECT 'R='||public.recovery_v1_transition('{org}','{state}','rec probe','rec-evidence-ref')::text;"), label)
        return val(out) or ('ERROR ' + str(err(out)))
    def state(org='org-test'):
        _, out = x.psql(f"SELECT 'R='||(SELECT state FROM recovery_v1.org_state WHERE org_id='{org}');", 'state'); return val(out)
    s0 = state()
    rows = {
        'cashier->ACTIVE': tr(CASH_A1, 'org-test', 'ACTIVE', 'r30-cashier-active'),
        'cashier->RESTRICTED': tr(CASH_A1, 'org-test', 'RESTRICTED', 'r30-cashier-restricted'),
        'manager->RESTRICTED': tr(MGR_A, 'org-test', 'RESTRICTED', 'r30-manager'),
        'other-org ADMIN->org-test RESTRICTED': tr(UNREL_ADMIN, 'org-test', 'RESTRICTED', 'r31-unrel-admin'),
        'other-org ADMIN->org-test ACTIVE': tr(UNREL_ADMIN, 'org-test', 'ACTIVE', 'r31-unrel-admin-active'),
        'other-org manager->org-test QUARANTINED': tr(UNREL_MGR, 'org-test', 'QUARANTINED', 'r31-unrel-mgr'),
    }
    denied = all('"denied"' in v for v in rows.values())
    x.record('r30', 'unauthorized transitions by non-ADMIN roles and by other organizations', 'every attempt denied; state unchanged',
             json.dumps(rows)[:600] + f' state_before={s0} state_after={state()}', 'PASS' if denied and state() == s0 else 'FAIL')
    _, out = x.psql("\\set ON_ERROR_STOP off\nSET ROLE orvix_recovery_operator;\nSELECT recovery_v1.transition('org-test','RESTRICTED','x','y');\nSELECT public.recovery_v1_transition('org-test','RESTRICTED','x','y');\n"
                    "UPDATE recovery_v1.org_state SET state='ACTIVE';\nRESET ROLE;\nSET ROLE service_role;\nSELECT public.recovery_v1_transition('org-test','ACTIVE','x','y');\nUPDATE recovery_v1.org_state SET state='ACTIVE';\nRESET ROLE;\n"
                    "SET ROLE anon;\nSELECT public.recovery_v1_status('org-test');\nRESET ROLE;", 'r32-operator-service-anon')
    n = len(re.findall(r'permission denied', out))
    x.record('r32', 'orvix_recovery_operator / service_role / anon try to transition or edit org_state', 'all permission denied (6 attempts)',
             f'permission_denied={n}/6', 'PASS' if n == 6 else 'FAIL')
    # ADMIN of the organization: ACTIVE is never reachable
    a = tr(ADMIN, 'org-test', 'ACTIVE', 'r33-admin-active')
    x.record('r33', 'authenticated ADMIN of the organization requests ACTIVE (reopen)', 'denied, reopen_authorized=false', a,
             'PASS' if '"denied"' in a and re.search(r'"reopen_authorized":\s*false', a) else 'FAIL')
    r = tr(ADMIN, 'org-test', 'RESTRICTED', 'r34-admin-restrict')
    s_r = state()
    q1 = tr(ADMIN, 'org-test', 'QUARANTINED', 'r34-admin-quarantine'); q2 = tr(ADMIN, 'org-test', 'RESTRICTED', 'r34-admin-unquarantine')
    x.record('r34', 'ADMIN containment transitions (ACTIVE->RESTRICTED->QUARANTINED->RESTRICTED)', 'containment allowed; never ACTIVE',
             f'restrict={r[:80]} state={s_r} quarantine={q1[:60]} back_to_restricted={q2[:60]} final={state()}',
             'PASS' if s_r == 'RESTRICTED' and state() == 'RESTRICTED' else 'FAIL')
    x.record('r34b', 'QUARANTINED is not sticky: the same org ADMIN can move QUARANTINED back to RESTRICTED/RECONCILING',
             'quarantine released only by independent authority', f"admin QUARANTINED->RESTRICTED outcome={q2[:60]} (no write is enabled either way)", 'LIMITATION')
    # owner key / owner authorization
    keydir = x.c['keydir']; sim = x.c['sim']
    _, tgt = x.psql("SELECT 'R='||recovery_v1.authorization_target()::text;", 'r35-target'); target = json.loads(val(tgt))
    live = [k['keyId'] for k in target['ownerKeys'] if not k['retired']]
    retired = [k['keyId'] for k in target['ownerKeys'] if k['retired']]
    (x.run / 'rec-target.json').write_text(json.dumps(target)); (x.run / 'rec-payload.json').write_text(json.dumps({'orgId': 'org-test', 'state': 'ACTIVE'}))
    def authorize(kid, purpose):
        p = subprocess.run(['node', str(sim), 'authorize', str(keydir / f'{kid}.private.pem'), kid, purpose, str(x.run / 'rec-target.json'), str(x.run / 'rec-payload.json')],
                           text=True, capture_output=True, check=True)
        a = json.loads(p.stdout); return a['authorization'], a['signature']
    kid = live[0]
    auth, sig = authorize(kid, 'reopen')
    args = ['psql', *x.c['dbargs'], '-v', f'a={auth}', '-v', f's={sig}']
    p = subprocess.run(args, input="\\set ON_ERROR_STOP off\nSELECT 'R='||(recovery_v1.owner_authorization(:'a',:'s','reopen')->>'purpose');\nSELECT 'S='||(SELECT state FROM recovery_v1.org_state WHERE org_id='org-test');\n"
                       "SELECT 'P='||coalesce((SELECT string_agg(DISTINCT p.proname, ',') FROM pg_proc p WHERE p.pronamespace='recovery_v1'::regnamespace AND p.prosrc ~* '''(reopen|release)'''),'none');\n"
                       "SELECT 'C='||string_agg(pg_get_constraintdef(oid),' ') FROM pg_constraint WHERE conrelid='recovery_v1.authorized_txn'::regclass AND contype='c';",
                       text=True, env=x.c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (x.run / 'rec-r35-owner-reopen.log').write_text(p.stdout); o = p.stdout
    x.record('r35', 'owner-authorized reopening with a VALID synthetic owner signature (purpose reopen)',
             'BLOCKED: no reopen/release consumer exists in V1', f"owner_authorization verified purpose={val(o)} (generic verifier accepts ANY purpose string and burns the nonce) ; "
             f"org_state after={val(o,'S')} ; functions consuming reopen/release={val(o,'P')} ; authorized_txn purposes={val(o,'C')}", 'BLOCKED')
    if val(o, 'S') == 'ACTIVE': x.record('r35x', 'owner signature alone changed org state', 'never', 'ACTIVE', 'FAIL')
    # invalid signature / unknown key / retired key / non-superuser
    bad = sig[:-4] + ('0000' if not sig.endswith('0000') else '1111')
    def call(fn, a, s, purpose_arg=None, role=None):
        body = (f"SET ROLE {role};\n" if role else '') + f"\\set ON_ERROR_STOP off\nSELECT 'R='||{fn}::text;\n" + ("RESET ROLE;\n" if role else '')
        q = subprocess.run(['psql', *x.c['dbargs'], '-v', f'a={a}', '-v', f's={s}'], input=body, text=True, env=x.c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return val(q.stdout) or err(q.stdout)
    a2, s2 = authorize(kid, 'offline-policy')
    inv = call("recovery_v1.set_offline_policy(:'a',:'s')", a2, bad)
    unknown_auth = json.loads(a2); unknown_auth['keyId'] = 'never-enrolled-key'
    unk = call("recovery_v1.set_offline_policy(:'a',:'s')", json.dumps(unknown_auth), s2)
    ret = 'n/a'
    if retired:
        a3, s3 = authorize(retired[0], 'offline-policy'); ret = call("recovery_v1.set_offline_policy(:'a',:'s')", a3, s3)
    nonsu = call("recovery_v1.set_offline_policy(:'a',:'s')", a2, s2, role='authenticated')
    ok = 'signature does not verify' in str(inv) and 'unknown owner key' in str(unk) and ('retired' in str(ret) or ret == 'n/a') and 'permission denied' in str(nonsu)
    x.record('r36', 'invalid owner signature / never-enrolled key (owner-key absence path) / retired key / non-superuser caller',
             'all refused', f'bad_sig={inv} unknown_key={unk} retired_key={ret} authenticated={nonsu}', 'PASS' if ok else 'FAIL')
    x.record('r36b', 'install without an owner key: no owner authorization possible', 'every owner_authorization refused (no row in owner_keys)',
             'not re-installed here (install is one-shot per cluster); same code path as unknown key (owner_keys lookup by keyId -> NULL -> refused), see r36', 'LIMITATION')
    # an owner-authorized MIGRATION that tries to reopen
    mig = "UPDATE recovery_v1.org_state SET state = 'ACTIVE' WHERE org_id = 'org-test';"
    import hashlib
    (x.run / 'rec-payload.json').write_text(json.dumps({'migration': {'id': 'rec-reopen-attempt', 'sqlSha256': hashlib.sha256(mig.encode()).hexdigest(),
                                                                    'predecessor': target['migrationChainHead'], 'allowedCommands': [], 'newTables': []}}))
    a4, s4 = authorize(kid, 'migration')
    q = subprocess.run(['psql', *x.c['dbargs'], '-v', f'a={a4}', '-v', f's={s4}', '-v', f'q={mig}'],
                       input="\\set ON_ERROR_STOP off\nSELECT recovery_v1.apply_authorized_migration(:'a',:'s',:'q');\nSELECT 'S='||(SELECT state FROM recovery_v1.org_state WHERE org_id='org-test');",
                       text=True, env=x.c['env'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (x.run / 'rec-r37-migration-reopen.log').write_text(q.stdout)
    x.record('r37', 'owner-SIGNED migration whose SQL reopens the organization', 'refused (an authorized migration only adds); state unchanged',
             # Step 5: refused by the migration scope check or, first, by the ACTIVE gate on org_state itself
             f"{err(q.stdout)} state={val(q.stdout,'S')}", 'PASS' if ('MIGRATION_SCOPE' in q.stdout or 'REOPEN_AUTHORIZATION_REQUIRED' in q.stdout) and val(q.stdout, 'S') == 'RESTRICTED' else 'FAIL')
    # Step 5: owner-authorized reopening is IMPLEMENTED (recovery_v1.reopen_apply behind the org_state ACTIVE gate); the
    # containment paths still never set ACTIVE. Its behaviour is tested by tools/recovery-v1/step5/s5_suite.py (R01-R18).
    _, o = x.psql("SELECT 'R='||(to_regprocedure('recovery_v1.reopen_apply(text,text,text)') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='recovery_v1_org_state_guard' AND tgenabled='A'))::text;", 'r38-reopen-path')
    x.record('r38', 'implementation status of owner-authorized reopening (Step 5)', 'implemented behind the ACTIVE gate; containment never sets ACTIVE',
             f"reopen_apply + org_state guard present: {val(o)}", 'PASS' if val(o) == 'true' else 'FAIL')


# ------------------------------------------------------------------------------------------------ r40-r46 refusals
def refusals(x, state_name, rid):
    snap = fin_digest(x, label=f'{rid}-before')
    k = [str(uuid.uuid4()) for _ in range(6)]
    tests = {
        'complete_sale': (CASH_A1, f"SELECT 'R='||public.complete_sale({SALE_ARGS},'{k[0]}')::text;"),
        'fin_complete_sale_split': (CASH_A1, f"SELECT 'R='||public.fin_complete_sale_split('direct','{k[1]}',jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a1'),'p_payment_method','CASH','p_paid_mmk',1000,'p_cart_discount_pct',0,'p_items','[{{\"product_id\":\"prod-1\",\"qty\":1}}]'::jsonb),'[{{\"method\":\"CASH\",\"amountMmk\":1000}}]')::text;"),
        'fin_record_cash_movement': (MGR_A, f"SELECT 'R='||public.fin_record_cash_movement(test.var('shift_a1'),'PAY_IN',100,'rec probe float',NULL,NULL,'{k[2]}')::text;"),
        'approve_refund_request': (MGR_A, f"SELECT 'R='||public.approve_refund_request('{x.pending}','{k[3]}')::text;"),
        'offline_capability': (CASH_A1, "SELECT 'R='||public.recovery_v1_offline_capability('org-test','shop-a','rec-device-0001')::text;"),
        'offline_sync_sale': (CASH_A1, f"SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', gen_random_uuid(), 'deviceSeq', 1)::text)::text, false);\n"
                                       f"SELECT 'R='||public.complete_sale({SALE_ARGS},'{k[4]}')::text;\nSELECT set_config('request.headers','',false);"),
    }
    res = {}
    for name, (who, body) in tests.items():
        _, out = x.psql(as_user(who, body), f'{rid}-{name}')
        v = val(out)
        res[name] = ('REFUSED ' + (err(out) or '')[:70]) if not v else (v[:90] if '"refused"' in v else 'EXECUTED ' + v[:60])
    after = fin_digest(x, label=f'{rid}-after')
    _, lk = x.psql(f"SELECT 'R='||count(*) FROM public.idempotency_keys WHERE key IN ({','.join(repr(z) for z in k)});", f'{rid}-ledger')
    ok = all(('ORG_SUSPENDED' in v) if v.startswith('REFUSED') else ('organization_not_active' in v) for v in res.values()) and after == snap and val(lk) == '0'
    x.record(rid, f'{state_name}: sale, split sale, cash movement, refund approval, offline capability, offline sync refused',
             'every financial write refused; no financial row and no ledger row created', json.dumps(res)[:700] + f' unchanged={after==snap} ledger_rows={val(lk)}',
             'PASS' if ok else 'FAIL')


# ------------------------------------------------------------------------------------------------ r50-r56 evidence store
def r5x_evidence(x):
    env = lambda dev, seq, h, org='org-test', op=None: ("jsonb_build_object('body',jsonb_build_object('protocol','orvix-device-evidence-v1','orgId','%s','shopId','shop-a','deviceId','%s','keyId','rec-key','operationId','%s','rpc','complete_sale','payloadHash',repeat('b',64),'sequence',%d,'authorization',jsonb_build_object('actorId','u-cash-a1')),'hash',repeat('%s',64),'signature','REC_SYNTHETIC_UNVERIFIED')"
                                                        % (org, dev, op or str(uuid.uuid4()), seq, h))
    rc = lambda dig, seq, h, wid='rec-witness', org='org-test': ("jsonb_build_object('body',jsonb_build_object('protocol','orvix-witness-receipt-v1','witnessId','%s','keyId','rec-key','checkpoint',jsonb_build_object('protocol','orvix-checkpoint-v1','orgId','%s','shopId','shop-a','streamId','rec-dev:rec-key','sequence',%d,'digest',repeat('%s',64),'previousReceiptHash',NULL)),'hash',repeat('%s',64),'signature','REC_SYNTHETIC_UNVERIFIED')"
                                                                 % (wid, org, seq, dig, h))
    def call(who, expr, label):
        _, out = x.psql(as_user(who, f"SELECT 'R='||{expr}::text;"), label); return val(out) or ('ERROR ' + str(err(out)))
    g1 = call(ADMIN, f"public.recovery_v1_store_evidence({env('rec-dev-gap',1,'1')})", 'r50-seq1')
    g3 = call(ADMIN, f"public.recovery_v1_store_evidence({env('rec-dev-gap',3,'3')})", 'r50-seq3')
    x.record('r50', 'evidence chain gap (sequence 1 then 3) uploaded to the server store', 'server stores both opaquely (verified:false); gap detection happens only client/owner-side (r33 vitest)',
             f'seq1={g1} seq3={g3}', 'LIMITATION' if '"stored"' in g1 and '"stored"' in g3 else 'FAIL')
    # slot squatting: a forged envelope stored first blocks the genuine one at the same device/key/sequence
    forged = call(ADMIN, f"public.recovery_v1_store_evidence({env('synthetic-till-7',1,'7')})", 'r51-forged')
    genuine = call(CASH_A1, f"public.recovery_v1_store_evidence({env('synthetic-till-7',1,'8')})", 'r51-genuine')
    x.record('r51', 'evidence fork: an ADMIN (or anyone holding ADMIN credentials) pre-stores a forged, unsigned-checked envelope for a till\'s next sequence; the till then uploads its genuine envelope',
             'both retained (fork recorded) or the forged one rejected', f'forged={forged} genuine={genuine}',
             'FAIL' if '"stored"' in forged and 'IMMUTABLE_EVIDENCE_CONFLICT' in genuine else 'PASS')
    w1 = call(ADMIN, f"public.recovery_v1_store_checkpoint({rc('d',1,'4')})", 'r52-receipt')
    w1b = call(ADMIN, f"public.recovery_v1_store_checkpoint({rc('d',1,'4')})", 'r52-replay')
    wf = call(ADMIN, f"public.recovery_v1_store_checkpoint({rc('e',1,'5')})", 'r52-fork')
    wx = call(UNREL_ADMIN, f"public.recovery_v1_store_checkpoint({rc('d',1,'4')})", 'r52-cross-org')
    # Script 2 fix r51: a second receipt for the same slot is KEPT and recorded as a fork (never lets the first writer block)
    ok = '"stored"' in w1 and 'already_stored' in w1b and 'stored_conflicting' in wf and 'INVALID_CHECKPOINT' in wx
    x.record('r52', 'witness receipts: exact replay, forked receipt at the same stream/sequence, replay into another organization',
             'replay idempotent; fork kept and audited (stored_conflicting); cross-org refused', f'first={w1} replay={w1b} fork={wf} cross_org={wx}', 'PASS' if ok else 'FAIL')
    bad = call(ADMIN, f"public.recovery_v1_store_checkpoint({rc('0',2,'6')})", 'r53-incorrect')
    x.record('r53', 'incorrect recovery checkpoint (digest matching no evidence) stored on the server', 'stored opaque, verified:false; detection client-side (vitest r37)',
             bad, 'LIMITATION' if '"verified": false' in bad or '"verified":false' in bad else 'FAIL')
    xe = call(ADMIN, f"public.recovery_v1_store_evidence({env('rec-dev-x',1,'9','org-unrelated')})", 'r54-wrong-org')
    x.record('r54', 'wrong-organization evidence upload', 'refused', xe, 'PASS' if 'INVALID_EVIDENCE' in xe else 'FAIL')
    _, out = x.psql("\\set ON_ERROR_STOP off\n" + "\n".join(
        f"{stmt};" for stmt in ["UPDATE recovery_v1.untrusted_evidence SET envelope='{}'", "DELETE FROM recovery_v1.untrusted_evidence",
                                "TRUNCATE recovery_v1.untrusted_checkpoints", "DELETE FROM recovery_v1.audit", "UPDATE recovery_v1.fences SET incident='x'",
                                "DELETE FROM recovery_v1.owner_authorizations_used", "ALTER TABLE recovery_v1.audit DISABLE TRIGGER recovery_v1_immutable",
                                "SET session_replication_role=replica; DELETE FROM recovery_v1.audit"]) + "\nRESET session_replication_role;", 'r55-immutability')
    n = len(re.findall(r'RECOVERY_V1_(EVIDENCE_IMMUTABLE|SELF_CHANGE_BLOCKED)', out))
    x.record('r55', 'superuser tries to update/delete/truncate preserved evidence, audit, fences, used authorizations; disable the trigger; replica mode',
             'all 8 refused (immutable, ENABLE ALWAYS, DDL guard)', f'refused={n}/8', 'PASS' if n == 8 else 'FAIL')
    _, out = x.psql("SELECT 'R='||coalesce(recovery_v1.integrity_problem(),'none');", 'r55-integrity')
    x.record('r56', 'recovery protection intact after all probes', 'integrity_problem() = none', val(out), 'PASS' if val(out) == 'none' else 'FAIL')


def r57_nothing_invented(x, snap):
    k = str(uuid.uuid4())
    _, out = x.psql("SET ROLE orvix_recovery_operator;\n\\set ON_ERROR_STOP off\n"
                    f"SELECT recovery_v1.fence_key(current_database(),(SELECT system_identifier::text FROM pg_control_system()),'org-test','shop-a','{k}','complete_sale','u-cash-a1','rec-r57',repeat('a',64),'synthetic-authorization');\n"
                    f"SELECT recovery_v1.request_unfence(current_database(),(SELECT system_identifier::text FROM pg_control_system()),'org-test','shop-a','{k}','rec-r57',repeat('a',64),'{{\"claimsApproved\":true}}');\n"
                    "SELECT recovery_v1.ledger_retention_report() IS NOT NULL;\nRESET ROLE;", 'r57-recovery-paths')
    after = fin_digest(x, label='r57-after')
    row = ledger_row(x, k)
    _, fc = x.psql("SELECT 'R='||count(*) FROM recovery_v1.fences;", 'r57-fences')
    ok = after == snap and row and row.get('response') is None and row.get('state') == 'abandoned'
    x.record('r57', 'recovery paths (status, transitions, evidence/checkpoint store, owner verification, fence, unfence, retention report) invent no sale, payment, payout, refund, cash or stock row',
             'all financial tables byte-identical; the only ledger row is the fence sentinel (abandoned, no response)',
             f"financial_tables_identical={after==snap} fence_sentinel={row and {k2: row.get(k2) for k2 in ('state','outcome_code','response')}} fences={val(fc)}",
             'PASS' if ok else 'FAIL')


def r61_retention_under_v1(x):
    keys = json.loads((x.run / 'rec-r61-keys.json').read_text())
    _, out = x.psql(f"SELECT 'K='||count(*) FROM public.idempotency_keys WHERE key IN ('{keys['legacy_aged_with_response']}','{keys['v7_aged']}') AND response IS NOT NULL;\n"
                    "\\set ON_ERROR_STOP off\nSELECT 'N='||count(*) FROM public.idempotency_keys;\nSELECT 'P='||public.prune_idempotency_keys();\nSELECT 'M='||count(*) FROM public.idempotency_keys;\n"
                    "SELECT public.op_purge_responses(interval '90 days');\nSELECT 'RESP='||count(*) FILTER (WHERE response IS NOT NULL) FROM public.idempotency_keys;", 'r61-prune-under-v1')
    _, o2 = x.psql(f"SELECT 'K='||count(*) FROM public.idempotency_keys WHERE key IN ('{keys['legacy_aged_with_response']}','{keys['v7_aged']}') AND response IS NOT NULL;", 'r61-after')
    ok = val(out, 'K') == '2' and val(out, 'N') == val(out, 'M') and 'ORG_SUSPENDED' in out and val(o2, 'K') == '2'
    x.record('r61', 'under V1: prune_idempotency_keys and op_purge_responses on aged completed rows (incl. the 400-day rows from rec_db_pre)',
             'nothing deleted; response purge refused (ledger growth instead of a duplicate-execution window)',
             f"aged_candidates={val(out,'K')} kept_with_response_after={val(o2,'K')} rows_before={val(out,'N')} prune_reported={val(out,'P')} rows_after={val(out,'M')} purge={err(out)}", 'PASS' if ok else 'FAIL')


def run(ctx):
    x = Ctx(ctx)
    _, out = x.psql("SELECT 'R='||(SELECT state FROM recovery_v1.org_state WHERE org_id='org-test')||':'||coalesce(recovery_v1.integrity_problem(),'none');", 'r00-pre')
    x.record('r00b', 'precondition: harness ACTIVE fixture for org-test (synthetic superuser fixture, not a recovery), V1 intact', 'ACTIVE:none', val(out),
             'PASS' if val(out) == 'ACTIVE:none' else 'FAIL')
    try:
        if not r01_kill_postmaster(x): raise RuntimeError('cluster did not restart after the kill -9 test')
        r02_terminate_approval(x)
        r2x_restore(x)
        # a PENDING refund request created while ACTIVE (for the refusal tests)
        _, out = x.psql(as_user(CASH_A1, f"SELECT public.complete_sale({SALE_ARGS},'{uuid.uuid4()}') AS s \\gset\n"
                        f"SELECT 'R='||(public.create_refund_void_request(:'s'::jsonb->'sale'->>'id','PARTIAL','rec pending',"
                        f"'[{{\"productId\":\"prod-1\",\"qtyUnits\":1,\"amountMmk\":1000}}]'::jsonb,NULL,NULL,'{uuid.uuid4()}')->'request'->>'id');"), 'r40-pending-setup')
        x.pending = val(out)
        snap = fin_digest(x, label='r57-before')
        r3x_authorization(x)
        refusals(x, 'RESTRICTED', 'r40')
        _, out = x.psql(as_user(ADMIN, "SELECT 'R='||(public.recovery_v1_transition('org-test','QUARANTINED','rec quarantine','rec-evidence-ref')->>'state');"), 'r41-quarantine')
        refusals(x, 'QUARANTINED', 'r41')
        r5x_evidence(x)
        r57_nothing_invented(x, snap)
        r61_retention_under_v1(x)
        x.record('r62', 'email archive delivery (real offsite)', 'owner retrieves an offsite copy', 'not exercised: only the simulated mailbox (deliverToSimulatedRecipient / backup-fixture-roundtrip) is used; delivery disabled by design', 'BLOCKED')
    finally:
        # FIXTURE RESTORE (Step 5: genuine owner-signed reopening, synthetic owner): the harness's race test after this module needs org-test ACTIVE.
        try: x.c['activate']('org-test')
        except Exception as e: x.record('zz', 'fixture reopening of org-test', 'reopened', f'could not reopen: {e}'[:300], 'FAIL')
        (x.run / 'rec-post-results.json').write_text(json.dumps(x.results, indent=1) + '\n')
