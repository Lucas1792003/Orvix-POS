"""Step 5 database suite: device trust, owner-authorized reopening, aggregate offline budgets, operator boundary.

Runs on db-smoke.py's private disposable cluster AFTER Recovery V1 and the Step 4 suite (--script2-post), with the seed
tools/recovery-v1/step5/s5_seed.sql applied BEFORE V1 (--script2-pre). Every signature comes from outside the database:
owner authorizations from owner-sim.mjs (synthetic owner key in the run directory), device signatures from device-sim.mjs.
The fixture device signer (s5fx) is switched OFF in every session of this suite (s5fx.disabled = on).
Results: <run>/s5-results.json (id, scenario, expected, actual, PASS/FAIL).
"""
import json, pathlib, subprocess, sys, time, uuid, datetime
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s5lib
from s5lib import q

A_ADMIN = 'a0000000-0000-4000-8000-000000000001'
A_A1 = 'a0000000-0000-4000-8000-000000000003'
A_A2 = 'a0000000-0000-4000-8000-000000000004'
A_B = 'a0000000-0000-4000-8000-000000000006'
A_UNREL = 'a0000000-0000-4000-8000-0000000000f1'
A_S5A = 'a0000000-0000-4000-8000-0000000005a1'
A_S5B = 'a0000000-0000-4000-8000-0000000005b1'
SALE = "public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', {amt}, 0, '[{{\"product_id\":\"prod-1\",\"qty\":1}}]'::jsonb, NULL, {key})"


