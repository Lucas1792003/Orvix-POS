#!/usr/bin/env python3
"""Plan a migration (or rollback) run for deploy/lucashome/apply-migrations.sh — and refuse unsafe ones.

Pure: reads the repo files plus two small TSV snapshots of the database (taken by the runner) and
writes the SQL bundle the runner executes in ONE psql --single-transaction:

  000_runner_guard.sql   try-lock (one runner at a time), bounded lock_timeout, ledger lock, and a
                         re-check that the ledger and the 086 lineage facts are still what was planned
  NNN_*.sql              the migrations (or the rollback file), byte-identical to the repo
  zzz_runner_record.sql  the ledger rows: version, ARRAY['sha256:<file hash>'], name (forward only;
                         a rollback file removes its own row)

Refuses (exit 2, "REFUSE: …" lines, nothing written) when: a file name or version is malformed or
duplicated; a recorded version has no repo file or is not NNN; a recorded checksum differs from the
repo file; a selected version is already recorded, older than the newest recorded one, on the
held list without --allow-skipped, or behind an unrecorded earlier version (gap); the 086 lineage
(op_execute or the (org_id, key) ledger identity) is present without 086 recorded — only 086 itself
(the documented forward recovery) may run then; 086 is recorded but its executor is missing; Recovery V1
(schema recovery_v1, the provisional installer) is present and the plan is a rollback, includes 086 or 087,
or is any other forward run without --recovery-v1-reviewed; the
ledger table lacks version/statements/name; or a file contains a statement that cannot run inside
one transaction (owner review). It never edits the ledger itself and never applies a migration
that was not selected.

  migration_plan.py forward  --migrations DIR --ledger L.tsv --facts F.tsv --from NNN --to NNN
                             [--held 084] [--allow-skipped] [--lock-timeout 10s] --out DIR
  migration_plan.py rollback --migrations DIR --rollbacks DIR --ledger L.tsv --facts F.tsv
                             --version NNN --owner-confirmed-till-queues-empty [--lock-timeout 5s] --out DIR

L.tsv: version <TAB> sha256 entries in statements (comma-joined, may be empty) <TAB> statements count
F.tsv: key <TAB> value  (ledger_md5, ledger_cols, has_op_execute, has_v87, has_recovery_v1, idem_pk)
"""
import argparse
import hashlib
import os
import re
import sys

NAME_RE = re.compile(r"^(\d{3})_([a-z0-9_]+)\.sql$")
SHA_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ROLLBACK_GATE = "till-queues-empty-confirmed-by-owner"
LINEAGE_VERSION = "086"   # first migration of the per-organisation ledger (op_execute, PK (org_id, key))

# Statements PostgreSQL refuses (or that misbehave) inside a transaction block, and psql meta-commands.
NON_TX = [
    (re.compile(r"(^|;)\s*(BEGIN|START\s+TRANSACTION|COMMIT|END\s+(WORK|TRANSACTION)|ROLLBACK|ABORT)\b"
                r"([^;\n]*;|\s*;|\s+AND\s+(NO\s+)?CHAIN\s*;)", re.I | re.M), "transaction control"),
    (re.compile(r"\bCONCURRENTLY\b", re.I), "CONCURRENTLY"),
    (re.compile(r"^\s*VACUUM\b", re.I | re.M), "VACUUM"),
    (re.compile(r"\bALTER\s+SYSTEM\b", re.I), "ALTER SYSTEM"),
    (re.compile(r"\b(CREATE|DROP)\s+(DATABASE|TABLESPACE)\b", re.I), "CREATE/DROP DATABASE/TABLESPACE"),
    (re.compile(r"\bALTER\s+TYPE\b[^;]*\bADD\s+VALUE\b", re.I), "ALTER TYPE … ADD VALUE"),
    (re.compile(r"^\s*\\", re.M), "psql meta-command"),
    (re.compile(r"(^|[\s;])\\(gexec|gset|g|c|connect|set|unset|i|ir|include|include_relative|o|out|copy|!|if|elif|else|endif|q)(\s|$)", re.M), "psql meta-command"),
]


def rd(path):
    with open(path) as f:
        return f.read()


def wr(path, text):
    with open(path, "w") as f:
        f.write(text)


class Refuse(Exception):
    pass


def strip_comments(sql):
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", "", sql)


