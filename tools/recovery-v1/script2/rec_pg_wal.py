#!/usr/bin/env python3
"""Script 2 / RECOVERY tester: WAL archive gap, zero-filled segment, PITR behaviour, and incomplete logical restores.

  python3 -I tools/recovery-v1/script2/rec_pg_wal.py [EVIDENCE_DIR]

Its OWN disposable PostgreSQL clusters only: /private/tmp/s2r.XXXX, unix socket in that directory, listen_addresses='',
ports 55493/55494. No Docker, no shared/hosted DB, synthetic rows only. Every cluster is stopped and its directory removed
at the end; logs and a results JSON are kept in EVIDENCE_DIR (default: a fresh /private/tmp/s2r-ev.XXXX).

r70 control PITR; r71 middle WAL segment deleted, no target; r72 deleted, with target; r73 zero-filled segment, with target;
r74 zero-filled, no target; r75 Orvix verifyWalCoverage on the real archive; r76 pg_waldump; r77-r79 logical dump checks.
"""
import json, os, pathlib, re, shutil, subprocess, sys, tempfile, time

ROOT = pathlib.Path(__file__).resolve().parents[3]
EV = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.mkdtemp(prefix='s2r-ev.', dir='/private/tmp'))
EV.mkdir(parents=True, exist_ok=True)
BASE = pathlib.Path(tempfile.mkdtemp(prefix='s2r.', dir='/private/tmp'))
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV.update(PSQLRC='/dev/null')
SEG = 16 * 1024 * 1024
results, started = [], []


def rec(i, scenario, expected, actual, status):
    results.append({'id': i, 'scenario': scenario, 'expected': expected, 'actual': actual, 'status': status})
    (EV / 'rec-wal-results.json').write_text(json.dumps(results, indent=1) + '\n')
    print(f'{i} {status} | {actual[:220]}', flush=True)


def sh(argv, log=None, check=True, **kw):
    p = subprocess.run(argv, text=True, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kw)
    if log: (EV / log).write_text(p.stdout)
    if check and p.returncode: raise RuntimeError(f'{argv[0]} rc={p.returncode}: {p.stdout[-1500:]}')
    return p


def q(sock, port, sql, db='postgres', check=True):
    return sh(['psql', '-X', '-q', '-A', '-t', '-h', str(sock), '-p', str(port), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql], check=check).stdout.strip()


def start(data, port, sock, log, extra_conf, wait_s=60):
    sock.mkdir(mode=0o700, exist_ok=True)
    with open(data / 'postgresql.auto.conf', 'a') as f:
        f.write(f"\nlisten_addresses = ''\nunix_socket_directories = '{sock}'\nport = {port}\n" + extra_conf)
    p = sh(['pg_ctl', '-D', str(data), '-l', str(log), '-w', '-t', str(wait_s), 'start'], check=False)
    if p.returncode == 0: started.append(data)
    return p.returncode == 0


def stop(data):
    if (data / 'postmaster.pid').exists():
        sh(['pg_ctl', '-D', str(data), '-m', 'fast', '-w', 'stop'], check=False)
    if data in started: started.remove(data)


def log_lines(log):
    t = pathlib.Path(log).read_text() if pathlib.Path(log).exists() else ''
    keep = [l for l in t.splitlines() if re.search(r'redo|recovery|FATAL|could not|invalid|timeline|archive recovery|consistent|selected new', l)]
    return keep


