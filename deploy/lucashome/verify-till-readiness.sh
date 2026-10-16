#!/usr/bin/env bash
# verify-till-readiness.sh — READ-ONLY proof that every active till uploads
# product images through the validated session flow, before migration 084
# removes the staff storage write policies.
# Method, GO criteria and owner steps: docs/selfhost-migration/phase-f/till-readiness-084.md
#
#   verify-till-readiness.sh [report] [--register FILE] [--days N] [--min-version X.Y.Z]
#                            [--min-log-hours N] [--old-quiet-hours N] [--recent-minutes N]
#                            [--access-log FILE]... [--no-docker-logs]
#   verify-till-readiness.sh reduce [--since T] [--until T]     # reduced access records (TSV) to stdout
#
# Evidence, all read-only:
#   DB   (READ ONLY transaction): 083/084 state; 084's own readiness predicate
#        (owner-stamped objects at direct-upload paths, last N days, per user);
#        owner-stamped objects at session paths (desktop-signed phone flow of
#        pre-JIT builds); upload sessions of the window with creator + status.
#   LOG  the Envoy access log (docker logs of the gateway; optional reduced
#        history files from `reduce`). Each line carries the user agent: the
#        desktop app's is "...<app>/<version> Chrome/... Electron/...", and once
#        the access-log format adds it, the x-client-info header
#        "shwephala-pos/<version> (validated-uploads)". The signed PUT of a
#        session's object names the session path, so a session is attributed to
#        the device that uploaded the bytes: Electron = desktop validated flow,
#        mobile browser = phone page. Direct storage writes and staff-signed
#        upload URLs from an app/browser user agent are old-client footprints.
#
# Output: counts, user refs (u-<sha256(users.id)[:10]>; ids can embed an e-mail, so
# they are never printed), roles, shop ids, dates,
# client versions. Object names, paths, query strings, referers and keys are
# never printed: paths are compared as md5 inside this process only.
#
# Exit: 0 GO (or 084 already applied), 1 NO-GO, 2 INSUFFICIENT EVIDENCE, 3 error.
#
# Environment (non-secret; defaults = server layout):
#   STACK_DIR         /srv/supabase/stack
#   DB_SERVICE        db
#   DB_ADMIN_USER     supabase_admin
#   TILL_DB_CONTAINER unset   (docker exec into this container instead of compose; tests)
#   TILL_GW_CONTAINER supabase-envoy
#
# Run on the server:  scp it (and the register) to lucashome:~/till-readiness/, then
#   ls$ ~/till-readiness/verify-till-readiness.sh --register ~/till-readiness/till-register.csv
# or without copying:  ssh lucashome 'bash -s -- report' < deploy/lucashome/verify-till-readiness.sh
set -euo pipefail
umask 077

STACK_DIR="${STACK_DIR:-/srv/supabase/stack}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_ADMIN_USER="${DB_ADMIN_USER:-supabase_admin}"
TILL_GW_CONTAINER="${TILL_GW_CONTAINER:-supabase-envoy}"

MODE=report
case "${1:-}" in report|reduce) MODE="$1"; shift;; esac
REGISTER=""; DAYS=14; MIN_VERSION=1.0.16; MIN_LOG_HOURS=72; OLD_QUIET_HOURS=72; RECENT_MINUTES=60
DOCKER_LOGS=1; SINCE=""; UNTIL=""; LOGS=()
while (($#)); do
  case "$1" in
    --register) REGISTER="$2"; shift 2;;
    --days) DAYS="$2"; shift 2;;
    --min-version) MIN_VERSION="$2"; shift 2;;
    --min-log-hours) MIN_LOG_HOURS="$2"; shift 2;;
    --old-quiet-hours) OLD_QUIET_HOURS="$2"; shift 2;;
    --recent-minutes) RECENT_MINUTES="$2"; shift 2;;
    --access-log) LOGS+=("$2"); shift 2;;
    --no-docker-logs) DOCKER_LOGS=0; shift;;
    --since) SINCE="$2"; shift 2;;
    --until) UNTIL="$2"; shift 2;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || true; exit 0;;
    *) echo "unknown option: $1" >&2; exit 3;;
  esac
done
for n in "$DAYS" "$MIN_LOG_HOURS" "$OLD_QUIET_HOURS" "$RECENT_MINUTES"; do
  [[ "$n" =~ ^[0-9]{1,5}$ ]] || { echo "numeric options must be integers" >&2; exit 3; }
