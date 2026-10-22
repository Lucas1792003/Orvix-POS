"""Step 5 test library: synthetic owner and device signers and GENUINE protocol fixtures for disposable clusters.

Nothing here edits recovery state by hand. An organization is reopened through the real owner-signed reopening
(recovery_v1.reopen_apply), a device is enrolled through the real request + owner approval, and every signature is
produced outside the database by tools/recovery-v1/owner/owner-sim.mjs (owner; key file in the run directory's
owner-keys/, never in PostgreSQL) or tools/recovery-v1/step5/device-sim.mjs (devices; in memory).

The only test-only object placed INSIDE the database is the optional FIXTURE DEVICE SIGNER (schema s5fx): an
owner-approved synthetic device whose private key the test harness keeps in s5fx, plus a trigger that signs the
ledger operations of the pre-Step-5 SQL suites with it (those suites predate device signatures and call the RPCs
directly). The server verifies those signatures exactly as it verifies a real till's. The Step 5 suite itself and the
Electron tests never use it.
"""
import json, pathlib, subprocess, uuid, datetime

FIXTURE_OWNER = 'SYNTHETIC-TEST-OWNER (local simulation; not an independent production authority)'


def q(s):
    return 'NULL' if s is None else "'" + str(s).replace("'", "''") + "'"


def now_iso(offset_s=0):
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=offset_s)
    return t.strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


