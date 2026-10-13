#!/usr/bin/env python3
"""Compare auth/storage column inventories (hosted vs self-hosted) and fix data.sql.

    schema_compat.py --hosted columns-hosted.json --selfhost columns-selfhost.txt
                     [--constraints-hosted c-hosted.json --constraints-selfhost c-selfhost.txt]
                     [--ignore auth.users.some_col ...]
                     [--fix-dump data.scrubbed.sql --out data.fixed.sql]

Inventories come from sql/columns_inventory.sql (CLI JSON ``{"rows":[...]}``
or ``psql -A -F '|'`` output with header). Findings:

  table only on hosted          WARN (COPY would fail) — --fix-dump DROPS the whole block
  table only on self-hosted     INFO
  column only on hosted         FAIL (COPY would fail) — --fix-dump REMOVES it from the block
  column only on self-hosted    ok if nullable or has a default, FAIL otherwise
  data_type differs             FAIL (use --ignore schema.table.column after checking)

With --fix-dump the COPY blocks of auth/storage tables are rewritten: hosted-only
columns are removed from the column list and from every data row (COPY text
format: rows split on literal TAB only; ``\\t`` escapes and ``\\N`` are left
alone), and COPY blocks for hosted-only tables are dropped entirely (an empty
block for a missing table still fails the restore). Exit 1 if any FAIL remains.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import CopyBlock, TextLine, load_rows, parse_dump, read_lines, write_lines  # noqa: E402

COLS_HEADER = ["table_schema", "table_name", "column_name", "data_type", "is_nullable", "column_default", "ordinal_position"]
CONS_HEADER = ["table_schema", "table_name", "kind", "name", "detail"]
SERVICE_SCHEMAS = ("auth", "storage")


def index_columns(rows: list[dict[str, str]]) -> dict[str, dict[str, dict[str, str]]]:
    """{schema.table: {column: row}}"""
    out: dict[str, dict[str, dict[str, str]]] = defaultdict(dict)
    for r in rows:
        t = f"{r['table_schema']}.{r['table_name']}"
        out[t][r["column_name"]] = r
    return dict(out)


def index_constraints(rows: list[dict[str, str]]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        out[f"{r['table_schema']}.{r['table_name']}"].add(f"{r['kind']}:{r['name']}")
    return dict(out)


def _is_truthy_nullable(v: str) -> bool:
    return v.strip().upper() in ("YES", "TRUE", "T", "1")


def compare(hosted: dict, selfhost: dict, ignore: set[str] | None = None) -> list[dict]:
    """Return findings: {level, kind, table, column, detail}."""
    ignore = ignore or set()
    findings: list[dict] = []
    tables = sorted(set(hosted) | set(selfhost))
    for t in tables:
        h = hosted.get(t)
        s = selfhost.get(t)
        if h is None:
            findings.append({"level": "INFO", "kind": "table_only_selfhost", "table": t, "column": "", "detail": ""})
            continue
        if s is None:
            findings.append({"level": "WARN", "kind": "table_only_hosted", "table": t, "column": "",
                             "detail": "COPY would fail; exclude with -x or --fix-dump drops the block"})
            continue
        for c in sorted(set(h) | set(s)):
            key = f"{t}.{c}"
            hc = h.get(c)
            sc = s.get(c)
            if hc is not None and sc is None:
                lvl = "ignored" if key in ignore else "FAIL"
                findings.append({"level": lvl, "kind": "column_only_hosted", "table": t, "column": c,
                                 "detail": f"{hc['data_type']}; COPY will fail — --fix-dump removes it"})
            elif hc is None and sc is not None:
                nullable = _is_truthy_nullable(sc.get("is_nullable", ""))
                has_default = bool((sc.get("column_default") or "").strip())
                if nullable or has_default:
                    lvl = "ok"
                    why = "nullable" if nullable else "has default"
                else:
                    lvl = "ignored" if key in ignore else "FAIL"
                    why = "NOT NULL without default — COPY of hosted rows will fail"
                findings.append({"level": lvl, "kind": "column_only_selfhost", "table": t, "column": c,
                                 "detail": f"{sc['data_type']}; {why}"})
            else:
                if hc["data_type"].strip() != sc["data_type"].strip():
                    lvl = "ignored" if key in ignore else "FAIL"
                    findings.append({"level": lvl, "kind": "type_mismatch", "table": t, "column": c,
                                     "detail": f"hosted {hc['data_type']} vs selfhost {sc['data_type']}"})
    return findings


def compare_constraints(hosted: dict[str, set[str]], selfhost: dict[str, set[str]]) -> list[dict]:
    findings: list[dict] = []
    for t in sorted(set(hosted) | set(selfhost)):
        h = hosted.get(t, set())
        s = selfhost.get(t, set())
        for n in sorted(h - s):
            findings.append({"level": "INFO", "kind": "constraint_only_hosted", "table": t, "column": n, "detail": ""})
        for n in sorted(s - h):
            findings.append({"level": "INFO", "kind": "constraint_only_selfhost", "table": t, "column": n, "detail": ""})
    return findings


def hosted_only_columns(findings: list[dict]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for f in findings:
        if f["kind"] == "column_only_hosted":
            out[f["table"]].add(f["column"])
    return dict(out)


def hosted_only_tables(findings: list[dict]) -> set[str]:
    return {f["table"] for f in findings if f["kind"] == "table_only_hosted"}


def strip_columns(block: CopyBlock, drop: set[str]) -> tuple[CopyBlock, int]:
    """Return a new block without the `drop` columns; second value = rows rewritten."""
    keep_idx = [i for i, c in enumerate(block.columns) if c not in drop]
    if len(keep_idx) == len(block.columns):
        return block, 0
    new_cols = [block.columns[i] for i in keep_idx]
    new_rows: list[str] = []
    for ln in block.data_lines:
        fields = ln.split("\t")  # COPY text: real tabs are escaped as \t, so a literal TAB is always a separator
        if len(fields) != len(block.columns):
            raise ValueError(
                f"{block.qualified}: row has {len(fields)} fields, header has {len(block.columns)} "
                f"(row starts {ln[:40]!r})"
            )
        new_rows.append("\t".join(fields[i] for i in keep_idx))
    nb = CopyBlock(block.schema, block.table, new_cols, block.header_line, new_rows, block.start_lineno, block.terminated)
    return nb, len(new_rows)


def fix_dump(lines: list[str], drop_cols: dict[str, set[str]], drop_tables: set[str]) -> tuple[list[str], list[dict]]:
    out: list[str] = []
    actions: list[dict] = []
    for seg in parse_dump(lines):
        if isinstance(seg, TextLine):
            out.append(seg.text)
            continue
        block: CopyBlock = seg
        if block.schema not in SERVICE_SCHEMAS:
            out.extend(block.render())
            continue
        if block.qualified in drop_tables:
            actions.append({"table": block.qualified, "action": "dropped_block", "rows": len(block.data_lines)})
            continue
        drop = drop_cols.get(block.qualified, set()) & set(block.columns)
        if drop:
            nb, n = strip_columns(block, drop)
            actions.append({"table": block.qualified, "action": "removed_columns", "columns": sorted(drop), "rows": n})
            out.extend(nb.render())
        else:
            out.extend(block.render())
    return out, actions


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hosted", required=True, help="columns inventory from hosted")
    ap.add_argument("--selfhost", required=True, help="columns inventory from self-hosted")
    ap.add_argument("--constraints-hosted")
    ap.add_argument("--constraints-selfhost")
    ap.add_argument("--ignore", action="append", default=[], metavar="SCHEMA.TABLE.COLUMN",
                    help="downgrade a FAIL on this column to 'ignored'")
    ap.add_argument("--fix-dump", metavar="DATA_SQL", help="rewrite auth/storage COPY blocks of this dump")
    ap.add_argument("--out", help="output for --fix-dump (default: <dump>.fixed.sql)")
    ap.add_argument("--quiet", action="store_true", help="hide INFO/ok rows")
    args = ap.parse_args(argv)

    hosted = index_columns(load_rows(args.hosted, default_header=COLS_HEADER))
    selfhost = index_columns(load_rows(args.selfhost, default_header=COLS_HEADER))
    if not hosted or not selfhost:
        print("error: an inventory is empty", file=sys.stderr)
        return 1
    findings = compare(hosted, selfhost, set(args.ignore))
    if args.constraints_hosted and args.constraints_selfhost:
        findings += compare_constraints(
            index_constraints(load_rows(args.constraints_hosted, default_header=CONS_HEADER)),
            index_constraints(load_rows(args.constraints_selfhost, default_header=CONS_HEADER)),
        )

    print(f"{'level':<7} {'kind':<24} {'table':<32} {'column':<28} detail")
    for f in findings:
        if args.quiet and f["level"] in ("INFO", "ok"):
            continue
        print(f"{f['level']:<7} {f['kind']:<24} {f['table']:<32} {f['column']:<28} {f['detail']}")

    fails = [f for f in findings if f["level"] == "FAIL"]
    fixed_kinds: set[str] = set()

    if args.fix_dump:
        out_path = args.out or (os.path.splitext(args.fix_dump)[0] + ".fixed.sql")
        lines = read_lines(args.fix_dump)
        try:
            out, actions = fix_dump(lines, hosted_only_columns(findings), hosted_only_tables(findings))
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        n = write_lines(out_path, out)
        print(f"\n--fix-dump: {len(actions)} block(s) changed -> {out_path} ({n} bytes)")
        for a in actions:
            if a["action"] == "dropped_block":
                print(f"  dropped COPY block {a['table']} ({a['rows']} rows) — table absent on self-hosted")
            else:
                print(f"  removed column(s) {', '.join(a['columns'])} from {a['table']} ({a['rows']} rows rewritten)")
        if not actions:
            print("  (nothing to change)")
        fixed_kinds = {"column_only_hosted"}
        # hosted-only columns are resolved by the fix; everything else still counts
        fails = [f for f in fails if f["kind"] not in fixed_kinds]

    n_warn = sum(1 for f in findings if f["level"] == "WARN")
    print(f"\n{len(findings)} finding(s): {len(fails)} FAIL, {n_warn} WARN"
          + (" (hosted-only columns resolved by --fix-dump)" if fixed_kinds else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