done
[[ "$MIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--min-version must be X.Y.Z" >&2; exit 3; }
[[ -z "$REGISTER" || -f "$REGISTER" ]] || { echo "register not found: $REGISTER" >&2; exit 3; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 3; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/till-readiness.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------------------------------------------------------------- python part
cat >"$WORK/r.py" <<'PY'
import sys, re, os, csv, hashlib, datetime as dt
from urllib.parse import unquote
from collections import defaultdict

UTC = dt.timezone.utc
LINE = re.compile(r'^\S+ - - \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)"(?: "((?:[^"\\]|\\.)*)")?\s*$')
ELECTRON = re.compile(r'\b([A-Za-z0-9._-]+)/(\d+\.\d+\.\d+)\b[^"]*\bElectron/')
XCI = re.compile(r'^shwephala-pos/(\d+\.\d+\.\d+)(?:\s*\(([^)]*)\))?')
BUCKET = "product-images"

def ref(uid):
    """printable pseudonym of a users.id (ids can embed an e-mail; never print them)"""
    return "u-" + hashlib.sha256(uid.encode()).hexdigest()[:10] if uid and not uid.startswith("(") else (uid or "-")

def ver(s):
    return tuple(int(x) for x in s.split(".")) if s else None

def client(ua, xci):
    """kind, version, validated-capability ('yes'|'no'|'')"""
    kind, v, cap = "other", "", ""
    m = XCI.match(xci or "")
    if m:
        v = m.group(1); caps = [c.strip() for c in (m.group(2) or "").replace(",", ";").split(";")]
        cap = "yes" if "validated-uploads" in caps else "no"
    e = ELECTRON.search(ua)
    if e:
        kind = "desktop"; v = v or e.group(2)
    elif m:
        kind = "web"  # the app in a browser (web build) sends x-client-info too
    elif re.search(r"HeadlessChrome|Playwright", ua):
        kind = "automation"
    elif re.search(r"Mobile|iPhone|iPad|Android", ua):
        kind = "phone"
    elif re.search(r"^Deno/|SupabaseEdgeRuntime", ua):
        kind = "function"
    elif re.search(r"Mozilla/", ua):
        kind = "browser"
    else:
        kind = "tool"
    return kind, v, cap

def classify(method, path):
    """returns (class, md5 of the object path or '')"""
    p = path.split("?", 1)[0].split("#", 1)[0]
    pre_put = "/storage/v1/object/upload/sign/" + BUCKET + "/"
    if p.startswith(pre_put):
        key = hashlib.md5(unquote(p[len(pre_put):]).encode()).hexdigest()
        if method == "PUT": return "signed_put", key
        if method == "POST": return "sign_upload", key
    pre_obj = "/storage/v1/object/" + BUCKET + "/"
    if p.startswith(pre_obj) and method in ("POST", "PUT"):
        return "direct_write", hashlib.md5(unquote(p[len(pre_obj):]).encode()).hexdigest()
    if p == "/functions/v1/phone-upload-token" and method == "POST": return "token", ""
    if p == "/rest/v1/rpc/create_product_image_upload_session": return "create_session", ""
    return "", ""

def parse_ts(s):
    return dt.datetime.strptime(s, "%d/%b/%Y:%H:%M:%S %z").astimezone(UTC)

def reduce_lines(stream, since=None, until=None):
    """yield reduced records: ts, kind, version, cap, class, status, key"""
    for raw in stream:
        m = LINE.match(raw.rstrip("\n"))
        if not m: continue
        try: ts = parse_ts(m.group(1))
        except ValueError: continue
        if since and ts < since: continue
        if until and ts >= until: continue
        kind, v, cap = client(m.group(5), m.group(6))
        cls, key = classify(m.group(2), m.group(3))
        yield (ts, kind, v, cap, cls, m.group(4), key)

def iso(t): return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else "-"
def day(t): return t.strftime("%Y-%m-%d %H:%M") if t else "-"
def pts(s):
    s = (s or "").strip()
    if not s: return None
    s = s.replace(" ", "T").replace("Z", "+00:00")
    if re.search(r"[+-]\d{2}$", s): s += ":00"
    t = dt.datetime.fromisoformat(s)
    return (t if t.tzinfo else t.replace(tzinfo=UTC)).astimezone(UTC)

def cmd_reduce(args):
    since = pts(args[0]) if args and args[0] else None
    until = pts(args[1]) if len(args) > 1 and args[1] else None
    w = sys.stdout
    w.write("#till-readiness-reduced v1\n")
    for r in reduce_lines(sys.stdin, since, until):
        w.write("\t".join([iso(r[0])] + [x or "" for x in r[1:]]) + "\n")

def load_records(docker_log, history):
    recs = []
    if docker_log and os.path.exists(docker_log):
        with open(docker_log, errors="replace") as f:
            recs.extend(reduce_lines(f))
    for h in history:
        with open(h, errors="replace") as f:
            first = f.readline()
            if first.startswith("#till-readiness-reduced"):
                for l in f:
                    p = l.rstrip("\n").split("\t")
                    if len(p) == 7: recs.append((pts(p[0]),) + tuple(p[1:]))
            else:
                f.seek(0); recs.extend(reduce_lines(f))
    return recs

def read_tsv(path):
    out = defaultdict(list)
    with open(path) as f:
        for l in f:
            p = l.rstrip("\n").split("\t")
            if p and p[0]: out[p[0]].append(p[1:])
    return out

def cmd_report(a):
    db = read_tsv(a["db"]); now = pts(db["meta"][0][0]) if db.get("meta") else dt.datetime.now(UTC)
    meta = dict((k, v) for k, v in (x for x in db.get("kv", [])))
    minv = ver(a["min_version"]); days = int(a["days"])
    recs = load_records(a["docker_log"], a["history"])
    reasons_no, reasons_ins, notes = [], [], []
    print(f"== till readiness for migration 084 · {iso(now)} · DB window {days} d · min client {a['min_version']}")

    # ---- server state
    m083, m084, schema = meta.get("m083") == "t", meta.get("m084") == "t", meta.get("schema", "?")
    print(f"server: schema {schema}; 083 applied: {'yes' if m083 else 'NO'}; 084 applied: {'yes' if m084 else 'no'}; "
          f"staff write policies present: {meta.get('write_policies', '?')}")
    if m084:
        print("VERDICT: 084 ALREADY APPLIED — nothing to decide (staff direct writes are refused by the database)")
        return 0
    if not m083: reasons_no.append("083 is not applied (084 refuses without it)")

    # ---- DB footprints
    g_cnt, g_new = (db.get("guard") or [["0", ""]])[0]
    t_cnt, t_new = (db.get("owned_temp") or [["0", ""]])[0]
    print(f"db: 084 guard predicate (owner-stamped direct-path objects, {days} d): {g_cnt}" + (f", newest {g_new[:16]}" if int(g_cnt) else ""))
    print(f"db: owner-stamped objects at session paths ({days} d, desktop-signed phone flow of old builds): {t_cnt}" + (f", newest {t_new[:16]}" if int(t_cnt) else ""))
    if int(g_cnt): reasons_no.append(f"{g_cnt} direct staff upload(s) in {days} d — 084's own guard would abort")
    if int(t_cnt): reasons_no.append(f"{t_cnt} staff-signed session upload(s) in {days} d (old build; breaks after 084)")

    # ---- log coverage + client versions
    log_from = min((r[0] for r in recs), default=None); log_to = max((r[0] for r in recs), default=None)
    cov_h = (now - log_from).total_seconds() / 3600 if log_from else 0.0
    print(f"log: {len(recs)} access records, {day(log_from)} → {day(log_to)} UTC (coverage {cov_h:.1f} h; need {a['min_log_hours']} h)")
    if cov_h < float(a["min_log_hours"]):
        reasons_ins.append(f"access-log coverage {cov_h:.1f} h < {a['min_log_hours']} h (gateway logs reset when the container is recreated; add reduced history, §3.3)")
    vers = defaultdict(lambda: [0, None, set()])
    for ts, kind, v, cap, cls, st, key in recs:
        if kind in ("desktop", "web"):
            e = vers[(kind, v or "?")]; e[0] += 1; e[1] = max(e[1] or ts, ts); e[2].add(cap or "-")
    print("log: app clients seen (kind, version, x-client-info capability, requests, last seen):")
    if not vers: print("   (none)")
    old_last = None
    for (kind, v), (n, last, caps) in sorted(vers.items(), key=lambda x: (x[0][0], ver(x[0][1]) if x[0][1] != "?" else (0,))):
        old = v == "?" or ver(v) < minv or caps == {"no"}
        print(f"   {kind:8} {v:9} cap={','.join(sorted(caps)):8} {n:7}  {day(last)}{'   <- OLD' if old else ''}")
        if old: old_last = max(old_last or last, last)
    if old_last:
        quiet = (now - old_last).total_seconds() / 3600
        if quiet < float(a["old_quiet_hours"]):
            reasons_no.append(f"an app build older than {a['min_version']} (or without validated uploads) was active {quiet:.1f} h ago (< {a['old_quiet_hours']} h quiet)")
        else:
            notes.append(f"old builds last seen {quiet:.0f} h ago (quiet ≥ {a['old_quiet_hours']} h)")
    foot = defaultdict(int)
    for ts, kind, v, cap, cls, st, key in recs:
        if cls in ("direct_write", "sign_upload") and kind not in ("function", "tool") and st.startswith("2"):
            foot[(cls, kind, v or "?")] += 1
    for (cls, kind, v), n in sorted(foot.items()):
        print(f"log: OLD-CLIENT FOOTPRINT {cls} from {kind} {v}: {n}")
        reasons_no.append(f"{n} {cls.replace('_', ' ')} request(s) from {kind} {v} in the access log")
    if not foot: print("log: old-client footprints (direct storage writes / staff-signed upload URLs): 0")

    # ---- sessions attributed to the uploading device
    puts = defaultdict(list)
    for ts, kind, v, cap, cls, st, key in recs:
        if cls == "signed_put" and st.startswith("2"): puts[key].append((ts, kind, v, cap))
    users = {ref(u[0]): u for u in db.get("user", [])}          # id, role, shop, active, can_upload, last_sign_in
    direct = {ref(u[0]): (u[1], u[2]) for u in db.get("direct", [])}
    per = defaultdict(lambda: defaultdict(int)); desk_vers = defaultdict(set); desk_sessions = []
    for sid_md5, created_by, shop, status, created, completed in db.get("session", []):
        created_by = ref(created_by)
        c = per[created_by]; c["sessions"] += 1
        if status != "COMPLETED": c["not_completed"] += 1; continue
        hits = puts.get(sid_md5, [])
        if not hits: c["unattributed"] += 1; continue
        ts, kind, v, cap = hits[-1]
        if kind == "desktop":
            ok = bool(v) and ver(v) >= minv and cap != "no"
            c["desktop_ok" if ok else "desktop_old"] += 1; desk_vers[created_by].add(v or "?")
            desk_sessions.append((pts(created), created_by, shop, v or "?", cap or "-", ok))
        elif kind == "phone": c["phone"] += 1
        else: c["other"] += 1
    print(f"\nper user (DB window {days} d; desktop = bytes PUT by the desktop app, i.e. the validated desktop flow):")
    print(f"   {'user ref':13} {'role':8} {'shop':14} act upl {'last sign-in':16} sess desk_ok desk_old phone unattr direct  readiness")
    need_proof = []
    for uid in sorted(set(users) | set(per) | set(direct)):
        u = users.get(uid, ["", "?", "?", "?", "?", ""])
        c = per.get(uid, {}); d = int(direct.get(uid, ("0", ""))[0])
        last = pts(u[5]) if u[5] else None
        if d or c.get("desktop_old"): r = "OLD CLIENT"
        elif c.get("desktop_ok"): r = "READY"
        else: r = "unproven"
        if u[3] == "t" and u[4] == "t" and last and (now - last).days < days and r != "READY": need_proof.append(uid)
        print(f"   {uid:13} {u[1][:8]:8} {(u[2] or '-')[:14]:14} {u[3]:3} {u[4]:3} {day(last):16} {c.get('sessions',0):4} {c.get('desktop_ok',0):7} "
              f"{c.get('desktop_old',0):8} {c.get('phone',0):5} {c.get('unattributed',0):6} {d:6}  {r}"
              + (f" ({','.join(sorted(desk_vers[uid]))})" if desk_vers.get(uid) else ""))
        if d: reasons_no.append(f"user {uid}: {d} direct upload(s)")
        if c.get("desktop_old"): reasons_no.append(f"user {uid}: desktop upload from an old build")
    recent = [s for s in desk_sessions if s[0] and (now - s[0]).total_seconds() <= int(a["recent_minutes"]) * 60]
    print(f"\nrecent desktop-validated uploads (last {a['recent_minutes']} min) — for the owner's per-till test:")
    for t, uid, shop, v, cap, ok in sorted(recent):
        print(f"   {day(t)}  user {uid}  shop {shop or '-'}  version {v}  cap {cap}  {'OK' if ok else 'OLD BUILD'}")
    if not recent: print("   (none)")

    # ---- till register
    print("\ntill register:")
    tills = []
    if a["register"]:
        with open(a["register"]) as f:
            rows = [r for r in csv.DictReader(l for l in f if not l.startswith("#"))]
        for r in rows:
            tid = (r.get("till_id") or "").strip()
            if not tid: continue
            if (r.get("retired") or "").strip().lower() in ("yes", "y", "1", "true"): continue
            test = pts(r.get("test_utc")); uid = (r.get("user_ref") or "").strip()
            proof = None
            if test:
                for t, suid, shop, v, cap, ok in desk_sessions:
                    if suid == uid and t and abs((t - test).total_seconds()) <= 30 * 60:
                        proof = (t, v, ok); break
            st = "PROVEN" if proof and proof[2] else ("OLD BUILD" if proof else ("no test recorded" if not test else "no matching desktop-validated upload"))
            tills.append((tid, st))
            print(f"   {tid:18} {(r.get('label') or '')[:18]:18} shop {(r.get('shop_id') or '-')[:14]:14} user {uid:13} test {r.get('test_utc') or '-':20} {st}"
                  + (f" ({day(proof[0])}, {proof[1]})" if proof else ""))
            if uid and uid not in users: notes.append(f"register till {tid}: user_ref matches no user")
    if not tills:
        print("   (no register given or no active tills in it)")
        reasons_ins.append("no till register (every active till must be listed with its test upload)")
    for tid, st in tills:
        if st == "OLD BUILD": reasons_no.append(f"till {tid}: its test upload came from an old build")
        elif st != "PROVEN": reasons_ins.append(f"till {tid}: {st}")
    proven_users = set()
    if a["register"]:
        with open(a["register"]) as f:
            for r in csv.DictReader(l for l in f if not l.startswith("#")):
                if any(t == (r.get("till_id") or "").strip() and s == "PROVEN" for t, s in tills): proven_users.add((r.get("user_ref") or "").strip())
    for uid in need_proof:
        if uid not in proven_users:
            reasons_ins.append(f"user {uid} (uploads allowed, signed in within {days} d) has no desktop-validated upload and no proven till")

    # ---- verdict
    print()
    for n in notes: print(f"note: {n}")
    if reasons_no:
        print("VERDICT: NO-GO for 084"); [print(f"  - {r}") for r in reasons_no]
        if reasons_ins: print("  also missing:"); [print(f"  - {r}") for r in reasons_ins]
        return 1
    if reasons_ins:
        print("VERDICT: INSUFFICIENT EVIDENCE (no old-client footprint found, but readiness is not proven)")
        [print(f"  - {r}") for r in reasons_ins]
        return 2
    print("VERDICT: GO for 084 — every registered till proven, no old-client footprint in the DB window or the access log")
    return 0

if __name__ == "__main__":
    if sys.argv[1] == "reduce":
        cmd_reduce(sys.argv[2:])
    else:
        a = dict(zip(["db", "docker_log", "register", "days", "min_version", "min_log_hours", "old_quiet_hours", "recent_minutes"], sys.argv[2:10]))
        a["history"] = sys.argv[10:]
        sys.exit(cmd_report(a))
PY

docker_gw_logs() {  # the gateway's stdout = its access log; stderr = envoy's own log
  docker logs "$TILL_GW_CONTAINER" 2>/dev/null
}

if [[ "$MODE" == reduce ]]; then
  docker_gw_logs | python3 -I "$WORK/r.py" reduce "$SINCE" "$UNTIL"
  exit 0
fi

# ---------------------------------------------------------------- DB part (read only)
psql_ro() {
  if [[ -n "${TILL_DB_CONTAINER:-}" ]]; then
    docker exec -i "$TILL_DB_CONTAINER" psql -X -q -At -F $'\t' -U "$DB_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 -v days="$DAYS"
  else
    (cd "$STACK_DIR" && docker compose exec -T "$DB_SERVICE" psql -X -q -At -F $'\t' -U "$DB_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 -v days="$DAYS")
  fi
}
psql_ro >"$WORK/db.tsv" <<'SQL' || { echo "database query failed" >&2; exit 3; }
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT 'meta', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SELECT 'kv', 'schema', coalesce((SELECT max(version) FROM supabase_migrations.schema_migrations), '?');
SELECT 'kv', 'm083', (coalesce(obj_description(to_regprocedure('public.complete_product_image_upload_session(text,text,text,integer,text)'), 'pg_proc'), '') LIKE '083:%')::text::char;
SELECT 'kv', 'm084', (coalesce(obj_description(to_regprocedure('public.app_storage_can_write_path(text)'), 'pg_proc'), '') LIKE '084:%'
                       OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                                       AND policyname IN ('product_images_insert', 'product_images_update')))::text::char;
SELECT 'kv', 'write_policies', coalesce(string_agg(policyname, ',' ORDER BY policyname), 'none')
  FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname IN ('product_images_insert', 'product_images_update');
-- 084's readiness predicate, verbatim (count + newest only)
SELECT 'guard', count(*), coalesce(to_char(max(o.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'), '')
  FROM storage.objects o
 WHERE o.bucket_id = 'product-images'
   AND o.name ~ '^(org/[^/]+/)?products/[^/]+/[^/]+$'
   AND (o.owner IS NOT NULL OR o.owner_id IS NOT NULL)
   AND o.created_at > now() - make_interval(days => :days);
-- staff-signed session uploads (validated flow signs with the service role: no owner)
SELECT 'owned_temp', count(*), coalesce(to_char(max(o.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'), '')
  FROM storage.objects o
 WHERE o.bucket_id = 'product-images'
   AND o.name ~ '^org/[^/]+/temp/[^/]+$'
   AND (o.owner IS NOT NULL OR o.owner_id IS NOT NULL)
   AND o.created_at > now() - make_interval(days => :days);
-- the same predicate per uploader (owner -> users.auth_id); unknown owners as '(unknown)'
SELECT 'direct', coalesce(u.id, '(unknown)'), count(*), to_char(max(o.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')
  FROM storage.objects o
  LEFT JOIN public.users u ON u.auth_id::text = coalesce(o.owner::text, o.owner_id)
 WHERE o.bucket_id = 'product-images'
   AND o.name ~ '^(org/[^/]+/)?(products|temp)/[^/]+(/[^/]+)?$'
   AND (o.owner IS NOT NULL OR o.owner_id IS NOT NULL)
   AND o.created_at > now() - make_interval(days => :days)
 GROUP BY 2;
-- staff (no names / e-mails); can_upload approximates product:create|update
SELECT 'user', u.id, u.role, coalesce(u.shop_id, ''), u.is_active::text::char,
       (u.role IN ('ADMIN', 'MANAGER', 'OWNER')
        OR (coalesce(u.permissions, '{}') || coalesce(u.granted_permissions, '{}')) && ARRAY['product:create', 'product:update'])::text::char,
       coalesce(to_char(a.last_sign_in_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
  FROM public.users u LEFT JOIN auth.users a ON a.id = u.auth_id;
-- sessions of the window: md5(path) only
SELECT 'session', md5(s.storage_path), s.created_by, coalesce(s.shop_id, ''), s.status,
       to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       coalesce(to_char(s.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
  FROM public.product_image_upload_sessions s
 WHERE s.created_at > now() - make_interval(days => :days);
COMMIT;
SQL

GWLOG="$WORK/gw.log"; : >"$GWLOG"
if (( DOCKER_LOGS )); then
  docker_gw_logs >"$GWLOG" || echo "warning: cannot read the gateway log ($TILL_GW_CONTAINER)" >&2
fi
set +e
python3 -I "$WORK/r.py" report "$WORK/db.tsv" "$GWLOG" "$REGISTER" "$DAYS" "$MIN_VERSION" "$MIN_LOG_HOURS" "$OLD_QUIET_HOURS" "$RECENT_MINUTES" ${LOGS[@]+"${LOGS[@]}"}
rc=$?
set -e
exit "$rc"