def non_transactional(sql):
    code = strip_comments(sql)
    return [label for rx, label in NON_TX if rx.search(code)]


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def repo_files(mig_dir):
    """{version: filename}; refuses malformed names and duplicate versions."""
    out, bad = {}, []
    for f in sorted(os.listdir(mig_dir)):
        if not f.endswith(".sql"):
            continue
        m = NAME_RE.match(f)
        if not m:
            bad.append(f"malformed migration file name {f!r} (expected NNN_name.sql)")
            continue
        v = m.group(1)
        if v in out:
            bad.append(f"duplicate migration version {v}: {out[v]} and {f}")
        out.setdefault(v, f)
    nums = sorted(int(v) for v in out)
    missing = [f"{n:03d}" for n in range(1, nums[-1] + 1) if f"{n:03d}" not in out] if nums else []
    if missing:
        bad.append(f"migration numbering has gaps (no file for {', '.join(missing)}): unknown state; owner review")
    if bad:
        raise Refuse(*bad)
    return out


def read_ledger(path):
    """[(version, [sha256 entries], statements count)]; refuses duplicate or malformed versions."""
    rows, seen, bad = [], set(), []
    for line in rd(path).split("\n"):
        if not line.strip():
            continue
        p = line.split("\t")
        if len(p) != 3:
            raise Refuse(f"unreadable ledger line {line[:60]!r}")
        v, shas, n = p[0], [s for s in p[1].split(",") if s], int(p[2] or 0)
        if not re.fullmatch(r"\d{3}", v):
            bad.append(f"ledger has a version this runner does not know: {v!r} (unknown state; owner review)")
        if v in seen:
            bad.append(f"ledger records version {v} more than once")
        if any(not SHA_RE.match(s) for s in shas) or len(shas) > 1:
            bad.append(f"ledger version {v}: malformed or multiple checksums {shas}")
        elif n != len(shas):
            # legacy rows have NO statements; anything else (SQL text, extra entries) is not this runner's
            bad.append(f"ledger version {v}: statements hold {n} entr{'y' if n == 1 else 'ies'} that are not one sha256 "
                       "checksum (unknown state; owner review)")
        seen.add(v)
        rows.append((v, shas, n))
    if bad:
        raise Refuse(*bad)
    return rows


def read_facts(path):
    facts = {}
    for line in rd(path).split("\n"):
        if line.strip():
            k, _, val = line.partition("\t")
            facts[k] = val
    for k in ("ledger_md5", "ledger_cols", "has_op_execute", "has_v87", "has_recovery_v1", "idem_pk"):
        if k not in facts:
            raise Refuse(f"database fact {k} missing (unknown state)")
    # embedded in the guard SQL: exact formats only
    if not (re.fullmatch(r"[0-9a-f]{32}", facts["ledger_md5"]) and facts["has_op_execute"] in ("t", "f") and facts["has_v87"] in ("t", "f") and facts["has_recovery_v1"] in ("t", "f")
            and re.fullmatch(r"[a-z_,]*", facts["idem_pk"]) and re.fullmatch(r"[a-z_,]*", facts["ledger_cols"])):
        raise Refuse("database facts are malformed (unknown state)")
    return facts


def check_history(files, ledger, facts, mig_dir):
    """Problems with what is already recorded, independent of the selection."""
    problems, notes = [], []
    cols = set(facts["ledger_cols"].split(","))
    missing = {"version", "statements", "name"} - cols
    if missing:
        problems.append(f"supabase_migrations.schema_migrations lacks column(s) {sorted(missing)}: cannot record checksums")
    for v, shas, _n in ledger:
        if v not in files:
            problems.append(f"ledger records {v}, but supabase/migrations has no {v}_*.sql (unknown state)")
            continue
        if shas:
            want = "sha256:" + sha256(os.path.join(mig_dir, files[v]))
            if shas[0] != want:
                problems.append(f"CHECKSUM MISMATCH: {v} was recorded as {shas[0][:19]}…, the repo file {files[v]} is {want[:19]}… "
                                "(the file changed after it was applied; never auto-repaired — owner review)")
    legacy = [v for v, shas, _ in ledger if not shas]
    if legacy:
        notes.append(f"{len(legacy)} recorded version(s) carry no checksum (recorded before checksums; not verifiable): "
                     f"{legacy[0]}…{legacy[-1]}")
    recorded = {v for v, _, _ in ledger}
    lineage = facts["has_op_execute"] == "t" or facts["idem_pk"] == "org_id,key"
    if LINEAGE_VERSION in recorded and facts["has_op_execute"] != "t":
        problems.append(f"{LINEAGE_VERSION} is recorded but public.op_execute is missing (inconsistent; owner review — "
                        f"a rollback removes the {LINEAGE_VERSION} ledger row)")
    return problems, notes, recorded, lineage


