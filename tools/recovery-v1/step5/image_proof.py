#!/usr/bin/env python3
"""Step 5 on the Supabase PostgreSQL 17 IMAGE (disposable phf-iso stack only): device enrollment, a forged enrollment row,
the ACTIVE gate and an owner-signed reopening, with the same synthetic signers as the private-cluster suite.

  image_proof.py OUT_DIR OWNER_KEYDIR OWNER_KEY_ID          (container phf-iso-db; prints one line per proof)
"""
import pathlib, subprocess, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s5lib
from s5lib import q

DB = 'phf-iso-db'


def main():
    out, keydir, key_id = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    out.mkdir(parents=True, exist_ok=True)

    def sql(text, log='image.log'):
        p = subprocess.run(['docker', 'exec', '-i', DB, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'],
                           input=text, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (out / log).write_text(p.stdout)
        if p.returncode: raise RuntimeError(f'{log}: {p.stdout[-1500:]}')
        return p.stdout

    def try_sql(text, log):
        try: return 'OK ' + sql(text, log).strip()[-200:]
        except RuntimeError as e: return 'REFUSED ' + str(e)[-220:]

    root = pathlib.Path(__file__).resolve().parents[3]
    owner = s5lib.Owner(sql, root / 'tools/recovery-v1/owner/owner-sim.mjs', keydir, out / 'owner-work')
    dev = s5lib.DeviceSim(root)
    try:
        row = sql("SELECT u.org_id||' '||u.shop_id||' '||u.id FROM public.users u WHERE u.shop_id IS NOT NULL AND u.is_active ORDER BY u.id LIMIT 1;").strip().split()
        if len(row) != 3:
            print('step5 image: no organization with a shop user on this stack; skipped'); return
        org, shop, user = row
        e = s5lib.enroll(sql, owner, dev, org, shop, user)
        state = sql(f"SELECT recovery_v1.device_enrollment_state({q(e['enrollmentId'])});").strip()
        print(f'step5 device enrollment on PG17 ({org}/{shop}): state={state}')
        b = dev.call('keygen', handle='img-forged')
        req = dev.call('request', handle='img-forged', orgId=org, shopId=shop, deviceId='till-image-forged-0001')
        sql(f"SELECT recovery_v1.device_request({q(req['request'])},{q(req['signature'])},u)::text FROM public.users u WHERE u.id={q(user)};")
        owner.keygen('img-attacker')
        a, s = owner.authorize('enroll-device', {'scope': org, 'ownerId': 'x', 'device': {'requestId': req['requestId'], 'orgId': org, 'shopId': shop,
                               'deviceId': 'till-image-forged-0001', 'keyFingerprint': b['fingerprint'], 'requestNonce': req['requestNonce'],
                               'notAfter': '2099-01-01T00:00:00.000Z', 'replacesEnrollmentId': None}}, key_id='img-attacker')
        forged = try_sql("INSERT INTO recovery_v1.device_enrollments(enrollment_id, org_id, shop_id, device_id, key_fingerprint, not_after, owner_key_id, nonce,"
                         f" authorization_text, signature, submitted_by) VALUES ({q(req['requestId'])}, {q(org)}, {q(shop)}, 'till-image-forged-0001',"
                         f" {q(b['fingerprint'])}, '2099-01-01', {q(key_id)}, gen_random_uuid(), {q(a)}, {q(s)}, 'superuser');", 'forged.log')
        print('step5 forged enrollment row (superuser INSERT): ' + ('refused' if 'UNVERIFIED_TRUST_ROW' in forged else forged))
        su = try_sql(f"UPDATE recovery_v1.org_state SET state='ACTIVE' WHERE org_id={q(org)};", 'su-active.log')
        print("step5 superuser UPDATE ... SET state='ACTIVE': " + ('refused' if 'REOPEN_AUTHORIZATION_REQUIRED' in su else su))
        r = s5lib.reopen(sql, owner, org)
        activation = sql(f"SELECT coalesce(recovery_v1.activation_problem({q(org)}), 'verified');").strip()
        print(f"step5 owner-signed reopening on PG17: {r.get('outcome')} decision={r.get('decision')} blockers={r.get('report', {}).get('blockers')} activation={activation}")
        others = sql(f"SELECT count(*) FILTER (WHERE state <> 'ACTIVE') || '/' || count(*) FROM recovery_v1.org_state WHERE org_id <> {q(org)};").strip()
        print(f'step5 other organizations still not ACTIVE: {others}')
        print('step5 integrity after: ' + sql("SELECT coalesce(recovery_v1.integrity_problem(), 'none');").strip())
    finally:
        dev.close()


if __name__ == '__main__':
    main()
