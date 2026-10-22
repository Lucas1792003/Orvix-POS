"""Script 2 (defensive) post-module: owner-authorization cryptography, chain re-verification, tamper refusals.

Runs as `--script2-post` after Recovery V1 install + the Step 4 suite, on the harness's private disposable
cluster. Owner key owner-sim-1 has been rotated to owner-sim-2 (the active key); owner-sim-1 is retired.
Every scenario records a test.check row via ctx['check']. Nothing is left mutated except harmless
zz_s2_* indexes created by the one accepted concurrent winner; integrity is re-asserted at the end.
Synthetic keys / data only. No product code is modified.
"""
import hashlib
import json
import subprocess
import threading


def run(ctx):
    sql, check, run, env, dbargs = ctx['sql'], ctx['check'], ctx['run'], ctx['env'], ctx['dbargs']
    sim, keydir = str(ctx['sim']), ctx['keydir']

    def psql(statement, label, **vars):
        argv = ['psql', *dbargs]
        for k, v in vars.items():
            argv += ['-v', f'{k}={v}']
        r = subprocess.run(argv, input=statement, text=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (run / f'script2-authz-{label}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    def apply(auth, sig, q, label):
        return psql("SELECT recovery_v1.apply_authorized_migration(:'a', :'s', :'q');", label, a=auth, s=sig, q=q)

    target = json.loads(sql("SELECT recovery_v1.authorization_target();", 'authz-target.log').strip())
    active = next(k['keyId'] for k in target['ownerKeys'] if not k['retired'])  # owner-sim-2
    retired = next((k['keyId'] for k in target['ownerKeys'] if k['retired']), None)

    def authorize(key_id, purpose, payload, tgt=None, expires_in=3600, issued_offset=0, label='a'):
        t = tgt or target
        (run / f's2-{label}-t.json').write_text(json.dumps(t))
        (run / f's2-{label}-p.json').write_text(json.dumps(payload))
        out = subprocess.run(['node', sim, 'authorize', str(keydir / f'{key_id}.private.pem'), key_id, purpose,
                              str(run / f's2-{label}-t.json'), str(run / f's2-{label}-p.json'),
                              '--expires-in', str(expires_in), '--issued-offset', str(issued_offset)],
                             text=True, capture_output=True, check=True).stdout
        a = json.loads(out)
        return a['authorization'], a['signature']

    def mpayload(mid, q, cmds, predecessor=None, new_tables=()):
        return {'migration': {'id': mid, 'sqlSha256': hashlib.sha256(q.encode()).hexdigest(),
                              'predecessor': predecessor or sql("SELECT recovery_v1.migration_chain_head();", 's2-head.log').strip(),
                              'allowedCommands': list(cmds), 'newTables': list(new_tables)}}

    Q = "CREATE INDEX zz_s2_probe ON public.loyalty_points (org_id);"

    # ---- cryptographic: signature over exact text -------------------------------------------------
    a1, s1 = authorize(active, 'migration', mpayload('S2-WRONGKEY', Q, ['CREATE INDEX']), label='wk')
    # wrong key: a key that was never enrolled
    newpub = subprocess.run(['node', sim, 'keygen', str(keydir), 'owner-sim-rogue'], text=True, capture_output=True, check=True).stdout
    ar, sr = authorize('owner-sim-rogue', 'migration', mpayload('S2-WRONGKEY', Q, ['CREATE INDEX']), label='wk2')
    rc, out = apply(ar, sr, Q, 'a01-wrongkey')
    check('a01 an authorization signed by an unenrolled key is refused (unknown owner key)', rc != 0 and 'unknown owner key' in out, out[-160:])

    # retired key: structurally valid, signed by the rotated-out key
    if retired:
        art, srt = authorize(retired, 'migration', mpayload('S2-RETIRED', Q, ['CREATE INDEX']), label='ret')
        rc, out = apply(art, srt, Q, 'a02-retired')
        check('a02 the retired (rotated-out) owner key authorizes nothing', rc != 0 and 'owner key retired' in out, out[-160:])
    else:
        check('a02 a retired key exists to test', False, 'no retired key present')

    # edited text after signing: change one character of the signed document, keep valid JSON
    edited = a1.replace('"nonce":"', '"nonce":"f', 1) if '"nonce":"' in a1 else a1 + ' '
    rc, out = apply(edited, s1, Q, 'a03-edited')
    check('a03 text edited after signing is refused (signature does not verify)', rc != 0 and 'signature does not verify' in out, out[-160:])

    # foreign signature: a signature made over a different document
    a2, s2 = authorize(active, 'migration', mpayload('S2-FOREIGN', Q, ['CREATE INDEX']), label='fs')
    rc, out = apply(a1, s2, Q, 'a04-foreign')
    check('a04 a signature of another document is refused (signature does not verify)', rc != 0 and 'signature does not verify' in out, out[-160:])

    # ---- database-enforced: target binding, window, purpose, order, checksum ----------------------
    wrong_sys = dict(target); wrong_sys['systemIdentifier'] = '1234567890123456789'
    aw, sw = authorize(active, 'migration', mpayload('S2-SYS', Q, ['CREATE INDEX']), tgt=wrong_sys, label='sys')
    rc, out = apply(aw, sw, Q, 'a05-sysid')
    check('a05 an authorization bound to another system identifier is refused (target)', rc != 0 and 'TARGET' in out, out[-160:])

    wrong_inst = dict(target); wrong_inst['recoveryV1InstalledAt'] = '2000-01-01T00:00:00.000000Z'
    ai, si = authorize(active, 'migration', mpayload('S2-INST', Q, ['CREATE INDEX']), tgt=wrong_inst, label='inst')
    rc, out = apply(ai, si, Q, 'a06-installtime')
    check('a06 an authorization bound to another V1 install time is refused (target)', rc != 0 and 'TARGET' in out, out[-160:])

    wrong_db = dict(target); wrong_db['database'] = 'some_other_db'
    ad, sd = authorize(active, 'migration', mpayload('S2-DB', Q, ['CREATE INDEX']), tgt=wrong_db, label='db')
    rc, out = apply(ad, sd, Q, 'a07-database')
    check('a07 an authorization for another database is refused (target)', rc != 0 and 'TARGET' in out, out[-160:])

    # not-yet-valid: issued well in the future (beyond the 5-minute skew)
    an, sn = authorize(active, 'migration', mpayload('S2-FUTURE', Q, ['CREATE INDEX']), issued_offset=7200, label='fut')
    rc, out = apply(an, sn, Q, 'a08-notyet')
    check('a08 a not-yet-valid authorization is refused (outside its validity window)', rc != 0 and 'EXPIRED' in out, out[-160:])

    # window too long: more than 7 days
    al, sl = authorize(active, 'migration', mpayload('S2-LONG', Q, ['CREATE INDEX']), expires_in=8 * 86400, label='long')
    rc, out = apply(al, sl, Q, 'a09-toolong')
    check('a09 a validity window longer than 7 days is refused', rc != 0 and 'validity window' in out, out[-160:])

    # wrong purpose: an offline-policy document presented to apply_authorized_migration
    ap, sp = authorize(active, 'offline-policy', {'policy': {'scope': '*', 'maxLifetimeSeconds': 3600, 'maxOps': 1, 'maxAmountMmk': 1, 'syncGraceSeconds': 60}}, label='pur')
    rc, out = apply(ap, sp, Q, 'a10-purpose')
    check('a10 a document signed for another purpose is refused (wrong protocol or purpose)', rc != 0 and 'purpose' in out, out[-160:])

    # checksum: a valid authorization whose named SQL differs from the SQL supplied
    ac, sc = authorize(active, 'migration', mpayload('S2-CKSUM', Q, ['CREATE INDEX']), label='ck')
    rc, out = apply(ac, sc, Q + "\nCREATE INDEX zz_s2_extra ON public.loyalty_points (shop_id);", 'a11-checksum')
    check('a11 SQL that is not the named reviewed SQL is refused (checksum)', rc != 0 and 'CHECKSUM' in out, out[-160:])

    # order: an authorization naming a stale predecessor
    stale = mpayload('S2-STALE', Q, ['CREATE INDEX'], predecessor='0' * 64)
    ao, so = authorize(active, 'migration', stale, label='ord')
    rc, out = apply(ao, so, Q, 'a12-order')
    check('a12 an authorization against a stale chain head is refused (order)', rc != 0 and 'ORDER' in out, out[-160:])

    # ---- concurrent migrations: exactly one applies ----------------------------------------------
    head = sql("SELECT recovery_v1.migration_chain_head();", 's2-chead.log').strip()
    qa = "CREATE INDEX zz_s2_conc_a ON public.loyalty_points (created_at);"
    qb = "CREATE INDEX zz_s2_conc_b ON public.loyalty_points (points);"
    aa, sa = authorize(active, 'migration', mpayload('S2-CONC-A', qa, ['CREATE INDEX'], predecessor=head), label='ca')
    ab, sb = authorize(active, 'migration', mpayload('S2-CONC-B', qb, ['CREATE INDEX'], predecessor=head), label='cb')
    res = {}
    ta = threading.Thread(target=lambda: res.__setitem__('a', apply(aa, sa, qa, 'a13-conc-a')))
    tb = threading.Thread(target=lambda: res.__setitem__('b', apply(ab, sb, qb, 'a13-conc-b')))
    ta.start(); tb.start(); ta.join(); tb.join()
    oks = sum(1 for k in 'ab' if res[k][0] == 0)
    orders = sum(1 for k in 'ab' if res[k][0] != 0 and 'ORDER' in res[k][1])
    check('a13 concurrent migrations from one head: exactly one applies, the other is refused (order)', oks == 1 and orders == 1,
          json.dumps({k: res[k][1][-120:] for k in 'ab'}))

    # ---- chain + stored-signature re-verification (read-only) -------------------------------------
    sig_ok = sql("SELECT count(*) FILTER (WHERE NOT recovery_v1.rsa_verify(k.n, k.e, convert_to(u.authorization_text,'UTF8'), u.signature)) "
                 "FROM recovery_v1.owner_authorizations_used u JOIN recovery_v1.owner_keys k ON k.key_id = u.key_id;", 's2-reverify-sig.log').strip()
    total = sql("SELECT count(*) FROM recovery_v1.owner_authorizations_used;", 's2-reverify-count.log').strip()
    check('a14 every stored owner authorization re-verifies against its enrolled key (tamper-evident)', sig_ok == '0' and int(total) > 0, f'bad={sig_ok} of {total}')
    chain = sql("""WITH m AS (SELECT seq, predecessor, chain_head, sql_sha256, auth_sha256,
                   lag(chain_head) OVER (ORDER BY seq) AS prev FROM recovery_v1.applied_migrations)
                 SELECT bool_and(chain_head = encode(sha256(convert_to(predecessor||':'||auth_sha256||':'||sql_sha256,'UTF8')),'hex')
                   AND (prev IS NULL OR predecessor = prev)) FROM m;""", 's2-reverify-chain.log').strip()
    check('a15 the applied-migration chain recomputes exactly (each head = H(predecessor:auth:sql), links unbroken)', chain == 't', chain)

    # ---- interrupted migration: server-log step + documentation mismatch --------------------------
    try:
        pg = (run / 'postgres.log').read_text()
    except OSError:
        pg = ''
    steps = sorted(set(l.split('step ')[1].split()[0] for l in pg.splitlines() if 'RECOVERY_V1_MIGRATION' in l and ' step ' in l))
    check('a16 apply_authorized_migration records each step to the server log (last step reached is recoverable)',
          'executing-sql' in steps and 'verified-signature' in steps, 'steps=' + ','.join(steps))
    try:
        s4 = json.loads((run / 'step4-results.json').read_text())
        m12 = next((ok for n, ok, _ in s4 if n.startswith('m12 ')), None)
        m12b = next((ok for n, ok, _ in s4 if n.startswith('m12b ')), None)
    except (OSError, ValueError, StopIteration):
        m12 = m12b = None
    # Step 4 m12/m12b establish: an interrupted migration leaves nothing AND the SAME authorization re-applies.
    # STEP4-DESIGN.md §3.2 says interruption repair is "forward only, with a new authorization" -> documentation mismatch.
    check('a17 interrupted migration leaves nothing yet the SAME authorization re-applies (nonce consumed only on commit) '
          '- contradicts STEP4-DESIGN.md §3.2 "with a new authorization"', m12 is True and m12b is True, f'm12={m12} m12b={m12b}')

    # ---- per-role: owner functions and V1 tables are out of reach for API / operator roles --------
    roles = {
        'authenticated': "SET ROLE authenticated;",
        'service_role': "SET ROLE service_role;",
        'anon': "SET ROLE anon;",
        'orvix_recovery_operator': "SET ROLE orvix_recovery_operator;",
    }
    for rn, setr in roles.items():
        rc, out = psql(setr + " SELECT recovery_v1.apply_authorized_migration('{}','00','SELECT 1'); RESET ROLE;", f'a18-{rn}-apply')
        check(f'a18 {rn} cannot call apply_authorized_migration (permission denied)', rc != 0 and 'permission denied' in out, out[-140:])
    rc, out = psql("SET ROLE authenticated; INSERT INTO recovery_v1.org_state(org_id) VALUES ('org-forged'); RESET ROLE;", 'a19-write')
    check('a19 authenticated cannot write recovery_v1 state tables (permission denied)', rc != 0 and 'permission denied' in out, out[-140:])
    rc, out = psql("SET ROLE orvix_recovery_operator; SELECT 1 FROM recovery_v1.keys; RESET ROLE;", 'a20-opread')
    check('a20 orvix_recovery_operator cannot read the offline MAC key table (permission denied)', rc != 0 and 'permission denied' in out, out[-140:])

    # ---- guard-removal attempts outside a migration (superuser) are refused by the DDL guard ------
    removals = [
        ('a21 DROP TRIGGER on a guarded table is refused', "DROP TRIGGER zz_recovery_v1_write ON public.sales;", 'GUARD_CHANGE_BLOCKED'),
        ('a22 ALTER TABLE ... DISABLE TRIGGER on a guarded table is refused', "ALTER TABLE public.sales DISABLE TRIGGER zz_recovery_v1_write;", 'GUARD_CHANGE_BLOCKED'),
        ('a23 DROP TABLE of a guarded table is refused', "DROP TABLE public.loyalty_points;", 'GUARD_CHANGE_BLOCKED'),
        ('a24 GRANT on recovery_v1 tables (the MAC key) is refused', "GRANT SELECT ON recovery_v1.keys TO authenticated;", 'SELF_CHANGE_BLOCKED'),
        ('a25 CREATE OR REPLACE of a V1 function is refused', "CREATE OR REPLACE FUNCTION recovery_v1.v1_catalog_state() RETURNS text LANGUAGE sql AS $f$ SELECT 'x' $f$;", 'SELF_CHANGE_BLOCKED'),
    ]
    for name, stmt, code in removals:
        rc, out = psql(stmt, name.split()[0])
        check(name, rc != 0 and code in out, out[-160:])

    # ---- event trigger disabled -> integrity quarantine (inside a rolled-back transaction) --------
    rc, out = psql("BEGIN;\nALTER EVENT TRIGGER zz_recovery_v1_ddl DISABLE;\n"
                   "SELECT 'integ='||coalesce(recovery_v1.integrity_problem(),'none');\n"
                   "DO $$BEGIN UPDATE public.shops SET address=address WHERE id='shop-a'; RAISE NOTICE 'S2 write=ALLOWED'; "
                   "EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'S2 write=REFUSED %', SQLERRM; END$$;\nROLLBACK;", 'a26-evt')
    quarantined = 'integ=ddl_guard_not_enabled' in out or 'ALTER EVENT TRIGGER' in out and 'ERROR' in out
    write_refused = 'S2 write=REFUSED' in out or 'ALLOWED' not in out
    check('a26 disabling the V1 DDL event trigger quarantines (integrity problem + guarded write refused); rolled back',
          quarantined and write_refused, out[-200:])
    restored = sql("SELECT recovery_v1.integrity_problem() IS NULL AND EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='zz_recovery_v1_ddl' AND evtenabled='A');", 'a27-restore.log').strip()
    check('a27 after rollback the event trigger is enabled again and integrity is intact', restored == 't', restored)
    # PG16 note: the SET event_triggers GUC does not exist here (PostgreSQL 17 only)
    guc = sql("SELECT count(*) FROM pg_settings WHERE name='event_triggers';", 'a28-guc.log').strip()
    check('a28 (recorded) PostgreSQL 16 has no event_triggers GUC; the SET event_triggers path is PG17-only', guc == '0', 'settings='+guc)

    # leave org-test ACTIVE for the harness checks that follow
    ctx['activate']('org-test')   # Step 5: genuine owner-signed reopening (synthetic owner), not a superuser edit
