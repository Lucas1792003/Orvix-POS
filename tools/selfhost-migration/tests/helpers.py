"""Test helpers: synthetic fixtures and a tiny in-memory storage API server."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(TESTS_DIR)
FIXTURES = os.path.join(TESTS_DIR, "fixtures")
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)


def fake_jwt(tag: str = "a") -> str:
    """A JWT-shaped string built at runtime (never stored in the repo)."""
    return "eyJ" + tag * 30 + ".eyJ" + "b" * 40 + "." + "c" * 43


def render_data_fixture(dst: str, audit_details: str = '{"note": "plain"}') -> str:
    with open(os.path.join(FIXTURES, "fake_data.sql.in"), encoding="utf-8") as fh:
        text = fh.read()
    text = text.replace("__FAKE_JWT__", fake_jwt()).replace("__AUDIT_DETAILS__", audit_details)
    with open(dst, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return dst


def fixture(name: str) -> str:
    return os.path.join(FIXTURES, name)


def read_text(path: str, encoding: str = "utf-8") -> str:
    with open(path, encoding=encoding) as fh:
        return fh.read()


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def load_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class FakeStorage:
    """In-memory stand-in for the storage API used by upload/verify tests.

    POST /storage/v1/object/{bucket}/{name}   (needs Authorization + apikey)
    GET|HEAD /storage/v1/object/public/{bucket}/{name}
    `fail_first` = names that answer 500 on their first upload attempt.
    `corrupt` = names whose public body is served altered.
    """

    def __init__(self, key: str = "test-service-key"):
        self.key = key
        self.objects: dict[str, dict] = {}
        self.fail_first: set[str] = set()
        self.corrupt: set[str] = set()
        self.attempts: dict[str, int] = {}
        self.lock = threading.Lock()
        store = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a, **k):  # silence
                pass

            def _parts(self):
                return self.path.split("?", 1)[0]

            def do_POST(self):
                path = self._parts()
                prefix = "/storage/v1/object/"
                if not path.startswith(prefix) or path.startswith(prefix + "public/"):
                    self.send_error(404)
                    return
                if self.headers.get("Authorization") != f"Bearer {store.key}" or self.headers.get("apikey") != store.key:
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b'{"message":"bad key"}')
                    return
                bucket, _, name = path[len(prefix):].partition("/")
                name = unquote(name)
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                with store.lock:
                    store.attempts[name] = store.attempts.get(name, 0) + 1
                    if name in store.fail_first and store.attempts[name] == 1:
                        self.send_response(500)
                        self.end_headers()
                        self.wfile.write(b'{"message":"synthetic transient error"}')
                        return
                    store.objects[name] = {
                        "bucket": bucket,
                        "body": body,
                        "content_type": self.headers.get("Content-Type"),
                        "cache_control": self.headers.get("Cache-Control"),
                        "upsert": self.headers.get("x-upsert"),
                    }
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"Key": f"{bucket}/{name}"}).encode())

            def _serve(self, with_body: bool):
                path = self._parts()
                prefix = "/storage/v1/object/public/"
                if not path.startswith(prefix):
                    self.send_error(404)
                    return
                _bucket, _, name = path[len(prefix):].partition("/")
                name = unquote(name)
                with store.lock:
                    obj = store.objects.get(name)
                if obj is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = obj["body"]
                if name in store.corrupt:
                    body = body + b"X"
                self.send_response(200)
                self.send_header("Content-Type", obj["content_type"] or "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                if obj["cache_control"]:
                    self.send_header("Cache-Control", obj["cache_control"])
                self.end_headers()
                if with_body:
                    self.wfile.write(body)

            def do_GET(self):
                self._serve(True)

            def do_HEAD(self):
                self._serve(False)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def make_objects_dir(root: str, bucket: str = "product-images") -> tuple[str, list[dict]]:
    """Create a few synthetic objects under root/<bucket>/..., return (dir, metadata rows)."""
    d = os.path.join(root, bucket)
    rows = []
    samples = [
        ("temp/abc/one.webp", b"RIFF\x00\x00\x00\x00WEBPVP8 fake-one", "image/webp", "max-age=3600"),
        ("temp/abc/two.webp", b"RIFF\x00\x00\x00\x00WEBPVP8 fake-two-longer", "image/webp", "max-age=3600"),
        ("products/p-003.jpg", b"\xff\xd8\xff\xe0fake-jpeg", "image/jpeg", ""),
    ]
    for name, body, mime, cc in samples:
        p = os.path.join(d, *name.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(body)
        rows.append({"name": name, "mime": mime, "size": str(len(body)), "cc": cc})
    return d, rows


def sha256_file(p: str) -> str:
    with open(p, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()