class S5:
    def __init__(self, ctx):
        self.c = ctx; self.run = ctx['run']; self.results = []
        self.dev = s5lib.DeviceSim(ctx['ROOT'])
        self.owner = s5lib.Owner(ctx['sql'], ctx['sim'], ctx['keydir'], self.run / 's5suite')
        self.ctr = {}
        self.n = 0

    # ------------------------------------------------------------------ plumbing
    def psql(self, script, label):
        self.n += 1
        r = subprocess.run(['psql', *self.c['dbargs']], input="SET s5fx.disabled = 'on';\n" + script, text=True, env=self.c['env'],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (self.run / f's5-{self.n:03d}-{label}.log').write_text(r.stdout)
        return r.returncode, r.stdout

    def sql(self, text, label='q'):
        rc, out = self.psql(text, label)
        if rc: raise RuntimeError(f'{label}: {out[-1500:]}')
        return out.strip()

    def as_user(self, auth, body, headers=None, label='u', role=True):
        h = json.dumps(headers) if headers else ''
        r1, r2 = ('SET ROLE authenticated;\n', 'RESET ROLE;\n') if role else ('', '')
        return self.psql(f"SELECT test.login('{auth}');\nSELECT set_config('request.headers', {q(h)}, false) IS NOT NULL AS headers_set;\n{r1}{body}\n{r2}", label)

    @staticmethod
    def msg(out):
        errs = [l for l in out.splitlines() if 'ERROR:' in l]
        return ' | '.join(errs)[-600:] if errs else out[-400:]

    def call(self, auth, action, args, label):
        rc, out = self.as_user(auth, f"SELECT public.recovery_v1_call({q(action)}, {q(json.dumps(args))}::jsonb)::text;", label=label)
        try: return json.loads([l for l in out.splitlines() if l.startswith('{')][-1]) if rc == 0 else {'error': self.msg(out)}
        except Exception: return {'error': self.msg(out)}

    def record(self, rid, scenario, expected, actual, ok):
        status = 'PASS' if ok else 'FAIL'
        self.results.append({'id': rid, 'scenario': scenario, 'expected': expected, 'actual': str(actual)[-400:], 'status': status})
        self.c['check'](f'S5-{rid} {scenario}', ok, str(actual)[-280:])

    # ------------------------------------------------------------------ devices
    def new_device(self, org, shop, auth, replaces=None, device_id=None, label='dev'):
        h = f'{label}-{uuid.uuid4().hex[:6]}'
        k = self.dev.call('keygen', handle=h)
        did = device_id or f'till-{uuid.uuid4()}'
        req = self.dev.call('request', handle=h, orgId=org, shopId=shop, deviceId=did, replacesEnrollmentId=replaces)
        r = self.call(auth, 'device.request', {'request': req['request'], 'signature': req['signature']}, f'req-{label}')
        return {'handle': h, 'deviceId': did, 'fingerprint': k['fingerprint'], 'n': k['n'], 'req': req, 'requested': r, 'org': org, 'shop': shop}

    def approval(self, d, **over):
        dev = {'requestId': d['req']['requestId'], 'orgId': d['org'], 'shopId': d['shop'], 'deviceId': d['deviceId'], 'keyFingerprint': d['fingerprint'],
               'requestNonce': d['req']['requestNonce'], 'notAfter': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
               'replacesEnrollmentId': d['req'] and json.loads(d['req']['request'])['replacesEnrollmentId']}
        dev.update(over.pop('device', {}))
        payload = {'scope': over.pop('scope', d['org']), 'ownerId': s5lib.FIXTURE_OWNER, 'device': dev}
        return self.owner.authorize('enroll-device', payload, **over)

    def enroll(self, org, shop, auth, label='dev', **kw):
        d = self.new_device(org, shop, auth, label=label, **kw)
        a, s = self.approval(d)
        r = self.call(auth, 'device.approve', {'authorization': a, 'signature': s}, f'approve-{label}')
        d['enrollmentId'] = r.get('enrollmentId'); d['approved'] = r
        return d

    def header(self, d, key, rpc, counter=None, include_key=False, offline=None):
        if counter is None:
            self.ctr[d['handle']] = self.ctr.get(d['handle'], 0) + 1; counter = self.ctr[d['handle']]
        marker = f"{offline['capabilityId']}:{offline['deviceSeq']}" if offline else 'online'
        return self.dev.call('header', handle=d['handle'], enrollmentId=d['enrollmentId'], orgId=d['org'], shopId=d['shop'], key=key, rpc=rpc,
                             counter=counter, includeKey=include_key, marker=marker)['header']

    def sale(self, auth, d, key=None, amt=1000, offline=None, label='sale', hdr=None):
        key = key or str(uuid.uuid4())
        headers = {}
        if d is not None: headers['x-orvix-device'] = hdr or self.header(d, key, 'complete_sale', offline=offline)
        if offline: headers['x-orvix-offline'] = json.dumps(offline)
        rc, out = self.as_user(auth, f"SELECT {SALE.format(amt=amt, key=q(key))}::text;", headers or None, label)
        return ('ok ' + out[-200:] if rc == 0 and '"sale"' in out else 'refused ' + self.msg(out)), key

    def idem(self, auth, d, key, hdr=None, label='idem'):
        headers = {'x-orvix-device': hdr} if hdr else ({'x-orvix-device': self.header(d, key, 'complete_sale')} if d else None)
        # idem_begin is the ledger entry every keyed RPC calls (not granted to the API roles): called as the logged-in user's
        # session (auth.uid) without SET ROLE, which isolates the ledger guard from each RPC's own validation
        # rolled back: an accepted probe must not leave an unfinished ledger operation behind (reconciliation would rightly
        # report it as a hard blocker, ledger_in_flight)
        rc, out = self.as_user(auth, f"BEGIN;\nSELECT public.idem_begin({q(key)}::uuid, 'complete_sale', md5('s5'))::text;\nROLLBACK;", headers, label, role=False)
        return 'ok ' + out[-200:] if rc == 0 else 'refused ' + self.msg(out)

    def capability(self, auth, d, label='cap'):
        key = str(uuid.uuid4())
        h = self.header(d, key, f"recovery_v1_offline_capability:{d['shop']}:{d['deviceId']}", include_key=True)
        rc, out = self.as_user(auth, f"SELECT public.recovery_v1_offline_capability({q(d['org'])},{q(d['shop'])},{q(d['deviceId'])})::text;", {'x-orvix-device': h}, label)
        try: return json.loads([l for l in out.splitlines() if l.startswith('{')][-1])
        except Exception: return {'error': self.msg(out)}

    def surrender(self, auth, d, cap_id, ops, amount, label='surrender', hdr=None):
        key = str(uuid.uuid4())
        h = hdr or self.header(d, key, f'recovery_v1_offline_surrender:{cap_id}:{ops}:{amount}', include_key=True)
        rc, out = self.as_user(auth, f"SELECT public.recovery_v1_call('offline.surrender', {q(json.dumps({'capabilityId': cap_id, 'opsRecorded': ops, 'amountRecordedMmk': amount}))}::jsonb)::text;",
                               {'x-orvix-device': h}, label)
        try: return json.loads([l for l in out.splitlines() if l.startswith('{')][-1]), h
        except Exception: return {'error': self.msg(out)}, h

    def attest(self, d, auth, pending=0, incident=None, epoch=None, sign_with=None, label='attest', attested_at=None):
        st = self.sql(f"SELECT incident_id||' '||recovery_epoch FROM recovery_v1.org_state WHERE org_id={q(d['org'])};").split()
        stmt = json.dumps({'protocol': 'orvix-device-attestation-v1', 'enrollmentId': d['enrollmentId'], 'orgId': d['org'], 'incidentId': incident or st[0],
                           'recoveryEpoch': int(epoch or st[1]), 'journalSequence': 0, 'journalHead': None, 'pendingOperations': pending,
                           'attestedAt': attested_at or s5lib.now_iso()})
        sig = self.dev.call('sign', handle=sign_with or d['handle'], text=stmt)['signature']
        return self.call(auth, 'device.attest', {'statement': stmt, 'signature': sig}, label)

    def state(self, org):
        return self.sql(f"SELECT state FROM recovery_v1.org_state WHERE org_id={q(org)};")


def device_trust(x):
    # D1-D4: requests
    a = x.new_device('org-test', 'shop-a', A_A1, label='A')
    x.record('D01', 'a till requests enrollment with proof of possession -> PENDING', 'pending', a['requested'],
             a['requested'].get('outcome') == 'pending' and x.call(A_A1, 'device.status', {'deviceId': a['deviceId']}, 'st-A').get('state') == 'PENDING')
    h = 'other-' + uuid.uuid4().hex[:4]; x.dev.call('keygen', handle=h)
    k2 = x.dev.call('keygen', handle='pk-' + h)
    bad = x.dev.call('request', handle='pk-' + h, signWith=h, orgId='org-test', shopId='shop-a', deviceId=f'till-{uuid.uuid4()}')
    r = x.call(A_A1, 'device.request', {'request': bad['request'], 'signature': bad['signature']}, 'req-pop')
    x.record('D02', 'a request not signed by the key it enrolls is refused', 'refused (proof of possession)', r, 'not signed by the key it enrolls' in r.get('error', ''))
    o = x.dev.call('request', handle='pk-' + h, orgId='org-unrelated', shopId='shop-unrel', deviceId=f'till-{uuid.uuid4()}')
    r = x.call(A_A1, 'device.request', {'request': o['request'], 'signature': o['signature']}, 'req-org')
    x.record('D03', 'a cashier cannot request enrollment for another organization', 'refused', r, 'DEVICE_REQUEST_INVALID' in r.get('error', ''))
    s = x.dev.call('request', handle='pk-' + h, orgId='org-test', shopId='shop-b', deviceId=f'till-{uuid.uuid4()}')
    r = x.call(A_A1, 'device.request', {'request': s['request'], 'signature': s['signature']}, 'req-shop')
    x.record('D04', 'a cashier cannot request enrollment for a shop it does not work in', 'refused', r, 'DEVICE_REQUEST_INVALID: shop' in r.get('error', ''))
    # D5-D8: approvals that must fail
    att = json.loads(x.owner.keygen('attacker-1'))
    au, sg = x.approval(a, key_id='attacker-1')
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-attacker')
    x.record('D05', 'an approval signed by a key the database does not hold is refused (no self-approval)', 'refused', r, r.get('outcome') == 'refused' and 'unknown owner key' in r.get('reason', ''))
    rc, out = x.psql(f"BEGIN; INSERT INTO recovery_v1.authorized_txn(txid, purpose, ref) VALUES (txid_current(), 'enroll-owner-key', 'forged');\n"
                     f"INSERT INTO recovery_v1.owner_keys(key_id, n, e, bits, fingerprint, enrolled_via, scope) SELECT 'attacker-1', recovery_v1.hex_to_numeric({q(att['n'])}), 65537, 2048,"
                     f" recovery_v1.owner_key_fingerprint(recovery_v1.hex_to_numeric({q(att['n'])}), 65537), 'owner-authorization', '*';\n"
                     "DELETE FROM recovery_v1.authorized_txn WHERE txid = txid_current(); COMMIT;", 'forge-ownerkey')
    au, sg = x.approval(a, key_id='attacker-1')
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-forgedkey')
    x.record('D06', 'a DB superuser who inserts its own "owner key" row cannot approve devices with it (not the install anchor nor enrolled by a trusted key)',
             'refused (not trusted)', f'insert rc={rc}; {r}', r.get('outcome') == 'refused' and 'not trusted' in r.get('reason', ''))
    au, sg = x.approval(a, device={'shopId': 'shop-b'})
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-wrongshop')
    x.record('D07', 'an approval for another shop than requested is refused', 'refused', r, 'does not match the device request' in r.get('reason', ''))
    au, sg = x.approval(a, device={'keyFingerprint': k2['fingerprint']})
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-keysub')
    x.record('D08', 'an approval naming another key (key substitution) is refused', 'refused', r, 'does not match the device request' in r.get('reason', ''))
    tgt = x.owner.target(); tgt['database'] = 'some-other-database'
    au, sg = x.approval(a, target=tgt)
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-target')
    x.record('D09', 'an approval for another database is refused', 'refused', r, 'another database' in r.get('reason', ''))
    au, sg = x.approval(a, issued_offset=-7200, expires_in=3600)
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-expired')
    x.record('D10', 'an expired approval is refused', 'refused', r, 'EXPIRED' in r.get('reason', ''))
    au, sg = x.approval(a, scope='org-unrelated')
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-otherorg')
    x.record('D11', 'an approval scoped to another organization is refused (cross-organization)', 'refused', r, r.get('outcome') == 'refused')
    # D12: genuine
    au, sg = x.approval(a)
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-ok')
    a['enrollmentId'] = r.get('enrollmentId')
    st = x.call(A_A1, 'device.status', {'deviceId': a['deviceId']}, 'st-A2')
    x.record('D12', 'a genuine (synthetic) owner approval enrolls the device: ACTIVE, with the owner-signed approval returned for the till to verify',
             'enrolled + ACTIVE', {'r': r, 'state': st.get('state')}, r.get('outcome') == 'enrolled' and st.get('state') == 'ACTIVE' and st.get('signature') and st.get('ownerKey', {}).get('fingerprint'))
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-replay')
    x.record('D13', 'a replayed approval is refused', 'refused (replay)', r, r.get('outcome') == 'refused' and ('REPLAY' in r.get('reason', '') or 'already' in r.get('reason', '')))
    # D14: forged enrollment row by a superuser (server-only forgery)
    b = x.new_device('org-test', 'shop-a', A_A1, label='B')
    au, sg = x.approval(b, key_id='attacker-1')
    rc, out = x.psql(f"INSERT INTO recovery_v1.device_enrollments(enrollment_id, org_id, shop_id, device_id, key_fingerprint, not_after, owner_key_id, nonce, authorization_text, signature, submitted_by)"
                     f" VALUES ({q(b['req']['requestId'])}, 'org-test', 'shop-a', {q(b['deviceId'])}, {q(b['fingerprint'])}, now() + interval '30 days', 'owner-sim-2', gen_random_uuid(), {q(au)}, {q(sg)}, 'superuser');", 'forge-enroll')
    x.record('D14', 'a server-only forged enrollment row (superuser INSERT, not owner-signed) is refused when written', 'refused', out, rc != 0 and 'UNVERIFIED_TRUST_ROW' in out)
    return a


def device_use(x, a):
    r, k = x.sale(A_A1, None, label='sale-untrusted')
    x.record('D15', 'ACTIVE organization, device untrusted (no device signature, e.g. an old client): sale refused, nothing written',
             'refused device_signature_required', r, r.startswith('refused') and 'device_signature_required' in r
             and x.sql(f"SELECT count(*) FROM public.idempotency_keys WHERE key={q(k)};") == '0')
    r, k = x.sale(A_A1, a, label='sale-trusted')
    x.record('D16', 'ACTIVE organization, trusted device: online sale recorded; the server recorded the device counter for it', 'ok', r,
             r.startswith('ok') and x.sql(f"SELECT count(*) FROM recovery_v1.device_counters WHERE op_key={q(k)} AND enrollment_id={q(a['enrollmentId'])};") == '1')
    t0 = time.time()
    for i in range(5): x.sale(A_A1, a, label='sale-timing')
    x.record('D16t', 'timing (informational): 5 device-signed sales incl. psql start-up', 'recorded', f'{(time.time() - t0) / 5:.3f}s per sale', True)
    # (review 2, H2) the offline marker is signed: an operation signed as recorded OFFLINE cannot be sent as an "online" one
    ko = str(uuid.uuid4())
    r28, _ = x.sale(A_A1, a, key=ko, label='strip-offline', hdr=x.header(a, ko, 'complete_sale', offline={'capabilityId': str(uuid.uuid4()), 'deviceSeq': 1}))
    x.record('D28', 'removing the x-orvix-offline header from an operation the device signed as offline invalidates its signature', 'device_signature_invalid', r28[-160:],
             'device_signature_invalid' in r28)
    key = str(uuid.uuid4()); hd = json.loads(x.header(a, key, 'complete_sale')); hd['sig'] = ('0' if hd['sig'][0] != '0' else '1') + hd['sig'][1:]
    r = x.idem(A_A1, None, key, hdr=json.dumps(hd), label='badsig')
    x.record('D17', 'a tampered device signature is refused', 'device_signature_invalid', r, 'device_signature_invalid' in r)
    h1 = x.header(a, str(uuid.uuid4()), 'complete_sale')
    r = x.idem(A_A1, None, str(uuid.uuid4()), hdr=h1, label='otherkey')
    x.record('D18', 'a device signature for one operation is refused for another (header replay onto a new key)', 'device_signature_invalid', r, 'device_signature_invalid' in r)
    used = int(x.sql(f"SELECT max(counter) FROM recovery_v1.device_counters WHERE enrollment_id={q(a['enrollmentId'])};"))   # a counter the server RECORDED
    k3 = str(uuid.uuid4())
    r = x.idem(A_A1, None, k3, hdr=x.header(a, k3, 'complete_sale', counter=used), label='ctrreuse')
    x.record('D19', 'a counter already used for another operation (cloned or rolled-back device profile) is refused', 'device_counter_reused', r, 'device_counter_reused' in r)
    kb = str(uuid.uuid4())
    r = x.idem(A_B, a, kb, label='wrongshop')
    x.record('D20', 'a device of shop-a used by a cashier of shop-b is refused (wrong shop)', 'device_wrong_shop', r, 'device_wrong_shop' in r)
    ku = str(uuid.uuid4())
    x.c['activate']('org-unrelated')   # an ACTIVE other organization, so the device binding itself is what refuses
    r = x.idem(A_UNREL, a, ku, label='otherorg')
    x.record('D21', 'another organization cannot use this device\'s signature', 'device_binding', r, 'device_binding' in r)
    rc, out = x.as_user(A_A1, "SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0, '[{\"product_id\":\"prod-1\",\"qty\":1}]'::jsonb, NULL, NULL)::text;", None, 'keyless')
    x.record('D22', 'a keyless legacy call (old client, no idempotency key) cannot write a sale under V1', 'refused', out, rc != 0 and ('ORG_SUSPENDED' in out or 'IDEMPOTENCY' in out.upper()))
    # suspension / reinstatement
    r = x.call(A_ADMIN, 'device.suspend', {'enrollmentId': a['enrollmentId'], 'reason': 'synthetic suspicion'}, 'suspend')
    s1, _ = x.sale(A_A1, a, label='sale-suspended')
    ev = x.sql(f"SELECT max(id) FROM recovery_v1.device_events WHERE enrollment_id={q(a['enrollmentId'])} AND kind='suspended';")
    au, sg = x.owner.authorize('device-reinstate', {'scope': 'org-test', 'ownerId': s5lib.FIXTURE_OWNER, 'device': {'enrollmentId': a['enrollmentId'], 'keyFingerprint': a['fingerprint'], 'suspensionEventId': int(ev)}}, key_id='attacker-1')
    r2 = x.call(A_ADMIN, 'device.reinstate', {'authorization': au, 'signature': sg}, 'reinstate-attacker')
    au, sg = x.owner.authorize('device-reinstate', {'scope': 'org-test', 'ownerId': s5lib.FIXTURE_OWNER, 'device': {'enrollmentId': a['enrollmentId'], 'keyFingerprint': a['fingerprint'], 'suspensionEventId': int(ev)}})
    r3 = x.call(A_ADMIN, 'device.reinstate', {'authorization': au, 'signature': sg}, 'reinstate')
    s2, _ = x.sale(A_A1, a, label='sale-reinstated')
    r4 = x.call(A_ADMIN, 'device.reinstate', {'authorization': au, 'signature': sg}, 'reinstate-replay')
    # Step 6: the suspension event a reinstatement must name is visible WITHOUT database access — in the suspend result and
    # in the ADMIN's / operator's overview (recovery_overview), and cleared once reinstated
    r5 = x.call(A_ADMIN, 'device.suspend', {'enrollmentId': a['enrollmentId'], 'reason': 'synthetic suspicion (again)'}, 'suspend-2')
    ov = x.call(A_ADMIN, 'recovery.overview', {}, 'overview-suspended')
    shown = next((e for e in ov.get('devices', {}).get('enrollments', []) if e.get('enrollmentId') == a['enrollmentId']), {})
    au5, sg5 = x.owner.authorize('device-reinstate', {'scope': 'org-test', 'ownerId': s5lib.FIXTURE_OWNER, 'device': {
        'enrollmentId': a['enrollmentId'], 'keyFingerprint': shown.get('keyFingerprint'), 'suspensionEventId': shown.get('suspensionEventId')}})
    r6 = x.call(A_ADMIN, 'device.reinstate', {'authorization': au5, 'signature': sg5}, 'reinstate-from-overview')
    ov2 = x.call(A_ADMIN, 'recovery.overview', {}, 'overview-reinstated')
    after = next((e for e in ov2.get('devices', {}).get('enrollments', []) if e.get('enrollmentId') == a['enrollmentId']), {})
    x.record('D23b', 'the current suspension event is returned by the suspension and shown in the overview; a reinstatement built only from that succeeds; it is cleared afterwards',
             'eventId == suspensionEventId; reinstated; null after',
             {'eventId': r5.get('eventId'), 'shown': shown.get('suspensionEventId'), 'state': shown.get('state'), 'reinstate': r6.get('outcome') or r6.get('reason', '')[:80],
              'after': after.get('suspensionEventId'), 'afterState': after.get('state')},
             r5.get('outcome') == 'suspended' and isinstance(r5.get('eventId'), int) and shown.get('suspensionEventId') == r5.get('eventId')
             and shown.get('state') == 'SUSPENDED' and r6.get('outcome') == 'reinstated' and after.get('suspensionEventId') is None and after.get('state') == 'ACTIVE')
    x.record('D23', 'a suspended device cannot sell; only an owner-signed reinstatement (not another key, not a replay) restores it',
             'suspended refused; attacker refused; owner reinstates; replay refused',
             {'suspend': r.get('outcome'), 'sale': s1[:80], 'attacker': r2.get('reason', '')[:80], 'reinstate': r3.get('outcome'), 'sale2': s2[:20], 'replay': r4.get('reason', '')[:60]},
             r.get('outcome') == 'suspended' and 'device_suspended' in s1 and r2.get('outcome') == 'refused' and r3.get('outcome') == 'reinstated' and s2.startswith('ok')
             and r4.get('outcome') == 'refused')
    # replacement of a lost device
    c = x.enroll('org-test', 'shop-a', A_A1, label='C')
    c2 = x.new_device('org-test', 'shop-a', A_A1, replaces=c['enrollmentId'], label='C2')
    au, sg = x.approval(c2, device={'replacesEnrollmentId': None})
    r1 = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-repl-unnamed')
    au, sg = x.approval(c2)
    r2 = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-repl')
    c2['enrollmentId'] = r2.get('enrollmentId')
    sc, _ = x.sale(A_A1, c, label='sale-replaced')
    sc2, _ = x.sale(A_A1, c2, label='sale-replacement')
    x.record('D24', 'a lost device is replaced only when the device request AND the owner approval both name it; the old key is then refused',
             'unnamed refused; named enrolled; old REPLACED; new sells', {'unnamed': r1.get('reason', '')[:80], 'named': r2.get('outcome'), 'old': sc[:80], 'new': sc2[:20]},
             r1.get('outcome') == 'refused' and r2.get('outcome') == 'enrolled' and 'device_replaced' in sc and sc2.startswith('ok'))
    d = x.new_device('org-test', 'shop-a', A_A1, device_id=c2['deviceId'], label='D')
    au, sg = x.approval(d)
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-dupe')
    # (review 2, L2) refused already at the REQUEST (a device id is requested once); the approval then names no stored request
    x.record('D25', 'a second key for an enrolled device id without naming the enrollment it replaces is refused', 'refused', {'request': d['requested'], 'approve': r},
             'already requested' in d['requested'].get('error', '') and r.get('outcome') == 'refused')
    # revocation
    r = x.call(A_ADMIN, 'device.revoke', {'enrollmentId': a['enrollmentId'], 'reason': 'synthetic: till stolen'}, 'revoke')
    s3, _ = x.sale(A_A1, a, label='sale-revoked')
    again = x.dev.call('request', handle=a['handle'], orgId='org-test', shopId='shop-a', deviceId=f'till-{uuid.uuid4()}')
    r5 = x.call(A_A1, 'device.request', {'request': again['request'], 'signature': again['signature']}, 'req-revokedkey')
    nk = 'nk-' + uuid.uuid4().hex[:4]; x.dev.call('keygen', handle=nk)
    same = x.dev.call('request', handle=nk, orgId='org-test', shopId='shop-a', deviceId=a['deviceId'])
    r6 = x.call(A_A1, 'device.request', {'request': same['request'], 'signature': same['signature']}, 'req-revokedid')
    x.record('D26', 'a revoked device cannot sell, and neither its key nor its device id can be enrolled again',
             'refused x3', {'sale': s3[:80], 'key': r5.get('error', '')[-120:], 'id': r6.get('error', '')[-120:]},
             r.get('outcome') == 'revoked' and 'device_revoked' in s3 and 'KEY_REVOKED' in r5.get('error', '') and 'DEVICE_REVOKED' in r6.get('error', ''))
    # expiry
    e = x.new_device('org-test', 'shop-a', A_A1, label='E')
    au, sg = x.approval(e, device={'notAfter': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=6)).strftime('%Y-%m-%dT%H:%M:%S.000Z')})
    r = x.call(A_A1, 'device.approve', {'authorization': au, 'signature': sg}, 'appr-short'); e['enrollmentId'] = r.get('enrollmentId')
    s4, _ = x.sale(A_A1, e, label='sale-short')
    time.sleep(7)
    s5, _ = x.sale(A_A1, e, label='sale-expired')
    x.record('D27', 'an enrollment past its notAfter can no longer sell (EXPIRED)', 'ok then device_expired', {'before': s4[:20], 'after': s5[-120:]}, s4.startswith('ok') and 'device_expired' in s5)
    return c2


