"""Step 4 Part B/C on a private disposable cluster (called by db-smoke.py; never connects anywhere else).

Owner authorizations are produced by tools/recovery-v1/owner/owner-sim.mjs with SYNTHETIC keys generated in the run directory.
Every result is a (name, ok, detail) tuple; db-smoke.py records them in test.results so they count like the SQL assertions.
"""
import json, re, subprocess, threading, time

class Suite:
    def __init__(self, root, run, dbargs, env, sql, command, sim, keydir):
        self.root, self.run, self.dbargs, self.env, self.sql, self.command = root, run, dbargs, env, sql, command
        self.sim, self.keydir = sim, keydir
        self.results = []

    def check(self, name, ok, detail=''):
        self.results.append((name, bool(ok), (detail or '')[:300]))

    def target(self):
        return json.loads(self.sql("SELECT recovery_v1.authorization_target();", 's4-target.log').strip())

    def authorize(self, key_id, purpose, payload, target=None, expires_in=3600, issued_offset=0, label='auth'):
        t = target or self.target()
        (self.run / f's4-{label}-target.json').write_text(json.dumps(t))
        (self.run / f's4-{label}-payload.json').write_text(json.dumps(payload))
        out = subprocess.run(['node', str(self.sim), 'authorize', str(self.keydir / f'{key_id}.private.pem'), key_id, purpose,
                              str(self.run / f's4-{label}-target.json'), str(self.run / f's4-{label}-payload.json'),
                              '--expires-in', str(expires_in), '--issued-offset', str(issued_offset)],
                             text=True, capture_output=True, check=True).stdout
        a = json.loads(out)
        return a['authorization'], a['signature']

    def psql(self, statement, label, **vars):
        argv = ['psql', *self.dbargs]
        for k, v in vars.items():
            argv += ['-v', f'{k}={v}']
        r = subprocess.run(argv, input=statement, text=True, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (self.run / f's4-{label}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    def apply(self, auth, sig, sqltext, label):
        return self.psql("SELECT recovery_v1.apply_authorized_migration(:'a', :'s', :'q');", label, a=auth, s=sig, q=sqltext)

    def migration_payload(self, mid, sqltext, commands, new_tables=(), predecessor=None):
        import hashlib
        return {'migration': {'id': mid, 'sqlSha256': hashlib.sha256(sqltext.encode()).hexdigest(),
                              'predecessor': predecessor or self.target()['migrationChainHead'],
                              'allowedCommands': list(commands), 'newTables': list(new_tables)}}

    def head(self):
        return self.target()['migrationChainHead']

    # ------------------------------------------------------------------ offline policy (owner-signed)
    def offline_policy(self, key_id, policy):
        a, s = self.authorize(key_id, 'offline-policy', {'policy': policy}, label='policy')
        rc, out = self.psql("SELECT recovery_v1.set_offline_policy(:'a', :'s');", 'policy', a=a, s=s)
        self.check('k01 owner-signed offline policy accepted', rc == 0 and '"set"' in out, out[-200:])
        rc, out = self.psql("SELECT recovery_v1.set_offline_policy(:'a', :'s');", 'policy-replay', a=a, s=s)
        self.check('k02 the same policy authorization cannot be replayed', rc != 0 and 'REPLAY' in out, out[-200:])

    # ------------------------------------------------------------------ authorized migrations
    def migrations(self, key_id):
        genesis = self.head()
        m1 = """CREATE TABLE public.loyalty_points (id text PRIMARY KEY, org_id text NOT NULL, shop_id text NOT NULL, points integer NOT NULL CHECK (points >= 0),
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.loyalty_points ENABLE ROW LEVEL SECURITY;
CREATE INDEX loyalty_points_org_idx ON public.loyalty_points (org_id);
CREATE POLICY loyalty_points_sel ON public.loyalty_points FOR SELECT TO authenticated USING (org_id = (SELECT u.org_id FROM public.users u WHERE u.auth_id = auth.uid()));
REVOKE ALL ON public.loyalty_points FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.loyalty_points TO authenticated;"""
        cmds = ['CREATE TABLE', 'ALTER TABLE', 'CREATE INDEX', 'CREATE POLICY', 'GRANT', 'REVOKE']
        a1, s1 = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0001-loyalty', m1, cmds, ['loyalty_points']), label='m1')
        # unauthorized DDL first (no context)
        rc, out = self.psql("CREATE TABLE public.zz_unauthorized (id int, org_id text NOT NULL);", 'm2')
        self.check('m02 DDL without an owner authorization is refused (new public table)', rc != 0 and 'UNGUARDED_TABLE_BLOCKED' in out, out[-200:])
        bad = s1[:-2] + ('00' if s1[-2:] != '00' else '01')
        rc, out = self.apply(a1, bad, m1, 'm3')
        self.check('m03 a forged / damaged signature is refused', rc != 0 and 'signature does not verify' in out, out[-200:])
        rc, out = self.apply(a1, s1, m1 + "\nCREATE TABLE public.zz_extra (id int);", 'm4')
        self.check('m04 SQL that is not the reviewed SQL (checksum) is refused', rc != 0 and 'CHECKSUM' in out, out[-200:])
        ax, sx = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0001-loyalty', m1, cmds, ['loyalty_points']),
                                issued_offset=-7200, expires_in=3600, label='m5')
        rc, out = self.apply(ax, sx, m1, 'm5')
        self.check('m05 an expired authorization is refused', rc != 0 and 'EXPIRED' in out, out[-200:])
        wrong = dict(self.target()); wrong['database'] = 'some_other_database'
        aw, sw = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0001-loyalty', m1, cmds, ['loyalty_points']), target=wrong, label='m7')
        rc, out = self.apply(aw, sw, m1, 'm7')
        self.check('m07 an authorization for another database is refused', rc != 0 and 'TARGET' in out, out[-200:])
        # the legitimate migration
        rc, out = self.apply(a1, s1, m1, 'm1')
        self.check('m01 an owner-authorized migration applies (exact SQL, target, window, nonce, predecessor)', rc == 0 and '"applied"' in out, out[-300:])
        st = self.sql("""SELECT json_build_object(
  'guarded', (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.loyalty_points'::regclass AND tgname IN ('zz_recovery_v1_write','zz_recovery_v1_truncate') AND tgenabled = 'A'),
  'registry', (SELECT resolver = 'org_id' AND migration_id = 'POST-V1-0001-loyalty' FROM recovery_v1.guarded_tables WHERE relname = 'loyalty_points'),
  'integrity', recovery_v1.integrity_problem() IS NULL,
  'chain', (SELECT count(*) = 1 AND min(predecessor) = %s FROM recovery_v1.applied_migrations),
  'audit', EXISTS (SELECT 1 FROM recovery_v1.audit WHERE kind = 'authorized_migration_applied'));""" % ("'" + genesis + "'"), 's4-m1-state.log')
        s = json.loads(st.strip())
        self.check('m01b the new table is guarded at once, registered, integrity intact, chain extended, audited', all(s.values()), json.dumps(s))
        rc, out = self.psql("INSERT INTO public.loyalty_points (id, org_id, shop_id, points) VALUES ('lp-x', 'org-unrelated', 'shop-unrel', 5);", 'm1-restricted')
        self.check('m01c recovery restrictions apply to the new table at once (RESTRICTED organization refused)', rc != 0 and 'ORG_SUSPENDED' in out, out[-200:])
        rc, out = self.psql("INSERT INTO public.loyalty_points (id, org_id, shop_id, points) VALUES ('lp-1', 'org-test', 'shop-a', 5);", 'm1-active')
        self.check('m01d an ACTIVE organization writes the new table', rc == 0, out[-200:])
        rc, out = self.apply(a1, s1, m1, 'm6')
        self.check('m06 a used authorization cannot be replayed', rc != 0 and 'REPLAY' in out, out[-200:])
        stale = self.migration_payload('POST-V1-0002-stale', "CREATE INDEX zz_stale_idx ON public.loyalty_points (shop_id);", ['CREATE INDEX'], predecessor=genesis)
        a8, s8 = self.authorize(key_id, 'migration', stale, label='m8')
        rc, out = self.apply(a8, s8, "CREATE INDEX zz_stale_idx ON public.loyalty_points (shop_id);", 'm8')
        self.check('m08 an authorization written against an older chain head is refused (ordering / rollback)', rc != 0 and 'ORDER' in out, out[-200:])
        # scope
        q9 = "DROP TRIGGER zz_recovery_v1_write ON public.sales;"
        a9, s9 = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0009-drop-guard', q9, ['DROP TRIGGER']), label='m9')
        rc, out = self.apply(a9, s9, q9, 'm9')
        self.check('m09 an authorization may never allow removing triggers (even owner-signed)', rc != 0 and 'never lists' in out, out[-200:])
        q9b = "ALTER TABLE public.sales DISABLE TRIGGER zz_recovery_v1_write;"
        a9b, s9b = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0009b-disable-guard', q9b, ['ALTER TABLE']), label='m9b')
        rc, out = self.apply(a9b, s9b, q9b, 'm9b')
        self.check('m09b an authorized ALTER TABLE still cannot disable a recovery guard', rc != 0 and 'GUARD_CHANGE_BLOCKED' in out, out[-200:])
        q10 = "CREATE TABLE recovery_v1.zz_side_door (id int);"
        a10, s10 = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0010-recovery-schema', q10, ['CREATE TABLE']), label='m10')
        rc, out = self.apply(a10, s10, q10, 'm10')
        self.check('m10 an authorized migration never touches the recovery schemas', rc != 0 and 'MIGRATION_SCOPE' in out, out[-200:])
        q10b = "CREATE TABLE public.not_listed (id int, org_id text NOT NULL);"
        a10b, s10b = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0010b-unlisted', q10b, ['CREATE TABLE']), label='m10b')
        rc, out = self.apply(a10b, s10b, q10b, 'm10b')
        self.check('m10b a table not named by the authorization is refused', rc != 0 and 'not an authorized new table' in out, out[-200:])
        q11 = "CREATE TABLE public.no_org (id int); ALTER TABLE public.no_org ENABLE ROW LEVEL SECURITY;"
        a11, s11 = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0011-no-org', q11, ['CREATE TABLE', 'ALTER TABLE'], ['no_org']), label='m11')
        rc, out = self.apply(a11, s11, q11, 'm11')
        self.check('m11 a new table without org_id is refused (its rows could not be resolved)', rc != 0 and 'org_id text NOT NULL' in out, out[-200:])
        q16 = "ALTER TABLE public.sales RENAME TO sales_renamed;"
        a16, s16 = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0016-rename', q16, ['ALTER TABLE']), label='m16')
        rc, out = self.apply(a16, s16, q16, 'm16')
        # refused by V1's guard-change check, or (087 adopted) first by the fixed-087 check: 087's own triggers are on sales
        still = self.sql("SELECT to_regclass('public.sales') IS NOT NULL AND to_regclass('public.sales_renamed') IS NULL;", 's4-m16-after.log').strip() == 't'
        self.check('m16 renaming a guarded table is refused (and nothing was renamed)',
                   rc != 0 and ('GUARD_CHANGE_BLOCKED' in out or '087_CHANGE_BLOCKED' in out) and still, out[-200:])
        q18 = "DROP TABLE public.loyalty_points;"
        a18, s18 = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0018-drop', q18, ['DROP TABLE']), label='m18')
        rc, out = self.apply(a18, s18, q18, 'm18')
        self.check('m18 an authorization may never allow dropping a table (rollback attack)', rc != 0 and 'never lists' in out, out[-200:])
        unchanged = self.sql("SELECT count(*) = 1 FROM recovery_v1.applied_migrations;", 's4-after-refusals.log').strip() == 't'
        self.check('m19 every refused migration left nothing behind (one applied, integrity intact)',
                   unchanged and self.sql("SELECT recovery_v1.integrity_problem() IS NULL;", 's4-int.log').strip() == 't')
        # interrupted migration, then a retry with the SAME authorization
        q12 = "CREATE TABLE public.gift_cards (id text PRIMARY KEY, org_id text NOT NULL, balance_mmk integer NOT NULL); ALTER TABLE public.gift_cards ENABLE ROW LEVEL SECURITY; SELECT pg_sleep(3);"
        a12, s12 = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0012-gift-cards', q12, ['CREATE TABLE', 'CREATE INDEX', 'ALTER TABLE'], ['gift_cards']), label='m12')
        holder = {}
        def go():
            holder['r'] = self.apply(a12, s12, q12, 'm12-interrupted')
        th = threading.Thread(target=go); th.start(); time.sleep(1.2)
        self.sql("SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE query LIKE '%apply_authorized_migration%' AND pid <> pg_backend_pid();", 's4-m12-kill.log')
        th.join()
        rc, out = holder['r']
        left = self.sql("SELECT to_regclass('public.gift_cards') IS NULL AND NOT EXISTS (SELECT 1 FROM recovery_v1.owner_authorizations_used WHERE auth_sha256 = encode(sha256(convert_to(%s, 'UTF8')), 'hex')) AND (SELECT count(*) = 1 FROM recovery_v1.applied_migrations);" % ("'" + a12.replace("'", "''") + "'"), 's4-m12-left.log').strip()
        interrupted = 'terminating connection' in out or 'server closed the connection' in out
        self.check('m12 an interrupted migration (backend terminated mid-SQL) leaves nothing (no table, nonce unused, chain unchanged)',
                   rc != 0 and interrupted and left == 't', out[-200:])
        rc, out = self.apply(a12, s12, q12, 'm12-retry')
        self.check('m12b the same authorization applies after the interruption (forward repair, no new approval needed)', rc == 0 and '"applied"' in out, out[-200:])
        # concurrent attempts with the same predecessor
        head = self.head()
        qa = "CREATE INDEX zz_conc_a ON public.loyalty_points (shop_id);"; qb = "CREATE INDEX zz_conc_b ON public.loyalty_points (points);"
        aa, sa = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0013-a', qa, ['CREATE INDEX'], predecessor=head), label='m13a')
        ab, sb = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0013-b', qb, ['CREATE INDEX'], predecessor=head), label='m13b')
        res = {}
        ta = threading.Thread(target=lambda: res.__setitem__('a', self.apply(aa, sa, qa, 'm13a')))
        tb = threading.Thread(target=lambda: res.__setitem__('b', self.apply(ab, sb, qb, 'm13b')))
        ta.start(); tb.start(); ta.join(); tb.join()
        oks = sum(1 for k in 'ab' if res[k][0] == 0)
        orders = sum(1 for k in 'ab' if res[k][0] != 0 and 'ORDER' in res[k][1])
        self.check('m13 concurrent migrations from the same head: exactly one applies, the other is refused (order)', oks == 1 and orders == 1,
                   json.dumps({k: res[k][1][-150:] for k in 'ab'}))
        # non-superuser callers
        self.sql("DROP ROLE IF EXISTS zz_s4_runner; CREATE ROLE zz_s4_runner LOGIN;", 's4-role.log')
        rc, out = self.psql("SET ROLE zz_s4_runner; SELECT recovery_v1.apply_authorized_migration('{}', '00', 'SELECT 1');", 'm14')
        self.check('m14 a non-superuser cannot run an authorized migration', rc != 0 and 'permission denied' in out, out[-200:])
        rc, out = self.psql("SET ROLE zz_s4_runner; INSERT INTO recovery_v1.authorized_txn VALUES (txid_current(), 'migration', 'forged');", 'm14b')
        self.check('m14b a non-superuser cannot forge a migration context', rc != 0 and 'permission denied' in out, out[-200:])
        rc, out = self.psql("SET ROLE authenticated; SELECT recovery_v1.authorization_target();", 'm14c')
        self.check('m14c API roles cannot read the authorization target', rc != 0 and 'permission denied' in out, out[-200:])
        self.sql("DROP ROLE zz_s4_runner;", 's4-role-drop.log')
        return head

    # ------------------------------------------------------------------ owner key rotation
    # ------------------------------------------------------------------ review hardening (Step 4 Part E)
    def hardening(self, key_id):
        """What an owner-signed SQL may NOT do (it only adds), and what nobody may do to V1 outside one."""
        chain_before = self.sql("SELECT count(*) FROM recovery_v1.applied_migrations;", 's4-h-before.log').strip()
        cases = [
            ('h01 an authorized migration that changes recovery data (reopens organizations) is rolled back',
             # Step 5: refused first by the ACTIVE gate on org_state itself (only an owner-signed reopening sets ACTIVE)
             "UPDATE recovery_v1.org_state SET state = 'ACTIVE';", [], 'REOPEN_AUTHORIZATION_REQUIRED'),
            # (review 3, M3) the MIGRATION_SCOPE refusal of recovery-data edits stays covered: an edit that does not touch ACTIVE
            ('h01b an authorized migration that edits recovery data without reopening (org_state.reason) is rolled back',
             "UPDATE recovery_v1.org_state SET reason = reason || ' (edited by a migration)';", [], 'MIGRATION_SCOPE'),
            ('h02 an authorized migration cannot lift its own command scope (authorized_txn is part of the checked state)',
             "UPDATE recovery_v1.authorized_txn SET ref = ref || '#guards' WHERE txid = txid_current(); CREATE INDEX zz_h02 ON public.loyalty_points (points);",
             ['CREATE INDEX'], 'MIGRATION_SCOPE'),
            ('h03 a GRANT on V1\'s own tables (the offline MAC key) is refused even when GRANT is listed',
             "GRANT SELECT ON recovery_v1.keys TO authenticated;", ['GRANT'], 'BLOCKED'),
            ('h04 a new trigger on an existing guarded table is refused (it could rewrite rows after the guard)',
             "CREATE FUNCTION public.zz_h04() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$; "
             "CREATE TRIGGER zzz_h04 BEFORE INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION public.zz_h04();",
             ['CREATE FUNCTION', 'CREATE TRIGGER'], 'MIGRATION_SCOPE'),
            ('h05 dropping an existing row-level security policy is refused (DROP statements carry no command row)',
             "DROP POLICY IF EXISTS sales_sel ON public.sales;", ['DROP POLICY'], 'MIGRATION_SCOPE'),
            ('h06 replacing an existing business function is refused (pinned bodies stay pinned)',
             "CREATE OR REPLACE FUNCTION public.app_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$ SELECT 'ADMIN'::text $f$;",
             ['CREATE FUNCTION'], 'MIGRATION_SCOPE'),
        ]
        for i, (name, q, cmds, want) in enumerate(cases, 1):
            a, s = self.authorize(key_id, 'migration', self.migration_payload(f'POST-V1-H{i:02d}', q, cmds), label=f'h{i:02d}')
            rc, out = self.apply(a, s, q, f'h{i:02d}')
            self.check(name, rc != 0 and want in out, out[-200:])
        rc, out = self.psql("CREATE OR REPLACE FUNCTION recovery_v1.v1_catalog_state() RETURNS text LANGUAGE sql AS $f$ SELECT 'x' $f$;", 'h07')
        self.check('h07 outside a migration nobody may replace a V1 function (superuser included)', rc != 0 and 'SELF_CHANGE_BLOCKED' in out, out[-200:])
        rc, out = self.psql("CREATE SCHEMA IF NOT EXISTS zz_h08; CREATE TABLE zz_h08.child () INHERITS (public.sales);", 'h08')
        self.check('h08 no table may inherit from a guarded table (its rows would skip the guards)', rc != 0 and 'inherit' in out, out[-200:])
        rc, out = self.psql("ALTER TABLE recovery_v1.owner_authorizations_used DISABLE TRIGGER USER;", 'h09')
        self.check('h09 V1\'s immutability triggers cannot be disabled', rc != 0 and 'BLOCKED' in out, out[-200:])
        unchanged = self.sql("SELECT recovery_v1.integrity_problem() IS NULL AND (SELECT count(*) FROM recovery_v1.applied_migrations) = " + chain_before + " "
                             "AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'zzz_h04') = 0;", 's4-h-after.log').strip() == 't'
        self.check('h10 every refused attempt left nothing behind (integrity intact, chain unchanged)', unchanged)
        # owner keys and authorization documents
        bad = json.loads(subprocess.run(['node', str(self.sim), 'keygen', str(self.keydir), 'owner-sim-e3'], text=True, capture_output=True, check=True).stdout)
        bad['e'] = 3
        a, s = self.authorize(key_id, 'enroll-owner-key', {'newKey': bad}, label='h11')
        rc, out = self.psql("SELECT recovery_v1.enroll_owner_key(:'a', :'s');", 'h11', a=a, s=s)
        self.check('h11 an owner key with e other than 65537 is refused', rc != 0 and 'e = 65537' in out, out[-200:])
        t = self.target()
        doc = json.dumps({'protocol': 'orvix-owner-authorization-v1', 'purpose': 'offline-policy', 'keyId': key_id, 'nonce': '00000000-0000-4000-8000-0000000000aa',
                          'target': {k: t[k] for k in ('database', 'systemIdentifier', 'recoveryV1InstalledAt')}, 'issuedAt': 'yesterday', 'expiresAt': 'tomorrow',
                          'policy': {'scope': '*', 'maxLifetimeSeconds': 60, 'maxOps': 1, 'maxAmountMmk': 1, 'syncGraceSeconds': 60}})
        (self.run / 's4-h12-doc.txt').write_text(doc)
        sig = subprocess.run(['node', '-e', "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.sign('sha256',Buffer.from(f.readFileSync(process.argv[1],'utf8'),'utf8'),{key:c.createPrivateKey(f.readFileSync(process.argv[2])),padding:c.constants.RSA_PKCS1_PADDING}).toString('hex'))",
                              str(self.run / 's4-h12-doc.txt'), str(self.keydir / f'{key_id}.private.pem')], text=True, capture_output=True, check=True).stdout
        rc, out = self.psql("SELECT recovery_v1.set_offline_policy(:'a', :'s');", 'h12', a=doc, s=sig)
        self.check("h12 a signed authorization with a floating window ('yesterday'..'tomorrow') is refused", rc != 0 and 'UTC instants' in out, out[-200:])

    def rotation(self, key_id, new_key_id):
        pub = json.loads(subprocess.run(['node', str(self.sim), 'keygen', str(self.keydir), new_key_id], text=True, capture_output=True, check=True).stdout)
        a, s = self.authorize(key_id, 'enroll-owner-key', {'newKey': pub, 'retireKeyId': key_id}, label='k3')
        rc, out = self.psql("SELECT recovery_v1.enroll_owner_key(:'a', :'s');", 'k3', a=a, s=s)
        self.check('k03 a new owner key is enrolled by an owner-signed authorization; the old key is retired', rc == 0 and '"enrolled"' in out, out[-200:])
        q = "CREATE INDEX zz_after_rotation ON public.loyalty_points (created_at);"
        ao, so = self.authorize(key_id, 'migration', self.migration_payload('POST-V1-0015-old-key', q, ['CREATE INDEX']), label='k4')
        rc, out = self.apply(ao, so, q, 'k4')
        self.check('k04 the retired key no longer authorizes anything', rc != 0 and 'retired' in out, out[-200:])
        an, sn = self.authorize(new_key_id, 'migration', self.migration_payload('POST-V1-0015-new-key', q, ['CREATE INDEX']), label='k5')
        rc, out = self.apply(an, sn, q, 'k5')
        self.check('k05 the new key authorizes migrations', rc == 0 and '"applied"' in out, out[-200:])
        rc, out = self.psql("UPDATE recovery_v1.owner_keys SET retired_at = NULL;", 'k6')
        self.check('k06 owner keys change only inside an owner-signed enrollment', rc != 0 and 'OWNER_AUTHORIZATION_REQUIRED' in out, out[-200:])
