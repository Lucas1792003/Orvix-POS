"""Fill the 086 migration template from the live 085 catalog (disposable
stack). Emits static SQL only: the md5 guard map, the allow-listed
dispatch (one CASE branch per RPC, typed binding) and the explicit
search_path hardening list. Refuses to emit an RPC whose own v_idem_hash is
not md5(jsonb_build_object(<all params except p_created_at and the key>)).

usage: python3 -I gen086.py catalog.json harden.txt template.sql out.sql report.txt
"""
import json, re, sys

cat_path, harden_path, tpl_path, out_path, rep_path, idem_path, rollback_path = sys.argv[1:8]
import hashlib
idem = json.load(open(idem_path))
GUARD = """  -- 086: a UUIDv7 key (minted only by 086 clients) runs only through
  -- op_execute, which marks the one key it is executing (transaction-local;
  -- no PostgREST request can set it). create_app_user stays direct-only.
  IF (get_byte(uuid_send(p_key), 8) >> 6) = 2 AND (get_byte(uuid_send(p_key), 6) >> 4) = 7
     AND p_rpc <> 'create_app_user'
     AND current_setting('orvix.op_execute_key', true) IS DISTINCT FROM p_key::text THEN
    RAISE EXCEPTION 'OP_EXECUTOR_REQUIRED: this operation must be sent through op_execute' USING ERRCODE = '22023';
  END IF;

"""
ANCHOR = "  -- Concurrent duplicates serialise here until the first transaction ends.\n"
src085 = idem["prosrc"]
assert hashlib.md5(src085.encode()).hexdigest() == idem["md5"] and src085.count(ANCHOR) == 1
src086 = src085.replace(ANCHOR, GUARD + ANCHOR)
md5_086 = hashlib.md5(src086.encode()).hexdigest()
cat = json.load(open(cat_path))
EXCLUDE = {"create_app_user": "links auth accounts (082 marker) and reads auth.users; stays direct-only"}
SKIP_HASH = {"p_created_at", "p_idempotency_key"}
BIND = {
    "text": "public.op_arg_text", "integer": "public.op_arg_int", "numeric": "public.op_arg_numeric",
    "jsonb": "public.op_arg_jsonb", "boolean": "public.op_arg_bool",
    "timestamp with time zone": "public.op_arg_tstz", "text[]": "public.op_arg_text_array",
}

expected_md5 = {fn["sig"]: fn["md5"] for fn in cat}
assert len(expected_md5) == 32, len(expected_md5)

report, branches = [], []
for fn in cat:
    name, args = fn["name"], fn["args"]
    if name in ("idem_begin", "idem_finish"):
        continue
    if name in EXCLUDE:
        report.append(f"{name}: EXCLUDED - {EXCLUDE[name]}")
        continue
    pairs = re.findall(r"'(p_[a-z_]+)'\s*,\s*([a-z_]+)", fn["hash"] or "")
    hashed = [k for k, _ in pairs]
    expect = [a["n"] for a in args if a["n"] not in SKIP_HASH]
    ok = (sorted(hashed) == sorted(expect) and all(k == v for k, v in pairs)
          and (fn["hash"] or "").startswith("v_idem_hash := md5(jsonb_build_object(")
          and (fn["hash"] or "").endswith(")::text);")
          and fn["rpccall"] == f"idem_begin(p_idempotency_key, '{name}', v_idem_hash);"
          and all(a["t"] in BIND for a in args if a["n"] != "p_idempotency_key")
          and args[-1]["n"] == "p_idempotency_key" and args[-1]["t"] == "uuid")
    report.append(f"{name}: {'MATCH' if ok else 'MISMATCH'} ({len(hashed)} hashed / {len(args)} params) md5 {fn['md5']}")
    if not ok:
        sys.exit(f"refusing to generate: {name} does not hash its parameters as expected")
    plain = [a for a in args if a["n"] != "p_idempotency_key"]
    required = [a["n"] for i, a in enumerate(args) if i < len(args) - fn["ndef"]]
    branches.append(dict(
        sig=fn["sig"],
        name=name, names=[a["n"] for a in plain], types=[a["t"] for a in plain], required=required,
        binds=",\n          ".join(f"{a['n']} => {BIND[a['t']]}(p_args, '{a['n']}')" for a in plain),
        hashobj=", ".join(f"'{a['n']}', {BIND[a['t']]}(p_args, '{a['n']}')" for a in args if a["n"] not in SKIP_HASH),
    ))

def arr(xs):
    return ("ARRAY[" + ",".join(f"'{x}'" for x in xs) + "]::text[]") if xs else "ARRAY[]::text[]"

spec = "\n".join(f"    WHEN '{b['name']}' THEN\n      v_names := {arr(b['names'])};\n      v_types := {arr(b['types'])};\n      v_required := {arr(b['required'])};" for b in branches)
sigs = "\n".join(f"    WHEN '{b['name']}' THEN RETURN '{b['sig']}';" for b in branches)
hashes = "\n".join(f"    WHEN '{b['name']}' THEN v_hash := md5(jsonb_build_object({b['hashobj']})::text);" for b in branches)
calls = "\n".join(f"    WHEN '{b['name']}' THEN\n      v_resp := public.{b['name']}(\n          {b['binds']},\n          p_idempotency_key => p_key);" for b in branches)