def reopening(x, dev_trusted):
    st = x.sql("SELECT state||'/'||recovery_epoch||'/'||(SELECT kind FROM recovery_v1.incidents i WHERE i.incident_id=s.incident_id) FROM recovery_v1.org_state s WHERE org_id='org-s5a';")
    x.record('R01', 'V1 installs and restricts: org-s5a RESTRICTED in incident 1 (kind install)', 'RESTRICTED/1/install', st, st == 'RESTRICTED/1/install')
    r = x.call(A_S5A, 'recovery.contain', {'state': 'ACTIVE', 'reason': 'looks fine', 'evidenceReference': 'none'}, 'contain-active')
    rc, out = x.as_user(A_S5A, "SELECT public.recovery_v1_transition('org-s5a','ACTIVE','restore finished','x')::text;", label='tr-active')
    x.record('R02', 'without an owner authorization the organization stays restricted (ACTIVE transition denied on every app path; a finished restore is no authorization)',
             'denied', {'contain': r.get('outcome'), 'transition': out[-80:]}, r.get('outcome') == 'denied' and '"denied"' in out and x.state('org-s5a') == 'RESTRICTED')
    # a trusted device of a RESTRICTED organization (enrollment is allowed while restricted; selling is not)
    sd = x.enroll('org-s5a', 'shop-s5a', A_S5A, label='S5A')
    rr = x.idem(A_S5A, sd, str(uuid.uuid4()), label='s5a-restricted')
    x.record('R03', 'RESTRICTED organization, trusted device: refused', 'ORG_SUSPENDED', {'enrolled': sd['approved'].get('outcome'), 'op': rr[-120:]},
             sd['approved'].get('outcome') == 'enrolled' and 'ORG_SUSPENDED' in rr)

    def payload(rep, **over):
        reo = {'orgId': 'org-s5a', 'incidentId': rep['incidentId'], 'recoveryEpoch': rep['recoveryEpoch'], 'fromState': 'RECONCILING', 'toState': 'ACTIVE',
               'reportDigest': rep['digest'], 'decision': 'limited' if rep['blockers'] else 'verified', 'acceptedBlockers': rep['blockers'],
               'uncertainties': ['SYNTHETIC: device evidence not yet uploaded by the till'] if rep['blockers'] else [],
               'witnessRequired': False, 'checkpointHashes': [], 'backupManifestSha256': None, 'recoveredAsOf': None}
        reo.update(over.pop('reopen', {}))
        return {'scope': over.pop('scope', 'org-s5a'), 'ownerId': s5lib.FIXTURE_OWNER, 'reopen': reo}

    def submit(auth, a, s, label):
        return x.call(auth, 'recovery.reopen', {'authorization': a, 'signature': s}, label)

    # an authorization while still RESTRICTED (reconciliation skipped)
    facts = json.loads(x.sql("SELECT recovery_v1.reconciliation_facts('org-s5a')::text;"))
    fake = {'incidentId': facts['incidentId'], 'recoveryEpoch': facts['recoveryEpoch'], 'digest': 'a' * 64, 'blockers': []}
    a, s = x.owner.authorize('reopen-organization', payload(fake, reopen={'fromState': 'RESTRICTED', 'decision': 'verified', 'acceptedBlockers': [], 'uncertainties': []}))
    r = submit(A_S5A, a, s, 'reopen-skip')
    x.record('R04', 'reopening without the required reconciliation (organization not RECONCILING) is refused', 'REOPEN_STATE', r, 'REOPEN_STATE' in r.get('reason', ''))
    x.call(A_S5A, 'recovery.contain', {'state': 'RECONCILING', 'reason': 'synthetic recovery review', 'evidenceReference': 'synthetic-incident-1'}, 'contain-rec')
    rep = x.call(A_S5A, 'recovery.reconcile', {}, 'report1')
    x.record('R05', 'RECONCILING: the reconciliation report is recorded with its digest and blockers (an approved till has not attested for this incident)',
             'reported', rep, rep.get('outcome') == 'reported' and 'device_attestation_missing' in rep.get('blockers', []))
    a, s = x.owner.authorize('reopen-organization', payload(rep))
    r = submit(A_S5A, a, s.replace(s[-4:], '0000' if s[-4:] != '0000' else '1111'), 'reopen-badsig')
    x.record('R06', 'an invalid owner signature is refused', 'signature does not verify', r, 'does not verify' in r.get('reason', ''))
    a2, s2 = x.owner.authorize('reopen-organization', payload(rep, scope='org-s5b', reopen={'orgId': 'org-s5b'}))
    r = submit(A_S5A, a2, s2, 'reopen-otherorg')
    a3, s3 = x.owner.authorize('reopen-organization', payload(rep, reopen={'orgId': 'org-s5b'}))
    r3 = submit(A_S5A, a3, s3, 'reopen-mismatch')
    x.record('R07', 'a wrong-organization authorization is refused (another scope; or a reopen naming another organization)', 'refused x2',
             {'scope': r.get('reason', '')[:90], 'orgId': r3.get('reason', '')[:90]}, r.get('outcome') == 'refused' and r3.get('outcome') == 'refused')
    a, s = x.owner.authorize('reopen-organization', payload(rep), issued_offset=-7200, expires_in=3600)
    r = submit(A_S5A, a, s, 'reopen-expired')
    x.record('R08', 'an expired authorization is refused', 'EXPIRED', r, 'EXPIRED' in r.get('reason', ''))
    a, s = x.owner.authorize('reopen-organization', payload(rep, reopen={'decision': 'verified', 'acceptedBlockers': [], 'uncertainties': []}))
    r = submit(A_S5A, a, s, 'reopen-verified-blocked')
    a, s = x.owner.authorize('reopen-organization', payload(rep, reopen={'acceptedBlockers': []}))
    r2 = submit(A_S5A, a, s, 'reopen-limited-wrongset')
    a, s = x.owner.authorize('reopen-organization', payload(rep, reopen={'decision': 'limited', 'uncertainties': []}))
    r3 = submit(A_S5A, a, s, 'reopen-limited-nounc')
    x.record('R09', 'incomplete evidence blocks reopening: a "verified" decision with open blockers, a limited one that does not accept exactly the open blockers, or that states no uncertainty',
             'refused x3', {'verified': r.get('reason', '')[:70], 'wrongset': r2.get('reason', '')[:70], 'nounc': r3.get('reason', '')[:70]},
             'REOPEN_BLOCKED' in r.get('reason', '') and 'REOPEN_BLOCKED' in r2.get('reason', '') and 'REOPEN_INVALID' in r3.get('reason', ''))
    # facts change after the owner reviewed them (a till uploads evidence while the organization is reconciling)
    env = {'body': {'protocol': 'orvix-device-evidence-v1', 'orgId': 'org-s5a', 'shopId': 'shop-s5a', 'deviceId': sd['deviceId'], 'keyId': 'k-' + sd['fingerprint'][:16],
                    'operationId': str(uuid.uuid4()), 'rpc': 'complete_sale', 'payloadHash': 'b' * 64, 'sequence': 1, 'authorization': {'actorId': 'u-s5a-admin'}},
           'hash': 'c' * 63 + '5', 'signature': 'SYNTHETIC_UNVERIFIED'}
    rc, out = x.as_user(A_S5A, f"SELECT public.recovery_v1_store_evidence({q(json.dumps(env))}::jsonb)::text;", label='evidence')
    a, s = x.owner.authorize('reopen-organization', payload(rep))
    r = submit(A_S5A, a, s, 'reopen-stale-facts')
    x.record('R10', 'facts that changed after the owner signed (new evidence) refuse the reopening', 'FACTS_CHANGED', r, 'FACTS_CHANGED' in r.get('reason', ''))
    f2 = json.loads(x.sql("SELECT recovery_v1.reconciliation_facts('org-s5a')::text;"))
    import hashlib
    unrecorded = {'incidentId': f2['incidentId'], 'recoveryEpoch': f2['recoveryEpoch'], 'digest': x.sql("SELECT encode(sha256(convert_to(recovery_v1.reconciliation_facts('org-s5a')::text,'UTF8')),'hex');"),
                  'blockers': json.loads(x.sql("SELECT recovery_v1.reconciliation_blockers(recovery_v1.reconciliation_facts('org-s5a'))::text;"))}
    a, s = x.owner.authorize('reopen-organization', payload(unrecorded))
    r = submit(A_S5A, a, s, 'reopen-unrecorded')
    x.record('R11', 'an authorization over facts no reconciliation report RECORDED is refused', 'REPORT_MISSING', r, 'REPORT_MISSING' in r.get('reason', ''))
    rep2 = x.call(A_S5A, 'recovery.reconcile', {}, 'report2')
    a, s = x.owner.authorize('reopen-organization', payload(rep2, reopen={'witnessRequired': True, 'checkpointHashes': ['d' * 64]}))
    r = submit(A_S5A, a, s, 'reopen-witness-missing')
    x.record('R12', 'witness receipts required but not stored for the organization: refused', 'REOPEN_WITNESS', r, 'REOPEN_WITNESS' in r.get('reason', ''))
    rcpt = {'body': {'protocol': 'orvix-witness-receipt-v1', 'witnessId': 'local-test-only', 'keyId': 'synthetic-witness', 'checkpoint': {'protocol': 'orvix-checkpoint-v1', 'orgId': 'org-s5a',
            'shopId': 'shop-s5a', 'streamId': sd['deviceId'] + '/k', 'sequence': 1, 'digest': 'e' * 64, 'previousReceiptHash': None}}, 'hash': 'f' * 63 + '5', 'signature': 'SYNTHETIC_UNVERIFIED'}
    x.as_user(A_S5A, f"SELECT public.recovery_v1_store_checkpoint({q(json.dumps(rcpt))}::jsonb)::text;", label='checkpoint')
    # device attestations: forged / wrong incident refused; a till still holding operations blocks a verified reopening
    other = 'att-' + uuid.uuid4().hex[:4]; x.dev.call('keygen', handle=other)
    fa = x.attest(sd, A_S5A, sign_with=other, label='attest-forged')
    wi = x.attest(sd, A_S5A, incident=str(uuid.uuid4()), label='attest-wrong-incident')
    x.record('A01', 'a device attestation not signed by the enrolled key, or for another incident, is refused', 'refused x2',
             {'forged': fa.get('error', '')[-90:], 'incident': wi.get('error', '')[-90:]}, 'not signed by the enrolled device key' in fa.get('error', '') and 'ATTESTATION_INVALID' in wi.get('error', ''))
    a2 = x.attest(sd, A_S5A, pending=2, label='attest-pending')
    repP = x.call(A_S5A, 'recovery.reconcile', {}, 'report-pending')
    a, s = x.owner.authorize('reopen-organization', payload(repP, reopen={'decision': 'verified', 'acceptedBlockers': [], 'uncertainties': [], 'witnessRequired': True, 'checkpointHashes': ['f' * 63 + '5']}))
    rv = submit(A_S5A, a, s, 'reopen-pending-verified')
    x.record('A02', 'a till that attests it still holds unsynced operations blocks a verified reopening (device_operations_unsynced)', 'blocker; refused',
             {'attest': a2.get('outcome'), 'blockers': repP.get('blockers'), 'reopen': rv.get('reason', '')[:100]},
             a2.get('outcome') == 'attested' and 'device_operations_unsynced' in repP.get('blockers', []) and 'REOPEN_BLOCKED' in rv.get('reason', ''))
    x.attest(sd, A_S5A, pending=0, label='attest-clean')
    rep3 = x.call(A_S5A, 'recovery.reconcile', {}, 'report3')
    a, s = x.owner.authorize('reopen-organization', payload(rep3, reopen={'witnessRequired': True, 'checkpointHashes': ['f' * 63 + '5']}))
    r = submit(A_S5A, a, s, 'reopen-ok')
    st = x.call(A_S5A, 'recovery.overview', {}, 'overview')
    stat = json.loads([l for l in x.as_user(A_S5A, "SELECT public.recovery_v1_status('org-s5a')::text;", label='status')[1].splitlines() if l.startswith('{')][-1])
    x.record('R13', 'verified recovery evidence (no open blocker; the named witness receipt is stored) + a valid synthetic owner authorization: transition to ACTIVE, audited',
             'reopened (verified)', {'r': r, 'activation': st.get('activation'), 'blockers': rep3.get('blockers'), 'status': stat.get('state')},
             rep3.get('blockers') == [] and r.get('outcome') == 'reopened' and r.get('decision') == 'verified' and st.get('activation') == 'verified'
             and stat.get('state') == 'ACTIVE' and stat.get('uncertainties') == [] and stat.get('recovered_as_of')
             and x.sql("SELECT count(*) FROM recovery_v1.audit WHERE org_id='org-s5a' AND kind='organization_reopened';") == '1')
    r = submit(A_S5A, a, s, 'reopen-replay')
    x.record('R14', 'the same authorization replayed is refused', 'REPLAY', r, r.get('outcome') == 'refused' and ('REPLAY' in r.get('reason', '') or 'REOPEN_STATE' in r.get('reason', '')))
    ok = x.idem(A_S5A, sd, str(uuid.uuid4()), label='s5a-active')
    x.record('R15', 'ACTIVE (owner-reopened) organization + trusted device: operation accepted', 'ok', ok, ok.startswith('ok'))
    # org-s5b: still restricted; a hard blocker (unfinished ledger operation) cannot be accepted
    rr = x.idem(A_S5B, None, str(uuid.uuid4()), label='s5b-blocked')
    x.call(A_S5B, 'recovery.contain', {'state': 'RECONCILING', 'reason': 'synthetic', 'evidenceReference': 'x'}, 's5b-rec')
    rb = x.call(A_S5B, 'recovery.reconcile', {}, 's5b-report')
    a, s = x.owner.authorize('reopen-organization', {'scope': 'org-s5b', 'ownerId': s5lib.FIXTURE_OWNER, 'reopen': {'orgId': 'org-s5b', 'incidentId': rb['incidentId'],
        'recoveryEpoch': rb['recoveryEpoch'], 'fromState': 'RECONCILING', 'toState': 'ACTIVE', 'reportDigest': rb['digest'], 'decision': 'limited', 'acceptedBlockers': rb['blockers'],
        'uncertainties': ['SYNTHETIC: owner accepts everything'], 'witnessRequired': False, 'checkpointHashes': []}})
    r = x.call(A_S5B, 'recovery.reopen', {'authorization': a, 'signature': s}, 's5b-reopen')
    x.record('R16', 'reopening one organization does not reopen another; an unfinished ledger operation is a HARD blocker no owner decision accepts',
             'org-s5b restricted; refused', {'op': rr[-80:], 'blockers': rb.get('hardBlockers'), 'reopen': r.get('reason', '')[:120]},
             'ORG_SUSPENDED' in rr and 'ledger_in_flight' in rb.get('hardBlockers', []) and 'REOPEN_BLOCKED' in r.get('reason', '') and x.state('org-s5b') == 'RECONCILING')
    # superuser attempts
    rc, out = x.psql("UPDATE recovery_v1.org_state SET state='ACTIVE' WHERE org_id='org-s5b';", 'su-active')
    rc2, out2 = x.psql(f"INSERT INTO recovery_v1.reopenings(reopen_id, org_id, incident_id, recovery_epoch, report_digest, decision, accepted_blockers, uncertainties, owner_key_id, nonce, authorization_text, signature, submitted_by)"
                       f" SELECT gen_random_uuid(), 'org-s5b', incident_id, recovery_epoch, repeat('a',64), 'verified', '[]', '[]', 'owner-sim-2', gen_random_uuid(), {q(a)}, {q(s)}, 'superuser' FROM recovery_v1.org_state WHERE org_id='org-s5b';", 'su-reopening')
    x.record('R17', 'a superuser can neither set ACTIVE by hand nor insert a reopening that does not verify', 'refused x2', {'update': out[-120:], 'insert': out2[-120:]},
             rc != 0 and 'REOPEN_AUTHORIZATION_REQUIRED' in out and rc2 != 0 and 'UNVERIFIED_TRUST_ROW' in out2 and x.state('org-s5b') == 'RECONCILING')
    # a new incident: the earlier authorization (and any for incident 1) no longer applies
    x.call(A_S5A, 'recovery.contain', {'state': 'RESTRICTED', 'reason': 'synthetic second incident', 'evidenceReference': 'incident-2'}, 's5a-restrict')
    x.call(A_S5A, 'recovery.contain', {'state': 'RECONCILING', 'reason': 'synthetic', 'evidenceReference': 'incident-2'}, 's5a-rec2')
    rep4 = x.call(A_S5A, 'recovery.reconcile', {}, 'report4')
    old = dict(rep4); old['incidentId'] = rep3['incidentId']; old['recoveryEpoch'] = rep3['recoveryEpoch']
    a, s = x.owner.authorize('reopen-organization', payload(old))
    r = submit(A_S5A, a, s, 'reopen-old-incident')
    x.record('R18', 'after a new incident (left ACTIVE: epoch 2) an authorization for the earlier incident is refused', 'REOPEN_STALE',
             {'epoch': rep4.get('recoveryEpoch'), 'r': r.get('reason', '')[:100]}, rep4.get('recoveryEpoch') == 2 and 'REOPEN_STALE' in r.get('reason', ''))
    # (review 3, M2) attestations only move forward: an older statement (a replay) never replaces a newer one
    t_new = s5lib.now_iso(); t_old = s5lib.now_iso(-120)
    an = x.attest(sd, A_S5A, pending=3, attested_at=t_new, label='attest-new')
    ao = x.attest(sd, A_S5A, pending=0, attested_at=t_old, label='attest-replay-older')
    x.record('A03', 'an older (replayed) device attestation is refused; the newer one stands', 'attested; refused',
             {'new': an.get('outcome'), 'older': ao.get('error', '')[-100:]}, an.get('outcome') == 'attested' and 'not newer' in ao.get('error', ''))
    # (reviews 1/3, H1/H2) containing a till does not erase what it declared: suspended / revoked after the incident began, its
    # unsynced operations and its missing attestation stay in the facts
    x.call(A_S5A, 'device.suspend', {'enrollmentId': sd['enrollmentId'], 'reason': 'synthetic containment during reconciliation'}, 'r19-suspend')
    rep5 = x.call(A_S5A, 'recovery.reconcile', {}, 'report5')
    a, s = x.owner.authorize('reopen-organization', payload(rep5, reopen={'decision': 'verified', 'acceptedBlockers': [], 'uncertainties': []}))
    rv = submit(A_S5A, a, s, 'reopen-after-containment')
    x.record('R19', 'an ADMIN suspending (or revoking) a till during reconciliation does not erase its declared unsynced operations: a verified reopening stays refused',
             'device_operations_unsynced kept; refused', {'blockers': rep5.get('blockers'), 'reopen': rv.get('reason', '')[:100]},
             'device_operations_unsynced' in rep5.get('blockers', []) and 'REOPEN_BLOCKED' in rv.get('reason', ''))
    return rep4


