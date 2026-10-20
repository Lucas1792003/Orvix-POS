"""Migration 087: the rolled-back archive allow-list (v87.x hardening), on the DISPOSABLE stack only (README.md, part `archive`).

A re-install of 087 accepts pre-existing recovery roles only when every recovery_archived_087_* schema still has the shape the
rollback left (087_recovery_hold.sql, DO $probe$; docs/selfhost-migration/phase-g/recovery-roles-prerequisite.md, item 4).
Each case adds ONE deviation to a REAL rolled-back archive as supabase_admin (simulating whoever could have planted it), runs
the REAL migration through the REAL runner, and expects:
  * a refusal naming that case's own deviation (the exact item, not just any refusal), and
  * nothing of 087 applied: the partial-application fingerprint (ledger row, schemas, canary, triggers, event triggers, 087
    functions, recovery roles, public ACLs) is identical before and after the attempt;
then reverts it. Afterwards: the archives are as the rollbacks left them (inventory.sql), and the legitimate paths work: the
re-install commits held, a further rollback archives again, and the archived evidence is untouched throughout.
Planted functions are inert (`select 1`); nothing reads or extracts archive contents.

Safety: local docker socket only; the fixed container phf-iso-db (supabase/postgres image, published on 127.0.0.1 only); no
connection string is accepted or used, and one in the environment is refused; the runner gets a minimal environment, always in
test mode, with HOST pointed at an unresolvable name, and every runner output must confirm the local test target. Its own
resources are zz_m087_* / zz_* objects, the extension tcn and the database zz_m087_other: it refuses to start if any exists
already, and removes only those.
  python3 -I tools/m087-verify/archive/archive-allowlist.py RESULTS_DIR      (run.sh: PARTS="... archive"; needs lib/stack.sh up)
"""
import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DB = "phf-iso-db"
REPORT = None
res = []


def say(s):
    print(s, flush=True)
    if REPORT:
        REPORT.write(s + "\n"); REPORT.flush()


def refuse(why):
    say(f"REFUSE: {why}"); say("== RESULT: 0 passed, 1 failed"); sys.exit(3)


# ---------------------------------------------------------------- guards: disposable, local, never a connection string (before
# anything is created, the results directory included)
if len(sys.argv) != 2:
    refuse("usage: archive-allowlist.py RESULTS_DIR")
if re.search(r"(postgres(ql)?:|host=|sslmode=|@)", sys.argv[1], re.I):
    refuse("connection strings are not accepted")
if not os.environ.get("DOCKER_HOST", "unix://").startswith("unix://"):
    refuse("local docker only")
for k in ("DATABASE_URL", "SUPABASE_DB_URL", "POSTGRES_URL", "PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
    v = os.environ.get(k, "")
    if v and not re.fullmatch(r"(localhost|127\.0\.0\.1|::1|/[\w/.-]*)", v) and "127.0.0.1" not in v and "localhost" not in v:
        refuse(f"{k} points at a non-local database; unset it (this suite never uses it)")
insp = subprocess.run(["docker", "inspect", "-f", "{{.Config.Image}}|{{json .HostConfig.PortBindings}}", DB], capture_output=True, text=True)
if insp.returncode != 0:
    refuse(f"container {DB} not found (start the disposable stack: lib/stack.sh up)")
image, ports = insp.stdout.strip().split("|", 1)
if not re.match(r"^(public\.ecr\.aws/)?supabase/postgres:", image):
    refuse(f"{DB} is not the disposable supabase/postgres stack container ({image})")
if any(b.get("HostIp") not in ("127.0.0.1",) for v in (json.loads(ports) or {}).values() for b in (v or [])):
    refuse(f"{DB} publishes a port beyond 127.0.0.1")
RUNNER_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp"), "LANG": "C.UTF-8",
              "APPLY_MIGRATIONS_TEST_CONTAINER": DB, "HOST": "refuse-non-test.invalid"}
RES = os.path.abspath(sys.argv[1])
if not os.path.isdir(RES):
    refuse(f"results directory {RES} does not exist (run.sh creates it)")
