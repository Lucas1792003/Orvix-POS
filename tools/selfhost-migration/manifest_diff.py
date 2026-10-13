#!/usr/bin/env python3
"""Compare two manifest.sql outputs (hosted vs self-hosted).

    manifest_diff.py manifest-hosted.json manifest-selfhost.txt
                     [--ignore object=storage.objects] [--ignore object=public.functions,metric=anon_executable]
                     [--ignore 'object=cron.*'] [--all]

Inputs may be the CLI JSON shape ``{"rows":[{"object":..,"metric":..,"value":..}]}``
or ``psql -A -F '|' [-t]`` output (``object|metric|value``).

Prints a table of differences (and, with --all, every row) and exits 1 on any
mismatch that is not covered by an --ignore rule. An --ignore rule is a comma
separated list of ``object=GLOB`` and/or ``metric=GLOB`` conditions that must
all match.
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import load_rows  # noqa: E402

HEADER = ["object", "metric", "value"]


def parse_ignore(rule: str) -> dict[str, str]:
    conds: dict[str, str] = {}
    for part in rule.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"bad --ignore condition {part!r} (want object=... or metric=...)")
        k, v = part.split("=", 1)
        k = k.strip()
        if k not in ("object", "metric"):
            raise ValueError(f"bad --ignore key {k!r}")
        conds[k] = v.strip()
    if not conds:
        raise ValueError("empty --ignore rule")
    return conds


def is_ignored(obj: str, metric: str, rules: list[dict[str, str]]) -> bool:
    for r in rules:
        ok = True
        if "object" in r and not fnmatch.fnmatchcase(obj, r["object"]):
            ok = False
        if "metric" in r and not fnmatch.fnmatchcase(metric, r["metric"]):
            ok = False
        if ok:
            return True
    return False


def to_map(rows: list[dict[str, str]]) -> dict[tuple[str, str], str]:
    m: dict[tuple[str, str], str] = {}
    for r in rows:
        key = (r.get("object", "").strip(), r.get("metric", "").strip())
        m[key] = r.get("value", "").strip()
    return m


def diff(left: dict, right: dict, rules: list[dict[str, str]]):
    """Yield (object, metric, left_value, right_value, status)."""
    keys = sorted(set(left) | set(right))
    for obj, metric in keys:
        lv = left.get((obj, metric))
        rv = right.get((obj, metric))
        if lv is None:
            status = "MISSING_LEFT"
        elif rv is None:
            status = "MISSING_RIGHT"
        elif lv == rv:
            status = "ok"
        else:
            status = "MISMATCH"
        if status != "ok" and is_ignored(obj, metric, rules):
            status = "ignored"
        yield obj, metric, "" if lv is None else lv, "" if rv is None else rv, status


def _short(v: str, n: int = 36) -> str:
    return v if len(v) <= n else v[: n - 1] + "…"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("left", help="manifest output A (e.g. hosted JSON)")
    ap.add_argument("right", help="manifest output B (e.g. self-hosted psql output)")
    ap.add_argument("--ignore", action="append", default=[], help="object=GLOB[,metric=GLOB] (repeatable)")
    ap.add_argument("--all", action="store_true", help="print matching rows too")
    ap.add_argument("--left-name", default="left")
    ap.add_argument("--right-name", default="right")
    args = ap.parse_args(argv)

    rules = [parse_ignore(r) for r in args.ignore]
    left = to_map(load_rows(args.left, default_header=HEADER))
    right = to_map(load_rows(args.right, default_header=HEADER))
    if not left or not right:
        print("error: one of the inputs has no rows", file=sys.stderr)
        return 1

    rows = list(diff(left, right, rules))
    bad = [r for r in rows if r[4] not in ("ok", "ignored")]
    ignored = [r for r in rows if r[4] == "ignored"]
    shown = rows if args.all else [r for r in rows if r[4] != "ok"]

    w_obj = max([len("object")] + [len(r[0]) for r in shown]) if shown else 6
    w_met = max([len("metric")] + [len(r[1]) for r in shown]) if shown else 6
    print(f"{'object':<{w_obj}}  {'metric':<{w_met}}  {args.left_name:<36}  {args.right_name:<36}  status")
    for obj, metric, lv, rv, status in shown:
        print(f"{obj:<{w_obj}}  {metric:<{w_met}}  {_short(lv):<36}  {_short(rv):<36}  {status}")
    print(
        f"\n{len(rows)} metric(s) compared: {len(rows) - len(bad) - len(ignored)} equal, "
        f"{len(ignored)} ignored, {len(bad)} different"
    )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
