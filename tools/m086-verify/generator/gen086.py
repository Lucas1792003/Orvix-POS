"""Fill the 086 migration template from the live 085 catalog (disposable
stack). Emits static SQL only: the md5 guard map, the allow-listed
dispatch (one CASE branch per RPC, typed binding) and the explicit
search_path hardening list. Refuses to emit an RPC whose own v_idem_hash is
not md5(jsonb_build_object(<all params except p_created_at and the key>)).

usage: python3 -I gen086.py catalog.json harden.txt template.sql out.sql report.txt \
         idem_begin_085.json out.rollback.sql idem_finish_085.json pay_supplier_lump_sum_085.json

Financial-safety corrections (before deployment): the ledger identity is per
organisation (org_id, key) — idem_begin / idem_finish are re-created from
their 085 bodies with ASSERTED, exact edits — and pay_supplier_lump_sum is
re-created from its 085 body with the lock-first / no-shortfall edits.
"""
import json, re, sys

cat_path, harden_path, tpl_path, out_path, rep_path, idem_path, rollback_path, finish_path, lump_path = sys.argv[1:10]
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
src085 = idem["prosrc"]
assert hashlib.md5(src085.encode()).hexdigest() == idem["md5"]

def edit(src: str, old: str, new: str) -> str:
    assert src.count(old) == 1, f"anchor not found exactly once: {old[:70]!r}"
    return src.replace(old, new)

# idem_begin: per-organisation ledger identity (lock and lookup by (org, key))
OLD_LOCK_AND_CALLER = """  -- Concurrent duplicates serialise here until the first transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('idem:' || p_key::text));

  -- 074: the caller, resolved exactly as 062 resolved actor_id.
  SELECT u.id, u.org_id INTO v_caller_id, v_caller_org
    FROM public.users u WHERE u.auth_id = auth.uid() LIMIT 1;

  SELECT * INTO v FROM public.idempotency_keys WHERE key = p_key;
"""
NEW_LOCK_AND_CALLER = """  -- 074: the caller, resolved exactly as 062 resolved actor_id.
  SELECT u.id, u.org_id INTO v_caller_id, v_caller_org
    FROM public.users u WHERE u.auth_id = auth.uid() LIMIT 1;
  -- 086: the ledger is per organisation (org_id, key); a caller with no
  -- organisation (bootstrap) uses the reserved unattributed namespace.
  v_caller_org := coalesce(v_caller_org, '!unattributed');

  -- Concurrent duplicates serialise here until the first transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('idem:' || v_caller_org || ':' || p_key::text));

  -- 086: a key whose organisation was never recorded (pre-074) stays
  -- refused in every organisation, as 074 refused it.
  IF v_caller_org <> '!unattributed'
     AND EXISTS (SELECT 1 FROM public.idempotency_keys WHERE org_id = '!unattributed' AND key = p_key) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v FROM public.idempotency_keys WHERE org_id = v_caller_org AND key = p_key;
"""
GUARD_ANCHOR = "  -- 074: the caller, resolved exactly as 062 resolved actor_id.\n"
src_org = edit(src085, OLD_LOCK_AND_CALLER, NEW_LOCK_AND_CALLER)          # 086 minus the v7 guard = the rollback body
assert src_org.count(GUARD_ANCHOR) == 1
src086 = src_org.replace(GUARD_ANCHOR, GUARD + GUARD_ANCHOR)
md5_086 = hashlib.md5(src086.encode()).hexdigest()
md5_rollback = hashlib.md5(src_org.encode()).hexdigest()

def header_of(defn: str) -> str:
    i = defn.index("AS $function$")
    return defn[:i].replace("SET search_path TO 'public'", "SET search_path = public, pg_temp")

# idem_finish: the caller's organisation's row only
finish = json.load(open(finish_path))
assert hashlib.md5(finish["prosrc"].encode()).hexdigest() == finish["md5"]
finish_src086 = edit(finish["prosrc"], """BEGIN
  UPDATE public.idempotency_keys SET response = p_response WHERE key = p_key;
END;
""", """DECLARE
  v_org text;
  v_n integer;
BEGIN
  -- 086: the ledger is per organisation (org_id, key): store the reply on
  -- the CALLER'S organisation's row only (resolved as idem_begin resolves it).
  SELECT u.org_id INTO v_org FROM public.users u WHERE u.auth_id = auth.uid() LIMIT 1;
  UPDATE public.idempotency_keys SET response = p_response
   WHERE org_id = coalesce(v_org, '!unattributed') AND key = p_key;
  -- fail closed: the reply must land on the row idem_begin wrote (same
  -- caller, same organisation); never lose it silently
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_FINISH_ROW_MISSING: key %', p_key USING ERRCODE = 'XX000';
  END IF;
END;
""")
finish_def086 = header_of(finish["def"]) + "AS $function$" + finish_src086 + "$function$;"
md5_finish086 = hashlib.md5(finish_src086.encode()).hexdigest()