def operator_boundary(x):
    rc, ov = x.psql("SET ROLE orvix_recovery_operator; SELECT recovery_v1.operator_overview()::text; RESET ROLE;", 'op-overview')
    rc2, out2 = x.psql("SET ROLE orvix_recovery_operator; SELECT count(*) FROM public.sales;", 'op-sales')
    rc3, out3 = x.psql("SET ROLE orvix_recovery_operator; SELECT count(*) FROM recovery_v1.device_requests;", 'op-table')
    rc4, out4 = x.as_user(A_ADMIN, "SELECT recovery_v1.operator_overview()::text;", label='app-operator')
    rc5, out5 = x.psql("SET ROLE service_role; SELECT recovery_v1.operator_overview()::text;", 'svc-operator')
    body = ov if rc == 0 else ''
    fin = [w for w in ['total_mmk', 'amount_mmk', 'receipt_no', 'customer', 'paid_mmk', 'cost_mmk', 'unit_cost', 'line_total'] if w in body]
    x.record('C01', 'operator interface: recovery metadata only (no sales, payments, costs); no table access; app users and the service role cannot call it',
             'overview ok; others denied', {'overview_fields_found': fin, 'sales': out2[-80:], 'table': out3[-80:], 'app': out4[-80:], 'svc': out5[-80:]},
             rc == 0 and '"orgId"' in body and not fin and 'permission denied' in out2 and 'permission denied' in out3 and 'permission denied' in out4 and 'permission denied' in out5)
    # an operator CARRIES an owner approval (enrollment requested by a till), it cannot create one
    d = x.new_device('org-test', 'shop-b', A_B, label='OP')
    a, s = x.approval(d)
    rc, out = x.psql(f"SET ROLE orvix_recovery_operator; SELECT recovery_v1.operator_submit({q(a)}, {q(s)}, 'control-operator-1')::text; RESET ROLE;", 'op-submit')
    a2, s2 = x.approval(x.new_device('org-test', 'shop-b', A_B, label='OP2'), key_id='attacker-1')
    rc2, out2 = x.psql(f"SET ROLE orvix_recovery_operator; SELECT recovery_v1.operator_submit({q(a2)}, {q(s2)}, 'control-operator-1')::text; RESET ROLE;", 'op-submit-forged')
    rc3, out3 = x.psql("SET ROLE orvix_recovery_operator; SELECT recovery_v1.operator_transition('org-test','ACTIVE','operator wants it open','x','control-operator-1')::text; RESET ROLE;", 'op-active')
    x.record('C02', 'Control (operator role) submits an owner-signed approval; it cannot approve with any other key nor transition an organization to ACTIVE',
             'enrolled; refused; denied', {'submit': out[-100:], 'forged': out2[-100:], 'active': out3[-80:]},
             '"enrolled"' in out and '"refused"' in out2 and '"denied"' in out3)
    aud = x.psql("SET ROLE orvix_recovery_operator; SELECT recovery_v1.operator_audit('org-test', 20)::text; RESET ROLE;", 'op-audit')[1]
    x.record('C03', 'operator audit history shows the operator-submitted enrollment and refusals', 'present', aud[-200:], 'operator:control-operator-1' in aud)
    return d


