#!/usr/bin/env python3
"""Verify re-uploaded storage objects through their PUBLIC URLs.

    verify_objects.py MANIFEST BASE_URL [--bucket product-images] [--dir LOCAL_DIR]
                      [--objects storage-objects.json] [--threads 4] [--report verify-report.json]
    verify_objects.py --make-manifest LOCAL_DIR [--out storage-manifest.sha256]

MANIFEST has ``<hash>  <path>`` lines as written by sha256sum / md5sum (hash
type is detected by length: 64 = sha256, 32 = md5). A leading ``<bucket>/`` on
the path is stripped, so both ``find product-images -type f -exec md5sum {} +``
output and --make-manifest output work. Each object is fetched from
``{BASE}/storage/v1/object/public/{bucket}/{name}``; the hash and the size
(against --dir file size, --objects metadata size, or Content-Length) are
compared. Prints ``N/N ok`` and exits 1 otherwise.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import load_rows  # noqa: E402


def public_url(base: str, bucket: str, name: str) -> str:
    return f"{base.rstrip('/')}/storage/v1/object/public/{urllib.parse.quote(bucket, safe='')}/{urllib.parse.quote(name, safe='/')}"


def parse_manifest(path: str) -> list[tuple[str, str, str]]:
    """Return [(algo, hexdigest, path)] from sha256sum/md5sum-style lines."""
    out: list[tuple[str, str, str]] = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip() or line.startswith("#"):
                continue
            # "<hash>  <path>" or "<hash> *<path>" (binary mode)
            parts = line.split(None, 1)
            if len(parts) != 2:
                raise ValueError(f"bad manifest line: {line!r}")
            digest, p = parts
            p = p.lstrip("*").strip()
            if len(digest) == 64:
                algo = "sha256"
            elif len(digest) == 32:
                algo = "md5"
            else:
                raise ValueError(f"unrecognised hash length in: {line!r}")
            out.append((algo, digest.lower(), p))
    return out


def object_name(p: str, bucket: str) -> str:
    p = p.replace(os.sep, "/")
    while p.startswith("./"):
        p = p[2:]
    if p.startswith(bucket + "/"):
        p = p[len(bucket) + 1:]
    return p


def make_manifest(dir_: str) -> list[str]:
    lines: list[str] = []
    for root, _dirs, files in os.walk(dir_):
        for f in files:
            fp = os.path.join(root, f)
            rel = os.path.relpath(fp, dir_).replace(os.sep, "/")
            h = hashlib.sha256()
            with open(fp, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 16), b""):
                    h.update(chunk)
            lines.append(f"{h.hexdigest()}  {rel}")
    lines.sort(key=lambda s: s.split("  ", 1)[1])
    return lines


def fetch(url: str, timeout: float = 60.0, opener=None) -> tuple[int, bytes, int | None]:
    opener = opener or urllib.request.build_opener()
    req = urllib.request.Request(url, method="GET")
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read()
            cl = resp.headers.get("Content-Length")
            return resp.status, body, int(cl) if cl is not None else None
    except urllib.error.HTTPError as e:
        e.close()
        return e.code, b"", None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", nargs="?")
    ap.add_argument("base_url", nargs="?")
    ap.add_argument("--bucket", default="product-images")
    ap.add_argument("--dir", help="local dir; file sizes are compared with the fetched size")
    ap.add_argument("--objects", help="storage-objects.json; metadata sizes are compared with the fetched size")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--report", default="verify-report.json")
    ap.add_argument("--make-manifest", metavar="LOCAL_DIR", help="write a sha256 manifest of LOCAL_DIR and exit")
    ap.add_argument("--out", default="storage-manifest.sha256", help="output for --make-manifest")
    args = ap.parse_args(argv)

    if args.make_manifest:
        lines = make_manifest(args.make_manifest)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + ("\n" if lines else ""))
        print(f"wrote {len(lines)} sha256 line(s) -> {args.out}")
        return 0

    if not args.manifest or not args.base_url:
        ap.error("MANIFEST and BASE_URL are required (or use --make-manifest)")

    entries = parse_manifest(args.manifest)
    if not entries:
        print("error: empty manifest", file=sys.stderr)
        return 1

    expected_size: dict[str, int] = {}
    if args.objects:
        for r in load_rows(args.objects, default_header=["name", "mime", "size", "cc"]):
            if r.get("name") and str(r.get("size", "")).isdigit():
                expected_size[r["name"]] = int(r["size"])

    def check(entry: tuple[str, str, str]) -> dict:
        algo, digest, p = entry
        name = object_name(p, args.bucket)
        url = public_url(args.base_url, args.bucket, name)
        try:
            status, body, cl = fetch(url, timeout=args.timeout)
        except (urllib.error.URLError, OSError) as e:
            return {"name": name, "ok": False, "error": f"{type(e).__name__}: {e}"}
        if status != 200:
            return {"name": name, "ok": False, "error": f"HTTP {status}"}
        got = hashlib.new(algo, body).hexdigest()
        problems: list[str] = []
        if got != digest:
            problems.append(f"{algo} mismatch")
        if cl is not None and cl != len(body):
            problems.append(f"Content-Length {cl} != body {len(body)}")
        if args.dir:
            lp = os.path.join(args.dir, *name.split("/"))
            if os.path.isfile(lp) and os.path.getsize(lp) != len(body):
                problems.append(f"local size {os.path.getsize(lp)} != fetched {len(body)}")
        if name in expected_size and expected_size[name] != len(body):
            problems.append(f"metadata size {expected_size[name]} != fetched {len(body)}")
        return {"name": name, "ok": not problems, "size": len(body), "error": "; ".join(problems)}

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, args.threads)) as ex:
        for fut in as_completed([ex.submit(check, e) for e in entries]):
            results.append(fut.result())
    results.sort(key=lambda r: r["name"])
    ok = sum(1 for r in results if r["ok"])
    for r in results:
        if not r["ok"]:
            print(f"FAIL {r['name']}: {r['error']}")
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump({"base_url": args.base_url, "bucket": args.bucket, "ok": ok, "total": len(results), "results": results}, fh, indent=2)
    print(f"{ok}/{len(results)} ok")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
