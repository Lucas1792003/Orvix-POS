#!/usr/bin/env python3
"""Gate: scan files/directories for secret-shaped strings before they move anywhere.

    check_secrets.py PATH [PATH ...] [--exclude GLOB ...] [--max-bytes N]

Patterns: JWT (eyJ….eyJ….…), postgres:// URLs with an embedded password,
Tailscale auth keys, Resend keys (re_…), sb_secret_…, sk_…. Binary files
(NUL in the first 8 KiB) are skipped.
Prints ``file:line: pattern masked`` and exits 1 if anything is found.
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import SECRET_PATTERNS, find_secrets  # noqa: E402

SKIP_DIRS = {".git", "node_modules", "__pycache__"}


def is_binary(path: str, probe: int = 8192) -> bool:
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(probe)
    except OSError:
        return True
    return b"\x00" in chunk


def iter_files(paths: list[str], excludes: list[str]):
    for p in paths:
        if os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for f in sorted(files):
                    fp = os.path.join(root, f)
                    if any(fnmatch.fnmatch(fp, g) or fnmatch.fnmatch(f, g) for g in excludes):
                        continue
                    yield fp
        elif os.path.isfile(p):
            if not any(fnmatch.fnmatch(p, g) or fnmatch.fnmatch(os.path.basename(p), g) for g in excludes):
                yield p
        else:
            print(f"warning: {p}: not found", file=sys.stderr)


def scan_file(path: str, max_bytes: int | None = None) -> list[tuple[int, str, str]]:
    """Return [(lineno, pattern_name, masked), ...]."""
    hits: list[tuple[int, str, str]] = []
    if is_binary(path):
        return hits
    read = 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh, start=1):
            read += len(line)
            if max_bytes is not None and read > max_bytes:
                break
            for name, masked in find_secrets(line, SECRET_PATTERNS):
                hits.append((i, name, masked))
    return hits


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--exclude", action="append", default=[], metavar="GLOB", help="skip matching files (name or path)")
    ap.add_argument("--max-bytes", type=int, default=None, help="only scan the first N bytes of each file")
    ap.add_argument("--quiet", action="store_true", help="only print the summary line")
    args = ap.parse_args(argv)

    total = 0
    files = 0
    for fp in iter_files(args.paths, args.exclude):
        files += 1
        for lineno, name, masked in scan_file(fp, args.max_bytes):
            total += 1
            if not args.quiet:
                print(f"{fp}:{lineno}: {name} {masked}")
    print(f"check_secrets: {files} file(s) scanned, {total} secret-shaped hit(s)")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
