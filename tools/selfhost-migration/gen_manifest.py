#!/usr/bin/env python3
"""Generate sql/manifest.sql: ONE SELECT returning rows (object, metric, value).

The same SQL runs on hosted (``supabase db query --linked -f manifest.sql``)
and on the self-hosted DB (``psql -A -F '|' -t -f manifest.sql``), and the two
outputs are compared with manifest_diff.py.

Usage:
    gen_manifest.py [--tables sql/tables.default.txt] [--out sql/manifest.sql]

Table list format: ``schema.table [id | id=<expr>] [created_at]`` per line.
"""
from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TABLES = os.path.join(HERE, "sql", "tables.default.txt")
DEFAULT_OUT = os.path.join(HERE, "sql", "manifest.sql")

TS_FMT = "YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\""


@dataclass
class TableSpec:
    schema: str
    table: str
    id_expr: str | None  # None -> no checksum
    created_at: bool

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.table}"

    @property
    def sql_name(self) -> str:
        return f'"{self.schema}"."{self.table}"'


def parse_table_list(text: str) -> list[TableSpec]:
    specs: list[TableSpec] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        name = parts[0]
        if "." not in name:
            raise ValueError(f"table must be schema.table: {name!r}")
        schema, table = name.split(".", 1)
        id_expr: str | None = None
        created_at = False
        for flag in parts[1:]:
            if flag == "id":
                id_expr = "id"
            elif flag.startswith("id="):
                id_expr = flag[3:]
            elif flag == "created_at":
                created_at = True
            else:
                raise ValueError(f"unknown flag {flag!r} on {name}")
        specs.append(TableSpec(schema, table, id_expr, created_at))
    return specs


def _lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def build_manifest_sql(specs: list[TableSpec]) -> str:
    arms: list[str] = []

    def arm(obj: str, metric: str, value_sql: str, from_sql: str = "") -> None:
        arms.append(f"select {_lit(obj)} as object, {_lit(metric)} as metric, {value_sql} as value{from_sql}")

    for s in specs:
        arm(s.qualified, "count", "count(*)::text", f" from {s.sql_name}")
        if s.id_expr:
            expr = s.id_expr
            arm(
                s.qualified,
                "checksum",
                f"md5(coalesce(string_agg(({expr})::text, ',' order by ({expr})::text), ''))",
                f" from {s.sql_name}",
            )
        if s.created_at:
            arm(
                s.qualified,
                "max_created_at",
                f"coalesce(to_char(max(created_at) at time zone 'UTC', {_lit(TS_FMT)}), '')",
                f" from {s.sql_name}",
            )

    # sequences
    arm("auth.refresh_tokens_id_seq", "last_value", "last_value::text", " from auth.refresh_tokens_id_seq")
    arm("auth.refresh_tokens", "max_id", "coalesce(max(id), 0)::text", " from auth.refresh_tokens")

    # publication membership (only the app publication; the realtime messages
    # publication holds per-day partitions and is never equal across hosts)
    arm(
        "publication:supabase_realtime",
        "tables",
        "coalesce(string_agg(schemaname || '.' || tablename, ',' order by schemaname, tablename), '')",
        " from pg_publication_tables where pubname = 'supabase_realtime'",
    )

    # policy count per public table (explicit per table so zeros appear)
    for s in specs:
        if s.schema != "public":
            continue
        arm(
            s.qualified,
            "policies",
            "count(*)::text",
            f" from pg_policies where schemaname = 'public' and tablename = {_lit(s.table)}",
        )
    arm("public", "policies_total", "count(*)::text", " from pg_policies where schemaname = 'public'")
    arm(
        "public",
        "policies_authenticated_all",
        "count(*)::text",
        " from pg_policies where schemaname = 'public' and policyname = 'authenticated_all'",
    )

    # RLS
    arm(
        "public",
        "tables_rls_enabled",
        "count(*) filter (where c.relrowsecurity)::text || '/' || count(*)::text",
        " from pg_class c join pg_namespace n on n.oid = c.relnamespace"
        " where n.nspname = 'public' and c.relkind in ('r', 'p')",
    )

    # functions
    fn_from = (
        " from pg_proc p join pg_namespace n on n.oid = p.pronamespace"
        " where n.nspname = 'public' and p.prokind in ('f', 'p')"
    )
    arm("public.functions", "count", "count(*)::text", fn_from)
    arm(
        "public.functions",
        "anon_executable",
        "count(*) filter (where has_function_privilege('anon', p.oid, 'EXECUTE'))::text",
        fn_from,
    )
    arm(
        "public.functions",
        "security_definer",
        "count(*) filter (where p.prosecdef)::text",
        fn_from,
    )
    arm(
        "public.functions",
        "names_checksum",
        "md5(coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ',' "
        "order by p.proname, pg_get_function_identity_arguments(p.oid)), ''))",
        fn_from,
    )

    # triggers / indexes / views in public (names only)
    arm(
        "public.triggers",
        "count",
        "count(*)::text",
        " from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace"
        " where n.nspname = 'public' and not t.tgisinternal",
    )
    arm("public.indexes", "count", "count(*)::text", " from pg_indexes where schemaname = 'public'")
    arm("public.views", "count", "count(*)::text", " from pg_views where schemaname = 'public'")

    # migration history
    arm(
        "supabase_migrations.schema_migrations",
        "count",
        "count(*)::text",
        " from supabase_migrations.schema_migrations",
    )
    arm(
        "supabase_migrations.schema_migrations",
        "max_version",
        "coalesce(max(version), '')",
        " from supabase_migrations.schema_migrations",
    )

    # cron
    arm("cron.job", "count", "count(*)::text", " from cron.job")
    arm(
        "cron.job",
        "names",
        "coalesce(string_agg(jobname || '@' || schedule, ',' order by jobname), '')",
        " from cron.job",
    )

    body = "\nunion all\n".join(arms)
    return (
        "-- GENERATED by tools/selfhost-migration/gen_manifest.py — do not edit by hand.\n"
        "-- One SELECT returning (object, metric, value). Run on hosted via\n"
        "--   supabase db query --linked -f tools/selfhost-migration/sql/manifest.sql > manifest-hosted.json\n"
        "-- and on self-hosted via\n"
        "--   docker compose exec -T db psql -U supabase_admin -d postgres -A -F '|' -t -f /tmp/manifest.sql > manifest-selfhost.txt\n"
        "-- then compare with manifest_diff.py.\n"
        "select object, metric, value from (\n"
        + body
        + "\n) m\norder by object, metric;\n"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tables", default=DEFAULT_TABLES, help="table list file (default: sql/tables.default.txt)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output SQL path (default: sql/manifest.sql); '-' for stdout")
    args = ap.parse_args(argv)

    with open(args.tables, encoding="utf-8") as fh:
        specs = parse_table_list(fh.read())
    sql = build_manifest_sql(specs)
    if args.out == "-":
        sys.stdout.write(sql)
    else:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(sql)
        print(f"wrote {args.out}: {len(specs)} tables, {sql.count('union all') + 1} metrics")
    return 0


if __name__ == "__main__":
    sys.exit(main())
