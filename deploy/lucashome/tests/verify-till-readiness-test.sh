#!/usr/bin/env bash
# Local test of deploy/lucashome/verify-till-readiness.sh against a DISPOSABLE
# Postgres (container phf-till-test-db, no published port) with synthetic data
# and synthetic Envoy access-log lines in the production log format.
#
#   deploy/lucashome/tests/verify-till-readiness-test.sh
# Needs docker (image postgres:17) and python3. Removes its container on exit.
#
# Cases:
#   old    old desktop build uploads directly (owner-stamped products/ object +
#          Electron 1.0.15 direct write in the log)                    -> NO-GO (1)
#   signed pre-JIT build signs a session upload as staff (owned temp object)
#                                                                       -> NO-GO (1)
#   oldver only validated uploads, but a 1.0.15 till is still active    -> NO-GO (1)
#   noreg  all validated, no till register                              -> INSUFFICIENT (2)
#   short  all validated + register, but only 10 h of access log        -> INSUFFICIENT (2)
#   go     all validated (1.0.16, x-client-info), register proven, 4 d log -> GO (0)
#   m084   084 applied                                                  -> exit 0, "ALREADY APPLIED"
# Every output is checked for object paths, e-mails and names (must not appear).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../verify-till-readiness.sh"
DB=phf-till-test-db
T="$(mktemp -d)"
down() { docker rm -f "$DB" >/dev/null 2>&1 || true; }
trap 'down; [ -n "${KEEP_OUT:-}" ] && cp "$T"/*.out "$KEEP_OUT"/ 2>/dev/null; rm -rf "$T"' EXIT
down
PASS=0; FAIL=0
ok() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'PASS  %-70s %s\n' "$1" "$2"; else FAIL=$((FAIL+1)); printf 'FAIL  %-70s got [%s] want [%s]\n' "$1" "$2" "$3"; fi; }

docker run -d --name "$DB" -e POSTGRES_PASSWORD=x postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 1
psql() { docker exec -i "$DB" psql -X -q -At -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

psql <<'SQL'
CREATE SCHEMA storage; CREATE SCHEMA auth; CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
INSERT INTO supabase_migrations.schema_migrations VALUES ('083'), ('085');
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text,
  owner uuid, owner_id text, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_images_read   ON storage.objects FOR SELECT USING (bucket_id = 'product-images');
CREATE POLICY product_images_delete ON storage.objects FOR DELETE USING (bucket_id = 'product-images');
CREATE POLICY product_images_insert ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'product-images');
CREATE POLICY product_images_update ON storage.objects FOR UPDATE USING (bucket_id = 'product-images');
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, last_sign_in_at timestamptz);
CREATE TABLE public.users (id text PRIMARY KEY, name text, email text, role text, shop_id text, permissions text[],
  is_active boolean, auth_id uuid, granted_permissions text[], revoked_permissions text[], org_id text);
CREATE TABLE public.product_image_upload_sessions (id text PRIMARY KEY, created_by text, shop_id text, product_id text,
  storage_path text, status text, created_at timestamptz, completed_at timestamptz);
