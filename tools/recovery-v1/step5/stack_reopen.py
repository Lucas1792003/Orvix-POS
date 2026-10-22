#!/usr/bin/env python3
"""Reopen ONE organization on the DISPOSABLE loopback stack (container phf-iso-db) through the GENUINE owner-signed protocol
(RECONCILING, recorded report, synthetic owner signature over its digest made on the host, submission). Used by test
installers that previously set a superuser ACTIVE fixture, which Recovery V1 refuses since Step 5.

  stack_reopen.py OUT_DIR OWNER_KEYDIR ORG_ID      -> prints {"outcome": ..., "decision": ..., "blockers": [...]}
"""
import json, pathlib, re, subprocess, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s5lib


def main():
    out, keydir, org = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    if not re.fullmatch(r'[A-Za-z0-9_-]+', org): raise SystemExit('bad org id')
    out.mkdir(parents=True, exist_ok=True)

    def sql(text, log='stack-reopen.log'):
        p = subprocess.run(['docker', 'exec', '-i', 'phf-iso-db', 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'],
                           input=text, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (out / log).write_text(p.stdout)
        if p.returncode: raise RuntimeError(f'{log}: {p.stdout[-1500:]}')
        return p.stdout

    root = pathlib.Path(__file__).resolve().parents[3]
    owner = s5lib.Owner(sql, root / 'tools/recovery-v1/owner/owner-sim.mjs', keydir, out / 'reopen-work')
    r = s5lib.reopen(sql, owner, org)
    print(json.dumps({'outcome': r.get('outcome'), 'decision': r.get('decision'), 'blockers': r.get('report', {}).get('blockers')}))
    if r.get('outcome') != 'reopened': raise SystemExit(1)


if __name__ == '__main__':
    main()