def guard_sql(facts, lock_timeout, mode, gate=None):
    lines = [
        f"-- apply-migrations.sh runner guard ({mode}); generated by migration_plan.py, runs first in the same transaction",
        f"SET LOCAL lock_timeout = '{lock_timeout}';",
    ] + (["SET LOCAL statement_timeout = '120s';"] if mode == "rollback" else []) + [
        "-- this transaction's id: every later runner file (and the rollback) checks it is still the same transaction",
        "SELECT set_config('orvix.runner_txid', txid_current()::text, true) IS NOT NULL AS runner_txid_set;",
        "DO $$ BEGIN",
        "  IF NOT pg_try_advisory_xact_lock(hashtext('orvix:apply-migrations')) THEN",
        "    RAISE EXCEPTION 'RUNNER_BUSY: another migration runner is active; nothing applied';",
        "  END IF;",
        "END $$;",
        "LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE;",
        "DO $$ BEGIN",
        "  -- the same expression apply-migrations.sh used for its snapshot",
        "  IF (SELECT md5(coalesce(string_agg(version || ':' || coalesce(to_jsonb(m)->>'statements', ''), '|' ORDER BY version), ''))",
        f"        FROM supabase_migrations.schema_migrations m) <> '{facts['ledger_md5']}' THEN",
        "    RAISE EXCEPTION 'LEDGER_CHANGED: the migration ledger changed after planning; nothing applied — plan again';",
        "  END IF;",
        "  IF (to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NOT NULL)::text <> "
        f"'{'true' if facts['has_op_execute'] == 't' else 'false'}'",
        "     OR coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_constraint c",
        "          CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)",
        "          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum",
        f"         WHERE c.conrelid = to_regclass('public.idempotency_keys') AND c.contype = 'p'), '') <> '{facts['idem_pk']}' THEN",
        "    RAISE EXCEPTION 'SCHEMA_CHANGED: the executor / ledger identity changed after planning; nothing applied — plan again';",
        "  END IF;",
        "  IF (to_regnamespace('recovery_v1') IS NOT NULL)::text <> "
        f"'{'true' if facts['has_recovery_v1'] == 't' else 'false'}' THEN",
        "    RAISE EXCEPTION 'SCHEMA_CHANGED: Recovery V1 was installed or removed after planning; nothing applied — plan again';",
        "  END IF;",
        "END $$;",
    ]
    if gate:
        lines.append(f"SELECT set_config('orvix.rollback_gate', '{gate}', true) IS NOT NULL AS gate_set;")
    return "\n".join(lines) + "\n"


def tripwire(where):
    """Raises when the runner's transaction ended (a COMMIT/END in a migration): the statements
    before it may have committed — reported, never recorded as applied."""
    return ("DO $$ BEGIN\n"
            "  IF current_setting('orvix.runner_txid', true) IS DISTINCT FROM txid_current()::text THEN\n"
            f"    RAISE EXCEPTION 'RUNNER_TRANSACTION_BROKEN ({where}): a migration ended the runner transaction; "
            "earlier statements may be committed — owner review, nothing is recorded';\n"
            "  END IF;\nEND $$;\n")