CREATE FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) RETURNS void LANGUAGE sql AS 'SELECT';
COMMENT ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) IS '083: service_role only';
CREATE FUNCTION public.app_storage_can_write_path(text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
INSERT INTO auth.users VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner.secret@example.com', now() - interval '1 day'),
  ('22222222-2222-2222-2222-222222222222', 'manager.secret@example.com', now() - interval '2 days'),
  ('33333333-3333-3333-3333-333333333333', 'cashier.secret@example.com', now() - interval '1 day');
INSERT INTO public.users VALUES
  ('user-admin-a', 'Secret Owner Name', 'owner.secret@example.com', 'ADMIN', 'shop-a', '{}', true, '11111111-1111-1111-1111-111111111111', '{}', '{}', 'org1'),
  ('user-mgr-b', 'Secret Manager Name', 'manager.secret@example.com', 'MANAGER', 'shop-b', '{}', true, '22222222-2222-2222-2222-222222222222', '{}', '{}', 'org1'),
  ('user-cash-a', 'Secret Cashier Name', 'cashier.secret@example.com', 'CASHIER', 'shop-a', '{}', true, '33333333-3333-3333-3333-333333333333', '{}', '{}', 'org1');
-- 574-style migrated objects: no owner, old -> never counted
INSERT INTO storage.objects (bucket_id, name, created_at)
  SELECT 'product-images', 'temp/legacy-' || g, timestamptz '2026-10-12' FROM generate_series(1, 5) g;
INSERT INTO storage.objects (bucket_id, name, created_at) VALUES ('product-images', 'products/legacy/1.jpg', now() - interval '2 days');
SQL

# fixture generator: DB rows + access-log lines relative to now
cat >"$T/gen.py" <<'PY'
import sys, datetime as dt
case, out = sys.argv[1], sys.argv[2]
now = dt.datetime.now(dt.timezone.utc)
def ts(t): return t.strftime("%d/%b/%Y:%H:%M:%S +0000")
def iso(t): return t.strftime("%Y-%m-%dT%H:%M:%SZ")
UA_OLD = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) retails-shop/1.0.15 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36"
UA_NEW = UA_OLD.replace("1.0.15", "1.0.16")
UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
XCI = "shwephala-pos/1.0.16 (validated-uploads)"
log, sql = [], []
def line(t, method, path, status, ua, xci=None, ref="-"):
    s = f'127.0.0.1 - - [{ts(t)}] "{method} {path} HTTP/1.1" {status} 10 "{ref}" "{ua}"'
    if xci is not None: s += f' "{xci}"'
    log.append((t, s))
first = now - dt.timedelta(hours=10 if case == "short" else 96)
line(first, "GET", "/rest/v1/products?select=*", 200, "node")           # log start
def session(sid, user, shop, minutes_ago, ua, xci=None, status="COMPLETED"):
    t = now - dt.timedelta(minutes=minutes_ago); path = f"org/org1/temp/pimg-{sid:032x}"
    sql.append(f"INSERT INTO product_image_upload_sessions VALUES ('pimg-{sid:032x}','{user}','{shop}','p{sid}','{path}','{status}','{iso(t)}',{'NULL' if status != 'COMPLETED' else repr(iso(t + dt.timedelta(seconds=3)))});")
    sql.append(f"INSERT INTO storage.objects (bucket_id, name, created_at) VALUES ('product-images','{path}','{iso(t)}');")
    line(t, "POST", "/rest/v1/rpc/create_product_image_upload_session", 200, ua, xci)
    line(t, "POST", "/functions/v1/phone-upload-token", 200, ua, xci)
    line(t, "PUT", f"/storage/v1/object/upload/sign/product-images/{path}?token=SECRETTOKEN", 200, ua, xci,
         ref="https://host/functions/v1/phone-upload-page#t=SECRETFRAG")
    line(t, "POST", "/functions/v1/phone-upload-token", 200, ua, xci)
validated = case in ("noreg", "short", "go", "oldver", "m084")
if validated:
    session(1, "user-admin-a", "shop-a", 20, UA_NEW, XCI)          # till A test upload
    session(2, "user-mgr-b", "shop-b", 50 * 60, UA_NEW, XCI)       # till B test upload, 2 days ago
    session(3, "user-mgr-b", "shop-b", 30 * 60, UA_PHONE)          # phone upload (JIT page) - fine
    session(4, "user-admin-a", "shop-a", 200, UA_NEW, XCI, status="CANCELED")
    line(now - dt.timedelta(minutes=5), "GET", "/rest/v1/products", 200, UA_NEW, XCI)
if case == "oldver":
    line(now - dt.timedelta(hours=3), "GET", "/rest/v1/sales", 200, UA_OLD, "")   # an old till still selling
