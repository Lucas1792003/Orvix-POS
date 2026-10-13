#!/usr/bin/env python3
"""Render sql/recreate_cron.sql.template into a 0600 file.

    SERVICE_ROLE_KEY='<new self-hosted service-role JWT>' \\
    render_cron.py --out /path/recreate_cron.sql [--functions-base-url http://api-gw:8000/functions/v1]
                   [--template sql/recreate_cron.sql.template]

The key is read ONLY from the environment (SERVICE_ROLE_KEY, fallback
SB_SERVICE_KEY) — never from argv, never printed. The output file is created
with mode 0600 and an existing file is replaced atomically.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import JWT_RE  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE = os.path.join(HERE, "sql", "recreate_cron.sql.template")
DEFAULT_FUNCTIONS_BASE_URL = "http://api-gw:8000/functions/v1"
PLACEHOLDER_RE = re.compile(r"\{\{([A-Z_]+)\}\}")


def render(template: str, functions_base_url: str, service_role_key: str) -> str:
    if not service_role_key:
        raise ValueError("service role key is empty")
    if "\n" in service_role_key or "'" in service_role_key or "$$" in service_role_key:
        raise ValueError("service role key contains characters that would break the SQL literal")
    values = {
        "FUNCTIONS_BASE_URL": functions_base_url.rstrip("/"),
        "SERVICE_ROLE_KEY": service_role_key,
    }
    unknown = sorted(set(PLACEHOLDER_RE.findall(template)) - set(values))
    if unknown:
        raise ValueError(f"template has unknown placeholder(s): {unknown}")
    return PLACEHOLDER_RE.sub(lambda m: values[m.group(1)], template)


def write_0600(path: str, content: str) -> None:
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".render_cron.", dir=d)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output path (created 0600)")
    ap.add_argument("--functions-base-url", default=DEFAULT_FUNCTIONS_BASE_URL)
    ap.add_argument("--template", default=DEFAULT_TEMPLATE)
    ap.add_argument("--allow-non-jwt", action="store_true", help="do not insist that the key looks like a JWT")
    args = ap.parse_args(argv)

    key = os.environ.get("SERVICE_ROLE_KEY") or os.environ.get("SB_SERVICE_KEY") or ""
    if not key:
        print("error: SERVICE_ROLE_KEY (or SB_SERVICE_KEY) is not set in the environment", file=sys.stderr)
        return 1
    if not args.allow_non_jwt and not JWT_RE.fullmatch(key.strip()):
        print("error: the key in SERVICE_ROLE_KEY does not look like a JWT (use --allow-non-jwt to override)",
              file=sys.stderr)
        return 1

    with open(args.template, encoding="utf-8") as fh:
        template = fh.read()
    try:
        content = render(template, args.functions_base_url, key.strip())
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    write_0600(args.out, content)
    n_jobs = content.count("cron.schedule(")
    print(f"rendered {n_jobs} cron.schedule statement(s) for {args.functions_base_url} -> {args.out} (mode 0600)")
    print("reminder: copy into the db container, run, then delete both copies.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