# pay_supplier_lump_sum: lock first, then the balance; never a silent shortfall
lump = json.load(open(lump_path))
assert hashlib.md5(lump["prosrc"].encode()).hexdigest() == lump["md5"]
lump_src086 = edit(lump["prosrc"], """  -- Total outstanding for this supplier in this shop (received, unpaid balance).
  SELECT COALESCE(sum(""", """  -- 086: lock this supplier's received purchase orders in this shop FIRST
  -- (in the allocation order below: oldest first), then compute the balance.
  -- A concurrent payment waits here and then sees the paid totals. (A PO
  -- received after this lock is counted but not locked; if it is paid
  -- concurrently, the guard after the loop refuses — never a shortfall.)
  PERFORM 1 FROM purchase_orders
   WHERE supplier_id = p_supplier_id AND shop_id = p_shop_id AND status = 'RECEIVED'
   ORDER BY created_at ASC, id ASC
   FOR UPDATE;

  -- Total outstanding for this supplier in this shop (received, unpaid balance).
  SELECT COALESCE(sum(""")
lump_src086 = edit(lump_src086, """  END LOOP;

  v_idem_result := jsonb_build_object(""", """  END LOOP;

  -- 086: never record less than was entered (defence in depth: the balance
  -- was checked under the lock above). The whole payment rolls back.
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Payment amount exceeds total outstanding balance';
  END IF;

  v_idem_result := jsonb_build_object(""")
lump_def086 = header_of(lump["def"]) + "AS $function$" + lump_src086 + "$function$;"
md5_lump086 = hashlib.md5(lump_src086.encode()).hexdigest()

SIG_BEGIN = "public.idem_begin(uuid,text,text)"
SIG_FINISH = "public.idem_finish(uuid,jsonb)"
SIG_LUMP = "public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)"
also_ok = {SIG_BEGIN: [md5_086, md5_rollback], SIG_FINISH: [md5_finish086], SIG_LUMP: [md5_lump086]}
new_086 = {SIG_BEGIN: md5_086, SIG_FINISH: md5_finish086, SIG_LUMP: md5_lump086}
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
assert expected_md5[SIG_FINISH] == finish["md5"] and expected_md5[SIG_LUMP] == lump["md5"]
out = (tpl.replace("{{EXPECTED_MD5}}", md5_json).replace("{{DISPATCH}}", dispatch)
          .replace("{{IDEM_BEGIN_086_BODY}}", src086)
          .replace("{{IDEM_FINISH_086_DEF}}", finish_def086).replace("{{LUMP_SUM_086_DEF}}", lump_def086)
          .replace("{{ALSO_OK_MD5}}", json.dumps(also_ok, sort_keys=True, separators=(",", ":")))
          .replace("{{NEW_086_MD5}}", json.dumps(new_086, sort_keys=True, separators=(",", ":")))
          .replace("{{HARDEN_ALTERS}}", harden_alters).replace("{{HARDEN_ARRAY}}", "\n    " + harden_array))
