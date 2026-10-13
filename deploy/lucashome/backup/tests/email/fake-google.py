#!/usr/bin/env python3
"""Local stand-in for Google's OAuth token endpoint, the OAuth consent redirect and the Gmail API
media-upload send endpoint (stdlib only, plain HTTP on 127.0.0.1). Synthetic tests only.

  fake-google.py --port P --dir D --creds CREDS.json [--max-bytes N] [--expires-in S]

  GET  /auth?...                                    consent screen stand-in: validates the request
                                                    (gmail.send only, S256, offline, consent) and
                                                    302-redirects to the loopback redirect_uri
  POST /token                                       grant_type=authorization_code (PKCE checked) or
                                                    grant_type=refresh_token
  POST /upload/gmail/v1/users/me/messages/send?uploadType=media
                                                    Content-Type message/rfc822, Bearer token;
                                                    stores the raw message as D/sent/NNN.eml and
                                                    returns {"id", "threadId", "labelIds"}

Scenario (whitespace-separated words, re-read on every request from D/SCENARIO; counters reset when
the text changes; D/MAX_BYTES overrides --max-bytes at runtime): ok | expire-after:K (after K accepted sends every issued access token is revoked
once -> 401) | invalid-grant | insufficient | rate429:N | rate403:N | 5xx | drop-after:K (the send
after K accepted ones reads half the body and drops the connection, once) | broad-scope |
badstate | denied.
D/requests.log gets one line per request (no token values). D/issued.txt lists every token this mock
issued so the suite can search for leaks; it is test-side data and never scanned.
"""
import argparse
import base64
import hashlib
import json
import os
import secrets
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCOPE = "https://www.googleapis.com/auth/gmail.send"
lock = threading.Lock()
st = {"scenario": None, "accepted": 0, "sends": 0, "revoked_once": False, "dropped": False,
      "n": 0, "tokens": {}, "refresh": set(), "codes": {}}


def scenario(cfg):
    p = os.path.join(cfg.dir, "SCENARIO")
    text = open(p).read().strip() if os.path.exists(p) else "ok"
    with lock:
        if text != st["scenario"]:
            st.update(scenario=text, accepted=0, sends=0, revoked_once=False, dropped=False)
    words = {}
    for w in text.split():
        k, _, v = w.partition(":")
        words[k] = int(v) if v.isdigit() else True
    return words


def logline(cfg, s):
    with open(os.path.join(cfg.dir, "requests.log"), "a") as fh:
        fh.write(f"{time.strftime('%H:%M:%S')} {s}\n")