OUT = os.path.join(RES, "archive")
os.makedirs(OUT, exist_ok=True)
REPORT = open(os.path.join(OUT, "ARCHIVE.txt"), "w")


def sql(q, db="postgres"):
    r = subprocess.run(["docker", "exec", "-i", DB, "psql", "-X", "-U", "supabase_admin", "-d", db, "-At", "-v", "ON_ERROR_STOP=1"],
                       input=q, capture_output=True, text=True, env=RUNNER_ENV)
    return r.stdout.strip(), (r.stderr.strip().split("ERROR:")[-1].strip().split("\n")[0] if r.returncode else ""), r.returncode


def runner(*args):
    r = subprocess.run(["bash", "deploy/lucashome/apply-migrations.sh", *args], cwd=ROOT, env=RUNNER_ENV, capture_output=True, text=True)
    out = r.stdout + r.stderr
    if f"TEST TARGET: local container {DB}" not in out:
        refuse("the runner did not confirm the local test target")
    return ("COMMITTED" in out), next((l.split("ERROR:")[-1].strip() for l in out.split("\n") if "ERROR:" in l), "")


def apply087():
    return runner("--from", "087", "--to", "087")


def rollback087():
    return runner("--rollback", "087", "--owner-confirmed-till-queues-empty")[0]


def installed():
    return sql("select to_regnamespace('recovery') is not null")[0] == "t"


def archives():
    o = sql("select string_agg(nspname, ',' order by nspname desc) from pg_namespace where nspname ~ '^recovery_archived_087_[0-9]{8}t[0-9]{6}$'")[0]
    return o.split(",") if o else []


# everything 087 creates or changes outside its archives; identical before and after a refused install = nothing applied
FINGERPRINT = """select concat_ws(' | ',
  (select count(*) from supabase_migrations.schema_migrations where version = '087'),
  to_regnamespace('recovery') is null, to_regnamespace('recovery_guard') is null, to_regclass('public.zz_recovery_canary') is null,
  (select string_agg(evtname || ':' || evtenabled::text, ',' order by evtname) from pg_event_trigger),
  (select count(*) from pg_trigger where tgname like 'zz\\_recovery\\_%'),
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like '%\\_v87' or proname like 'recovery\\_%')),
  (select string_agg(rolname || ':' || rolcanlogin || ':' || (rolpassword is null) || ':' || rolbypassrls || ':' || rolinherit || ':' || rolconnlimit
                     || ':' || coalesce(rolvaliduntil::text, '-'), ',' order by rolname) from pg_authid where rolname like 'recovery\\_%'),
  (select md5(string_agg(c.relname || '=' || coalesce(c.relacl::text, '-'), ',' order by c.relname)) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')),
  (select coalesce(proacl::text, '-') from pg_proc where oid = 'public.prune_idempotency_keys()'::regprocedure))"""


def fingerprint():
    o = sql(FINGERPRINT)
    assert o[2] == 0, f"fingerprint failed: {o[1]}"
    return o[0]


def evidence():
    """row counts of the evidence tables in every archive (never their contents)"""
    q = " union all ".join(f"select '{a}', (select count(*) from {a}.journal), (select count(*) from {a}.events), (select count(*) from {a}.chain_log), "
                           f"(select count(*) from {a}.decisions), (select count(*) from {a}.quarantine), (select count(*) from {a}.tills)" for a in archives())
    return sql(q + " order by 1")[0]


def has_item(err, needle):
    """needle present as a whole item (not followed by a name character); a trailing '*' means prefix match"""
    if needle.endswith("*"):
        return needle[:-1] in err
    return re.search(re.escape(needle) + r"(?![\w\[\]])", err) is not None


def rec(i, what, expected, observed, ok):
    res.append({"id": i, "what": what, "expected": expected, "observed": observed, "pass": bool(ok)})
    say(f"{'PASS' if ok else 'FAIL'} {i:5} {what[:84]:84} | {str(observed)[:170]}")


def inventory():
    o = sql(open(os.path.join(HERE, "inventory.sql")).read())
    assert o[2] == 0 and "== schemas" in o[0] and "recovery_archived_087_" in o[0], f"inventory failed: {o[1]}"
    return o[0]