if case == "old":
    t = now - dt.timedelta(days=2)
    sql.append(f"INSERT INTO storage.objects (bucket_id, name, owner, created_at) VALUES ('product-images','org/org1/products/p9/170000.jpg','11111111-1111-1111-1111-111111111111','{iso(t)}');")
    line(t, "POST", "/storage/v1/object/product-images/org/org1/products/p9/170000.jpg", 200, UA_OLD)
if case == "signed":
    t = now - dt.timedelta(days=1); path = "org/org1/temp/pimg-" + "e" * 32
    sql.append(f"INSERT INTO product_image_upload_sessions VALUES ('pimg-{'e'*32}','user-mgr-b','shop-b','p8','{path}','COMPLETED','{iso(t)}','{iso(t)}');")
    sql.append(f"INSERT INTO storage.objects (bucket_id, name, owner, created_at) VALUES ('product-images','{path}','22222222-2222-2222-2222-222222222222','{iso(t)}');")
    line(t, "POST", f"/storage/v1/object/upload/sign/product-images/{path}", 200, UA_OLD)
    line(t, "PUT", f"/storage/v1/object/upload/sign/product-images/{path}?token=SECRETTOKEN", 200, UA_PHONE)
if case == "m084":
    sql.append("DROP POLICY product_images_insert ON storage.objects; DROP POLICY product_images_update ON storage.objects;")
    sql.append("COMMENT ON FUNCTION public.app_storage_can_write_path(text) IS '084: no policy uses this';")
line(now - dt.timedelta(seconds=30), "GET", "/storage/v1/version", 200, "curl/8.5.0")
open(out + ".log", "w").write("Generating Envoy configuration...\n" + "\n".join(l for t, l in log if t >= first) + "\n")
open(out + ".sql", "w").write("\n".join(sql) + "\n")
reg = ("# till register (synthetic)\ntill_id,label,shop_id,user_ref,updated_utc,test_utc,retired\n"
       f"till-aaaaaaaaaa,Counter A,shop-a,u-ab2c117f6e,{iso(now - dt.timedelta(hours=1))},{iso(now - dt.timedelta(minutes=20))},\n"
       f"till-bbbbbbbbbb,Counter B,shop-b,u-182321a26a,{iso(now - dt.timedelta(days=3))},{iso(now - dt.timedelta(minutes=50*60 - 2))},\n"
       "till-cccccccccc,Old laptop,shop-a,u-ab2c117f6e,,,yes\n")
open(out + ".csv", "w").write(reg)
PY

reset_data() {
  psql -c "TRUNCATE public.product_image_upload_sessions; DELETE FROM storage.objects WHERE name NOT LIKE 'temp/legacy-%' AND name <> 'products/legacy/1.jpg';"
  psql -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='product_images_insert') THEN
             CREATE POLICY product_images_insert ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'product-images');
             CREATE POLICY product_images_update ON storage.objects FOR UPDATE USING (bucket_id = 'product-images'); END IF; END\$\$;
           COMMENT ON FUNCTION public.app_storage_can_write_path(text) IS '078: rule';"
}
has() { grep -qE -- "$1" "$T/$2.out" && echo 0 || echo 1; }
run_case() { # case want_rc grep_text [register?]
  local c="$1" want="$2" text="$3" reg="${4:-reg}" rc=0 args=()
  reset_data
  python3 -I "$T/gen.py" "$c" "$T/$c"
  psql <"$T/$c.sql"
  [ "$reg" = reg ] && args+=(--register "$T/$c.csv")
  TILL_DB_CONTAINER=$DB DB_ADMIN_USER=postgres bash "$SCRIPT" report --no-docker-logs --access-log "$T/$c.log" ${args[@]+"${args[@]}"} >"$T/$c.out" 2>&1 || rc=$?
  ok "$c: exit code" "$rc" "$want"
  ok "$c: verdict contains '$text'" "$(grep -c -- "$text" "$T/$c.out" | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')" "yes"
  ok "$c: no object path / token / e-mail / name in output" \
    "$(grep -cE 'org/org1|pimg-|products/p9|SECRET|@example|Secret |user-admin|user-mgr|user-cash' "$T/$c.out" || true)" "0"
}