class DeviceSim:
    def __init__(self, root):
        self.p = subprocess.Popen(['node', str(pathlib.Path(root) / 'tools/recovery-v1/step5/device-sim.mjs'), 'serve'],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.n = 0

    def call(self, cmd, **kw):
        self.n += 1
        kw.update(id=self.n, cmd=cmd)
        self.p.stdin.write(json.dumps(kw) + '\n'); self.p.stdin.flush()
        r = json.loads(self.p.stdout.readline())
        if not r.get('ok'): raise RuntimeError(f'device-sim {cmd}: {r.get("error")}')
        return r

    def close(self):
        try: self.p.stdin.close(); self.p.wait(5)
        except Exception: self.p.kill()


class Owner:
    """The synthetic owner: signs owner authorizations OUTSIDE the database (owner-sim.mjs, key in keydir)."""

    def __init__(self, sql, sim, keydir, workdir):
        self.sql, self.sim, self.keydir, self.dir = sql, pathlib.Path(sim), pathlib.Path(keydir), pathlib.Path(workdir)
        self.dir.mkdir(parents=True, exist_ok=True); self.n = 0

    def target(self):
        return json.loads(self.sql("SELECT recovery_v1.authorization_target()::text;", 's5-target.log').strip())

    def current_key(self):
        # the most recently enrolled owner key the DATABASE currently trusts (Step 4's rotation test retires owner-sim-1)
        return self.sql("SELECT key_id FROM recovery_v1.owner_keys k WHERE (recovery_v1.trusted_owner_key(k.key_id)).key_id IS NOT NULL ORDER BY (k.scope = '*') DESC, enrolled_at DESC LIMIT 1;", 's5-key.log').strip()

    def authorize(self, purpose, payload, key_id=None, expires_in=3600, issued_offset=0, target=None):
        key_id = key_id or self.current_key()
        self.n += 1
        t = self.dir / f'target-{self.n}.json'; p = self.dir / f'payload-{self.n}.json'
        t.write_text(json.dumps(target or self.target())); p.write_text(json.dumps(payload))
        out = subprocess.run(['node', str(self.sim), 'authorize', str(self.keydir / f'{key_id}.private.pem'), key_id, purpose, str(t), str(p),
                              '--expires-in', str(expires_in), '--issued-offset', str(issued_offset)], text=True, capture_output=True, check=True).stdout
        d = json.loads(out)
        return d['authorization'], d['signature']

    def keygen(self, key_id):
        return subprocess.run(['node', str(self.sim), 'keygen', str(self.keydir), key_id], text=True, capture_output=True, check=True).stdout.strip()


def submit(sql, auth, sig, submitter='superuser:fixture', log='s5-submit.log'):
    return json.loads(sql(f"SELECT recovery_v1.submit_owner_authorization({q(auth)},{q(sig)},{q(submitter)},NULL)::text;", log).strip())


def reopen(sql, owner, org, decision=None, uncertainty=None, key_id=None, extra=None, log='s5-reopen.log'):
    """Genuine owner-signed reopening of `org`: RECONCILING -> recorded report -> owner signs its digest -> submit."""
    st = sql(f"SELECT state FROM recovery_v1.org_state WHERE org_id={q(org)};", log).strip()
    if st == 'ACTIVE': return {'outcome': 'already_active'}
    if st != 'RECONCILING':
        sql(f"SELECT recovery_v1.contain({q(org)},'RECONCILING','synthetic fixture reconciliation','fixture','superuser:fixture');", log)
    rep = json.loads(sql(f"SELECT recovery_v1.reconciliation_report({q(org)},'superuser:fixture')::text;", log).strip())
    blockers = rep['blockers']
    decision = decision or ('verified' if not blockers else 'limited')
    payload = {'scope': org, 'ownerId': FIXTURE_OWNER, 'reopen': {
        'orgId': org, 'incidentId': rep['incidentId'], 'recoveryEpoch': rep['recoveryEpoch'], 'fromState': 'RECONCILING', 'toState': 'ACTIVE',
        'reportDigest': rep['digest'], 'decision': decision, 'acceptedBlockers': blockers if decision == 'limited' else [],
        'uncertainties': [uncertainty or ('SYNTHETIC FIXTURE: accepted for a local test reopening: ' + ', '.join(blockers))] if decision == 'limited' else [],
        'witnessRequired': False, 'checkpointHashes': [], 'backupManifestSha256': None, 'recoveredAsOf': None}}
    if extra: payload['reopen'].update(extra)
    auth, sig = owner.authorize('reopen-organization', payload, key_id=key_id)
    r = submit(sql, auth, sig, log=log)
    r['report'] = rep
    return r


def enroll(sql, owner, dev, org, shop, user_id, handle=None, device_id=None, not_after_days=30, replaces=None, log='s5-enroll.log'):
    """Genuine enrollment: device key + self-signed request (as `user_id`) + owner approval. Returns the enrollment id."""
    handle = handle or f'fx-{org}-{shop}-{uuid.uuid4().hex[:6]}'
    k = dev.call('keygen', handle=handle)
    device_id = device_id or f'till-{uuid.uuid4()}'
    req = dev.call('request', handle=handle, orgId=org, shopId=shop, deviceId=device_id, replacesEnrollmentId=replaces)
    r = json.loads(sql(f"SELECT recovery_v1.device_request({q(req['request'])},{q(req['signature'])},u)::text FROM public.users u WHERE u.id={q(user_id)};", log).strip())
    if r.get('outcome') != 'pending': raise RuntimeError(f'enrollment request refused: {r}')
    nb = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=not_after_days)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    auth, sig = owner.authorize('enroll-device', {'scope': org, 'ownerId': FIXTURE_OWNER, 'device': {
        'requestId': req['requestId'], 'orgId': org, 'shopId': shop, 'deviceId': device_id, 'keyFingerprint': k['fingerprint'],
        'requestNonce': req['requestNonce'], 'notAfter': nb, 'replacesEnrollmentId': replaces}})
    a = submit(sql, auth, sig, log=log)
    if a.get('outcome') != 'enrolled': raise RuntimeError(f'enrollment approval refused: {a}')
    return {'enrollmentId': a['enrollmentId'], 'handle': handle, 'deviceId': device_id, 'fingerprint': k['fingerprint'], 'n': k['n']}