dispatch = (
    f"-- Allow-list: {len(branches)} RPCs.\n"
    "CREATE OR REPLACE FUNCTION public.op_spec(p_rpc text, OUT v_names text[], OUT v_types text[], OUT v_required text[])\n"
    " LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$\nBEGIN\n  CASE p_rpc\n" + spec +
    "\n    ELSE v_names := NULL; v_types := NULL; v_required := NULL;\n  END CASE;\nEND;\n$f$;\n\n"
    "-- The RPC's own signature (for the EXECUTE-privilege parity check).\n"
    "CREATE OR REPLACE FUNCTION public.op_rpc_signature(p_rpc text)\n"
    " RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$\nBEGIN\n  CASE p_rpc\n" + sigs +
    "\n    ELSE RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023';\n  END CASE;\nEND;\n$f$;\n\n"
    "-- The RPC's own request hash, computed from the typed arguments.\n"
    "CREATE OR REPLACE FUNCTION public.op_request_hash(p_rpc text, p_args jsonb)\n"
    " RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$\nDECLARE v_hash text;\nBEGIN\n  CASE p_rpc\n" + hashes +
    "\n    ELSE RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023';\n  END CASE;\n  RETURN v_hash;\nEND;\n$f$;\n\n"
    "-- Invoker: runs as op_execute's owner, inside op_execute's savepoint.\n"
    "CREATE OR REPLACE FUNCTION public.op_dispatch(p_key uuid, p_rpc text, p_args jsonb)\n"
    " RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $f$\nDECLARE v_resp jsonb;\nBEGIN\n  CASE p_rpc\n" + calls +
    "\n    ELSE RAISE EXCEPTION 'OP_UNKNOWN_RPC' USING ERRCODE = '22023';\n  END CASE;\n  RETURN v_resp;\nEND;\n$f$;"
)

harden = [l.split("|")[0] for l in open(harden_path).read().split("\n") if l.strip()]
harden = [h for h in harden if h != "public.prune_idempotency_keys()"]   # redefined by 086 itself
harden_alters = "\n".join(f"ALTER FUNCTION {h} SET search_path = public, pg_temp;" for h in harden)
harden_array = ",\n    ".join(f"'{h}'" for h in harden)

tpl = open(tpl_path).read()
md5_json = json.dumps(expected_md5, sort_keys=True, separators=(",", ":"))
out = (tpl.replace("{{EXPECTED_MD5}}", md5_json).replace("{{DISPATCH}}", dispatch)
          .replace("{{IDEM_BEGIN_086_BODY}}", src086).replace("{{IDEM_BEGIN_086_MD5}}", md5_086)
          .replace("{{HARDEN_ALTERS}}", harden_alters).replace("{{HARDEN_ARRAY}}", "\n    " + harden_array))
assert "{{" not in out
assert md5_json.count(idem["md5"]) == 1
open(out_path, "w").write(out)
open(rollback_path, "w").write(
    "-- Migration 086 ROLLBACK (the documented rollback; docs/selfhost-migration/phase-g/migration-086.md \"Rollback\").\n"
    "-- GENERATED together with 086 (gen086.py). Owner-approved rollbacks only; never applied by\n"
    "-- deploy/lucashome/apply-migrations.sh (this directory is not supabase/migrations).\n"
    "--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -f 086_operation_outcomes.rollback.sql\n"
    "-- Drops the executor, the status lookup and every op_* helper, and restores the 085 idem_begin body\n"
    "-- (search_path stays hardened). KEEPS the idempotency_keys columns, constraint and index, every\n"
    "-- rejected/abandoned tombstone (their R:/A: hashes keep them refused on the legacy path), the 086\n"
    "-- prune_idempotency_keys (inert without the executor) and the search_path hardening.\n"
    "-- Never restore 062's prune body. Re-apply 086 to recover forward.\n"
    "BEGIN;\nDO $$\nDECLARE f regprocedure;\nBEGIN\n"
    "  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p\n"
    "            WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'op\\_%' LOOP\n"
    "    EXECUTE format('DROP FUNCTION %s', f);\n  END LOOP;\nEND $$;\n"
    "CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid, p_rpc text, p_request_hash text)\n"
    " RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path = public, pg_temp\n"
    f"AS $function${src085}$function$;\n"
    "DO $$\nBEGIN\n"
    f"  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure) <> '{idem['md5']}' THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: idem_begin is not the 085 body';\n  END IF;\n"
    "  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'op\\_%') THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: op_* functions remain';\n  END IF;\n"
    "  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proconfig = '{search_path=public}') THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: search_path hardening lost';\n  END IF;\n"
    "  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.prune_idempotency_keys()'::regprocedure) NOT LIKE '%nothing pruned%' THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: prune_idempotency_keys is not the inert 086 body (never restore 062''s)';\n  END IF;\n"
    "END $$;\n"
    "NOTIFY pgrst, 'reload schema';\nCOMMIT;\n")
report.append(f"allow-listed: {len(branches)}; hardened: {len(harden)}; md5-guarded: {len(expected_md5)}; idem_begin 085 {idem['md5']} -> 086 {md5_086}")
open(rep_path, "w").write("\n".join(report) + "\n")
print(report[-1])
