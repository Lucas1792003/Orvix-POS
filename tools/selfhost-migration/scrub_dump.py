#!/usr/bin/env python3
"""Scrub a `supabase db dump --data-only --use-copy` file before it leaves the Mac.

    scrub_dump.py data.sql [--out data.scrubbed.sql] [--cron-out cron-job.redacted.txt]
                  [--drop schema.table ...] [--drop-list file] [--no-default-drops]
                  [--report scrub-report.json]
    scrub_dump.py --roles roles.sql [--roles-out roles.scrubbed.sql]
    scrub_dump.py --schema schema.sql [--schema-out schema.scrubbed.sql]

What it does to data.sql:
  a) the whole ``COPY "cron"."job" (...) FROM stdin; ... \\.`` block is removed
     from the output and written, with JWTs replaced by <REDACTED_JWT>, to
     --cron-out (default cron-job.redacted.txt next to the output);
  b) COPY blocks for the tables in the drop list are removed (default list =
     docs/05 §3.2 exclusions + hosted-only auth tables that do not exist on the
     self-hosted GoTrue; fnmatch globs allowed, e.g. storage.s3_multipart_uploads*);
  c) any REMAINING line containing a JWT-shaped token, ``tskey-``, ``sk_live`` or
     a Resend key (``re_`` + 20 alnum) is a hard stop: exit 2, nothing written;
  d) ``SET transaction_timeout …`` lines are commented out;
  e) with --roles, lines referencing ``cli_login_postgres`` are removed;
  f) counts of blocks kept / dropped and bytes in / out are printed and written
     to the JSON report.

A COPY block is terminated ONLY by a line that is exactly ``\\.``; data lines
starting with ``--`` or containing backslashes are never treated as SQL.

Exit codes: 0 ok · 1 usage/IO error · 2 secrets remain in the output.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    JWT_RE,
    SCRUB_HARD_FAIL_PATTERNS,
    CopyBlock,
    TextLine,
    find_secrets,
    glob_match,
    parse_dump,
    read_lines,
    write_lines,
)

CRON_JOB = "cron.job"

#: docs/05 §3.2 ``-x`` list (kept here too, in case the dump was taken without -x)
#: + storage tables that exist only on hosted + hosted-only auth tables that do
#: not exist on self-hosted GoTrue v2.196.0 (an empty COPY block for a missing
#: table still fails the restore).
DEFAULT_DROPS: list[str] = [
    "cron.job_run_details",
    "net._http_response",
    "net.http_request_queue",
    "storage.objects",
    "storage.buckets",
    "storage.s3_multipart_uploads*",
    "storage.buckets_analytics",
    "storage.buckets_vectors",
    "storage.vector_indexes",
    "auth.audit_log_entries",
    "auth.flow_state",
    "auth.one_time_tokens",
    "auth.mfa_challenges",
    # hosted-only auth tables (verified 2026-10-11 against self-hosted GoTrue v2.196.0)
    "auth.mfa_recovery_code_sets",
    "auth.mfa_recovery_codes",
    "auth.scim_tokens",
    "auth.scim_users",
]

TRANSACTION_TIMEOUT_RE = re.compile(r"^\s*SET\s+transaction_timeout\b", re.IGNORECASE)
PG_NET_PUBLIC_RE = re.compile(r'CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"?pg_net"?\s+WITH\s+SCHEMA\s+"?public"?', re.I)
CLI_LOGIN_ROLE = "cli_login_postgres"


def redact_jwts(text: str) -> str:
    return JWT_RE.sub("<REDACTED_JWT>", text)


def scrub_data(lines: list[str], drops: list[str]) -> tuple[list[str], dict, list[str] | None]:
    """Return (output_lines, report, redacted_cron_lines_or_None)."""
    out: list[str] = []
    report: dict = {
        "blocks_kept": [],
        "blocks_dropped": [],
        "cron_job_block": None,
        "transaction_timeout_lines_commented": [],
        "unterminated_block": None,
        "secrets_remaining": [],
    }
    cron_lines: list[str] | None = None

    for seg in parse_dump(lines):
        if isinstance(seg, TextLine):
            text = seg.text
            if TRANSACTION_TIMEOUT_RE.match(text):
                report["transaction_timeout_lines_commented"].append(seg.lineno)
                text = "-- " + text + "   -- commented out by scrub_dump.py"
            out.append(text)
            continue

        block: CopyBlock = seg
        if not block.terminated:
            report["unterminated_block"] = {"table": block.qualified, "line": block.start_lineno}
        name = block.qualified
        entry = {"table": name, "rows": len(block.data_lines), "line": block.start_lineno}
        if name == CRON_JOB:
            cron_lines = [redact_jwts(block.header_line)] + [redact_jwts(ln) for ln in block.data_lines] + ["\\."]
            entry["reason"] = "cron.job redacted copy written to --cron-out; not re-created (jobs retired 2026-10-13)"
            report["cron_job_block"] = entry
            report["blocks_dropped"].append(entry)
            continue
        matched = next((p for p in drops if glob_match(name, p)), None)
        if matched is not None:
            entry["reason"] = f"drop list ({matched})"
            report["blocks_dropped"].append(entry)
            continue
        report["blocks_kept"].append(entry)
        out.extend(block.render())

    # c) hard-stop scan of what would be written
    for i, ln in enumerate(out, start=1):
        hits = find_secrets(ln, SCRUB_HARD_FAIL_PATTERNS)
        if hits:
            report["secrets_remaining"].append({"output_line": i, "hits": [f"{n}:{m}" for n, m in hits]})

    return out, report, cron_lines


def scrub_roles(lines: list[str]) -> tuple[list[str], list[int]]:
    out: list[str] = []
    removed: list[int] = []
    for i, ln in enumerate(lines, start=1):
        if CLI_LOGIN_ROLE in ln:
            removed.append(i)
            continue
        out.append(ln)
    return out, removed


def scrub_schema(lines: list[str]) -> tuple[list[str], dict]:
    out: list[str] = []
    rep = {"transaction_timeout_lines_commented": [], "pg_net_in_public_lines": []}
    for i, ln in enumerate(lines, start=1):
        if TRANSACTION_TIMEOUT_RE.match(ln):
            rep["transaction_timeout_lines_commented"].append(i)
            ln = "-- " + ln + "   -- commented out by scrub_dump.py"
        if PG_NET_PUBLIC_RE.search(ln):
            rep["pg_net_in_public_lines"].append(i)
        out.append(ln)
    return out, rep


def _default_out(path: str, suffix: str = ".scrubbed") -> str:
    stem, ext = os.path.splitext(path)
    return f"{stem}{suffix}{ext or '.sql'}"


def _load_drop_list(path: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        return [ln.split("#", 1)[0].strip() for ln in fh if ln.split("#", 1)[0].strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data", nargs="?", help="data.sql from `supabase db dump --data-only --use-copy`")
    ap.add_argument("--out", help="scrubbed output (default: <data>.scrubbed.sql)")
    ap.add_argument("--cron-out", help="redacted cron.job COPY block (default: cron-job.redacted.txt next to --out)")
    ap.add_argument("--drop", action="append", default=[], metavar="SCHEMA.TABLE", help="extra table/glob to drop")
    ap.add_argument("--drop-list", help="file with one schema.table (or glob) per line")
    ap.add_argument("--no-default-drops", action="store_true", help="only use --drop/--drop-list")
    ap.add_argument("--report", help="JSON report path (default: <out>.report.json)")
    ap.add_argument("--roles", help="roles.sql to scrub (removes cli_login_postgres lines)")
    ap.add_argument("--roles-out", help="default: <roles>.scrubbed.sql")
    ap.add_argument("--schema", help="schema.sql to scrub (comments out SET transaction_timeout; reports pg_net in public)")
    ap.add_argument("--schema-out", help="default: <schema>.scrubbed.sql")
    args = ap.parse_args(argv)

    if not (args.data or args.roles or args.schema):
        ap.error("give a data.sql, --roles roles.sql and/or --schema schema.sql")

    rc = 0
    report: dict = {}

    if args.roles:
        lines = read_lines(args.roles)
        out, removed = scrub_roles(lines)
        roles_out = args.roles_out or _default_out(args.roles)
        n = write_lines(roles_out, out)
        report["roles"] = {"in": args.roles, "out": roles_out, "lines_removed": removed, "bytes_out": n}
        print(f"roles: removed {len(removed)} line(s) referencing {CLI_LOGIN_ROLE} -> {roles_out}")
        for ln in removed:
            print(f"  line {ln}")

    if args.schema:
        lines = read_lines(args.schema)
        out, rep = scrub_schema(lines)
        schema_out = args.schema_out or _default_out(args.schema)
        n = write_lines(schema_out, out)
        rep.update({"in": args.schema, "out": schema_out, "bytes_out": n})
        report["schema"] = rep
        print(
            f"schema: commented {len(rep['transaction_timeout_lines_commented'])} SET transaction_timeout line(s)"
            f" -> {schema_out}"
        )
        if rep["pg_net_in_public_lines"]:
            print(
                f"schema: NOTE pg_net is created WITH SCHEMA public at line(s) {rep['pg_net_in_public_lines']}"
                " (left as is; see docs/05 §4.2)"
            )

    if args.data:
        drops = [] if args.no_default_drops else list(DEFAULT_DROPS)
        if args.drop_list:
            drops += _load_drop_list(args.drop_list)
        drops += args.drop
        data_out = args.out or _default_out(args.data)
        cron_out = args.cron_out or os.path.join(os.path.dirname(os.path.abspath(data_out)), "cron-job.redacted.txt")
        report_path = args.report or (data_out + ".report.json")

        lines = read_lines(args.data)
        bytes_in = os.path.getsize(args.data)
        out, rep, cron_lines = scrub_data(lines, drops)
        rep.update({"in": args.data, "out": data_out, "bytes_in": bytes_in, "drop_patterns": drops})

        kept_rows = sum(b["rows"] for b in rep["blocks_kept"])
        dropped_rows = sum(b["rows"] for b in rep["blocks_dropped"])
        print(f"data: {len(rep['blocks_kept'])} COPY block(s) kept ({kept_rows} rows), "
              f"{len(rep['blocks_dropped'])} dropped ({dropped_rows} rows)")
        for b in rep["blocks_dropped"]:
            print(f"  dropped {b['table']:40} {b['rows']:>7} rows  (line {b['line']}; {b['reason']})")
        if rep["transaction_timeout_lines_commented"]:
            print(f"data: commented out SET transaction_timeout at line(s) {rep['transaction_timeout_lines_commented']}")
        if rep["unterminated_block"]:
            print(f"data: WARNING unterminated COPY block {rep['unterminated_block']} — dump truncated?")
            rc = 1

        if rep["secrets_remaining"]:
            print(f"data: HARD STOP — {len(rep['secrets_remaining'])} output line(s) still contain secret-shaped tokens:")
            for s in rep["secrets_remaining"]:
                print(f"  output line {s['output_line']}: {', '.join(s['hits'])}")
            print("  nothing written. Exclude/inspect the offending table or line and re-run.")
            rep["bytes_out"] = 0
            rc = 2
        else:
            n = write_lines(data_out, out)
            rep["bytes_out"] = n
            if cron_lines is not None:
                write_lines(cron_out, cron_lines)
                rep["cron_out"] = cron_out
                print(f"data: cron.job block ({rep['cron_job_block']['rows']} rows) redacted -> {cron_out}")
            else:
                print("data: no cron.job block found (fine if dumped with -x cron.job)")
            print(f"data: {bytes_in} bytes in -> {n} bytes out -> {data_out}")

        report["data"] = rep
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"report -> {report_path}")

    return rc


if __name__ == "__main__":
    sys.exit(main())