def issue(cfg, kind):
    tok = ("ya29.phfgmaccess" if kind == "access" else "1//phfgmrefresh") + secrets.token_hex(16)
    with open(os.path.join(cfg.dir, "issued.txt"), "a") as fh:
        fh.write(tok + "\n")
    return tok


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, code, obj, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def gerr(self, code, reason, status, message, headers=None):
        return self.reply(code, {"error": {"code": code, "message": message, "status": status,
                                           "errors": [{"message": message, "domain": "global", "reason": reason}]}},
                          headers)

    # ------------------------------------------------------------- consent ---
    def do_GET(self):
        cfg = self.server.cfg
        u = urllib.parse.urlsplit(self.path)
        if u.path != "/auth":
            return self.reply(404, {"error": "not_found"})
        q = dict(urllib.parse.parse_qsl(u.query))
        sc = scenario(cfg)
        creds = json.load(open(cfg.creds))
        problems = []
        if q.get("response_type") != "code":
            problems.append("response_type")
        if q.get("client_id") != creds["client_id"]:
            problems.append("client_id")
        if q.get("scope") != SCOPE:
            problems.append("scope")
        if q.get("access_type") != "offline":
            problems.append("access_type")
        if q.get("prompt") != "consent":
            problems.append("prompt")
        if q.get("code_challenge_method") != "S256" or len(q.get("code_challenge", "")) != 43:
            problems.append("pkce")
        ru = q.get("redirect_uri", "")
        if not ru.startswith("http://127.0.0.1:"):
            problems.append("redirect_uri")
        if not q.get("state"):
            problems.append("state")
        if problems:
            logline(cfg, f"auth 400 bad={','.join(problems)}")
            return self.reply(400, {"error": "invalid_request", "bad": problems})
        code = "4/phfgmcode" + secrets.token_hex(8)
        with lock:
            st["codes"][code] = (q["code_challenge"], ru)
        state = q["state"] + ("x" if sc.get("badstate") else "")
        params = {"error": "access_denied", "state": state} if sc.get("denied") else {"code": code, "scope": SCOPE, "state": state}
        logline(cfg, "auth 302")
        self.send_response(302)
        self.send_header("Location", ru + ("&" if "?" in ru else "?") + urllib.parse.urlencode(params))
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------------------------------------------------------------- POST ---
    def do_POST(self):
        cfg = self.server.cfg
        u = urllib.parse.urlsplit(self.path)
        n = int(self.headers.get("Content-Length", "0"))
        if u.path == "/token":
            return self.token(cfg, self.rfile.read(n).decode())
        if u.path == "/upload/gmail/v1/users/me/messages/send":
            return self.send(cfg, u, n)
        self.rfile.read(n)
        return self.reply(404, {"error": "not_found"})

    def token(self, cfg, body):
        sc = scenario(cfg)
        q = dict(urllib.parse.parse_qsl(body))
        creds = json.load(open(cfg.creds))
        gt = q.get("grant_type")
        if q.get("client_id") != creds["client_id"] or q.get("client_secret") != creds["client_secret"]:
            logline(cfg, f"token 401 grant={gt} invalid_client")
            return self.reply(401, {"error": "invalid_client", "error_description": "The OAuth client was not found."})
        out = {"expires_in": cfg.expires_in, "token_type": "Bearer",
               "scope": SCOPE + (" https://mail.google.com/" if sc.get("broad-scope") else "")}
        if gt == "authorization_code":
            with lock:
                ch = st["codes"].pop(q.get("code", ""), None)
            v = q.get("code_verifier", "")
            calc = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
            if not ch or ch[0] != calc or ch[1] != q.get("redirect_uri") or not (43 <= len(v) <= 128):
                logline(cfg, "token 400 grant=authorization_code invalid_grant(pkce/code)")
                return self.reply(400, {"error": "invalid_grant", "error_description": "Bad Request"})
            rt = issue(cfg, "refresh")
            with lock:
                st["refresh"].add(rt)
            out["refresh_token"] = rt
        elif gt == "refresh_token":
            if sc.get("invalid-grant") or (q.get("refresh_token") != creds.get("refresh_token") and q.get("refresh_token") not in st["refresh"]):
                logline(cfg, "token 400 grant=refresh_token invalid_grant")
                return self.reply(400, {"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
        else:
            logline(cfg, f"token 400 grant={gt}")
            return self.reply(400, {"error": "unsupported_grant_type"})
        at = issue(cfg, "access")
        with lock:
            st["tokens"][at] = True
        out["access_token"] = at
        logline(cfg, f"token 200 grant={gt}")
        return self.reply(200, out)

    def send(self, cfg, u, n):
        sc = scenario(cfg)
        q = dict(urllib.parse.parse_qsl(u.query))
        auth = self.headers.get("Authorization", "")
        tok = auth[7:] if auth.startswith("Bearer ") else ""
        with lock:
            st["sends"] += 1
            sends = st["sends"]
            ea = sc.get("expire-after")
            if ea is not None and st["accepted"] >= ea and not st["revoked_once"]:
                for t in st["tokens"]:
                    st["tokens"][t] = False
                st["revoked_once"] = True
            valid = st["tokens"].get(tok, False)
            da = sc.get("drop-after")
            drop = da is not None and st["accepted"] >= da and not st["dropped"]
            if drop:
                st["dropped"] = True
        if drop:
            self.rfile.read(max(1, n // 2))
            logline(cfg, f"send DROP bytes={n}")
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return
        data = self.rfile.read(n)
        if not valid:
            logline(cfg, f"send 401 bytes={n}")
            return self.reply(401, {"error": {"code": 401, "message": "Request had invalid authentication credentials.",
                                              "status": "UNAUTHENTICATED", "errors": [{"reason": "authError"}]}})
        if q.get("uploadType") != "media" or self.headers.get("Content-Type", "").split(";")[0].strip() != "message/rfc822":
            logline(cfg, f"send 400 bytes={n} bad upload type/content type")
            return self.gerr(400, "badRequest", "INVALID_ARGUMENT", "Media type not supported")
        if sc.get("insufficient"):
            logline(cfg, f"send 403 insufficientPermissions bytes={n}")
            return self.reply(403, {"error": {"code": 403, "message": "Request had insufficient authentication scopes.",
                                              "status": "PERMISSION_DENIED", "errors": [{"reason": "insufficientPermissions"}],
                                              "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo",
                                                           "reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}})
        if isinstance(sc.get("rate429"), int) and sends <= sc["rate429"]:
            logline(cfg, f"send 429 bytes={n}")
            return self.gerr(429, "rateLimitExceeded", "RESOURCE_EXHAUSTED", "Too many requests", {"Retry-After": "1"})
        if isinstance(sc.get("rate403"), int) and sends <= sc["rate403"]:
            logline(cfg, f"send 403 userRateLimitExceeded bytes={n}")
            return self.gerr(403, "userRateLimitExceeded", "PERMISSION_DENIED", "User-rate limit exceeded")
        if sc.get("5xx"):
            logline(cfg, f"send 503 bytes={n}")
            return self.gerr(503, "backendError", "UNAVAILABLE", "Backend Error")
        mb = cfg.max_bytes
        mf = os.path.join(cfg.dir, "MAX_BYTES")
        if os.path.exists(mf):
            mb = int(open(mf).read().strip() or 0)
        if mb and n > mb:
            logline(cfg, f"send 413 bytes={n}")
            return self.gerr(413, "uploadTooLarge", "INVALID_ARGUMENT", "Request payload size exceeds the limit")
        with lock:
            st["accepted"] += 1
            st["n"] += 1
            k = st["n"]
        os.makedirs(os.path.join(cfg.dir, "sent"), exist_ok=True)
        with open(os.path.join(cfg.dir, "sent", f"{k:03d}.eml"), "wb") as fh:
            fh.write(data)
        mid = secrets.token_hex(8)
        logline(cfg, f"send 200 bytes={n} id={mid}")
        return self.reply(200, {"id": mid, "threadId": mid, "labelIds": ["SENT"]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--creds", required=True)
    ap.add_argument("--max-bytes", type=int, default=0)
    ap.add_argument("--expires-in", type=int, default=3599)
    cfg = ap.parse_args()
    os.makedirs(cfg.dir, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", cfg.port), H)
    srv.cfg = cfg
    srv.serve_forever()


if __name__ == "__main__":
    main()