# ---------------------------------------------------------------- own resources must not pre-exist (so cleanup removes only ours)
pre = sql("""select concat_ws(',',
  (select string_agg(n.nspname || '.' || c.relname, ',') from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname like 'zz\\_m087\\_%'),
  (select string_agg(proname, ',') from pg_proc where proname like 'zz\\_m087\\_%'),
  (select string_agg(typname, ',') from pg_type where typname like 'zz\\_m087\\_%'),
  (select string_agg(collname, ',') from pg_collation where collname like 'zz\\_m087\\_%'),
  (select string_agg(stxname, ',') from pg_statistic_ext where stxname like 'zz\\_m087\\_%'),
  (select string_agg(pubname, ',') from pg_publication where pubname like 'zz\\_m087\\_%'),
  (select string_agg(extname, ',') from pg_extension where extname = 'tcn'),
  (select string_agg(datname, ',') from pg_database where datname = 'zz_m087_other'),
  (select string_agg(nspname, ',') from pg_namespace where nspname in ('recovery_archived_087_zz', 'recovery_archived_087_20200101t000000')))""")
if pre[2] != 0 or pre[0]:
    refuse(f"resources this suite owns already exist ({pre[0] or pre[1]}); it never removes what it did not create")

# ---------------------------------------------------------------- setup: 087 rolled back, at least two REAL archives
say("== archive allow-list (087 v87.x): setup")
if installed() and not rollback087():
    refuse("could not roll back the installed 087 through the runner")
while len(archives()) < 2:
    if not (apply087()[0] and rollback087()):
        refuse("could not create a real archive (install + rollback through the runner)")
if installed() or len(archives()) < 2:
    refuse("setup did not reach: 087 rolled back with >= 2 real archives")
ARCHS = archives()
A, B = ARCHS[0], ARCHS[1]   # the newest, an older one (after x2: the first archive holds the suite's live evidence)
INV0 = inventory()
EV0 = evidence()
open(os.path.join(OUT, "inventory-before.txt"), "w").write(INV0)
say(f"   archives: {len(ARCHS)} (newest {A})")
FN = "create or replace function public.zz_m087_fn(int default 0) returns int language sql immutable as 'select 1'"
DROPFN = "drop function public.zz_m087_fn(int)"