def plan_forward(a):
    files = repo_files(a.migrations)
    ledger = read_ledger(a.ledger)
    facts = read_facts(a.facts)
    problems, notes, recorded, lineage = check_history(files, ledger, facts, a.migrations)
    held = set(x for x in (a.held or "").replace(",", " ").split() if x)
    for x in held:
        if not re.fullmatch(r"\d{3}", x):
            raise Refuse(f"--held entry {x!r} is not NNN")
    if not (re.fullmatch(r"\d{3}", a.from_) and re.fullmatch(r"\d{3}", a.to) and a.from_ <= a.to):
        raise Refuse(f"--from/--to must be NNN with from <= to (got {a.from_!r}, {a.to!r})")
    sel = [v for v in sorted(files) if a.from_ <= v <= a.to]
    if not sel:
        raise Refuse(f"no migration files in {a.from_}–{a.to}")
    if a.from_ not in files or a.to not in files:
        problems.append(f"--from {a.from_} / --to {a.to} must name existing migration files exactly")
    newest = max(recorded) if recorded else None
    for v in sel:
        if v in recorded:
            problems.append(f"{v} is already recorded as applied (never re-run; forward recovery for 086 after a rollback "
                            "is the rollback removing its row)")
        elif newest and v < newest:
            problems.append(f"{v} is older than the newest recorded migration {newest}: out-of-order application refused")
        if v in held and not a.allow_skipped:
            problems.append(f"{v} is on the held list ({' '.join(sorted(held))}); it is applied only with --allow-skipped "
                            "after its owner gate")
    for v in sorted(files):
        if v < sel[0] and v not in recorded and v not in held:
            problems.append(f"gap: earlier migration {v} ({files[v]}) is not recorded and not on the held list — "
                            "never applied implicitly")
    if lineage and LINEAGE_VERSION not in recorded:
        if sel != [LINEAGE_VERSION]:
            problems.append(f"the {LINEAGE_VERSION} lineage is present (op_execute={facts['has_op_execute']}, ledger identity "
                            f"({facts['idem_pk']})) but {LINEAGE_VERSION} is not recorded: only {LINEAGE_VERSION} itself "
                            "(the documented forward recovery) may run; never 062–085")
    if facts["has_v87"] == "t" and LINEAGE_VERSION in sel:
        # 086's grant step re-owns and revokes EVERY public op_% function, op_execute_v87 / op_status_v87
        # included: the v87 tills would be refused everything (audit 2026-10-20; supabase/tests/m086-rerun).
        problems.append(f"087 is installed here (schema recovery / op_execute_v87 present): {LINEAGE_VERSION} must never be "
                        f"re-run after 087 — its grant step would take the v87 executors away from every till. Forward "
                        f"recovery for {LINEAGE_VERSION} exists only before 087 (or after an 087 rollback)")
    if facts["has_recovery_v1"] == "t":
        # Recovery V1 pins the idempotency stage (its DDL guard refuses 086) and adopts 087 only when 087
        # was installed BEFORE it; 087 applied after V1 quarantines every organization and cannot be
        # rolled back (its rollback drops every zz_recovery_* trigger, V1's included).
        for v in ("086", "087"):
            if v in sel:
                problems.append(f"Recovery V1 is installed here (schema recovery_v1): {v} must never run after it — V1 "
                                f"{'pins the idempotency stage' if v == '086' else 'adopts 087 only when 087 was installed first; 087 after V1 quarantines every organization'}")
        if not a.recovery_v1_reviewed:
            problems.append("Recovery V1 is installed here (schema recovery_v1): a new migration's tables are not guarded by "
                            "V1 and its DDL must pass V1's DDL guard — apply only after its V1 review, with --recovery-v1-reviewed")
    elif a.recovery_v1_reviewed:
        problems.append("--recovery-v1-reviewed was given but Recovery V1 is not installed here: refused (it attests a V1 review only)")
    for v in sel:
        bad = non_transactional(rd(os.path.join(a.migrations, files[v])))
        if bad:
            problems.append(f"{files[v]} contains {', '.join(bad)}: cannot run inside the runner's single transaction "
                            "— stop for owner review")
    if problems:
        raise Refuse(*problems)
    os.makedirs(a.out, exist_ok=True)
    wr(os.path.join(a.out, "000_runner_guard.sql"), guard_sql(facts, a.lock_timeout, "forward"))
    vals = []
    for v in sel:
        name = NAME_RE.match(files[v]).group(2)
        vals.append(f"('{v}', ARRAY['sha256:{sha256(os.path.join(a.migrations, files[v]))}']::text[], '{name}')")
    rec = ("-- apply-migrations.sh ledger record; same transaction as the migrations (no ON CONFLICT: a clash aborts all)\n"
           + tripwire("before the ledger record") +
           "INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES\n  "
           + ",\n  ".join(vals) + ";\n")
    wr(os.path.join(a.out, "zzz_runner_record.sql"), rec)
    order = ["000_runner_guard.sql"]
    for v in sel:
        between = f"{v}_zz_runner_check.sql"
        wr(os.path.join(a.out, between), f"-- apply-migrations.sh: after {files[v]}\n" + tripwire(f"after {files[v]}")
           + f"SET LOCAL lock_timeout = '{a.lock_timeout}';\n")
        order += [files[v], between]
    order += ["zzz_runner_record.sql"]
    wr(os.path.join(a.out, "files.txt"), "\n".join(order) + "\n")
    for n in notes:
        print(f"note: {n}")
    print(f"plan: apply {' '.join(sel)} in one transaction, then record each with its sha256")
    for v in sel:
        print(f"  {files[v]}  sha256:{sha256(os.path.join(a.migrations, files[v]))}")
    skipped = sorted(v for v in held if v not in recorded and v < sel[0])
    if skipped:
        print(f"held (not applied, by design): {' '.join(skipped)}")
    return 0