run_case old    1 "VERDICT: NO-GO"
ok "old: reason = 084 guard predicate" "$(has "direct staff upload" old)" "0"
ok "old: log footprint attributed to desktop 1.0.15" "$(has "FOOTPRINT direct_write from desktop 1.0.15" old)" "0"
ok "old: per-user row says OLD CLIENT" "$(has "u-ab2c117f6e .*OLD CLIENT" old)" "0"
run_case signed 1 "VERDICT: NO-GO"
ok "signed: owned temp object reported" "$(has "staff-signed session upload" signed)" "0"
ok "signed: staff signing in the log" "$(has "FOOTPRINT sign_upload from desktop" signed)" "0"
run_case oldver 1 "VERDICT: NO-GO"
ok "oldver: old build active is the reason" "$(has "older than 1.0.16" oldver)" "0"
run_case noreg  2 "VERDICT: INSUFFICIENT" noreg
ok "noreg: reason = no register" "$(has "no till register" noreg)" "0"
run_case short  2 "VERDICT: INSUFFICIENT"
ok "short: reason = log coverage" "$(has "coverage 10" short)" "0"
run_case go     0 "VERDICT: GO for 084"
ok "go: till A PROVEN" "$(has "till-aaaaaaaaaa .*PROVEN" go)" "0"
ok "go: till B PROVEN" "$(has "till-bbbbbbbbbb .*PROVEN" go)" "0"
ok "go: retired till ignored" "$(has "till-cccccccccc" go)" "1"
ok "go: manager row: 1 desktop-validated, 1 phone, READY" "$(has "u-182321a26a .* 1 +0 +1 +0 +0 +READY" go)" "0"
ok "go: cashier (no upload permission) unproven but not blocking" "$(has "u-18692b50d8 .*unproven" go)" "0"
ok "go: owner test upload listed as recent desktop-validated" \
  "$(grep -A1 "recent desktop-validated" "$T/go.out" | grep -cE "u-ab2c117f6e.*1\.0\.16.*OK" || true)" "1"
run_case m084   0 "ALREADY APPLIED"

# reduce mode: reduced records keep no path, token or referer
python3 -I "$T/gen.py" go "$T/red"
sed -n '/^cat >"\$WORK\/r.py" <</,/^PY$/p' "$SCRIPT" | sed '1d;$d' > "$T/r.py"
python3 -I "$T/r.py" reduce < "$T/red.log" > "$T/red.tsv"
ok "reduce: header + one record per access line" "$(($(wc -l < "$T/red.tsv") - 1))" "$(grep -c '^127' "$T/red.log")"
ok "reduce: no path / token / referer in reduced records" "$(grep -cE 'org/|SECRET|phone-upload-page|pimg' "$T/red.tsv" || true)" "0"
reset_data; psql <"$T/red.sql"
rc=0; TILL_DB_CONTAINER=$DB DB_ADMIN_USER=postgres bash "$SCRIPT" report --no-docker-logs --access-log "$T/red.tsv" --register "$T/red.csv" >"$T/red.out" 2>&1 || rc=$?
ok "reduce: report from reduced history alone -> GO" "$rc" "0"

# read-only: the DB transaction refuses writes (inject one into a copy)
sed 's/^COMMIT;$/INSERT INTO storage.objects (bucket_id, name) VALUES ($$x$$, $$y$$);\nCOMMIT;/' "$SCRIPT" > "$T/inject.sh"
rc=0; TILL_DB_CONTAINER=$DB DB_ADMIN_USER=postgres bash "$T/inject.sh" report --no-docker-logs >"$T/inject.out" 2>&1 || rc=$?
ok "read-only transaction: injected write refused (exit 3)" "$rc|$(grep -c 'read-only transaction' "$T/inject.out" || true)" "3|1"

echo
echo "verify-till-readiness: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
