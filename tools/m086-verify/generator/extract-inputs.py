"""Extract the inputs gen086.py needs from a DISPOSABLE database at migration
085 (084 not applied): the 32 idempotent functions it guards and dispatches
(catalog.json), the functions pinned to search_path=public that 086 hardens
(harden.txt) and the 085 body of idem_begin (idem_begin_085.json).

usage: python3 -I extract-inputs.py <db-container> <out-dir>
Read-only: SELECTs only, inside the given local container.
"""
import json, os, re, subprocess, sys

container, out = sys.argv[1], sys.argv[2]
if not re.fullmatch(r"[A-Za-z0-9_.-]+", container):
    sys.exit("unsafe container name")
os.makedirs(out, exist_ok=True)

def q(sql: str) -> str:
    return subprocess.run(
        ["docker", "exec", "-i", container, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1",
         "-c", "SET default_transaction_read_only = on; " + sql],
        check=True, capture_output=True, text=True).stdout.strip().split("\n")[-1]

SIG = "'public.' || p.proname || '(' || replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ',') || ')'"

# catalog: every function that calls idem_begin with its own key, plus idem_begin / idem_finish
rows = json.loads(q(f"""
SELECT json_agg(json_build_object(
  'name', p.proname, 'sig', {SIG}, 'md5', md5(p.prosrc), 'src', p.prosrc, 'ndef', p.pronargdefaults,
  'argnames', p.proargnames, 'argtypes', (SELECT json_agg(format_type(t, NULL) ORDER BY o) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(t, o))
) ORDER BY p.proname)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND (p.prosrc LIKE '%idem_begin(p_idempotency_key%' OR p.proname IN ('idem_begin', 'idem_finish'))"""))
catalog = []
for r in rows:
    src = r["src"]
    h = re.search(r"v_idem_hash\s*:=\s*md5\(jsonb_build_object\(.*?\)::text\);", src, re.S)
    c = re.search(r"idem_begin\(p_idempotency_key,\s*'[a-z_]+',\s*v_idem_hash\);", src)
    names = r["argnames"] or []
    catalog.append({
        "name": r["name"], "sig": r["sig"], "md5": r["md5"],
        "args": [{"n": n, "t": t} for n, t in zip(names, r["argtypes"] or [])],
        "ndef": r["ndef"],
        "hash": re.sub(r"\s+", " ", h.group(0)) if h else None,
        "rpccall": re.sub(r"\s+", " ", c.group(0)) if c else None,
    })
json.dump(catalog, open(os.path.join(out, "catalog.json"), "w"))

# harden: functions pinned to search_path=public (| SECURITY DEFINER)
hard = json.loads(q(f"""
SELECT json_agg({SIG} || '|' || p.prosecdef::text ORDER BY {SIG})
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proconfig = ARRAY['search_path=public']"""))
open(os.path.join(out, "harden.txt"), "w").write("\n".join(hard) + "\n")

idem = json.loads(q("""
SELECT json_build_object('prosrc', p.prosrc, 'md5', md5(p.prosrc), 'cfg', p.proconfig, 'owner', pg_get_userbyid(p.proowner))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'idem_begin'"""))
json.dump(idem, open(os.path.join(out, "idem_begin_085.json"), "w"))

# The 085 bodies 086 replaces (financial-safety corrections): the full
# definition (header + body) so the generator can re-create them verbatim.
for fn, sig in (("idem_finish", "public.idem_finish(uuid,jsonb)"),
                ("pay_supplier_lump_sum", "public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)")):
    d = json.loads(q(f"""
SELECT json_build_object('prosrc', p.prosrc, 'md5', md5(p.prosrc), 'def', pg_get_functiondef(p.oid), 'owner', pg_get_userbyid(p.proowner))
FROM pg_proc p WHERE p.oid = to_regprocedure('{sig}')"""))
    json.dump(d, open(os.path.join(out, f"{fn}_085.json"), "w"))
print(f"extracted: {len(catalog)} catalog functions, {len(hard)} hardening entries, idem_begin md5 {idem['md5']}, idem_finish + pay_supplier_lump_sum 085 definitions")
