#!/usr/bin/env python3
"""gmail-oauth-mint.py - mint the send-only Gmail credential for the email backup tier (stdlib only).

Owner's Mac (has a browser), signed in to the SENDER Gmail in the browser:

    python3 -I gmail-oauth-mint.py ~/Downloads/client_secret_XXXX.json ~/pos-backup-keys/gmail-oauth.json

  * Installed-app ("Desktop app") OAuth flow: loopback redirect on http://127.0.0.1:<random port>,
    PKCE (S256), random state checked on return, access_type=offline, prompt=consent.
  * Requests exactly ONE scope: https://www.googleapis.com/auth/gmail.send (send only; it cannot
    read, list, modify or delete mail). The granted scope string must be exactly that one scope,
    otherwise nothing is written.
  * Writes {client_id, client_secret, refresh_token, scope, created} as a NEW file with mode 0600.
    Refuses Desktop, Documents and cloud-synced folders (iCloud Drive, ~/Library/CloudStorage).
  * Never prints a token or the client secret. Exits non-zero on any error.

Server (as the backup user, after the owner copied the file there with scp and chmod 0600):

    python3 -I gmail-oauth-mint.py --check /srv/supabase/backup/credentials/gmail-oauth.json

  does ONE token refresh and prints only "ok, scope=..., expires_in=...". It sends no mail.

Options: --no-browser (print the URL only; open it yourself), --timeout SECONDS (default 300),
--force (replace an existing output file).
Test harness only: GMAIL_MINT_AUTH_URL / GMAIL_TOKEN_URL may point at http(s)://127.0.0.1 (nothing
else is accepted); never set them for real use.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

SCOPE = "https://www.googleapis.com/auth/gmail.send"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
LOCAL_RE = re.compile(r"^https?://127\.0\.0\.1(:[0-9]{1,5})?(/\S*)?$")


class Fail(Exception):
    pass


def endpoint(env, default):
    v = os.environ.get(env)
    if not v or v == default:
        return default
    if not LOCAL_RE.match(v):
        raise Fail(f"{env} may only point at 127.0.0.1 (test harness); unset it for real use")
    return v


def post_form(url, fields, timeout=60):
    """POST x-www-form-urlencoded; return (status, parsed JSON or {}). Secrets stay in memory."""
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode() or "{}")
        except ValueError:
            body = {}
        return e.code, body if isinstance(body, dict) else {}
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Fail(f"token endpoint unreachable ({type(e).__name__})")


def err_code(body):
    e = body.get("error")
    if isinstance(e, dict):
        e = e.get("status") or e.get("message")
    return re.sub(r"[^A-Za-z0-9_.-]", "", str(e or "unknown"))[:64]


def scope_ok(s):
    return isinstance(s, str) and s.split() == [SCOPE]


def refuse_path(path):
    home = os.path.realpath(os.path.expanduser("~"))
    real = os.path.realpath(path)
    bad = [os.path.join(home, d) for d in ("Desktop", "Documents", "Library/Mobile Documents", "Library/CloudStorage")]
    for b in bad:
        if real == b or real.startswith(b + os.sep):
            raise Fail(f"refusing to write under {b}: Desktop/Documents/iCloud/cloud-synced folders may be uploaded. "
                       "Use e.g. ~/pos-backup-keys (mkdir -m 700)")
    if "Mobile Documents" in real or "/CloudStorage/" in real or "iCloud" in real:
        raise Fail("refusing a cloud-synced output path")


def load_client(path):
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError) as e:
        raise Fail(f"cannot read the client JSON ({type(e).__name__})")
    if not isinstance(d, dict) or "installed" not in d:
        raise Fail("the client JSON is not a 'Desktop app' OAuth client (no 'installed' section); "
                   "create the client with application type Desktop app")
    c = d["installed"]
    cid, csec = c.get("client_id"), c.get("client_secret")
    if not isinstance(cid, str) or not cid.strip() or not isinstance(csec, str) or not csec.strip():
        raise Fail("the client JSON lacks client_id/client_secret")
    return cid.strip(), csec.strip()


def mint(a):
    auth_url = endpoint("GMAIL_MINT_AUTH_URL", AUTH_URL)
    token_url = endpoint("GMAIL_TOKEN_URL", TOKEN_URL)
    cid, csec = load_client(a.client_json)
    out = os.path.abspath(os.path.expanduser(a.out))
    refuse_path(out)
    parent = os.path.dirname(out)
    if not os.path.isdir(parent):
        raise Fail(f"output directory {parent} does not exist (mkdir -m 700 it first)")
    if os.path.lexists(out) and not a.force:
        raise Fail(f"{out} exists; pass --force to replace it")

    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)  # 86 chars, within RFC 7636's 43..128
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    result = {}
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            q = dict(urllib.parse.parse_qsl(u.query))
            if u.path != "/" or not ({"code", "error", "state"} & set(q)):
                self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
                return
            if not secrets.compare_digest(q.get("state", ""), state):
                result["error"] = "state mismatch (possible forged redirect); nothing written"
            elif "error" in q:
                result["error"] = f"authorization refused: {re.sub(r'[^A-Za-z0-9_.-]', '', q['error'])[:64]}"
            elif not q.get("code"):
                result["error"] = "no authorization code returned"
            else:
                result["code"] = q["code"]
            msg = b"Done. You can close this tab and return to the terminal." if "code" in result \
                else b"Authorization failed. See the terminal."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            done.set()

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{srv.server_address[1]}/"
    url = auth_url + "?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "code_challenge": challenge,
        "code_challenge_method": "S256", "state": state})
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    print("Sign in as the SENDER Gmail and allow 'Send email on your behalf' only.", file=sys.stderr)
    print("If the browser does not open, open this URL yourself:", file=sys.stderr)
    print(f"URL: {url}", file=sys.stderr, flush=True)
    if not a.no_browser:
        webbrowser.open(url)
    ok = done.wait(a.timeout)
    srv.shutdown()
    srv.server_close()
    if not ok:
        raise Fail(f"no browser redirect within {a.timeout}s")
    if "error" in result:
        raise Fail(result["error"])

    status, body = post_form(token_url, {
        "grant_type": "authorization_code", "code": result["code"], "client_id": cid,
        "client_secret": csec, "redirect_uri": redirect, "code_verifier": verifier})
    if status != 200:
        raise Fail(f"code exchange failed: http {status} ({err_code(body)})")
    if not scope_ok(body.get("scope")):
        raise Fail("Google granted a different scope set than exactly gmail.send; nothing written. "
                   "Re-check the consent screen (Data access: gmail.send only) and try again")
    rt = body.get("refresh_token")
    if not isinstance(rt, str) or not rt.strip():
        raise Fail("no refresh token returned (remove the app at myaccount.google.com/permissions and retry)")
    doc = {"client_id": cid, "client_secret": csec, "refresh_token": rt.strip(), "scope": SCOPE,
           "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if a.force and os.path.lexists(out):
        os.unlink(out)
    old = os.umask(0o077)
    try:
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh)
            fh.write("\n")
    finally:
        os.umask(old)
    os.chmod(out, 0o600)
    print(f"wrote {out} (mode 0600, scope=gmail.send). The file is a send-only credential: keep it off "
          "cloud folders, copy it to the server with scp, then delete the local copy and the client JSON.")
    return 0


def check(a):
    token_url = endpoint("GMAIL_TOKEN_URL", TOKEN_URL)
    p = a.check
    try:
        s = os.lstat(p)
    except OSError:
        raise Fail(f"{p} not found")
    if not stat.S_ISREG(s.st_mode):
        raise Fail(f"{p} is not a regular file")
    if s.st_uid != os.getuid():
        raise Fail(f"{p} is not owned by the running user")
    if stat.S_IMODE(s.st_mode) not in (0o600, 0o400):
        raise Fail(f"{p} has mode {stat.S_IMODE(s.st_mode):o} (need 600)")
    try:
        with open(p, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError) as e:
        raise Fail(f"cannot read {p} ({type(e).__name__})")
    for k in ("client_id", "client_secret", "refresh_token"):
        if not isinstance(d.get(k), str) or not d[k].strip():
            raise Fail(f"'{k}' missing in {p}")
    if not scope_ok(d.get("scope")):
        raise Fail("the file's scope is not exactly gmail.send; re-mint")
    status, body = post_form(token_url, {"grant_type": "refresh_token", "client_id": d["client_id"].strip(),
                                         "client_secret": d["client_secret"].strip(),
                                         "refresh_token": d["refresh_token"].strip()})
    if status != 200:
        code = err_code(body)
        if code == "invalid_grant":
            raise Fail("gmail oauth token invalid — owner must re-mint (invalid_grant)")
        raise Fail(f"token refresh failed: http {status} ({code})")
    if "scope" in body and not scope_ok(body["scope"]):
        raise Fail("the token grants more than gmail.send; re-mint with gmail.send only")
    if not isinstance(body.get("access_token"), str) or not body["access_token"]:
        raise Fail("no access token in the response")
    print(f"ok, scope={body.get('scope', d['scope'])}, expires_in={int(body.get('expires_in', 0))}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("client_json", nargs="?", help="downloaded Desktop-app client JSON")
    ap.add_argument("out", nargs="?", help="where to write gmail-oauth.json (new file, mode 0600)")
    ap.add_argument("--check", metavar="FILE", help="refresh once with FILE and print scope/expiry only")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    try:
        if a.check:
            if a.client_json or a.out:
                raise Fail("--check takes only the credential file")
            return check(a)
        if not a.client_json or not a.out:
            ap.print_usage(sys.stderr)
            raise Fail("need CLIENT_JSON and OUT (or --check FILE)")
        return mint(a)
    except Fail as e:
        print(f"gmail-oauth-mint: ERROR: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("gmail-oauth-mint: interrupted", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