def plan_rollback(a):
    files = repo_files(a.migrations)
    ledger = read_ledger(a.ledger)
    facts = read_facts(a.facts)
    problems, notes, recorded, _ = check_history(files, ledger, facts, a.migrations)
    v = a.version
    if facts["has_recovery_v1"] == "t":
        # every rollback file drops or re-grants objects V1 guards (087's drops every zz_recovery_* trigger,
        # V1's included, and restores pre-V1 grants); V1's DDL guard refuses them anyway — refuse up front
        problems.append(f"Recovery V1 is installed here (schema recovery_v1): rollback of {v} is refused (it would remove "
                        "or re-grant what V1 guards; V1 has no uninstall — forward repair only, owner decision)")
    if not re.fullmatch(r"\d{3}", v) or v not in files:
        raise Refuse(f"--rollback {v!r}: no such migration")
    rb = [f for f in sorted(os.listdir(a.rollbacks)) if f.startswith(f"{v}_") and f.endswith(".rollback.sql")]
    if len(rb) != 1:
        raise Refuse(f"expected exactly one supabase/rollbacks/{v}_*.rollback.sql, found {rb}")
    if not re.fullmatch(r"\d{3}_[a-z0-9_]+\.rollback\.sql", rb[0]):
        raise Refuse(f"malformed rollback file name {rb[0]!r}")
    if not a.owner_confirmed_till_queues_empty:
        problems.append("the owner has not confirmed that every till's queue is empty AND no till has an unresolved "
                        "online-only operation (or both were exported and reconciled by an owner with the current build): pass "
                        "--owner-confirmed-till-queues-empty only after checking every till — the server cannot prove it. "
                        "After a rollback, current-build tills hold every executor operation until 086 is re-applied")
    if v not in recorded:
        problems.append(f"{v} is not recorded as applied: nothing to roll back")
    elif max(recorded) != v:
        problems.append(f"{v} is not the newest recorded migration ({max(recorded)}): roll back newer ones first")
    else:
        shas = dict((x, s) for x, s, _ in ledger)[v]
        if not shas:
            problems.append(f"{v} was recorded without a checksum: cannot prove the rollback matches what was applied "
                            "(owner review)")
    bad = non_transactional(rd(os.path.join(a.rollbacks, rb[0])))
    if bad:
        problems.append(f"{rb[0]} contains {', '.join(bad)}: it must run inside the runner's transaction")
    if problems:
        raise Refuse(*problems)
    os.makedirs(a.out, exist_ok=True)
    wr(os.path.join(a.out, "000_runner_guard.sql"), guard_sql(facts, a.lock_timeout, "rollback", ROLLBACK_GATE))
    wr(os.path.join(a.out, "files.txt"), f"000_runner_guard.sql\n{rb[0]}\n")
    for n in notes:
        print(f"note: {n}")
    print(f"plan: roll back {v} with {rb[0]} (sha256:{sha256(os.path.join(a.rollbacks, rb[0]))}) in one transaction; "
          f"the rollback removes the {v} ledger row itself, only after its post-checks pass")
    return 0


def main(argv):
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="mode", required=True)
    for name in ("forward", "rollback"):
        s = sub.add_parser(name)
        s.add_argument("--migrations", required=True)
        s.add_argument("--ledger", required=True)
        s.add_argument("--facts", required=True)
        s.add_argument("--out", required=True)
    f = sub.choices["forward"]
    f.add_argument("--from", dest="from_", required=True)
    f.add_argument("--to", required=True)
    f.add_argument("--held", default="084")
    f.add_argument("--allow-skipped", action="store_true")
    f.add_argument("--lock-timeout", default="10s")
    f.add_argument("--recovery-v1-reviewed", action="store_true",
                   help="only when Recovery V1 is installed: the selected migrations were reviewed against V1 (never 086/087)")
    r = sub.choices["rollback"]
    r.add_argument("--rollbacks", required=True)
    r.add_argument("--version", required=True)
    r.add_argument("--owner-confirmed-till-queues-empty", action="store_true")
    r.add_argument("--lock-timeout", default="5s")
    a = p.parse_args(argv)
    if not re.fullmatch(r"[1-9]\d{0,4}(ms|s)", a.lock_timeout):
        print(f"REFUSE: --lock-timeout {a.lock_timeout!r} must be like 10s or 500ms (bounded, never 0)")
        return 2
    try:
        return plan_forward(a) if a.mode == "forward" else plan_rollback(a)
    except Refuse as e:
        for msg in e.args:
            print(f"REFUSE: {msg}")
        print("nothing planned; nothing applied")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