assert "{{" not in out
assert md5_json.count(idem["md5"]) == 1
open(out_path, "w").write(out)
assert "$rollback$" not in src_org and "$ddl$" not in src_org
open(rollback_path, "w").write(
    "-- Migration 086 ROLLBACK (the documented rollback; docs/selfhost-migration/phase-g/migration-086.md \"Rollback\").\n"
    "-- GENERATED together with 086 (gen086.py). Owner-approved rollbacks only, and ONLY through the runner:\n"
    "--   deploy/lucashome/apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty [--dry-run]\n"
    "-- ONE statement (a single DO block), so it is atomic in any client mode — with or without\n"
    "-- ON_ERROR_STOP, inside or outside a transaction. It runs only inside the runner's transaction: the\n"
    "-- runner guard (one runner at a time, ledger locked and re-checked, bounded lock and statement\n"
    "-- timeouts) sets, for THAT transaction only, the owner's till-queue confirmation\n"
    "-- (orvix.rollback_gate; the server cannot prove that every till's queue is empty) and the\n"
    "-- transaction's id (orvix.runner_txid). Run any other way — plain psql, a gate set by hand for a\n"
    "-- session — the preflight refuses and nothing changes.\n"
    "-- Drops the executor, the status lookup and every op_* helper, and restores idem_begin WITHOUT the\n"
    "-- UUIDv7 guard (the 085 behaviour on the per-organisation ledger: (org_id, key) lookups and locks;\n"
    "-- the 085 key-only body is NOT restored — it would read another organisation's row once a key is used\n"
    "-- in two organisations). KEEPS the per-organisation identity, idem_finish (per organisation), the\n"
    "-- corrected pay_supplier_lump_sum, the idempotency_keys columns, constraint and index, every\n"
    "-- rejected/abandoned tombstone (their R:/A: hashes keep them refused on the legacy path), the 086\n"
    "-- prune_idempotency_keys (inert without the executor) and the search_path hardening. The operation\n"
    "-- ledger is write-locked (bounded by lock_timeout) and must be unchanged afterwards (row count and\n"
    "-- per-row hashes). The 086 ledger row is removed LAST, after every post-check; any failure rolls\n"
    "-- back everything. Never restore 062's prune body. Re-apply 086 (apply-migrations.sh --from 086\n"
    "-- --to 086) to recover forward.\n"
    "DO $rollback$\n"
    "DECLARE\n  f regprocedure;\n  v_n integer;\n  v_before text;\n  v_after text;\n"
    "BEGIN\n"
    "  -- preflight\n"
    "  IF current_setting('orvix.rollback_gate', true) IS DISTINCT FROM 'till-queues-empty-confirmed-by-owner' THEN\n"
    "    RAISE EXCEPTION 'rollback preflight: no owner confirmation that every till queue is empty (run only via apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty); nothing changed';\n  END IF;\n"
    "  IF current_setting('orvix.runner_txid', true) IS DISTINCT FROM txid_current()::text THEN\n"
    "    RAISE EXCEPTION 'rollback preflight: not inside the runner''s transaction (run only via apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty); nothing changed';\n  END IF;\n"
    "  IF current_setting('lock_timeout') IN ('0', '0ms', '0s') THEN\n"
    "    RAISE EXCEPTION 'rollback preflight: lock_timeout is unbounded; nothing changed';\n  END IF;\n"
    "  IF to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NULL THEN\n"
    "    RAISE EXCEPTION 'rollback preflight: 086 is not applied here (no op_execute); nothing changed';\n  END IF;\n"
    "  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '086') THEN\n"
    "    RAISE EXCEPTION 'rollback preflight: 086 is not recorded in supabase_migrations; nothing changed';\n  END IF;\n"
    "  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version > '086') THEN\n"
    "    RAISE EXCEPTION 'rollback preflight: a newer migration is recorded; roll it back first; nothing changed';\n  END IF;\n"
    f"  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure) <> '{md5_086}' THEN\n"
    "    RAISE EXCEPTION 'rollback preflight: idem_begin is not the 086 body (unknown state; owner review); nothing changed';\n  END IF;\n"
    "  -- operation history: write-locked, and proven unchanged below (per-row hashes: no size limit)\n"
    "  LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;\n"
    "  SELECT count(*) || ':' || coalesce(sum(hashtextextended(k::text, 0)::numeric), 0) || ':' || coalesce(sum(hashtextextended(k::text, 1)::numeric), 0)\n"
    "    INTO v_before FROM public.idempotency_keys k;\n"
    "  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p\n"
    "            WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'op\\_%' LOOP\n"
    "    EXECUTE format('DROP FUNCTION %s', f);\n  END LOOP;\n"
    "  EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid, p_rpc text, p_request_hash text)\n"
    " RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path = public, pg_temp\n"
    f"AS $function${src_org}$function$$ddl$;\n"
    "  -- post-checks\n"
    f"  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure) <> '{md5_rollback}' THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: idem_begin is not the per-organisation body without the UUIDv7 guard';\n  END IF;\n"
    f"  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_finish(uuid,jsonb)'::regprocedure) <> '{md5_finish086}'\n"
    f"     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)'::regprocedure) <> '{md5_lump086}' THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: idem_finish / pay_supplier_lump_sum must stay the corrected 086 bodies';\n  END IF;\n"
    "  IF (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)\n"
    "        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum\n"
    "       WHERE c.conrelid = 'public.idempotency_keys'::regclass AND c.contype = 'p') IS DISTINCT FROM 'org_id,key' THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: the per-organisation ledger identity must be kept';\n  END IF;\n"
    "  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'op\\_%') THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: op_* functions remain';\n  END IF;\n"
    "  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proconfig = '{search_path=public}') THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: search_path hardening lost';\n  END IF;\n"
    "  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.prune_idempotency_keys()'::regprocedure) NOT LIKE '%nothing pruned%' THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: prune_idempotency_keys is not the inert 086 body (never restore 062''s)';\n  END IF;\n"
    "  SELECT count(*) || ':' || coalesce(sum(hashtextextended(k::text, 0)::numeric), 0) || ':' || coalesce(sum(hashtextextended(k::text, 1)::numeric), 0)\n"
    "    INTO v_after FROM public.idempotency_keys k;\n"
    "  IF v_after IS DISTINCT FROM v_before THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: the operation ledger (idempotency_keys) changed; nothing rolled back';\n  END IF;\n"
    "  -- last: the ledger row, so a re-apply of 086 is the forward recovery\n"
    "  DELETE FROM supabase_migrations.schema_migrations WHERE version = '086';\n"
    "  GET DIAGNOSTICS v_n = ROW_COUNT;\n"
    "  IF v_n <> 1 THEN\n"
    "    RAISE EXCEPTION 'rollback post-check: expected to remove exactly one 086 ledger row, removed %', v_n;\n  END IF;\n"
    "  PERFORM pg_notify('pgrst', 'reload schema');\n"
    "END $rollback$;\n")
report.append(f"allow-listed: {len(branches)}; hardened: {len(harden)}; md5-guarded: {len(expected_md5)}; "
              f"idem_begin 085 {idem['md5']} -> 086 {md5_086} (rollback {md5_rollback}); "
              f"idem_finish {finish['md5']} -> {md5_finish086}; pay_supplier_lump_sum {lump['md5']} -> {md5_lump086}")
open(rep_path, "w").write("\n".join(report) + "\n")
print(report[-1])