# (id, what, plant, revert, the item the refusal must name)
CASES = [
    ("V1", "view in the archive (owned by recovery_owner)",
     f"create view {A}.zz_v as select 1 as x; alter view {A}.zz_v owner to recovery_owner", f"drop view {A}.zz_v", f"relation {A}.zz_v (kind v*"),
    ("V2", "materialized view in the archive",
     f"create materialized view {A}.zz_mv as select 1 as x; alter materialized view {A}.zz_mv owner to recovery_owner", f"drop materialized view {A}.zz_mv",
     f"relation {A}.zz_mv (kind m*"),
    ("V3", "extra table not made by 087 (owned by recovery_owner)",
     f"create table {A}.zz_extra (x int); alter table {A}.zz_extra owner to recovery_owner", f"drop table {A}.zz_extra", f"relation {A}.zz_extra (kind r*"),
    ("V4", "087 table owned by postgres (NULL ACL: invisible to the old grant check)",
     f"alter table {A}.quota owner to postgres", f"alter table {A}.quota owner to recovery_owner", f"relation {A}.quota (kind r, owner postgres)*"),
    ("V5", "087 table owned by recovery_gate (another recovery role)",
     f"alter table {A}.quota owner to recovery_gate", f"alter table {A}.quota owner to recovery_owner", f"relation {A}.quota (kind r, owner recovery_gate)*"),
    ("V6", "standalone sequence (not owned by an archive column)",
     f"create sequence {A}.zz_seq; alter sequence {A}.zz_seq owner to recovery_owner", f"drop sequence {A}.zz_seq", f"relation {A}.zz_seq (kind S*"),
    ("V7", "087 table set UNLOGGED",
     f"alter table {A}.quota set unlogged", f"alter table {A}.quota set logged", f"relation {A}.quota (kind r, owner recovery_owner)*"),
    ("V8", "a VIEW under an allowed table name (kind rule alone; the table moved aside)",
     f"alter table {A}.quota rename to zz_quota_t; create view {A}.quota as select * from {A}.zz_quota_t; alter view {A}.quota owner to recovery_owner",
     f"drop view {A}.quota; alter table {A}.zz_quota_t rename to quota", f"relation {A}.quota (kind v*"),
    ("V9", "a PARTITION under an allowed table name (relispartition alone)",
     f"alter table {A}.quota rename to zz_quota_t; create table {A}.zz_pp (org_id text) partition by list (org_id); "
     f"create table {A}.quota partition of {A}.zz_pp for values in ('x'); alter table {A}.zz_pp owner to recovery_owner; alter table {A}.quota owner to recovery_owner",
     f"drop table {A}.zz_pp; alter table {A}.zz_quota_t rename to quota", f"relation {A}.quota (kind r, owner recovery_owner)*"),
    ("P1", "SELECT on an archive table granted to recovery_gate (old check allowed it)",
     f"grant select on {A}.keys to recovery_gate", f"revoke select on {A}.keys from recovery_gate", f"privilege SELECT on {A}.keys for recovery_gate"),
    ("P2", "SELECT on an archive table granted to a superuser (old check allowed it)",
     f"grant select on {A}.keys to supabase_admin", f"revoke select on {A}.keys from supabase_admin", f"privilege SELECT on {A}.keys for supabase_admin"),
    ("P3", "SELECT on an archive table granted to authenticated",
     f"grant select on {A}.keys to authenticated", f"revoke select on {A}.keys from authenticated", f"privilege SELECT on {A}.keys for authenticated"),
    ("P4", "COLUMN-level SELECT granted to authenticated (old check never read attacl)",
     f"grant select (name) on {A}.keys to authenticated", f"revoke select (name) on {A}.keys from authenticated",
     f"column privilege SELECT on {A}.keys.name for authenticated"),
    ("P5", "USAGE on an archive sequence granted to anon",
     f"grant usage on sequence {A}.events_id_seq to anon", f"revoke usage on sequence {A}.events_id_seq from anon", f"privilege USAGE on {A}.events_id_seq for anon"),
    ("P6", "CREATE on the archive schema granted to postgres (old check never read nspacl)",
     f"grant create on schema {A} to postgres", f"revoke create on schema {A} from postgres", f"schema privilege CREATE of {A} for postgres"),
    ("P7", "USAGE on the archive schema granted to PUBLIC",
     f"grant usage on schema {A} to public", f"revoke usage on schema {A} from public", f"schema privilege USAGE of {A} for PUBLIC"),
    ("P8", "USAGE on the archive schema WITH GRANT OPTION for authenticated",
     f"grant usage on schema {A} to authenticated with grant option", f"revoke grant option for usage on schema {A} from authenticated",
     f"schema privilege USAGE of {A} for authenticated"),
    ("P9", "default privilege of postgres inside the archive (old check: recovery roles only)",
     f"alter default privileges for role postgres in schema {A} grant select on tables to anon",
     f"alter default privileges for role postgres in schema {A} revoke select on tables from anon", f"default privilege of postgres in {A}"),
    ("P10", "USAGE on an archive row type granted to anon explicitly",
     f"grant usage on type {A}.keys to anon", f"revoke usage on type {A}.keys from anon", f"type {A}.keys"),
    ("P11", "schema USAGE for anon granted by recovery_gate (grantor is not the owner)",
     f"grant usage on schema {A} to recovery_gate with grant option; set role recovery_gate; grant usage on schema {A} to anon; reset role",
     f"revoke grant option for usage on schema {A} from recovery_gate cascade", f"schema privilege USAGE of {A} for anon"),
    ("P12", "deviation in an OLDER archive (not the newest)",
     f"grant select on {B}.keys to authenticated", f"revoke select on {B}.keys from authenticated", f"privilege SELECT on {B}.keys for authenticated"),
    ("T1", "domain type in the archive",
     f"create domain {A}.zz_dom as int; alter domain {A}.zz_dom owner to recovery_owner", f"drop domain {A}.zz_dom", f"type {A}.zz_dom"),
    ("T2", "enum type in the archive",
     f"create type {A}.zz_enum as enum ('a'); alter type {A}.zz_enum owner to recovery_owner", f"drop type {A}.zz_enum", f"type {A}.zz_enum"),
    ("T3", "standalone composite type in the archive",
     f"create type {A}.zz_comp as (x int); alter type {A}.zz_comp owner to recovery_owner", f"drop type {A}.zz_comp", f"relation {A}.zz_comp (kind c*"),
    ("F1", "function in the archive (the earlier forged-archive case)",
     f"create function {A}.zz_f() returns int language sql as 'select 1'; alter function {A}.zz_f() owner to recovery_owner", f"drop function {A}.zz_f()",
     f"function {A}.zz_f()"),
    ("F2", "operator in the archive",
     f"{FN}; create operator {A}.### (rightarg = int, function = public.zz_m087_fn)", f"drop operator {A}.### (none, int); {DROPFN}",
     f"operator {A}.###(NONE,integer)"),
    ("F3", "collation in the archive", f"create collation {A}.zz_coll from \"C\"", f"drop collation {A}.zz_coll", "collation zz_coll"),
    ("F4", "text search configuration in the archive",
     f"create text search configuration {A}.zz_ts (copy = pg_catalog.simple)", f"drop text search configuration {A}.zz_ts", "text search configuration zz_ts"),
    ("C1", "trigger on an archive table (built-in pg_catalog trigger function)",
     f"create trigger zz_tg before update on {A}.quota for each row execute function pg_catalog.suppress_redundant_updates_trigger()",
     f"drop trigger zz_tg on {A}.quota", f"trigger zz_tg on {A}.quota"),
    ("C2", "rule on an archive table", f"create rule zz_rule as on insert to {A}.quota do instead nothing", f"drop rule zz_rule on {A}.quota",
     f"rule zz_rule on {A}.quota"),
    ("C3", "row-level policy on an archive table", f"create policy zz_pol on {A}.quota using (true)", f"drop policy zz_pol on {A}.quota",
     f"policy zz_pol on {A}.quota"),
    ("C4", "column DEFAULT calling a function outside the archive",
     f"{FN}; alter table {A}.quota alter column max_bytes set default public.zz_m087_fn()", f"alter table {A}.quota alter column max_bytes drop default; {DROPFN}",
     f"dependency of default value for column max_bytes of table {A}.quota on function public.zz_m087_fn(integer)"),
    ("C5", "INDEX expression on a function outside the archive (evaluated by ANALYZE as the owner)",
     f"{FN}; create index zz_idx on {A}.quota (public.zz_m087_fn(max_bytes::int))", f"drop index {A}.zz_idx; {DROPFN}",
     f"dependency of index {A}.zz_idx on function public.zz_m087_fn(integer)"),
    ("C6", "CHECK constraint calling a function outside the archive",
     f"{FN}; alter table {A}.quota add constraint zz_chk check (public.zz_m087_fn() = 1)", f"alter table {A}.quota drop constraint zz_chk; {DROPFN}",
     f"dependency of constraint zz_chk on table {A}.quota on function public.zz_m087_fn(integer)"),
    ("C7", "column re-typed to a domain outside the archive",
     f"create domain public.zz_m087_dom as text; alter table {A}.quota alter column org_id type public.zz_m087_dom",
     f"alter table {A}.quota alter column org_id type text; drop domain public.zz_m087_dom",
     f"dependency of column org_id of table {A}.quota on type public.zz_m087_dom"),
    ("C8", "foreign key from a public table into the archive (RI triggers on the archive table)",
     f"create table public.zz_m087_fk (org_id text references {A}.quota (org_id))", "drop table public.zz_m087_fk", "trigger RI_ConstraintTrigger_a_*"),
    ("C9", "public table INHERITS from an archive table",
     f"create table public.zz_m087_child () inherits ({A}.events)", "drop table public.zz_m087_child", f"inheritance public.zz_m087_child of {A}.events"),
    ("C10", "statistics object on an archive table",
     f"create statistics public.zz_m087_st on org_id, max_bytes from {A}.quota", "drop statistics public.zz_m087_st", "statistics object zz_m087_st"),
    ("C11", "archive table in a publication (owned by postgres)",
     f"create publication zz_m087_pub for table {A}.journal; alter publication zz_m087_pub owner to postgres", "drop publication zz_m087_pub",
     f"publication of {A}.journal"),
    ("C12", "EXCLUDE constraint on an archive table",
     f"alter table {A}.quota add constraint zz_ex exclude using btree (org_id with =)", f"alter table {A}.quota drop constraint zz_ex", "constraint zz_ex (x)"),
    ("C13", "FOREIGN KEY between two archive tables (constraint kind f)",
     f"alter table {A}.quarantine add constraint zz_fk foreign key (org_id) references {A}.quota (org_id) not valid",
     f"alter table {A}.quarantine drop constraint zz_fk", "constraint zz_fk (f)"),
    ("C14", "column default reaching into ANOTHER archive (same-archive rule)",
     f"alter table {A}.quota alter column max_bytes set default nextval('{B}.events_id_seq')", f"alter table {A}.quota alter column max_bytes drop default",
     f"dependency of default value for column max_bytes of table {A}.quota on sequence {B}.events_id_seq"),
    ("C15", "column given a non-built-in (ICU) collation outside the archive",
     f"create collation public.zz_m087_coll (provider = icu, locale = 'und'); alter table {A}.quota alter column org_id type text collate public.zz_m087_coll",
     f"alter table {A}.quota alter column org_id type text collate pg_catalog.\"default\"; drop collation public.zz_m087_coll",
     f"dependency of column org_id of table {A}.quota on collation public.zz_m087_coll"),
    ("X1", "the archive SCHEMA made a member of an extension (hidden from pg_dump)",
     f"create extension tcn; alter extension tcn add schema {A}", f"alter extension tcn drop schema {A}; drop extension tcn",
     f"dependency of schema {A} on extension tcn"),
    ("N1", "schema with the archive prefix but not the rollback's name format (owned by recovery_owner)",
     "create schema recovery_archived_087_zz authorization recovery_owner", "drop schema recovery_archived_087_zz",
     "schema recovery_archived_087_zz (owner recovery_owner)"),
    ("N2", "schema with the rollback's exact name format but owned by postgres",
     "create schema recovery_archived_087_20200101t000000 authorization postgres", "drop schema recovery_archived_087_20200101t000000",
     "schema recovery_archived_087_20200101t000000 (owner postgres)"),
    ("N3", "an EMPTY forged archive (right name, owned by recovery_owner)",
     "create schema recovery_archived_087_20200101t000000 authorization recovery_owner", "drop schema recovery_archived_087_20200101t000000",
     "missing 087 table recovery_archived_087_20200101t000000.settings"),
    ("N4", "an archive missing one 087 table (renamed inside the archive)",
     f"alter table {A}.v87_txn rename to zz_v87_txn", f"alter table {A}.zz_v87_txn rename to v87_txn", f"missing 087 table {A}.v87_txn"),
    ("R1", "recovery_owner without BYPASSRLS (not as 087 creates it)",
     "alter role recovery_owner nobypassrls", "alter role recovery_owner bypassrls", "recovery_owner is not as 087 creates it (no BYPASSRLS)*"),
    ("G1", "a GLOBAL default privilege of recovery_owner (outside any archive)",
     "alter default privileges for role recovery_owner grant select on tables to anon",
     "alter default privileges for role recovery_owner revoke select on tables from anon", "outside a rolled-back 087 archive: pg_default_acl*"),
]

