#!/usr/bin/env python3
"""Local stand-in for POST https://api.resend.com/emails (stdlib only). Synthetic tests only.

  fake-resend.py --port P --dir D --key-file K [--mode ok|500|422|413] [--max-bytes N]

* checks `Authorization: Bearer <key>` against K (401 otherwise);
* honours `Idempotency-Key`: a repeated key returns the first id and is NOT recorded again;
* records every accepted request as D/NNN.json (body + idempotency key) and returns {"id": ...};
* --mode makes every request fail with that status; --max-bytes rejects larger bodies with 413
  (Resend documents a 40 MB limit including base64).
The mode can be changed at runtime by writing ok|500|422|413 into D/MODE.
"""
import argparse
import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
seen = {}
count = {"n": 0}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        cfg = self.server.cfg
        n = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(n)
        with open(cfg.key_file) as fh:
            key = fh.read().strip()
        if self.headers.get("Authorization") != f"Bearer {key}":
            return self.reply(401, {"name": "validation_error", "message": "invalid api key"})
        mode = cfg.mode
        mf = os.path.join(cfg.dir, "MODE")
        if os.path.exists(mf):
            mode = open(mf).read().strip() or mode
        if mode != "ok":
            return self.reply(int(mode), {"name": "injected", "message": f"injected {mode}"})
        if cfg.max_bytes and n > cfg.max_bytes:
            return self.reply(413, {"name": "content_too_large", "message": "too large"})
        ikey = self.headers.get("Idempotency-Key")
        with lock:
            if ikey and ikey in seen:
                return self.reply(200, {"id": seen[ikey]})
            mid = str(uuid.uuid4())
            if ikey:
                seen[ikey] = mid
            count["n"] += 1
            k = count["n"]
        with open(os.path.join(cfg.dir, f"{k:03d}.json"), "w") as fh:
            json.dump({"idempotency_key": ikey, "id": mid, "body": json.loads(data)}, fh)
        self.reply(200, {"id": mid})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--mode", default="ok")
    ap.add_argument("--max-bytes", type=int, default=0)
    cfg = ap.parse_args()
    os.makedirs(cfg.dir, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", cfg.port), H)
    srv.cfg = cfg
    srv.serve_forever()


if __name__ == "__main__":
    main()