def owner_scope_and_forgery(x):
    # an organization-scoped owner key (enrolled by the current '*' key, superuser runner)
    pub = json.loads(x.owner.keygen('org-key-s5b')); pub['scope'] = 'org-s5b'; pub['ownerId'] = 'SYNTHETIC org-s5b owner'
    cur = x.owner.current_key()
    a, s = x.owner.authorize('enroll-owner-key', {'newKey': pub})
    x.sql(f"SELECT recovery_v1.enroll_owner_key({q(a)},{q(s)})::text;", 'k-enroll-scoped')
    pol = {'scope': '*', 'maxLifetimeSeconds': 3600, 'maxOps': 3, 'maxAmountMmk': 999999, 'syncGraceSeconds': 86400, 'orgBudgetMmk': 999999000, 'shopBudgetMmk': 999999000, 'deviceBudgetMmk': 999999000}
    a, s = x.owner.authorize('offline-policy', {'policy': pol}, key_id='org-key-s5b')
    rc1, o1 = x.psql(f"SELECT recovery_v1.set_offline_policy({q(a)},{q(s)})::text;", 'k01')
    a, s = x.owner.authorize('migration', {'migration': {'id': 'K02-X', 'sqlSha256': '0' * 64, 'predecessor': 'x', 'allowedCommands': ['CREATE TABLE'], 'newTables': ['zz_k02']}}, key_id='org-key-s5b')
    rc2, o2 = x.psql(f"SELECT recovery_v1.apply_authorized_migration({q(a)},{q(s)},'CREATE TABLE public.zz_k02(id int)')::text;", 'k02')
    pub3 = json.loads(x.owner.keygen('org-key-s5b-2')); pub3['scope'] = 'org-s5b'
    a, s = x.owner.authorize('enroll-owner-key', {'newKey': pub3, 'retireKeyId': cur}, key_id='org-key-s5b')
    rc3, o3 = x.psql(f"SELECT recovery_v1.enroll_owner_key({q(a)},{q(s)})::text;", 'k03')
    still = x.sql(f"SELECT (recovery_v1.trusted_owner_key({q(cur)})).key_id IS NOT NULL;")
    x.record('K01', 'a key limited to one organization cannot authorize a global offline policy, a migration, or retire the global key (review 4, H1/H2)',
             'refused x3; global key still trusted', {'policy': x.msg(o1)[-90:], 'migration': x.msg(o2)[-90:], 'retire': x.msg(o3)[-90:], 'globalTrusted': still},
             rc1 and 'SCOPE' in o1 and rc2 and 'SCOPE' in o2 and rc3 and 'SCOPE' in o3 and still == 't')
    # a superuser inserting an enrollment row that carries a genuine but EXPIRED approval (refused on the normal path)
    d = x.new_device('org-test', 'shop-b', A_B, label='K04')
    a, s = x.approval(d, issued_offset=-7200, expires_in=3600)
    rc4, o4 = x.psql(f"INSERT INTO recovery_v1.owner_authorizations_used(nonce, purpose, key_id, auth_sha256, authorization_text, signature)"
                     f" SELECT ({q(a)}::jsonb->>'nonce')::uuid, 'enroll-device', {q(cur)}, encode(sha256(convert_to({q(a)}, 'UTF8')), 'hex'), {q(a)}, {q(s)};\n"
                     f"INSERT INTO recovery_v1.device_enrollments(enrollment_id, org_id, shop_id, device_id, key_fingerprint, not_after, owner_key_id, nonce, authorization_text, signature, submitted_by, approved_at)"
                     f" VALUES ({q(d['req']['requestId'])}, 'org-test', 'shop-b', {q(d['deviceId'])}, {q(d['fingerprint'])}, ({q(a)}::jsonb#>>'{{device,notAfter}}')::timestamptz, {q(cur)},"
                     f" ({q(a)}::jsonb->>'nonce')::uuid, {q(a)}, {q(s)}, 'superuser', now() - interval '90 minutes');", 'k04')
    x.record('K04', 'a superuser cannot make an EXPIRED (server-refused) owner approval effective by writing the rows itself, even with a backdated time (reviews 2/3/4)',
             'refused (UNVERIFIED_TRUST_ROW)', x.msg(o4)[-160:], rc4 != 0 and 'UNVERIFIED_TRUST_ROW' in o4)


