#!/usr/bin/env python3
"""Step 5 fixture CLI, called from SQL suites through psql (tools/recovery-v1/step5/fixture-activate.psql).

  fixture_cli.py activate     reopen $S5FX_ORG through the GENUINE owner-signed protocol (synthetic owner key)

Environment (set by tools/recovery-v1/db/db-smoke.py for its own disposable cluster only):
  S5FX_PSQL (JSON psql argv), S5FX_ORG, S5FX_SIM (owner-sim.mjs), S5FX_KEYDIR (owner key dir), S5FX_DIR (work dir).
"""
import json, os, pathlib, subprocess, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s5lib


def main():
    if sys.argv[1:] != ['activate']: raise SystemExit('usage: fixture_cli.py activate')
    argv = json.loads(os.environ['S5FX_PSQL'])
    if '/private/tmp/' not in ' '.join(argv): raise SystemExit('REFUSED: the fixture runs only against a disposable cluster socket under /private/tmp')
    work = pathlib.Path(os.environ['S5FX_DIR']); work.mkdir(parents=True, exist_ok=True)

    def sql(text, log='fixture.log'):
        p = subprocess.run(['psql', *argv], input=text, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (work / log).write_text(p.stdout)
        if p.returncode: raise RuntimeError(f'{log}: {p.stdout[-2000:]}')
        return p.stdout

    owner = s5lib.Owner(sql, os.environ['S5FX_SIM'], os.environ['S5FX_KEYDIR'], work)
    r = s5lib.reopen(sql, owner, os.environ['S5FX_ORG'])
    if r.get('outcome') not in ('reopened', 'already_active'): raise SystemExit(f'fixture reopening refused: {r}')
    print(json.dumps({'fixture_reopen': os.environ['S5FX_ORG'], 'outcome': r['outcome'], 'decision': r.get('decision')}))


if __name__ == '__main__':
    main()
