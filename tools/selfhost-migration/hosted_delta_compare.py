#!/usr/bin/env python3
"""Compare the owner's pasted hosted-delta.sql output with the export manifest.

    hosted_delta_compare.py PASTED [--manifest MANIFEST] [--json]

PASTED    the text the owner copied from the hosted SQL editor after running
          tools/selfhost-migration/hosted-delta.sql: the JSON cell itself, or the
          editor's "copy as JSON" / CSV export of the one-row result. Surrounding
          text is ignored.
MANIFEST  the export manifest (manifest.sql output, CLI JSON or psql '|' text).
          Default: ~/shwephala-migration/20261011T2347Z/manifest-hosted.json
          (read-only; only its count / checksum / max_created_at rows are used).

Per table it prints NO-CHANGE or CHANGED (+n since cutoff, ...), then a verdict:
  exit 0  OK to cut over: no table differs from the export
  exit 1  CHANGED: hosted has data the export does not -> needs a delta migration plan
  exit 2  input problem (not the expected output, truncated, not read-only, ...)

Nothing here connects anywhere. Stdlib only. It prints table names, counts and
timestamps; the input carries nothing else.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from _common import load_rows  # noqa: E402

DEFAULT_MANIFEST = os.path.expanduser("~/shwephala-migration/20261011T2347Z/manifest-hosted.json")
KIND = "shwephala-hosted-delta"
CUTOFF = "2026-10-11T23:47:00Z"
# tables of the export (sql/tables.default.txt) that hosted-delta.sql reports on
SCOPE_SCHEMAS = ("public.",)
SCOPE_EXTRA = ("auth.users", "auth.identities", "auth.mfa_factors", "storage.buckets", "storage.objects")


class InputError(Exception):
    pass


def _try_json(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return None


def _unwrap(obj):
    """Find the delta object inside what the editor exported."""
    if isinstance(obj, dict):
        if obj.get("kind") == KIND:
            return obj
        for v in obj.values():
            found = _unwrap(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _unwrap(v)
            if found is not None:
                return found
    elif isinstance(obj, str) and KIND in obj:
        inner = _try_json(obj.strip())
        if inner is not None:
            return _unwrap(inner)
    return None


def parse_pasted(text: str) -> dict:
    """Return the delta object from any of the shapes an owner may paste."""
    text = text.strip().lstrip("﻿")
    if KIND not in text:
        raise InputError("this is not hosted-delta.sql output (no 'shwephala-hosted-delta' marker)")
    candidates = [text]
    # CSV export: header line + one quoted cell with "" escapes
    try:
        for row in csv.reader(io.StringIO(text)):
            candidates.extend(cell for cell in row if KIND in cell)
    except csv.Error:
        pass
    # bare: first '{' .. last '}' (also with "" escapes undone)
    if "{" in text and "}" in text:
        core = text[text.index("{"): text.rindex("}") + 1]
        candidates.extend([core, core.replace('""', '"')])
    for c in candidates:
        obj = _try_json(c)
        if obj is None:
            continue
        found = _unwrap(obj)
        if found is not None:
            return found
    raise InputError("could not read the JSON (truncated copy?): copy the whole cell again")


def validate(delta: dict) -> list[str]:
    """Problems that make the result unusable (-> exit 2)."""
    problems = []
    if delta.get("v") != 1:
        problems.append(f"unexpected format version {delta.get('v')!r} (want 1)")
    if delta.get("cutoff") != CUTOFF:
        problems.append(f"cutoff {delta.get('cutoff')!r} is not the export time {CUTOFF}")
    tables = delta.get("tables")
    if not isinstance(tables, dict) or not tables:
        problems.append("no tables in the output")
    elif delta.get("n_tables") != len(tables):
        problems.append(f"n_tables {delta.get('n_tables')} != {len(tables)} tables present (truncated copy?)")
    else:
        bad = [k for k, v in tables.items() if not isinstance(v, dict) or not isinstance(v.get("n"), int)]
        if bad:
            problems.append(f"tables without a count: {', '.join(sorted(bad))}")
    return problems


def load_manifest(path: str) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for r in load_rows(path, default_header=["object", "metric", "value"]):
        obj, metric = (r.get("object") or "").strip(), (r.get("metric") or "").strip()
        if metric in ("count", "checksum", "max_created_at"):
            out.setdefault(obj, {})[metric] = (r.get("value") or "").strip()
    if not out:
        raise InputError(f"manifest {path}: no count rows found")
    return out


def in_scope(name: str) -> bool:
    return name.startswith(SCOPE_SCHEMAS) or name in SCOPE_EXTRA


def compare(delta: dict, manifest: dict[str, dict[str, str]]) -> list[dict]:
    """One result per table: name, status (NO-CHANGE|CHANGED|INFO), reasons, numbers."""
    tables: dict[str, dict] = delta["tables"]
    missing = set(delta.get("missing") or [])
    # manifest tables carry a checksum; public.functions / indexes / views are not tables
    names = sorted(set(tables) | {m for m, v in manifest.items() if in_scope(m) and "checksum" in v})
    results = []
    for name in names:
        now = tables.get(name)
        base = manifest.get(name)
        res = {"table": name, "reasons": [], "status": "NO-CHANGE", "since_cutoff": 0}
        if now is None:
            if base is None:
                continue
            res["status"] = "CHANGED"
            res["reasons"].append("table missing on hosted now" if name in missing else "table not in the output")
            results.append(res)
            continue
        n_now = int(now["n"])
        c_after, u_after, o_after = (int(now.get(k, 0) or 0) for k in ("c_after", "u_after", "o_after"))
        res.update(n_now=n_now, c_after=c_after, u_after=u_after, o_after=o_after, since_cutoff=c_after)
        if base is None or "count" not in base:
            if n_now or c_after or u_after or o_after:
                res["status"] = "CHANGED"
                res["reasons"].append(f"table not in the export, {n_now} row(s)")
            else:
                res["status"] = "INFO"
                res["reasons"].append("table not in the export, empty")
            results.append(res)
            continue
        n_then = int(base["count"])
        res["n_export"] = n_then
        ids_then, ids_now = base.get("checksum"), now.get("ids")
        same_ids = bool(ids_then and ids_now and ids_then == ids_now and n_now == n_then)
        if c_after and same_ids:
            # created in the minutes between the cutoff and the end of the export:
            # the id set is identical, so they are in the export
            res["notes"] = [f"{c_after} created after the cutoff but in the export (same ids)"]
            res["since_cutoff"] = 0
        elif c_after:
            res["reasons"].append(f"+{c_after} created since cutoff")
        if n_now != n_then:
            res["reasons"].append(f"count {n_then} -> {n_now} ({n_now - n_then:+d})")
            if "max_c" not in now and n_now > n_then:
                res["since_cutoff"] = n_now - n_then  # no created_at: the count is the only measure
        if u_after:
            res["reasons"].append(f"{u_after} updated since cutoff")
        if o_after:
            res["reasons"].append(f"{o_after} with another timestamp after cutoff")
        if ids_then and ids_now and ids_then != ids_now and n_now == n_then:
            res["reasons"].append("same count but different ids (rows deleted and re-created)")
        mc_then, mc_now = base.get("max_created_at"), now.get("max_c")
        if mc_then is not None and mc_now and mc_now > (mc_then or "") and not c_after:
            res["reasons"].append(f"max(created_at) {mc_then or '-'} -> {mc_now}")
        if res["reasons"]:
            res["status"] = "CHANGED"
        results.append(res)
    return results


def render(delta: dict, results: list[dict], manifest_path: str) -> tuple[str, int]:
    lines = [
        f"hosted delta  ran_at {delta.get('ran_at', '?')}  cutoff {delta.get('cutoff')}  "
        f"read_only {delta.get('read_only', '?')}  pg {delta.get('pg', '?')}",
        f"export manifest: {manifest_path}",
    ]
    mig = delta.get("migrations") or {}
    if mig:
        lines.append(f"hosted migrations: {mig.get('n')} (max {mig.get('max') or '-'})")
    lines.append("")
    w = max(len(r["table"]) for r in results) if results else 10
    for r in results:
        if r["status"] == "CHANGED":
            head = f"CHANGED (+{r['since_cutoff']} since cutoff)"
        else:
            head = r["status"]
        detail = "; ".join(r["reasons"] + r.get("notes", []))
        count = f"{r.get('n_export', '-')}->{r.get('n_now', '-')}" if "n_now" in r else ""
        lines.append(f"{r['table']:<{w}}  {head:<30} {count:<12} {detail}".rstrip())
    changed = [r for r in results if r["status"] == "CHANGED"]
    lines.append("")
    if changed:
        total = sum(r["since_cutoff"] for r in changed)
        lines.append(f"VERDICT: CHANGED - {len(changed)} table(s) differ from the export "
                     f"({total} row(s) created since the cutoff). Needs a delta migration plan "
                     "before cut-over; do not cut over on the 2026-10-11 export alone.")
        rc = 1
    else:
        lines.append(f"VERDICT: NO DELTA - all {len(results)} tables match the export. OK to cut over "
                     "(re-run this check right before the cut-over if time passes).")
        rc = 0
    if delta.get("read_only") != "on":
        lines.append("NOTE: the editor did not report a read-only transaction (read_only != on); the query "
                     "only reads, but say so in the cut-over record.")
    return "\n".join(lines), rc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pasted")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--json", action="store_true", help="machine-readable result")
    a = ap.parse_args(argv)
    try:
        with open(a.pasted, encoding="utf-8") as fh:
            delta = parse_pasted(fh.read())
        problems = validate(delta)
        if problems:
            raise InputError("; ".join(problems))
        manifest = load_manifest(a.manifest)
    except (InputError, OSError, ValueError) as e:
        print(f"hosted_delta_compare: {e}", file=sys.stderr)
        return 2
    results = compare(delta, manifest)
    text, rc = render(delta, results, a.manifest)
    if a.json:
        print(json.dumps({"verdict": "CHANGED" if rc else "NO-DELTA", "tables": results}, indent=1))
    else:
        print(text)
    return rc


if __name__ == "__main__":
    sys.exit(main())