def budgets(x):
    # synthetic owner-signed policy for org-test ONLY (test values; production limits are an owner decision)
    pol = {'scope': 'org-test', 'maxLifetimeSeconds': 3600, 'maxOps': 30, 'maxAmountMmk': 20000, 'syncGraceSeconds': 86400,
           'orgBudgetMmk': 100000, 'shopBudgetMmk': 60000, 'deviceBudgetMmk': 40000}
    a, s = x.owner.authorize('offline-policy', {'policy': {k: v for k, v in pol.items() if not k.endswith('BudgetMmk')}})
    rc, out = x.psql(f"SELECT recovery_v1.set_offline_policy({q(a)},{q(s)})::text;", 'pol-nobudget')
    x.record('B00', 'an owner policy without aggregate budgets is refused (missing policy never means unlimited)', 'POLICY_INVALID', out[-120:], rc != 0 and 'OFFLINE_POLICY_INVALID' in out)
    # Every capability that could still be in use counts (current epoch until its sync deadline; older epochs, surrendered and
    # revoked ones until they expire), including those issued earlier on this cluster by the offline smoke. Each check therefore
    # re-signs the (synthetic) policy so that exactly ONE limit binds: "what is outstanding now + N".
    OUTQ = ("SELECT coalesce(sum(max_amount_mmk),0) FROM recovery_v1.offline_capabilities c WHERE org_id='org-test' {shop} AND ((c.offline_epoch=(SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='org-test')"
            " AND c.sync_deadline > now()) OR (c.offline_epoch<>(SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='org-test') AND c.expires_at > now()))"
            " AND (c.expires_at > now() OR NOT EXISTS (SELECT 1 FROM recovery_v1.offline_surrenders s WHERE s.capability_id=c.id));")
    out = lambda shop=None: int(x.sql(OUTQ.format(shop=f"AND shop_id={q(shop)}" if shop else '')) or 0)
    BIG = 1_000_000_000

    def policy(label, shop=BIG, org=BIG):
        pl = dict(pol, shopBudgetMmk=shop, orgBudgetMmk=org)
        a, s_ = x.owner.authorize('offline-policy', {'policy': pl})
        x.sql(f"SELECT recovery_v1.set_offline_policy({q(a)},{q(s_)})::text;", label)
        return pl
    policy('pol-device')
    P = [x.enroll('org-test', 'shop-a', A_A1, label=f'P{i}') for i in (1, 2, 3)]
    Q = [x.enroll('org-test', 'shop-b', A_B, label=f'Q{i}') for i in (1, 2, 3)]
    c1 = x.capability(A_A1, P[0], 'cap-p1a'); c2 = x.capability(A_A1, P[0], 'cap-p1b'); c3 = x.capability(A_A1, P[0], 'cap-p1c')
    x.record('B01', 'repeated issuance to one device stops at its device budget (2 x 20,000 = 40,000; the third is refused)', 'issued, issued, exhausted',
             [c1.get('outcome'), c2.get('outcome'), c3.get('reason')], c1.get('outcome') == 'issued' and c2.get('outcome') == 'issued' and c3.get('reason') == 'offline_budget_exhausted')
    shop_cap = out('shop-a') + 20000
    policy('pol-shop', shop=shop_cap)
    c4 = x.capability(A_A1, P[1], 'cap-p2'); c5 = x.capability(A_A1, P[2], 'cap-p3')
    x.record('B02', 'another device of the same shop gets only what the SHOP budget has left (outstanding + 20,000)', 'issued, exhausted', [shop_cap, c4.get('outcome'), c5.get('reason')],
             c4.get('outcome') == 'issued' and c5.get('reason') == 'offline_budget_exhausted' and out('shop-a') == shop_cap)
    org_cap = out() + 40000
    policy('pol-org', shop=org_cap, org=org_cap)
    c6 = x.capability(A_B, Q[0], 'cap-q1'); c7 = x.capability(A_B, Q[1], 'cap-q2'); c8 = x.capability(A_B, Q[2], 'cap-q3')
    x.record('B03', 'devices of another shop stop at the ORGANIZATION budget (outstanding + 40,000)', 'issued, issued, exhausted',
             [org_cap, c6.get('outcome'), c7.get('outcome'), c8.get('reason')], c6.get('outcome') == 'issued' and c7.get('outcome') == 'issued' and c8.get('reason') == 'offline_budget_exhausted')
    x.record('B04', 'outstanding exposure across all devices and cashiers never exceeds the organization budget', f'<= {org_cap}', out(), out() <= org_cap)
    cA = x.capability(A_A2, P[0], 'cap-p1-otheruser')
    x.record('B05', 'another cashier on the same device draws from the same device budget', 'exhausted', cA.get('reason'), cA.get('reason') == 'offline_budget_exhausted')
    # offline operations under P1's first capability, then a verified surrender
    cap = c1['capability']['id']
    s1, k1 = x.sale(A_A1, P[0], amt=1000, offline={'capabilityId': cap, 'deviceSeq': 1}, label='off1')
    s1b, _ = x.sale(A_A1, P[0], key=k1, amt=1000, offline={'capabilityId': cap, 'deviceSeq': 1}, label='off1-replay')
    s2, k2 = x.sale(A_A1, P[0], amt=1000, offline={'capabilityId': cap, 'deviceSeq': 2}, label='off2')
    x.record('B06', 'offline sales under the capability are accepted at sync; a replayed queue entry is counted once', 'ok; usage 2 / 2000',
             [s1[:20], s1b[:20], s2[:20]], s1.startswith('ok') and s1b.startswith('ok') and s2.startswith('ok')
             and x.sql(f"SELECT count(*)||'/'||sum(amount_mmk) FROM recovery_v1.offline_usage WHERE capability_id={q(cap)};") == '2/2000')
    sx, _ = x.sale(A_A1, P[1], amt=1000, offline={'capabilityId': cap, 'deviceSeq': 3}, label='off-subst')
    x.record('B07', 'another device presenting this device\'s capability is held (device substitution)', 'offline_capability_device', sx[-120:], 'offline_capability_device' in sx)
    r1, _ = x.surrender(A_A1, P[0], cap, 1, 1000, 'surr-short')
    r2, h2 = x.surrender(A_A1, P[0], cap, 2, 2000, 'surr-ok')
    r2b, _ = x.surrender(A_A1, P[0], cap, 2, 2000, 'surr-replay', hdr=h2)
    s3, _ = x.sale(A_A1, P[0], amt=1000, offline={'capabilityId': cap, 'deviceSeq': 3}, label='off-after-surrender')
    c9 = x.capability(A_A1, P[0], 'cap-after-surrender')
    # (review 2, M2) a surrender stops acceptance at once but releases the reservation only at the capability's EXPIRY (a till could
    # still hand goods over under it until then): the device budget (40,000 = cap1 + cap2) is still fully reserved
    x.record('B08', 'a surrender is accepted only when the device-signed report equals the synced usage; a replayed surrender header is refused; the surrendered capability authorizes nothing more; its reservation lasts until its expiry',
             'unsynced refused; surrendered; replay refused; held; still reserved', [r1.get('reason'), r2.get('outcome'), r2b.get('reason'), s3[-60:], c9.get('reason')],
             r1.get('reason') == 'unsynced_operations' and r2.get('outcome') == 'surrendered' and r2b.get('reason') == 'device_counter_reused'
             and 'offline_capability_surrendered' in s3 and c9.get('reason') == 'offline_budget_exhausted')
    OUT = ("SELECT coalesce(sum(max_amount_mmk),0) FROM recovery_v1.offline_capabilities c WHERE org_id='org-test' AND ((c.offline_epoch=(SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='org-test')"
           " AND c.sync_deadline > now()) OR (c.offline_epoch<>(SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='org-test') AND c.expires_at > now()))"
           " AND (c.expires_at > now() OR NOT EXISTS (SELECT 1 FROM recovery_v1.offline_surrenders s WHERE s.capability_id=c.id));")
    # concurrent allocation: the owner signs a larger organization budget (120,000), leaving exactly 20,000; two shop-b tills race for it
    race_cap = out() + 20000
    policy('pol-race', shop=race_cap, org=race_cap)
    left = race_cap - out()

    def racer(auth, d, label):
        key = str(uuid.uuid4())
        h = x.header(d, key, f"recovery_v1_offline_capability:{d['shop']}:{d['deviceId']}", include_key=True)
        script = (f"SET s5fx.disabled='on'; SELECT test.login('{auth}'); SELECT set_config('request.headers', {q(json.dumps({'x-orvix-device': h}))}, false); SET ROLE authenticated;\n"
                  f"BEGIN; SELECT public.recovery_v1_offline_capability({q(d['org'])},{q(d['shop'])},{q(d['deviceId'])})::text; SELECT pg_sleep(1.5); COMMIT;\n")
        return subprocess.Popen(['psql', *x.c['dbargs']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=x.c['env']), script
    p1, sc1 = racer(A_B, Q[2], 'race1'); p2, sc2 = racer(A_B, Q[0], 'race2')   # both in shop-b: the ORGANIZATION budget is the binding limit
    p1.stdin.write(sc1); p1.stdin.close(); time.sleep(0.3); p2.stdin.write(sc2); p2.stdin.close()
    o1 = p1.stdout.read(); p1.wait(); o2 = p2.stdout.read(); p2.wait()
    (x.run / 's5-race.log').write_text(o1 + '\n----\n' + o2)
    issued = [o for o in (o1, o2) if '"issued"' in o]
    after = int(x.sql(OUT) or 0)
    x.record('B09', 'two concurrent capability requests competing for the last 20,000: the allocation is serialized, the total never exceeds the budget',
             f'one issued ({left} left before)', {'issued': len(issued), 'outstanding_after': after}, left == 20000 and len(issued) == 1 and after <= race_cap)
    # (review 1/2) revocation: the device's operations are refused, but its capability keeps counting until its sync deadline
    before_rev = int(x.sql(OUT) or 0)
    x.call(A_ADMIN, 'device.revoke', {'enrollmentId': Q[1]['enrollmentId'], 'reason': 'synthetic: lost'}, 'revoke-q2')
    sq, _ = x.sale(A_B, Q[1], amt=1000, offline={'capabilityId': c7['capability']['id'], 'deviceSeq': 1}, label='off-revoked')
    c10 = x.capability(A_B, Q[0], 'cap-after-revoke')
    x.record('B10', 'a revoked device cannot obtain new authority and its queued offline sales are refused; its reservation KEEPS counting (goods may already be out)',
             'refused; outstanding unchanged; no new capability', [sq[-80:], before_rev, int(x.sql(OUT) or 0), c10.get('reason')],
             'device_revoked' in sq and int(x.sql(OUT) or 0) == before_rev and c10.get('reason') == 'offline_budget_exhausted')
    # a recovery incident during disconnection: older-epoch operations are held; older-epoch capabilities count until they expire
    ep = x.sql("SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='org-test';")
    x.call(A_ADMIN, 'recovery.contain', {'state': 'RESTRICTED', 'reason': 'synthetic incident while tills offline', 'evidenceReference': 'b11'}, 'b11-restrict')
    ro = s5lib.reopen(x.c['sql'], x.owner, 'org-test', log='b11-reopen.log')
    so, _ = x.sale(A_A1, P[0], amt=1000, offline={'capabilityId': c2['capability']['id'], 'deviceSeq': 1}, label='off-stale')
    c11 = x.capability(A_A1, P[1], 'cap-new-epoch')
    x.record('B11', 'organization restricted while tills were offline: their older-epoch operations are held (never accepted), and the older capabilities keep counting until they expire',
             'reopened; stale epoch; no new allocation beyond the budget', [ep, ro.get('outcome'), ro.get('decision'), so[-80:], c11.get('reason'), out()],
             ro.get('outcome') == 'reopened' and 'offline_capability_stale_epoch' in so and c11.get('reason') == 'offline_budget_exhausted' and out() <= race_cap)
    rc, out = x.as_user(A_A1, "SELECT public.recovery_v1_offline_capability('org-unrelated','shop-unrel','till-x0000000')::text;", label='cap-otherorg')
    x.record('B12', 'a capability for another organization is refused', 'CALLER_REQUIRED', out[-100:], 'CALLER_REQUIRED' in out)
    return P


def run(ctx):
    x = S5(ctx)
    try:
        a = device_trust(x)
        device_use(x, a)
        reopening(x, a)
        operator_boundary(x)
        owner_scope_and_forgery(x)
        budgets(x)
        # leave org-test ACTIVE for the harness checks that follow
        x.c['activate']('org-test')
    finally:
        x.dev.close()
        (x.run / 's5-results.json').write_text(json.dumps(x.results, indent=1) + '\n')