def main():
    data, arch, sock = BASE / 'p', BASE / 'a', BASE / 's'
    arch.mkdir(mode=0o700)
    sh(['initdb', '-D', str(data), '-U', 'postgres', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject'], 'initdb.log')
    ok = start(data, 55493, sock, EV / 'primary.log',
               f"wal_level = replica\narchive_mode = on\narchive_command = 'test ! -f {arch}/%f && cp %p {arch}/%f'\nmax_wal_senders = 2\n")
    if not ok: raise RuntimeError('primary did not start')
    q(sock, 55493, "CREATE TABLE t(id serial PRIMARY KEY, batch int NOT NULL, v text NOT NULL);")
    sh(['pg_basebackup', '-h', str(sock), '-p', '55493', '-U', 'postgres', '-D', str(BASE / 'bb'), '-X', 'none', '-c', 'fast'], 'basebackup.log')
    label = (BASE / 'bb' / 'backup_label').read_text()
    start_lsn = re.search(r'START WAL LOCATION: (\S+)', label).group(1)
    segs = {}
    for b in range(1, 5):
        q(sock, 55493, f"INSERT INTO t(batch,v) SELECT {b}, md5(g::text) FROM generate_series(1,1000) g;")
        segs[b] = q(sock, 55493, "SELECT pg_walfile_name(pg_current_wal_lsn());")
        q(sock, 55493, "SELECT pg_switch_wal();")
    target_time = q(sock, 55493, "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00';")
    end_lsn = q(sock, 55493, "SELECT pg_current_wal_lsn();")
    q(sock, 55493, "INSERT INTO t(batch,v) VALUES (5,'after-target');")
    last = q(sock, 55493, "SELECT pg_walfile_name(pg_current_wal_lsn());"); q(sock, 55493, "SELECT pg_switch_wal();")
    for _ in range(200):
        if q(sock, 55493, "SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver;") >= last: break
        time.sleep(0.05)
    # ---- logical dumps (r77-r79) from the same primary
    q(sock, 55493, "CREATE DATABASE shop;")
    q(sock, 55493, "CREATE TABLE sales(id int PRIMARY KEY, total int); CREATE TABLE sale_items(id int PRIMARY KEY, sale_id int REFERENCES sales, qty int);"
                   "INSERT INTO sales SELECT g, g*100 FROM generate_series(1,100) g; INSERT INTO sale_items SELECT g, 1+g%100, 1 FROM generate_series(1,300) g;", db='shop')
    full, partial, trunc = BASE / 'full.dump', BASE / 'partial.dump', BASE / 'trunc.dump'
    sh(['pg_dump', '-h', str(sock), '-p', '55493', '-U', 'postgres', '-d', 'shop', '-Fc', '-f', str(full)])
    sh(['pg_dump', '-h', str(sock), '-p', '55493', '-U', 'postgres', '-d', 'shop', '-Fc', '-t', 'sales', '-f', str(partial)])
    b = full.read_bytes(); trunc.write_bytes(b[:int(len(b) * 0.6)])
    pg_restore = shutil.which('pg_restore')
    node = subprocess.run(['node', '--input-type=module', '-e', f"""
import {{ validateLogicalDump }} from '{ROOT}/tools/recovery-v1/restore-verification.mjs';
// the tables a real backup's counts.json lists (its `rows` keys); the verifier passes them the same way (inspectContents)
const counted = ['public.sales', 'public.sale_items'];
console.log(JSON.stringify({{ full: validateLogicalDump('{full}', '{pg_restore}', counted), partial: validateLogicalDump('{partial}', '{pg_restore}', counted), truncated: validateLogicalDump('{trunc}', '{pg_restore}', counted) }}));"""],
                          text=True, capture_output=True, env=ENV)
    v = json.loads(node.stdout.strip().splitlines()[-1])
    rec('r77', 'truncated custom-format dump (60% of bytes)', 'validateLogicalDump: damaged', json.dumps(v['truncated']), 'PASS' if v['truncated']['status'] == 'damaged' else 'FAIL')
    q(sock, 55493, "CREATE DATABASE r_partial;"); q(sock, 55493, "CREATE DATABASE r_trunc;")
    pp = sh(['pg_restore', '-h', str(sock), '-p', '55493', '-U', 'postgres', '-d', 'r_partial', '--exit-on-error', str(partial)], 'restore-partial.log', check=False)
    pt = sh(['pg_restore', '-h', str(sock), '-p', '55493', '-U', 'postgres', '-d', 'r_trunc', '--exit-on-error', str(trunc)], 'restore-trunc.log', check=False)
    have_items = q(sock, 55493, "SELECT to_regclass('public.sale_items') IS NOT NULL;", db='r_partial')
    rec('r78', 'partial dump (pg_dump -t sales: sale_items missing) checked and restored', 'incomplete restore detected',
        f"validateLogicalDump={v['partial']['status']} pg_restore_rc={pp.returncode} sale_items_present={have_items} (table list from counts.json compared with the dump TOC)",
        'FAIL' if v['partial']['status'] == 'verified' and pp.returncode == 0 else 'PASS')
    rec('r79', 'pg_restore --exit-on-error of the truncated dump; full dump control', 'truncated restore fails loudly; full verified',
        f"truncated_restore_rc={pt.returncode} full={v['full']['status']}", 'PASS' if pt.returncode != 0 and v['full']['status'] == 'verified' else 'FAIL')
    stop(data)

    # ---- PITR restores
    names = sorted(f.name for f in arch.iterdir() if re.fullmatch(r'[0-9A-F]{24}', f.name))
    gap = segs[2]
    def restore(case, archive_dir, target, port):
        d = BASE / f'r{case}'; shutil.copytree(BASE / 'bb', d); d.chmod(0o700)
        (d / 'recovery.signal').write_text('')
        conf = f"restore_command = 'cp {archive_dir}/%f %p'\nrecovery_target_action = 'promote'\narchive_mode = off\nhot_standby = off\n"
        if target: conf += f"recovery_target_time = '{target}'\n"
        log = EV / f'restore-{case}.log'
        up = start(d, port, BASE / f's{case}', log, conf)
        # pg_ctl -w returns while recovery is still running (or about to FATAL): wait for promotion or death
        for _ in range(600):
            if not (d / 'postmaster.pid').exists(): up = False; break
            r = sh(['psql', '-X', '-A', '-t', '-h', str(BASE / f's{case}'), '-p', str(port), '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT pg_is_in_recovery();'], check=False)
            if r.returncode == 0 and r.stdout.strip() == 'f': break
            time.sleep(0.1)
        else: up = False
        if not up and d in started: started.remove(d)
        out = {'started': up}
        if up:
            out.update(rows=q(BASE / f's{case}', port, "SELECT count(*)||' rows, batches '||string_agg(DISTINCT batch::text, ',') FROM t;"),
                       in_recovery=q(BASE / f's{case}', port, "SELECT pg_is_in_recovery();"))
            stop(d)
        out['log'] = log_lines(log)[-6:]
        shutil.rmtree(d, ignore_errors=True)
        return out
    a = restore('A', arch, target_time, 55494)
    rec('r70', 'control: base backup + complete WAL archive, PITR to the time after batch 4', 'starts, 4000 rows (batches 1-4), promoted',
        f"{a.get('rows')} in_recovery={a.get('in_recovery')}", 'PASS' if a.get('rows', '').startswith('4000 rows') else 'FAIL')
    arch_b = BASE / 'a_missing'; shutil.copytree(arch, arch_b); (arch_b / gap).unlink()
    b1 = restore('B', arch_b, None, 55494)
    rec('r71', f'middle WAL segment {gap} (batch 2) deleted; recovery WITHOUT a target ("latest", WAL-ARCHIVING.md step 3)', 'restore stops/fails, never silently skips',
        f"started={b1['started']} result={b1.get('rows')} in_recovery={b1.get('in_recovery')} log={b1['log'][-3:]}",
        'LIMITATION' if b1['started'] and b1.get('in_recovery') == 'f' else 'PASS')   # PostgreSQL behaviour: ends at the gap, promotes, no error
    b2 = restore('C', arch_b, target_time, 55494)
    rec('r72', 'middle WAL segment deleted; recovery WITH recovery_target_time after the gap', 'refuses to finish (FATAL), nothing promoted',
        f"started={b2['started']} log={b2['log'][-3:]}", 'PASS' if not b2['started'] and any('before configured recovery target' in l for l in b2['log']) else 'FAIL')
    arch_z = BASE / 'a_zero'; shutil.copytree(arch, arch_z); (arch_z / gap).write_bytes(b'\0' * SEG)
    z1 = restore('D', arch_z, target_time, 55494)
    rec('r73', 'middle WAL segment replaced by 16 MiB of zeros; recovery WITH target', 'refuses (FATAL)', f"started={z1['started']} log={z1['log'][-3:]}",
        'PASS' if not z1['started'] else 'FAIL')
    z2 = restore('E', arch_z, None, 55494)
    rec('r74', 'zero-filled middle segment; recovery WITHOUT target', 'restore stops/fails, never silently skips',
        f"started={z2['started']} result={z2.get('rows')} in_recovery={z2.get('in_recovery')} log={z2['log'][-3:]}",
        'LIMITATION' if z2['started'] and z2.get('in_recovery') == 'f' else 'PASS')
    # ---- Orvix tooling on the real archives
    node = subprocess.run(['node', '--input-type=module', '-e', f"""
import {{ readFileSync, readdirSync }} from 'node:fs';
import {{ verifyWalCoverage }} from '{ROOT}/tools/recovery-v1/restore-verification.mjs';
const load = (d) => new Map(readdirSync(d).filter((n) => /^[0-9A-F]{{24}}$/.test(n)).map((n) => ['wal/' + n, readFileSync(d + '/' + n)]));
const req = {{ timeline: 1, startLsn: '{start_lsn}', endLsnExclusive: '{end_lsn}', segmentBytes: {SEG} }};
const o = (m) => {{ const r = verifyWalCoverage(m, req); return {{ status: r.status, missing: r.missing, findings: r.findings.map((f) => f.code) }}; }};
console.log(JSON.stringify({{ complete: o(load('{arch}')), missing: o(load('{arch_b}')), zeroed: o(load('{arch_z}')) }}));"""], text=True, capture_output=True, env=ENV)
    w = json.loads(node.stdout.strip().splitlines()[-1])
    rec('r75a', 'restore-verification.verifyWalCoverage on the real archive with the deleted segment', 'REQUIRED_WAL_MISSING', json.dumps(w['missing']),
        'PASS' if w['missing']['status'] == 'incomplete' and gap in (w['missing']['missing'] or []) and w['complete']['status'] == 'verified' else 'FAIL')
    rec('r75b', 'verifyWalCoverage on the real archive with the zero-filled segment (PostgreSQL itself cannot replay it, r73/r74)', 'not verified',
        json.dumps(w['zeroed']), 'FAIL' if w['zeroed']['status'] == 'verified' else 'PASS')
    wd = sh(['pg_waldump', '-p', str(arch_z), names[0], names[-1]], check=False)
    tail = [l for l in wd.stdout.splitlines() if 'error' in l.lower() or 'invalid' in l.lower()][-1:] or wd.stdout.splitlines()[-1:]
    rec('r76', 'pg_waldump over the zero-filled archive (candidate content check for the tooling)', 'reports the damaged segment',
        f"rc={wd.returncode} {tail}", 'PASS' if wd.returncode != 0 or tail and 'invalid' in tail[0].lower() else 'FAIL')


try:
    main()
finally:
    for d in list(started): stop(d)
    shutil.rmtree(BASE, ignore_errors=True)
    print(f'evidence: {EV}  (clusters removed: {not BASE.exists()})')
