"""Recovery Script 2 -- OFFLINE-FIRST / OFFLINE-AUTHORIZATION adversarial module (server side).

Run (private disposable cluster only, synthetic data and keys):
  python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial --script2-post tools/recovery-v1/script2/off_offline_auth.py
  python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial --with-087 --script2-post tools/recovery-v1/script2/off_offline_auth.py

Every scenario is simulated exactly as offline-smoke.sql does it: test.login(<auth id>) + request.headers carrying the
x-orvix-offline header (as PostgREST presents it) + SET ROLE authenticated. Fixture rows that need the server MAC key
(expired-but-not-past-deadline, tampered, copied) are written as the cluster superuser, exactly like offline-smoke.sql.

Check naming: "OFF-oNN <scenario>". Checks that demonstrate a design limitation (not a feature that exists) are named
"LIMITATION: ..." and pass when the limitation is DEMONSTRATED (the number is recorded in the detail). Policy-dependent
behaviour is named "POLICY: ...". A defect is a check that asserts the CORRECT behaviour and therefore fails.
Machine-readable evidence: <run>/off-offline-auth.json.

Step 5 port (docs/recovery-v1/STEP5-DESIGN.md): a capability is issued only to an OWNER-APPROVED device that signs the request,
and an offline operation must carry the capability's own device signature. Every till below is therefore an owner-approved
fixture device (tools/recovery-v1/step5/s5lib.py, enrolled through the genuine protocol, its key held by the s5fx test signer):
issue() asks through s5fx.capability, and a sale is signed by the capability's device (s5fx.device). Three Script 2
LIMITATION checks are resolved by Step 5 and now assert the correct behaviour instead: o11 (a capability presented from another
device is held), o25 (cumulative exposure is bounded by the aggregate budgets), o27 (a renamed device id gets no capability).
"""
import json, pathlib, re, subprocess, sys, time, uuid
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'step5'))
import s5lib

A_ADMIN = 'a0000000-0000-4000-8000-000000000001'
A_MGR_A = 'a0000000-0000-4000-8000-000000000002'
A_A1 = 'a0000000-0000-4000-8000-000000000003'
A_A2 = 'a0000000-0000-4000-8000-000000000004'
A_B = 'a0000000-0000-4000-8000-000000000006'
A_UNREL = 'a0000000-0000-4000-8000-0000000000f1'
PROBE = re.compile(r'PROBE\|([^|]+)\|(.*)')