say("== deviations: each refused, naming itself, with nothing applied")
aborted = False
for cid, what, plant, revert, needle in CASES:
    p = sql(plant)
    if p[2] != 0:
        rec(cid, what, "refused, nothing applied", {"plant_failed": p[1][:150]}, False)
        sql(revert)
        continue
    try:
        fp0 = fingerprint()
        ok, err = apply087()
        inst = installed()
        same = fingerprint() == fp0
        rec(cid, what, f"refused naming '{needle}'; nothing applied", err[:200] if same else {"err": err[:120], "PARTIAL_APPLICATION": True},
            not ok and not inst and same and has_item(err, needle))
        if inst:  # never continue on a wrongly-installed state
            say(f"NOTE {cid}: 087 installed on a deviating state; rolling back"); rollback087()
    except Exception as e:  # a harness error: still revert this case's own deviation, then stop
        rec(cid, what, "refused, nothing applied", {"harness_error": str(e)[:150]}, False); aborted = True
    finally:
        r = sql(revert)
    if aborted or r[2] != 0:
        if r[2] != 0:
            rec(cid + "r", f"revert of {cid}", "reverted", r[1][:150], False)
        aborted = True; break

if not aborted:
    c = sql("create database zz_m087_other")
    o = sql("create table public.zz_m087_t (x int); alter table public.zz_m087_t owner to recovery_owner", db="zz_m087_other")
    fp0 = fingerprint()
    ok, err = apply087()
    inst = installed()
    rec("S1", "a table owned by recovery_owner in another database (pg_shdepend, every database)", "refused; nothing applied", err[:200],
        c[2] == 0 and o[2] == 0 and not ok and not inst and fingerprint() == fp0 and "outside a rolled-back 087 archive: pg_class:" in err)
    if inst:
        say("NOTE S1: 087 installed; rolling back"); rollback087()
    d = sql("drop database zz_m087_other")
    rec("S1r", "revert of S1 (drop the suite's own database)", "dropped", d[1] or "dropped", d[2] == 0)

    say("== legitimate paths")
    inv = inventory()
    open(os.path.join(OUT, "inventory-after.txt"), "w").write(inv)
    same = sorted(inv.split("\n")) == sorted(INV0.split("\n"))   # order-independent
    rec("Z1", "after all cases, every archive is as the rollbacks left it (inventory)", "identical", "identical" if same else "DIFFERS", same)
    ok, err = apply087()
    st = sql("select (select state from recovery.continuity) || '|' || (not recovery.lease_ok())::text || '|' || "
             "(select count(*) from supabase_migrations.schema_migrations where version = '087')")[0] if ok else ""
    rec("Z2", f"unchanged real archives ({len(ARCHS)}): the hardened 087 re-installs, held, no lease, one ledger row", "COMMITTED; hold|true|1",
        {"install": err[:120] or "COMMITTED", "state": st}, ok and installed() and st == "hold|true|1")
    ev1 = evidence()
    rec("Z3", "the re-install leaves the archived evidence untouched (row counts per archive)", "identical", "identical" if ev1 == EV0 else "DIFFERS", ev1 == EV0)
    rb = rollback087()
    n = len(archives())
    ok, err = apply087()
    rec("Z4", f"a further rollback ({n} real archives now) and re-install", "rollback ok; COMMITTED",
        {"rollback": rb, "archives": n, "install": err[:120] or "COMMITTED"}, rb and ok and installed() and n == len(ARCHS) + 1)
    ev2 = evidence()
    rec("Z5", "earlier archives' evidence still untouched after the further rollback and re-install", "identical",
        "identical" if "\n".join(l for l in ev2.split("\n") if l.split("|")[0] in ARCHS) == EV0 else "DIFFERS",
        "\n".join(l for l in ev2.split("\n") if l.split("|")[0] in ARCHS) == EV0)
    left = sql("""select concat_ws(',', (select string_agg(relname, ',') from pg_class where relname like 'zz\\_m087\\_%'),
      (select string_agg(proname, ',') from pg_proc where proname like 'zz\\_m087\\_%'), (select string_agg(extname, ',') from pg_extension where extname = 'tcn'),
      (select string_agg(datname, ',') from pg_database where datname = 'zz_m087_other'),
      (select string_agg(nspname, ',') from pg_namespace where nspname in ('recovery_archived_087_zz', 'recovery_archived_087_20200101t000000')))""")[0]
    rec("Z6", "none of the suite's own resources are left", "none", left or "none", left == "")
json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
say(f"== RESULT: {sum(r['pass'] for r in res)} passed, {sum(not r['pass'] for r in res)} failed")
