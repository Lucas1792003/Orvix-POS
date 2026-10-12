#!/usr/bin/env python3
"""Re-upload storage objects by name into the NEW stack's storage API.

    SB_SERVICE_KEY='<new service-role key>' \\
    upload_objects.py LOCAL_DIR storage-objects.json BASE_URL [--bucket product-images]
                      [--threads 4] [--retries 3] [--dry-run] [--only-missing]
                      [--report upload-report.json]

LOCAL_DIR is the directory `supabase storage cp -r` filled (its layout mirrors
object names). storage-objects.json is the hosted metadata export (CLI JSON
``{"rows":[{"name","mime","size","cc"}]}`` or a plain list). Each object is
sent as ``POST {BASE}/storage/v1/object/{bucket}/{name}`` with the original
Content-Type and Cache-Control and ``x-upsert: true``; 5xx / 429 / network
errors are retried with exponential backoff. The key comes from the
environment only and is never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import load_rows  # noqa: E402

OBJ_HEADER = ["name", "mime", "size", "cc"]


def object_url(base: str, bucket: str, name: str) -> str:
    return f"{base.rstrip('/')}/storage/v1/object/{urllib.parse.quote(bucket, safe='')}/{urllib.parse.quote(name, safe='/')}"


def public_url(base: str, bucket: str, name: str) -> str:
    return f"{base.rstrip('/')}/storage/v1/object/public/{urllib.parse.quote(bucket, safe='')}/{urllib.parse.quote(name, safe='/')}"


class Uploader:
    def __init__(self, base: str, bucket: str, key: str, retries: int = 3, backoff: float = 1.0,
                 timeout: float = 60.0, sleep=time.sleep, opener=None):
        self.base = base
        self.bucket = bucket
        self.key = key
        self.retries = retries
        self.backoff = backoff
        self.timeout = timeout
        self.sleep = sleep
        self.opener = opener or urllib.request.build_opener()

    def _request(self, method: str, url: str, data: bytes | None = None, headers: dict | None = None):
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        return self.opener.open(req, timeout=self.timeout)

    def head_public(self, name: str) -> tuple[int, int | None]:
        """(status, content_length) of the public URL; status 0 on network error."""
        try:
            with self._request("HEAD", public_url(self.base, self.bucket, name)) as resp:
                cl = resp.headers.get("Content-Length")
                return resp.status, int(cl) if cl is not None else None
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, None
        except (urllib.error.URLError, OSError):
            return 0, None

    def upload(self, name: str, data: bytes, mime: str, cache_control: str | None) -> dict:
        url = object_url(self.base, self.bucket, name)
        headers = {
            "Authorization": f"Bearer {self.key}",
            "apikey": self.key,
            "Content-Type": mime or "application/octet-stream",
            "x-upsert": "true",
        }
        if cache_control:
            headers["Cache-Control"] = cache_control
        attempts = 0
        last_err = ""
        while attempts <= self.retries:
            attempts += 1
            try:
                with self._request("POST", url, data=data, headers=headers) as resp:
                    return {"name": name, "status": "uploaded", "http": resp.status, "attempts": attempts, "bytes": len(data)}
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read(300).decode("utf-8", "replace")
                except Exception:
                    pass
                finally:
                    e.close()
                last_err = f"HTTP {e.code} {body.strip()}"
                retryable = e.code >= 500 or e.code == 429
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                last_err = f"{type(e).__name__}: {e}"
                retryable = True
            if not retryable or attempts > self.retries:
                break
            self.sleep(self.backoff * (2 ** (attempts - 1)))
        return {"name": name, "status": "failed", "error": last_err, "attempts": attempts, "bytes": len(data)}


def load_objects(path: str) -> list[dict[str, str]]:
    rows = load_rows(path, default_header=OBJ_HEADER)
    out = []
    for r in rows:
        name = r.get("name", "")
        if not name:
            continue
        out.append({
            "name": name,
            "mime": r.get("mime") or r.get("mimetype") or "application/octet-stream",
            "size": r.get("size") or "",
            "cc": r.get("cc") or r.get("cacheControl") or "",
        })
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("local_dir")
    ap.add_argument("objects_json")
    ap.add_argument("base_url")
    ap.add_argument("--bucket", default="product-images")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--backoff", type=float, default=1.0, help="first retry delay in seconds (doubles)")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--dry-run", action="store_true", help="list what would be uploaded; no network calls")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip objects whose public URL already answers 200 with the same size")
    ap.add_argument("--report", default="upload-report.json")
    args = ap.parse_args(argv)

    key = os.environ.get("SB_SERVICE_KEY", "")
    if not key and not args.dry_run:
        print("error: SB_SERVICE_KEY is not set in the environment", file=sys.stderr)
        return 1
    if not args.base_url.startswith(("http://", "https://")):
        print("error: base URL must start with http:// or https://", file=sys.stderr)
        return 1

    objects = load_objects(args.objects_json)
    if not objects:
        print("error: no objects in metadata export", file=sys.stderr)
        return 1

    uploader = Uploader(args.base_url, args.bucket, key, retries=args.retries, backoff=args.backoff, timeout=args.timeout)
    results: list[dict] = []
    lock = threading.Lock()
    todo: list[dict] = []

    for o in objects:
        path = os.path.join(args.local_dir, *o["name"].split("/"))
        if not os.path.isfile(path):
            results.append({"name": o["name"], "status": "skipped", "reason": "local file missing", "path": path})
            continue
        local_size = os.path.getsize(path)
        entry = dict(o, path=path, local_size=local_size)
        if o["size"] and o["size"].isdigit() and int(o["size"]) != local_size:
            entry["size_warning"] = f"metadata size {o['size']} != local {local_size}"
        todo.append(entry)

    if args.dry_run:
        for e in todo:
            warn = f"  WARNING {e['size_warning']}" if e.get("size_warning") else ""
            print(f"would upload {e['name']}  ({e['mime']}, {e['local_size']} B, cc={e['cc'] or '-'}){warn}")
        for r in results:
            print(f"skip {r['name']}: {r['reason']}")
        print(f"dry-run: {len(todo)} to upload, {len(results)} skipped")
        return 0

    def work(e: dict) -> dict:
        if args.only_missing:
            st, cl = uploader.head_public(e["name"])
            if st == 200 and (cl is None or cl == e["local_size"]):
                return {"name": e["name"], "status": "skipped", "reason": "already present"}
        with open(e["path"], "rb") as fh:
            data = fh.read()
        r = uploader.upload(e["name"], data, e["mime"], e["cc"] or None)
        if e.get("size_warning"):
            r["size_warning"] = e["size_warning"]
        return r

    done = 0
    with ThreadPoolExecutor(max_workers=max(1, args.threads)) as ex:
        futs = {ex.submit(work, e): e for e in todo}
        for fut in as_completed(futs):
            r = fut.result()
            with lock:
                results.append(r)
                done += 1
                if r["status"] == "failed":
                    print(f"[{done}/{len(todo)}] FAILED {r['name']}: {r['error']} (after {r['attempts']} attempt(s))")
                elif done % 50 == 0 or done == len(todo):
                    print(f"[{done}/{len(todo)}] …")

    counts = {k: sum(1 for r in results if r["status"] == k) for k in ("uploaded", "skipped", "failed")}
    report = {
        "base_url": args.base_url,
        "bucket": args.bucket,
        "counts": counts,
        "size_warnings": [r for r in results if r.get("size_warning")],
        "results": sorted(results, key=lambda r: r["name"]),
    }
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"uploaded {counts['uploaded']}, skipped {counts['skipped']}, failed {counts['failed']} -> {args.report}")
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