class Off:
    def __init__(self, ctx):
        self.ctx, self.run = ctx, ctx['run']
        self.results = []
        self.n = 0
        self.cap_dev = {}       # capability id -> the fixture device label it was issued to
        self.dev_user = {}      # fixture device label -> (org, shop, device id)

    def enroll_devices(self, specs):
        """Step 5: every till of this module is an owner-approved fixture device (genuine request + synthetic owner approval)."""
        dev = s5lib.DeviceSim(self.ctx['ROOT'])
        owner = s5lib.Owner(self.ctx['sql'], self.ctx['sim'], self.ctx['keydir'], self.run / 'off-owner')
        try:
            for label, org, shop, user in specs:
                e = s5lib.add_fixture_device(self.ctx['sql'], owner, dev, org, shop, user, label=label)
                self.dev_user[label] = (org, shop, e['deviceId'])
        finally:
            dev.close()

    def device_id(self, label):
        return self.dev_user[label][2]

    # -------------------------------------------------------------- plumbing
    def psql(self, script, label):
        self.n += 1
        r = subprocess.run(['psql', *self.ctx['dbargs']], input=script, text=True, env=self.ctx['env'],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (self.run / f'off-{self.n:02d}-{label}.log').write_text(script + '\n-- OUTPUT --\n' + r.stdout)
        return r.returncode, r.stdout

    def q(self, text):
        rc, out = self.psql(text, 'q')
        if rc:
            raise RuntimeError(out[-2000:])
        return out.strip()

    def check(self, name, ok, detail=''):
        self.results.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[-600:]})
        self.ctx['check'](name, bool(ok), detail)

    @staticmethod
    def probes(out):
        return {m.group(1): m.group(2).strip() for m in PROBE.finditer(out)}

    @staticmethod
    def hdr(cap, seq):
        return ("SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', '%s', 'deviceSeq', %s)::text)::text, false);"
                % (cap, seq))

    @staticmethod
    def raw_hdr(value_sql):
        return "SELECT set_config('request.headers', %s, false);" % value_sql

    NOHDR = "SELECT set_config('request.headers', '', false);"

    @staticmethod
    def sale_call(shift, key, qty=1, product='prod-1', paid=None, shop='shop-a'):
        price = {'prod-1': 1000, 'prod-2': 2000, 'prod-3': 3000}[product]
        paid = paid if paid is not None else price * qty
        k = 'NULL' if key is None else f"'{key}'"
        return (f"public.complete_sale('{shop}', '{shift}', 'CASH', {paid}, 0, '[{{\"product_id\":\"{product}\",\"qty\":{qty}}}]'::jsonb, NULL, {k})")

    @staticmethod
    def probe(tag, call):
        return (f"DO $p$ DECLARE r jsonb; BEGIN r := {call}; RAISE NOTICE 'PROBE|{tag}|accepted %', coalesce(r->'sale'->>'id', left(r::text, 80)); "
                f"EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PROBE|{tag}|%', SQLERRM; END $p$;")

    def as_user(self, auth, body, tx=None, device=''):
        """body runs as `authenticated` for auth; tx = None (autocommit), 'commit' or 'rollback'. device: the fixture device label whose
        signature the s5fx test signer attaches to ledger operations (Step 5; '' = the shop's default fixture device)."""
        pre = 'BEGIN;\n' if tx else ''
        post = ('COMMIT;\n' if tx == 'commit' else 'ROLLBACK;\n') if tx else ''
        return f"{pre}SELECT set_config('s5fx.device', '{device}', false);\nSELECT test.login('{auth}');\nSET ROLE authenticated;\n{body}\nRESET ROLE;\n{self.NOHDR}\n{post}"

    def issue(self, auth, device, shop='shop-a', org='org-test'):
        """Step 5: the device-signed capability request of an owner-approved fixture device (label)."""
        rc, out = self.psql(self.as_user(auth, f"SELECT s5fx.capability('{org}', '{shop}', '{device}')::text;"), 'issue')
        line = next((l for l in out.splitlines() if l.startswith('{')), None)
        if rc or not line:
            return {'outcome': 'error', 'raw': out[-400:]}
        r = json.loads(line)
        if r.get('outcome') == 'issued': self.cap_dev[r['capability']['id']] = device
        return r

    def cap_id(self, auth, device, shop='shop-a'):
        r = self.issue(auth, device, shop)
        if r.get('outcome') != 'issued':
            raise RuntimeError(f'capability not issued for {auth}/{device}: {r}')
        return r['capability']['id']

    def sale(self, auth, header_sql, shift, key, tag='s', device=None, **kw):
        """device: the fixture device that signs (default: the device of the capability named in the header, if known)."""
        if device is None:
            m = re.search(r"'capabilityId', '([0-9a-f-]{36})'", header_sql)
            device = self.cap_dev.get(m.group(1), '') if m else ''
        rc, out = self.psql(self.as_user(auth, header_sql + '\n' + self.probe(tag, self.sale_call(shift, key, **kw)), device=device), 'sale-' + tag)
        return self.probes(out).get(tag, f'NO-PROBE rc={rc} {out[-300:]}')

    def usage(self, cap):
        return self.q(f"SELECT count(*)||'/'||coalesce(sum(amount_mmk),0) FROM recovery_v1.offline_usage WHERE capability_id = '{cap}';")

    def open_shift(self, auth, user_id, shop):
        sid = self.q(f"SELECT id FROM public.shifts WHERE cashier_id = '{user_id}' AND shop_id = '{shop}' AND ended_at IS NULL ORDER BY 1 LIMIT 1;")
        if sid:
            return sid
        rc, out = self.psql(self.as_user(auth, self.NOHDR + f"\nSELECT public.open_shift('{shop}', 0, NULL, NULL, '{uuid.uuid4()}')->'shift'->>'id';",
                                         device=f'default:{shop}'), 'open-shift')   # Step 5: signed by a device OF that shop
        sid = self.q(f"SELECT id FROM public.shifts WHERE cashier_id = '{user_id}' AND shop_id = '{shop}' AND ended_at IS NULL ORDER BY 1 LIMIT 1;")
        if not sid:
            raise RuntimeError(f'no open shift for {user_id} in {shop}: {out[-400:]}')
        return sid

    def fixture_cap(self, src_cap, new_id, device, expires_sql, deadline_sql, issued_sql="now() - interval '2 days'", mac_override=None, doc_patch='', label='a1-fx'):
        """Insert a capability row as the superuser (like offline-smoke.sql o22): the document is re-built for new_id and
        MAC'd with the server key unless mac_override is given. doc_patch is a jsonb expression merged into the document."""
        mac = mac_override or "encode(recovery_v1.hmac_sha256(convert_to(x.doc::text, 'UTF8'), (SELECT k FROM recovery_v1.keys WHERE name = 'offline-mac')), 'hex')"
        patch = f" || {doc_patch}" if doc_patch else ''
        # Step 5: the row is bound to an owner-approved fixture device (its enrollment and device id)
        device = self.device_id(label); self.cap_dev[new_id] = label
        enr = self.q(f"SELECT enrollment_id FROM s5fx.devices WHERE label = '{label}';")
        return self.psql(f"""
INSERT INTO recovery_v1.offline_capabilities
SELECT '{new_id}'::uuid, c.org_id, c.shop_id, '{device}', c.user_id, y.ep, c.policy_scope, c.policy_status, {issued_sql}, y.ex, y.dl,
       (x.doc->>'maxOps')::int, (x.doc->>'maxAmountMmk')::bigint, c.allowed_ops, x.doc::text, {mac}, '{enr}'::uuid
  FROM recovery_v1.offline_capabilities c,
  LATERAL (SELECT (SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id = c.org_id) AS ep,
                  date_trunc('milliseconds', {expires_sql}) AS ex, date_trunc('milliseconds', {deadline_sql}) AS dl) y,
  LATERAL (SELECT jsonb_build_object('protocol','orvix-offline-capability-v1','id','{new_id}','orgId',c.org_id,'shopId',c.shop_id,'deviceId','{device}',
     'userId',c.user_id,'enrollmentId','{enr}','offlineEpoch',y.ep,'policyScope',c.policy_scope,'policyStatus',c.policy_status,
     'expiresAt', to_char(y.ex AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'maxOps',c.max_ops,'maxAmountMmk',c.max_amount_mmk,
     'syncDeadline', to_char(y.dl AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')){patch} AS doc) x
 WHERE c.id = '{src_cap}'::uuid;""", 'fixture-cap')

    # -------------------------------------------------------------- scenarios
    def all(self):
        q = self.q
        pol = q("SELECT max_ops||'/'||max_amount_mmk||'/'||max_lifetime_seconds||'/'||sync_grace_seconds||'/'||status FROM recovery_v1.offline_policy WHERE scope='*';")
        self.check('OFF-o00 precondition: owner-signed policy 3 ops / 20000 MMK / 3600 s / 86400 s grace; org-test ACTIVE',
                   pol == '3/20000/3600/86400/OWNER_APPROVED' and q("SELECT state FROM recovery_v1.org_state WHERE org_id='org-test';") == 'ACTIVE', pol)
        # synthetic stock fixture so that no scenario is decided by "insufficient stock" (superuser, org-test is ACTIVE)
        q("UPDATE public.inventory SET qty_base_units = 100000 WHERE shop_id IN ('shop-a','shop-b') AND product_id IN ('prod-1','prod-2','prod-3');")
        # Step 5: the module's tills, each an owner-approved fixture device (one enrollment per label)
        a1 = ['off-dev-a1-0001', 'off-dev-a1-dev1', 'a1-fx', 'off-dev-a1-expo', 'off-dev-a1-ops1', 'off-dev-a1-nall', 'off-dev-a1-conc', 'off-dev-a1-revk', 'off-dev-a1-epch']
        self.enroll_devices([(d, 'org-test', 'shop-a', 'u-cash-a1') for d in a1] + [('off-dev-admin-01', 'org-test', 'shop-a', 'u-admin')]
                            + [(d, 'org-test', 'shop-a', 'u-cash-a2') for d in ['off-dev-a2-cumu'] + [f'off-a2-rate{i}' for i in range(1, 6)]]
                            + [(f'off-dev-b-cumu{i}', 'org-test', 'shop-b', 'u-cash-b') for i in (1, 2, 3)])
        s_a1 = self.open_shift(A_A1, 'u-cash-a1', 'shop-a')
        s_a2 = self.open_shift(A_A2, 'u-cash-a2', 'shop-a')
        sale = self.sale

        # o01 valid sync accepted -------------------------------------------------------------
        cap = self.cap_id(A_A1, 'off-dev-a1-0001')
        k1 = str(uuid.uuid4())
        r1 = sale(A_A1, self.hdr(cap, 1), s_a1, k1, 'o01')
        self.check('OFF-o01 a valid offline sale synced with its capability is accepted; usage 1 op / 1000 MMK',
                   r1.startswith('accepted') and self.usage(cap) == '1/1000', f'{r1} usage={self.usage(cap)}')
        # o02 duplicate resend of the same op key: replay, counted once, amount not doubled
        r2 = sale(A_A1, self.hdr(cap, 1), s_a1, k1, 'o02')
        self.check('OFF-o02 duplicate resend (same op key, same seq) replays the same sale; usage still 1 op / 1000 MMK',
                   r2 == r1 and self.usage(cap) == '1/1000', f'{r2} usage={self.usage(cap)}')
        # o02b resend of the same key with ANOTHER seq (client bug / tamper): still a replay, no new usage
        r2b = sale(A_A1, self.hdr(cap, 7), s_a1, k1, 'o02b')
        self.check('OFF-o02b resend of the same op key under a different deviceSeq replays; no second usage row',
                   r2b == r1 and self.usage(cap) == '1/1000', f'{r2b} usage={self.usage(cap)}')
        # o03 replayed deviceSeq with another op key
        r3 = sale(A_A1, self.hdr(cap, 1), s_a1, str(uuid.uuid4()), 'o03')
        self.check('OFF-o03 a reused deviceSeq with another op key is held (offline_device_sequence_reused), nothing recorded',
                   'offline_device_sequence_reused' in r3 and self.usage(cap) == '1/1000', r3)
        # o04 forged header: random capability id
        r4 = sale(A_A1, self.hdr(uuid.uuid4(), 1), s_a1, str(uuid.uuid4()), 'o04')
        self.check('OFF-o04 forged header (random capability uuid) is held (offline_capability_unknown)', 'offline_capability_unknown' in r4, r4)
        # o05 malformed headers
        bad = {
            'o05a': "'{\"x-orvix-offline\":\"not json\"}'",
            'o05b': "'{\"x-orvix-offline\":\"{\\\"capabilityId\\\":\\\"zzz\\\",\\\"deviceSeq\\\":1}\"}'",
            'o05c': f"'{{\"x-orvix-offline\":\"{{\\\"capabilityId\\\":\\\"{cap}\\\",\\\"deviceSeq\\\":0}}\"}}'",
            'o05d': f"'{{\"x-orvix-offline\":\"{{\\\"capabilityId\\\":\\\"{cap}\\\",\\\"deviceSeq\\\":-4}}\"}}'",
            'o05e': f"'{{\"x-orvix-offline\":\"{{\\\"capabilityId\\\":\\\"{cap}\\\",\\\"deviceSeq\\\":\\\"abc\\\"}}\"}}'",
            'o05f': "'{\"x-orvix-offline\":\"{}\"}'",
            'o05g': f"'{{\"x-orvix-offline\":\"{{\\\"capabilityId\\\":\\\"{cap}\\\",\\\"deviceSeq\\\":1.5}}\"}}'",
        }
        res5 = {t: sale(A_A1, self.raw_hdr(v), s_a1, str(uuid.uuid4()), t) for t, v in bad.items()}
        self.check('OFF-o05 malformed headers (not JSON, bad uuid, seq 0 / negative / text / fractional, empty object) are all held, none accepted',
                   all(not v.startswith('accepted') and 'offline_' in v for v in res5.values()) and self.usage(cap) == '1/1000', json.dumps(res5))
        # o06 JSON null header value == online (same class as omission)
        r6 = sale(A_A1, self.raw_hdr("'{\"x-orvix-offline\":\"null\"}'"), s_a1, str(uuid.uuid4()), 'o06')
        self.check('OFF-o06 LIMITATION: x-orvix-offline: null is treated as an ONLINE operation (accepted, no usage) -- same class as omitting the header',
                   r6.startswith('accepted'), r6)
        # o07 till OMITS the header -> online
        r7 = sale(A_A1, self.NOHDR, s_a1, str(uuid.uuid4()), 'o07')
        self.check('OFF-o07 LIMITATION: a till that OMITS the header is treated as online (accepted, no offline usage, no capability needed)',
                   r7.startswith('accepted') and self.usage(cap) == '1/1000', r7)
        # o08 offline header with NULL idempotency key: is the capability still enforced?
        r8 = sale(A_A1, self.hdr(uuid.uuid4(), 99), s_a1, None, 'o08')
        self.check('OFF-o08 an offline-marked sale WITHOUT an idempotency key is still verified (unknown capability must be held, not accepted)',
                   not r8.startswith('accepted'), r8)
        # o09 another cashier presents A1's capability
        r9 = sale(A_A2, self.hdr(cap, 2), s_a2, str(uuid.uuid4()), 'o09')
        self.check('OFF-o09 another cashier presenting A1\'s capability is held (offline_capability_binding)', 'offline_capability_binding' in r9, r9)
        # o10 another organization's capability (org-unrelated made ACTIVE for this rolled-back transaction only)
        # Step 5: org-unrelated is reopened through the genuine owner-signed protocol (was a rolled-back superuser UPDATE) and its
        # capability is requested by its own owner-approved fixture device
        self.ctx['activate']('org-unrelated')
        rc, out = self.psql(f"""SELECT test.login('{A_UNREL}'); SET ROLE authenticated;
SELECT s5fx.capability('org-unrelated','shop-unrel','default:shop-unrel')->'capability'->>'id' AS ucap \\gset
RESET ROLE; SELECT test.login('{A_A1}'); SELECT set_config('s5fx.device', 'off-dev-a1-0001', false);
SELECT set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', :'ucap', 'deviceSeq', 1)::text)::text, false);
SET ROLE authenticated;
{self.probe('o10', self.sale_call(s_a1, uuid.uuid4()))}
RESET ROLE; {self.NOHDR}""", 'o10')
        r10 = self.probes(out).get('o10', out[-300:])
        self.check('OFF-o10 a capability of another organization is held (offline_capability_binding)', 'offline_capability_binding' in r10, r10)
        # o11 capability of another DEVICE: the header carries no device identity
        cap_d1 = self.cap_id(A_A1, 'off-dev-a1-dev1')
        r11 = sale(A_A1, self.hdr(cap_d1, 1), s_a1, str(uuid.uuid4()), 'o11', device='off-dev-a1-0001')
        self.check('OFF-o11 (Step 5: limitation resolved) a capability issued for device D1 and presented from another till of the same cashier is held '
                   '(offline_capability_device: the operation must carry D1\'s own device signature)', 'offline_capability_device' in r11, r11)

        # o17 exposure: ops and amount ------------------------------------------------------------------
        cx = self.cap_id(A_A1, 'off-dev-a1-expo')
        ra = sale(A_A1, self.hdr(cx, 1), s_a1, str(uuid.uuid4()), 'o17a', product='prod-3', qty=6)       # 18000
        rb = sale(A_A1, self.hdr(cx, 2), s_a1, str(uuid.uuid4()), 'o17b', product='prod-1', qty=3)       # 3000 -> 21000 > 20000
        rc_ = sale(A_A1, self.hdr(cx, 3), s_a1, str(uuid.uuid4()), 'o17c', product='prod-1', qty=2)      # 2000 -> exactly 20000
        rd = sale(A_A1, self.hdr(cx, 4), s_a1, str(uuid.uuid4()), 'o17d', product='prod-1', qty=1)  # 0 amount left
        u17 = self.usage(cx)
        self.check('OFF-o17 exposure amount: 18000 accepted, +3000 held (offline_exposure_amount), +2000 (=20000 exactly) accepted, +1000 held',
                   ra.startswith('accepted') and 'offline_exposure_amount' in rb and rc_.startswith('accepted') and 'offline_exposure_amount' in rd and u17 == '2/20000',
                   f'{ra} | {rb} | {rc_} | {rd} | usage={u17}')
        co = self.cap_id(A_A1, 'off-dev-a1-ops1')
        ro = [sale(A_A1, self.hdr(co, i), s_a1, str(uuid.uuid4()), f'o18{i}') for i in (1, 2, 3, 4)]
        self.check('OFF-o18 exposure ops: 3 accepted, the 4th held (offline_exposure_ops); usage 3 ops',
                   all(x.startswith('accepted') for x in ro[:3]) and 'offline_exposure_ops' in ro[3] and self.usage(co) == '3/3000', ' | '.join(ro))
        # o19 offline header on an operation that is not allowed offline
        sale_id = r1.split(' ', 1)[1] if r1.startswith('accepted') else 'none'
        cn = self.cap_id(A_A1, 'off-dev-a1-nall')
        rc, out = self.psql(self.as_user(A_A1, self.hdr(cn, 1) + '\n' + self.probe('o19', f"public.log_receipt_reprint('{sale_id}', '{uuid.uuid4()}')")), 'o19')
        r19 = self.probes(out).get('o19', out[-300:])
        self.check('OFF-o19 an offline-marked operation that is not a sale (receipt reprint) is held (offline_operation_not_allowed)',
                   'offline_operation_not_allowed' in r19, r19)
        # o20 shop binding: ADMIN's capability for shop-a used for a sale in shop-b
        s_adm_b = self.open_shift(A_ADMIN, 'u-admin', 'shop-b')
        cadm = self.cap_id(A_ADMIN, 'off-dev-admin-01', shop='shop-a')
        r20 = sale(A_ADMIN, self.hdr(cadm, 1), s_adm_b, str(uuid.uuid4()), 'o20', shop='shop-b')
        self.check('OFF-o20 a capability issued for shop-a must not authorize an offline sale in shop-b (held, not accepted)',
                   not r20.startswith('accepted'), f'{r20} usage={self.usage(cadm)}')

        # o21 concurrent syncs of one capability cannot exceed the amount ----------------------------------
        cc = self.cap_id(A_A1, 'off-dev-a1-conc')
        s1 = (f"BEGIN; SELECT test.login('{A_A1}'); SELECT set_config('s5fx.device', 'off-dev-a1-conc', false); {self.hdr(cc, 1)} SET ROLE authenticated; "
              f"{self.probe('c1', self.sale_call(s_a1, uuid.uuid4(), product='prod-3', qty=5))} SELECT pg_sleep(2); COMMIT;")
        p1 = subprocess.Popen(['psql', *self.ctx['dbargs']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=self.ctx['env'])
        p1.stdin.write(s1); p1.stdin.close()
        for _ in range(200):
            if q(f"SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.query LIKE '%pg_sleep(2)%' AND l.locktype='advisory';") not in ('', '0'):
                break
            time.sleep(0.02)
        r21b = sale(A_A1, self.hdr(cc, 2), s_a1, str(uuid.uuid4()), 'c2', product='prod-3', qty=5)
        o1 = p1.stdout.read(); p1.wait()
        (self.run / 'off-concurrent-session1.log').write_text(o1)
        r21a = self.probes(o1).get('c1', o1[-200:])
        self.check('OFF-o21 two concurrent syncs under one capability (15000 + 15000 > 20000): one accepted, the other held; usage 1 op / 15000',
                   r21a.startswith('accepted') and 'offline_exposure_amount' in r21b and self.usage(cc) == '1/15000', f'{r21a} | {r21b} | usage={self.usage(cc)}')

        # o22 issuance refusals ----------------------------------------------------------------------------
        rc, out = self.psql(f"""BEGIN; UPDATE recovery_v1.org_state SET state='RESTRICTED' WHERE org_id='org-test';
{self.as_user(A_A2, "SELECT 'R='||(public.recovery_v1_offline_capability('org-test','shop-a','off-dev-a2-rest')->>'reason');")}
ROLLBACK;""", 'o22')
        self.check('OFF-o22 no capability while the organization is not ACTIVE (organization_not_active)', 'R=organization_not_active' in out, out[-200:])
        rc, out = self.psql(f"""BEGIN;
INSERT INTO recovery_v1.authorized_txn(txid, purpose, ref) VALUES (txid_current(), 'offline-policy', 'org-test');
INSERT INTO recovery_v1.offline_policy(scope, max_lifetime_seconds, max_ops, max_amount_mmk, sync_grace_seconds, status) VALUES ('org-test', 3600, 3, 20000, 86400, 'DEFAULT_UNAPPROVED');
{self.as_user(A_A2, "SELECT 'R='||(public.recovery_v1_offline_capability('org-test','shop-a','off-dev-a2-unap')->>'reason');")}
ROLLBACK;""", 'o23')
        self.check('OFF-o23 an unapproved (DEFAULT_UNAPPROVED) org policy issues nothing (offline_policy_not_approved; superuser fixture, rolled back)',
                   'R=offline_policy_not_approved' in out, out[-300:])
        # o24 rate limit 30 / hour / cashier (A2, rolled back)
        # Step 5: the aggregate budgets would stop issuance before 30, so this rolled-back transaction gives org-test a generous
        # (superuser fixture) policy; the requests come from 5 owner-approved fixture devices of A2, in turn
        rc, out = self.psql("BEGIN;\nINSERT INTO recovery_v1.authorized_txn(txid, purpose, ref) VALUES (txid_current(), 'offline-policy', 'org-test');\n"
            "INSERT INTO recovery_v1.offline_policy(scope, max_lifetime_seconds, max_ops, max_amount_mmk, sync_grace_seconds, status, auth_sha256, org_budget_mmk, shop_budget_mmk, device_budget_mmk)"
            " VALUES ('org-test', 3600, 3, 20000, 86400, 'OWNER_APPROVED', repeat('0',64), 1000000000, 1000000000, 1000000000);\n"
            "DELETE FROM recovery_v1.authorized_txn WHERE txid = txid_current();\n"
            + self.as_user(A_A2, """DO $r$ DECLARE r jsonb; n int := 0; i int; first_refusal int; BEGIN
 FOR i IN 1..35 LOOP r := s5fx.capability('org-test','shop-a','off-a2-rate'||(1 + i % 5)::text);
   IF r->>'outcome' = 'issued' THEN n := n + 1; ELSIF first_refusal IS NULL THEN first_refusal := i; RAISE NOTICE 'PROBE|why|%', r->>'reason'; END IF; END LOOP;
 RAISE NOTICE 'PROBE|rate|%|%', n, first_refusal; END $r$;""") + "ROLLBACK;\n", 'o24')
        pr = self.probes(out)
        existing = q("SELECT count(*) FROM recovery_v1.offline_capabilities WHERE user_id='u-cash-a2' AND issued_at > now() - interval '1 hour';")
        self.check('OFF-o24 issuance is rate limited at 30 per cashier per hour (rate_limited)',
                   pr.get('why') == 'rate_limited' and pr.get('rate', '').split('|')[0] == str(30 - int(existing)), f"{pr} existing={existing}")

        # o25 cumulative exposure (LIMITATION) -------------------------------------------------------------
        self.cumulative(s_a2)

        # o26 revocation while offline, then sync => held; o27 device fungibility -------------------------
        cr = self.cap_id(A_A1, 'off-dev-a1-revk')
        rc, out = self.psql(self.as_user(A_ADMIN, f"SELECT public.recovery_v1_revoke_device('org-test','{self.device_id('off-dev-a1-revk')}','Synthetic: till lost')::text;"), 'revoke')
        r26 = sale(A_A1, self.hdr(cr, 1), s_a1, str(uuid.uuid4()), 'o26')
        again = self.issue(A_A1, 'off-dev-a1-revk')
        # Step 5: the revoked device's signature is refused by the device-trust check itself (device_revoked), before the offline check
        self.check('OFF-o26 revoked while offline: the sync is held (device_revoked / offline_device_revoked) and the device gets no new capability (device_revoked)',
                   ('offline_device_revoked' in r26 or 'device_revoked' in r26) and again.get('reason') == 'device_revoked', f'{r26} | {again}')
        renamed = 'till-renamed-' + uuid.uuid4().hex[:8]
        rc, out = self.psql(self.as_user(A_A1, f"""SELECT s5fx.request_header('org-test', 'off-dev-a1-0001', 'recovery_v1_offline_capability:shop-a:{renamed}') IS NOT NULL AS h,
  public.recovery_v1_offline_capability('org-test', 'shop-a', '{renamed}')->>'reason' AS why \\gset
SELECT 'PROBE|o27|'||:'why';"""), 'o27')
        r27 = self.probes(out).get('o27', out[-300:])
        self.check('OFF-o27 (Step 5: limitation resolved) a renamed, unapproved device id gets no capability (the request must come from the owner-approved '
                   'device it names: device_binding); revocation cannot be bypassed by renaming', r27 == 'device_binding', r27)

        # o28 org restricted while offline, reactivated (epoch bump) => held (LAST: invalidates every outstanding capability)
        ce = self.cap_id(A_A1, 'off-dev-a1-epch')
        ep0 = q("SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='org-test';")
        rc, out = self.psql(self.as_user(A_ADMIN, "SELECT public.recovery_v1_transition('org-test','RESTRICTED','synthetic recovery event','synthetic-evidence')::text;"), 'restrict')
        r28a = sale(A_A1, self.hdr(ce, 1), s_a1, str(uuid.uuid4()), 'o28a')
        self.ctx['activate']('org-test')   # Step 5: genuine owner-signed reopening of the new incident (synthetic owner)
        ep1 = q("SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='org-test';")
        r28b = sale(A_A1, self.hdr(ce, 1), s_a1, str(uuid.uuid4()), 'o28b')
        self.check('OFF-o28 restricted while offline: refused while RESTRICTED (ORG_SUSPENDED), and after reactivation the older-epoch capability is held '
                   '(offline_capability_stale_epoch); epoch +1', 'ORG_SUSPENDED' in r28a and 'offline_capability_stale_epoch' in r28b and int(ep1) == int(ep0) + 1,
                   f'{r28a} | {r28b} | epoch {ep0}->{ep1}')
        # Step 5: the superuser-planted capability rows below (o13 copy / o14 forgery with 1,000,000,000 MMK limits) count against the
        # aggregate budgets like any capability (fail-safe), so they run AFTER o28 (a new offline epoch), not before the issuance scenarios
        # o12 MAC-tampered row / copied row / forged with the key ---------------------------------------
        t_id = str(uuid.uuid4())
        rc, out = self.fixture_cap(cap, t_id, None, "now() + interval '1 hour'", "now() + interval '1 day'", mac_override="repeat('0', 64)")
        r12 = sale(A_A1, self.hdr(t_id, 1), s_a1, str(uuid.uuid4()), 'o12') if rc == 0 else f'fixture failed {out[-200:]}'
        self.check('OFF-o12 a row whose MAC does not match its document is held (offline_capability_integrity)', 'offline_capability_integrity' in r12, r12)
        c_id = str(uuid.uuid4())
        rc, out = self.psql(f"""INSERT INTO recovery_v1.offline_capabilities SELECT '{c_id}'::uuid, org_id, shop_id, device_id, user_id, offline_epoch, policy_scope, policy_status,
  now() - interval '2 days', expires_at, sync_deadline, 1000, 1000000000, allowed_ops, document, mac, enrollment_id FROM recovery_v1.offline_capabilities WHERE id = '{cap}'::uuid;""", 'copy')
        r13 = sale(A_A1, self.hdr(c_id, 1), s_a1, str(uuid.uuid4()), 'o13') if rc == 0 else f'fixture failed {out[-200:]}'
        self.check('OFF-o13 a copied row (another capability\'s document + MAC under a new id, raised limits) is held (offline_capability_integrity)',
                   'offline_capability_integrity' in r13, r13)
        f_id = str(uuid.uuid4())
        rc, out = self.fixture_cap(cap, f_id, None, "now() + interval '1 hour'", "now() + interval '1 day'",
                                   doc_patch="jsonb_build_object('maxOps', 1000, 'maxAmountMmk', 1000000000)")
        r14 = sale(A_A1, self.hdr(f_id, 1), s_a1, str(uuid.uuid4()), 'o14', product='prod-3', qty=10) if rc == 0 else f'fixture failed {out[-200:]}'
        self.check('OFF-o14 LIMITATION: a database superuser who reads recovery_v1.keys can mint a valid capability with any limits '
                   '(the MAC key lives in the same database; MAC only stops edits made without it)', r14.startswith('accepted'), r14)

        # o15 expired but before deadline / o16 after deadline ------------------------------------------
        e_id = str(uuid.uuid4())
        rc, out = self.fixture_cap(cap, e_id, None, "now() - interval '10 minutes'", "now() + interval '20 hours'")
        r15 = sale(A_A1, self.hdr(e_id, 1), s_a1, str(uuid.uuid4()), 'o15') if rc == 0 else f'fixture failed {out[-200:]}'
        self.check('OFF-o15 POLICY: an operation synced AFTER expires_at but before sync_deadline is ACCEPTED (server checks only the deadline; '
                   'expiry is enforced by the till alone)', r15.startswith('accepted'), r15)
        d_id = str(uuid.uuid4())
        rc, out = self.fixture_cap(cap, d_id, None, "now() - interval '2 days'", "now() - interval '1 second'")
        r16 = sale(A_A1, self.hdr(d_id, 1), s_a1, str(uuid.uuid4()), 'o16') if rc == 0 else f'fixture failed {out[-200:]}'
        self.check('OFF-o16 an operation synced after the sync deadline is held (offline_capability_sync_deadline)', 'offline_capability_sync_deadline' in r16, r16)

        (self.run / 'off-offline-auth.json').write_text(json.dumps(self.results, indent=1) + '\n')

    def cumulative(self, s_a2):
        """One cashier / one device: how much offline value can be ACCEPTED in one hour? (rolled back)
        Step 5: issuance is bounded by the AGGREGATE budgets (owner-signed policy: device 100,000 / shop 500,000 / org 1,000,000);
        a cashier cannot invent device ids (only owner-approved devices sign), so B uses its 3 approved devices in turn."""
        s_b = self.open_shift(A_B, 'u-cash-b', 'shop-b')
        body = """DO $x$ DECLARE r jsonb; s jsonb; n_cap int := 0; n_ok int := 0; v bigint := 0; i int; dev text; BEGIN
 FOR i IN 1..40 LOOP
   dev := CASE WHEN %(one_device)s THEN '%(dev)s' ELSE '%(dev)s'||(1 + i %% 3)::text END;
   r := s5fx.capability('org-test', '%(shop)s', dev);
   PERFORM set_config('s5fx.device', dev, false);
   EXIT WHEN r->>'outcome' <> 'issued';
   n_cap := n_cap + 1;
   PERFORM set_config('request.headers', jsonb_build_object('x-orvix-offline', jsonb_build_object('capabilityId', r->'capability'->>'id', 'deviceSeq', 1)::text)::text, false);
   BEGIN
     s := public.complete_sale('%(shop)s', '%(shift)s', 'CASH', 20000, 0, '[{"product_id":"prod-2","qty":10}]'::jsonb, NULL, gen_random_uuid());
     n_ok := n_ok + 1; v := v + 20000;
   EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PROBE|err%(tag)s|%%', SQLERRM; END;
 END LOOP;
 PERFORM set_config('request.headers', '', false);
 RAISE NOTICE 'PROBE|%(tag)s|%%|%%|%%', n_cap, n_ok, v; END $x$;"""
        script = (
            "BEGIN;\nUPDATE public.inventory SET qty_base_units = 100000 WHERE product_id = 'prod-2';\n"
            + self.as_user(A_A2, body % dict(one_device='true', dev='off-dev-a2-cumu', shop='shop-a', shift=s_a2, tag='a2'))
            + self.as_user(A_B, body % dict(one_device='false', dev='off-dev-b-cumu', shop='shop-b', shift=s_b, tag='b'))
            + "SELECT 'TOTAL='||coalesce(sum(u.amount_mmk),0)||'/'||count(*) FROM recovery_v1.offline_usage u JOIN recovery_v1.offline_capabilities c ON c.id=u.capability_id "
              "WHERE c.enrollment_id IN (SELECT enrollment_id FROM s5fx.devices WHERE label LIKE 'off-dev-a2-cumu%' OR label LIKE 'off-dev-b-cumu%');\nROLLBACK;\n")
        rc, out = self.psql(script, 'o25-cumulative')
        pr = self.probes(out)
        a2 = [int(x) for x in pr.get('a2', '0|0|0').split('|')]
        b = [int(x) for x in pr.get('b', '0|0|0').split('|')]
        tot = re.search(r'TOTAL=(\d+)/(\d+)', out)
        accepted = int(tot.group(1)) if tot else -1
        cashiers = int(self.q("SELECT count(*) FROM public.users WHERE org_id='org-test';"))
        dev_budget = int(self.q("SELECT device_budget_mmk FROM recovery_v1.offline_policy WHERE scope='*';"))
        shop_budget = int(self.q("SELECT shop_budget_mmk FROM recovery_v1.offline_policy WHERE scope='*';"))
        detail = (f'policy maxAmount=20000/cap, budgets device {dev_budget} / shop {shop_budget}; cashier A2 ONE device: {a2[0]} caps, {a2[1]} sales accepted = {a2[2]} MMK; '
                  f'cashier B, its 3 approved devices in turn: {b[0]} caps, {b[2]} MMK; accepted total {accepted} MMK (Script 2 without budgets: unbounded per hour)')
        self.check('OFF-o25 (Step 5: limitation resolved) cumulative offline exposure is bounded: one device stops at its device budget, a cashier '
                   'cannot invent device ids, and every issuance counts against the shop and organization budgets',
                   a2[2] <= dev_budget and a2[0] == dev_budget // 20000 and b[2] <= 3 * dev_budget and accepted == a2[2] + b[2] and accepted <= shop_budget,
                   detail + ' ' + json.dumps({k: v for k, v in pr.items() if k.startswith('err')})[:200])
        (self.run / 'off-cumulative.txt').write_text(detail + '\n')


def run(ctx):
    Off(ctx).all()