# ---------------------------------------------------------------- in-database FIXTURE device signer (pre-Step-5 suites)
SIGNER_SQL = r"""
CREATE SCHEMA s5fx;
COMMENT ON SCHEMA s5fx IS 'TEST FIXTURE ONLY (Step 5): owner-approved synthetic devices whose keys the test harness holds; signs pre-Step-5 suites'' ledger operations. Never in a real database.';
CREATE TABLE s5fx.devices (org_id text NOT NULL, shop_id text NOT NULL, label text NOT NULL, device_id text NOT NULL, enrollment_id uuid PRIMARY KEY, n numeric NOT NULL,
  p numeric NOT NULL, q numeric NOT NULL, dp numeric NOT NULL, dq numeric NOT NULL, qi numeric NOT NULL, k int NOT NULL, UNIQUE(org_id, label));
CREATE SEQUENCE s5fx.counter START 1000000;
CREATE FUNCTION s5fx.modexp(p_b numeric, p_e numeric, p_m numeric) RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE r numeric := 1; b numeric := mod(p_b, p_m); e numeric := p_e;
BEGIN WHILE e > 0 LOOP IF mod(e, 2) = 1 THEN r := mod(r * b, p_m); END IF; e := div(e, 2); IF e > 0 THEN b := mod(b * b, p_m); END IF; END LOOP; RETURN r; END $$;
CREATE FUNCTION s5fx.hex_to_numeric(p_hex text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE v numeric := 0; i int := 1; c text;
BEGIN WHILE i <= length(p_hex) LOOP c := substr(p_hex, i, 6); v := v * (16::numeric ^ length(c)) + ('x' || lpad(c, 8, '0'))::bit(32)::bigint; i := i + 6; END LOOP; RETURN v; END $$;
CREATE FUNCTION s5fx.numeric_to_hex(p_v numeric, p_bytes int) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE v numeric := p_v; o text := '';
BEGIN WHILE v > 0 LOOP o := lpad(to_hex(mod(v, 16777216)::bigint), 6, '0') || o; v := div(v, 16777216); END LOOP; RETURN lpad(ltrim(o, '0'), p_bytes * 2, '0'); END $$;
-- RSASSA-PKCS1-v1_5 / SHA-256 signature with the CRT parts (RFC 8017 5.1.2)
CREATE FUNCTION s5fx.rsa_sign(d s5fx.devices, p_msg text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE t text := '3031300d060960864801650304020105000420' || encode(sha256(convert_to(p_msg, 'UTF8')), 'hex'); m numeric; m1 numeric; m2 numeric; h numeric;
BEGIN
  m := s5fx.hex_to_numeric('0001' || repeat('ff', d.k - 3 - length(t) / 2) || '00' || t);
  m1 := s5fx.modexp(m, d.dp, d.p); m2 := s5fx.modexp(m, d.dq, d.q);
  h := mod(d.qi * mod(mod(m1 - m2, d.p) + d.p, d.p), d.p);
  RETURN s5fx.numeric_to_hex(m2 + h * d.q, d.k);
END $$;
CREATE FUNCTION s5fx.autosign() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE h jsonb; d s5fx.devices; v_shop text; v_ctr bigint;
BEGIN
  IF coalesce(current_setting('s5fx.disabled', true), '') = 'on' OR to_regnamespace('recovery_v1') IS NULL THEN RETURN NEW; END IF;
  BEGIN h := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb); EXCEPTION WHEN OTHERS THEN RETURN NEW; END;
  -- a header the TEST supplied itself (not one this fixture wrote earlier in the transaction) is left alone
  IF h ? 'x-orvix-device' AND coalesce((h->>'x-orvix-device')::jsonb->>'fx', '') <> 'fixture' THEN RETURN NEW; END IF;
  SELECT u.shop_id INTO v_shop FROM public.users u WHERE u.auth_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_shop := coalesce(nullif(current_setting('s5fx.shop', true), ''), v_shop);
  -- s5fx.device names a labelled fixture device (e.g. the device an offline capability was issued to); else the shop's default
  IF nullif(current_setting('s5fx.device', true), '') IS NOT NULL THEN
    SELECT * INTO d FROM s5fx.devices x WHERE x.org_id = NEW.org_id AND x.label = current_setting('s5fx.device', true);
  ELSE
    SELECT * INTO d FROM s5fx.devices x WHERE x.org_id = NEW.org_id AND x.label LIKE 'default%' AND (v_shop IS NULL OR x.shop_id = v_shop) ORDER BY x.shop_id LIMIT 1;
  END IF;
  IF d.enrollment_id IS NULL THEN RETURN NEW; END IF;
  v_ctr := nextval('s5fx.counter');
  PERFORM set_config('request.headers', (h || jsonb_build_object('x-orvix-device', jsonb_build_object('v', 1, 'fx', 'fixture', 'enrollmentId', d.enrollment_id, 'counter', v_ctr,
    'sig', s5fx.rsa_sign(d, 'orvix-device-request-v1' || E'\n' || d.enrollment_id::text || E'\n' || NEW.org_id || E'\n' || d.shop_id || E'\n' || NEW.key::text || E'\n'
       || NEW.rpc || E'\n' || v_ctr::text || E'\n' || recovery_v1.offline_marker()))::text))::text, true);
  RETURN NEW;
END $$;
CREATE TRIGGER aa_s5fx_device_sign BEFORE INSERT ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION s5fx.autosign();
-- a signed NON-ledger device request (offline capability, surrender) by the labelled fixture device: sets the header for THIS
-- transaction and returns its request key. Call it in the same statement as the RPC (s5fx.capability below).
CREATE FUNCTION s5fx.request_header(p_org text, p_label text, p_rpc text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE h jsonb; d s5fx.devices; v_key uuid := gen_random_uuid(); v_ctr bigint := nextval('s5fx.counter');
BEGIN
  SELECT * INTO d FROM s5fx.devices WHERE org_id = p_org AND label = p_label;
  IF d.enrollment_id IS NULL THEN RAISE EXCEPTION 's5fx: no fixture device %/%', p_org, p_label; END IF;
  h := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  PERFORM set_config('request.headers', (h || jsonb_build_object('x-orvix-device', jsonb_build_object('v', 1, 'fx', 'fixture-request', 'key', v_key, 'enrollmentId', d.enrollment_id,
    'counter', v_ctr, 'sig', s5fx.rsa_sign(d, 'orvix-device-request-v1' || E'\n' || d.enrollment_id::text || E'\n' || p_org || E'\n' || d.shop_id || E'\n' || v_key::text || E'\n'
       || p_rpc || E'\n' || v_ctr::text || E'\n' || recovery_v1.offline_marker()))::text))::text, true);
  RETURN v_key;
END $$;
-- the device-signed offline capability request of a labelled fixture device (runs as the CALLER, like the RPC itself)
CREATE FUNCTION s5fx.capability(p_org text, p_shop text, p_label text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_dev text := (SELECT device_id FROM s5fx.device_ids WHERE org_id = p_org AND label = p_label);
BEGIN
  PERFORM s5fx.request_header(p_org, p_label, 'recovery_v1_offline_capability:' || p_shop || ':' || v_dev);
  RETURN public.recovery_v1_offline_capability(p_org, p_shop, v_dev);
END $$;
CREATE VIEW s5fx.device_ids AS SELECT org_id, shop_id, label, device_id, enrollment_id FROM s5fx.devices;
GRANT USAGE ON SCHEMA s5fx TO authenticated;
GRANT SELECT ON s5fx.device_ids TO authenticated;
GRANT EXECUTE ON FUNCTION s5fx.request_header(text,text,text), s5fx.capability(text,text,text) TO authenticated;
"""


def install_fixture_signer(sql):
    sql(SIGNER_SQL, 's5fx-install.log')


def add_fixture_device(sql, owner, dev, org, shop, user_id, label='default'):
    e = enroll(sql, owner, dev, org, shop, user_id, handle=f'fx-{org}-{label}', log='s5fx-enroll.log')
    k = dev.call('fixtureKey', handle=e['handle'])
    sql(f"INSERT INTO s5fx.devices VALUES ({q(org)},{q(shop)},{q(label)},{q(e['deviceId'])},{q(e['enrollmentId'])},{k['n']},{k['p']},{k['q']},{k['dp']},{k['dq']},{k['qi']},{k['bytes']});", 's5fx-device.log')
    return e
