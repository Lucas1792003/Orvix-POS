#!/usr/bin/env python3
"""Machine checks for the final POS migration sequence (supabase/migrations-provisional/SEQUENCE.json).

Workstation only. Never connects to a database: it reads repository files, and (plan) a JSON
document of database facts produced by the READ-ONLY query that `facts-sql` prints.

  verify.py check-repo [--held-originals FILE]    repository is consistent with the manifest
  verify.py facts-sql                             print the read-only facts query (run it yourself)
  verify.py plan --facts FACTS.json               state, order violations, next permissible steps + gates
  verify.py update-checksums                      rewrite manifest sha256 values (ONLY after owner review)

Exit codes: 0 ok, 1 problems found, 2 usage / unreadable input.
"""
import argparse
import hashlib
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
MANIFEST = os.path.join(ROOT, "supabase", "migrations-provisional", "SEQUENCE.json")
V1_FILE = os.path.join(ROOT, "supabase", "migrations-provisional", "RECOVERY_V1_guards.sql")
NAME_RE = re.compile(r"^(\d{3})_([a-z0-9_]+)\.sql$")


def rd(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_manifest(path=MANIFEST):
    m = json.loads(rd(path))
    if m.get("schema") != "orvix-final-migration-sequence-v1":
        raise SystemExit("unknown manifest schema")
    return m


def v1_pins():
    """(pinned 087 fingerprint, fingerprint SQL expression) from the V1 installer itself (one source)."""
    text = rd(V1_FILE)
    pin = re.search(r"m087_fingerprint\(\) IS DISTINCT FROM '([0-9a-f]{32})'", text)
    body = re.search(r"CREATE FUNCTION recovery_v1\.m087_fingerprint\([^)]*\)[^$]*\$\$(.*?)\$\$;", text, re.S)
    # the portable (pinned) form: p_full = false
    return (pin.group(1) if pin else None), (re.sub(r"\bp_full\b", "false", body.group(1).strip()) if body else None)


def check_repo(a):
    m = load_manifest()
    problems = []
    steps = {s["id"]: s for s in m["steps"]}
    if len(steps) != len(m["steps"]):
        problems.append("duplicate step ids in the manifest")
    for s in m["steps"]:
        path = os.path.join(ROOT, s["file"])
        if not os.path.isfile(path):
            problems.append(f"{s['id']}: file {s['file']} is missing")
            continue
        if s["sha256"] != sha256(path):
            problems.append(f"{s['id']}: sha256 mismatch for {s['file']} (manifest {s['sha256'][:16]}…, file {sha256(path)[:16]}…)")
        if s.get("rollback") and not os.path.isfile(os.path.join(ROOT, s["rollback"])):
            problems.append(f"{s['id']}: rollback file {s['rollback']} is missing")
        if s["kind"].startswith("numbered"):
            nm = NAME_RE.match(os.path.basename(s["file"]))
            if not nm or nm.group(1) != s["id"] or os.path.dirname(s["file"]) != "supabase/migrations":
                problems.append(f"{s['id']}: a numbered step must be supabase/migrations/{s['id']}_*.sql")
        else:
            if os.path.dirname(s["file"]).startswith("supabase/migrations") and os.path.dirname(s["file"]) == "supabase/migrations":
                problems.append(f"{s['id']}: a provisional / held step must never be in supabase/migrations (the runner would apply it)")
    # numbered files: contiguous, nothing beyond the manifest's last numbered step, exactly one 088
    mig = sorted(f for f in os.listdir(os.path.join(ROOT, "supabase", "migrations")) if f.endswith(".sql"))
    versions = [NAME_RE.match(f).group(1) for f in mig if NAME_RE.match(f)]
    if len(versions) != len(set(versions)):
        problems.append("duplicate numbered migration versions")
    top = max(s["id"] for s in m["steps"] if s["kind"].startswith("numbered"))
    beyond = [v for v in versions if v > top]
    if beyond:
        problems.append(f"numbered migrations beyond the manifest ({', '.join(beyond)}): the sequence must be reviewed first")
    t88 = [f for f in mig if f.startswith("088_")]
    if t88 != ["088_retired_number.sql"]:
        problems.append(f"088 must be exactly the retired tombstone, found {t88}")
    else:
        code = re.sub(r"--[^\n]*", "", rd(os.path.join(ROOT, "supabase", "migrations", t88[0]))).strip()
        if code != "SELECT 'migration 088 is a retired number: no-op' AS migration_088;":
            problems.append("088 tombstone must stay a no-op SELECT")
    numbering = os.path.join(ROOT, "supabase", "migrations", "NUMBERING.md")
    if not os.path.isfile(numbering) or "088" not in rd(numbering) or "retired" not in rd(numbering).lower():
        problems.append("supabase/migrations/NUMBERING.md must record 088 as retired")
    # order: recommended_order is a topological order of `requires`, and respects forbidden_orders / never_after
    order = m["recommended_order"]
    if sorted(order) != sorted(steps):
        problems.append("recommended_order must list every step exactly once")
    pos = {sid: i for i, sid in enumerate(order)}
    for sid, s in steps.items():
        for req in s.get("requires", []):
            if "|" in req:
                continue  # numbered baseline alternatives (085|086), outside the manifest
            if req not in pos:
                problems.append(f"{sid}: requires unknown step {req}")
            elif pos[req] > pos.get(sid, -1):
                problems.append(f"{sid}: recommended before its prerequisite {req}")
        for later in s.get("never_after", []):
            if later in pos and pos[later] < pos.get(sid, -1):
                problems.append(f"{sid} is recommended after {later}, but must never run after it")
    for f in m["forbidden_orders"]:
        if f["first"] in pos and f["then"] in pos and pos[f["first"]] < pos[f["then"]]:
            problems.append(f"recommended_order contains the forbidden order {f['first']} -> {f['then']}")
        if f["first"] not in steps or f["then"] not in steps:
            problems.append(f"forbidden order names an unknown step: {f}")
    # 087 pin: the manifest, the V1 installer and the installer's sha comment agree
    pin, body = v1_pins()
    if not pin or not body:
        problems.append("RECOVERY_V1 installer: pinned 087 fingerprint or fingerprint function not found")
    elif steps["087"].get("catalog_fingerprint") != pin:
        problems.append(f"087 catalog fingerprint: manifest {steps['087'].get('catalog_fingerprint')} != V1 installer pin {pin}")
    if steps["087"]["sha256"][:16] not in rd(V1_FILE):
        problems.append("RECOVERY_V1 installer does not name the reviewed 087 file checksum")
    # the runner knows about V1 (fact + guard re-check)
    runner = rd(os.path.join(ROOT, "deploy", "lucashome", "apply-migrations.sh"))
    planner = rd(os.path.join(ROOT, "deploy", "lucashome", "migration_plan.py"))
    if "has_recovery_v1" not in runner or "has_recovery_v1" not in planner:
        problems.append("apply-migrations.sh / migration_plan.py must snapshot and check has_recovery_v1")
    # held PFIN-C copy is byte-identical to the archived originals (optional input; outside the repo)
    if a.held_originals:
        for line in rd(a.held_originals).splitlines():
            if not line.strip():
                continue
            want, rel = line.split(None, 1)
            rel = rel.strip()
            p = os.path.join(ROOT, rel)
            if not os.path.isfile(p) or sha256(p) != want:
                problems.append(f"held copy differs from the archived original: {rel}")
    for p in problems:
        print(f"PROBLEM: {p}")
    print(f"check-repo: {len(m['steps'])} steps, {len(versions)} numbered files (top {versions[-1] if versions else '-'}), "
          f"087 pin {pin}: {'OK' if not problems else str(len(problems)) + ' problem(s)'}")
    return 1 if problems else 0


def dyn(query, default="null"):
    """A value from a query that may reference objects that do not exist (read-only, no temp objects)."""
    q = query.replace("'", "''")
    return (f"coalesce((xpath('//row/v/text()', query_to_xml('{q}', true, false, '')))[1]::text, '{default}')")


def facts_sql(_a=None):
    _, body = v1_pins()
    sql = f"""-- READ-ONLY facts for tools/migration-sequence/verify.py plan (catalog reads; no writes, no temp objects)
SET search_path = pg_catalog, pg_temp;
SELECT jsonb_build_object(
 'schema', 'orvix-migration-facts-v1',
 'ledger', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('supabase_migrations.schema_migrations') AND relkind = 'r') THEN NULL
               ELSE {dyn("SELECT string_agg(version, ',' ORDER BY version) AS v FROM supabase_migrations.schema_migrations")} END,
 'has_086', to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NOT NULL,
 'has_087', to_regnamespace('recovery') IS NOT NULL OR to_regnamespace('recovery_guard') IS NOT NULL,
 'PSAFE-A', EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'zz_orvix_no_086_after_087'),
 'PFIN-A', (SELECT count(*) = 5 FROM pg_class WHERE relkind = 'i' AND relnamespace = 'public'::regnamespace AND relname IN
            ('sales_shop_created_idx','sales_shift_idx','refund_void_requests_sale_idx','audit_logs_fin_approval_entity_idx','audit_logs_fin_approval_time_idx')),
 'PFIN-B', to_regproc('public.fin_report_summary') IS NOT NULL AND to_regproc('public.fin_shift_reconciliation') IS NOT NULL,
 'PCOST-A', to_regclass('public.product_costs') IS NOT NULL AND to_regclass('public.sale_item_costs') IS NOT NULL,
 'PFIN-C', to_regprocedure('public.fin_guard_refund_net_paid()') IS NOT NULL,
 'PFIN-D', to_regclass('public.sale_payments') IS NOT NULL AND to_regclass('public.cash_movements') IS NOT NULL,
 'PFIN-E', to_regclass('public.refund_lines') IS NOT NULL AND to_regclass('public.refund_payouts') IS NOT NULL,
 'PFIN-F', to_regclass('public.fin_approvals') IS NOT NULL AND to_regclass('public.refund_payout_confirmations') IS NOT NULL,
 'PDISC-A', to_regprocedure('public.fin_discount_authorize(public.sales,bigint,boolean)') IS NOT NULL,
 'PNET-A', EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtname = 'zz_orvix_net_lockdown' AND e.evtenabled <> 'D'
                   AND e.evtfoid = to_regprocedure('orvix_netguard.lockdown_event()'))
            AND coalesce((SELECT r.rolsuper FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'orvix_netguard'), false),
 'RECOVERY_V1', to_regnamespace('recovery_v1') IS NOT NULL,
 'adapter_087', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = to_regclass('recovery_v1.adapter_087') AND c.relkind = 'r' AND r.rolsuper) THEN NULL
                     ELSE {dyn("SELECT count(*) AS v FROM recovery_v1.adapter_087")} END,
 'v1_integrity', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = to_regprocedure('recovery_v1.integrity_problem()') AND r.rolsuper) THEN 'unreadable'
                      ELSE {dyn("SELECT coalesce(recovery_v1.integrity_problem(), 'none') AS v", "unreadable")} END,
 -- read 087 data only from the real 087 table (a view or other relation swapped in could run planted code)
 'm087_state', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('recovery.continuity') AND relkind = 'r'
                                     AND relowner = to_regrole('recovery_owner')) THEN NULL ELSE {dyn("SELECT state AS v FROM recovery.continuity")} END,
 'm087_fingerprint', CASE WHEN to_regnamespace('recovery') IS NULL THEN NULL ELSE {dyn(body + " AS v") if body else "NULL"} END
)::text AS facts;
"""
    print(sql)
    return 0


STEP_FACT = {"086": "has_086", "087": "has_087", "PSAFE-A": "PSAFE-A", "PFIN-A": "PFIN-A", "PFIN-B": "PFIN-B",
             "PCOST-A": "PCOST-A", "PFIN-C": "PFIN-C", "PFIN-D": "PFIN-D", "PFIN-E": "PFIN-E",
             "PFIN-F": "PFIN-F", "PDISC-A": "PDISC-A", "PNET-A": "PNET-A", "RECOVERY_V1": "RECOVERY_V1"}


def plan(a):
    m = load_manifest()
    try:
        facts = json.loads(rd(a.facts))
    except (OSError, ValueError) as e:
        print(f"unreadable facts: {e}")
        return 2
    if facts.get("schema") != "orvix-migration-facts-v1":
        print("facts: unknown schema (produce them with verify.py facts-sql)")
        return 2
    steps = {s["id"]: s for s in m["steps"]}
    raw_ledger = facts.get("ledger")
    ledger = set(("" if raw_ledger in (None, "null") else raw_ledger).split(",")) - {""}
    for k, val in list(facts.items()):
        if val == "null":
            facts[k] = None
    installed = {sid for sid, k in STEP_FACT.items() if facts.get(k) is True}
    if "088" in ledger:
        installed.add("088")
    violations, notes = [], []
    pin, _ = v1_pins()
    if facts.get("has_087"):
        if facts.get("m087_fingerprint") != pin:
            violations.append(f"installed 087 is not the reviewed 087 (fingerprint {facts.get('m087_fingerprint')} != {pin})")
    if facts.get("RECOVERY_V1"):
        integ = facts.get("v1_integrity")
        if integ not in ("none", None):
            violations.append(f"Recovery V1 integrity problem: {integ} (every organization is QUARANTINED)")
        if facts.get("has_087") and str(facts.get("adapter_087")) != "1":
            violations.append("087 is present but was not adopted by the V1 adapter: 087 was applied AFTER V1 (forbidden order)")
        if not facts.get("has_087") and str(facts.get("adapter_087")) == "1":
            violations.append("V1 adopted an 087 that is no longer present (removed or rolled back): quarantined")
    if facts.get("has_087") and not facts.get("has_086"):
        violations.append("087 present without 086 executors")
    if ledger and "086" in ledger and not facts.get("has_086"):
        violations.append("086 recorded but its executor is missing")
    nxt = []
    for sid in m["recommended_order"]:
        s = steps[sid]
        if sid in installed:
            continue
        why = []
        for req in s.get("requires", []):
            alts = req.split("|")
            # 085 is the production baseline this sequence starts from (the facts cannot prove a schema level by themselves)
            if not any(r in installed or r in ledger or (r == "085" and not ledger) for r in alts):
                why.append(f"needs {req}")
        for later in s.get("never_after", []):
            if later in installed:
                why.append(f"never after {later}")
        if sid == "PCOST-A" and facts.get("has_087") and facts.get("m087_state") != "open":
            why.append("first application needs 087 OPEN (a held 087 refuses the cost null-out)")
        if sid == "087" and facts.get("RECOVERY_V1"):
            why.append("never after RECOVERY_V1")
        if facts.get("RECOVERY_V1") and sid in steps["RECOVERY_V1"].get("after_if_present", []):
            why.append("only before RECOVERY_V1 (its tables / triggers would not be guarded or are untested after it)")
        if s["kind"] == "held" and not a.allow_held:
            why.append("HELD (owner decisions; pass --allow-held only after they are recorded)")
        nxt.append((sid, why, s.get("gates", []), s.get("optional", False)))
    print(f"state: installed = {', '.join(sorted(installed)) or '(none of the managed steps)'}; ledger = {facts.get('ledger') or '(none)'}")
    for v in violations:
        print(f"VIOLATION: {v}")
    print("next steps (recommended order):")
    for sid, why, gates, optional in nxt:
        tag = "REFUSED" if why else "allowed"
        print(f"  {sid:12} {tag}{' (optional)' if optional else ''}{': ' + '; '.join(why) if why else ''}")
        if not why:
            for g in gates:
                print(f"      gate: {g}")
    for n in notes:
        print(f"note: {n}")
    return 1 if violations else 0


def update_checksums(_a):
    m = load_manifest()
    for s in m["steps"]:
        new = sha256(os.path.join(ROOT, s["file"]))
        if s["kind"] == "numbered" and s["sha256"] != new:
            print(f"REFUSED: {s['id']} is committed history; its checksum is never rewritten (file changed?)")
            return 1
        s["sha256"] = new
    pin, _ = v1_pins()
    for s in m["steps"]:
        if s["id"] == "087":
            s["catalog_fingerprint"] = pin
    with open(MANIFEST, "w", encoding="utf-8") as f:
        f.write(json.dumps(m, indent=2, ensure_ascii=False) + "\n")
    print("manifest checksums rewritten from the working tree (owner review required)")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check-repo")
    c.add_argument("--held-originals")
    sub.add_parser("facts-sql")
    p = sub.add_parser("plan")
    p.add_argument("--facts", required=True)
    p.add_argument("--allow-held", action="store_true")
    sub.add_parser("update-checksums")
    a = ap.parse_args(argv)
    return {"check-repo": check_repo, "facts-sql": facts_sql, "plan": plan, "update-checksums": update_checksums}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
