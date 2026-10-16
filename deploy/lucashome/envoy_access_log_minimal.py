#!/usr/bin/env python3
"""PREPARED, NOT APPLIED. Replaces the Envoy access-log format of listener "supabase"
with a minimal one that never logs a query string, a referer, a header other than the
user agent and x-client-info, or a body (docs/selfhost-migration/phase-f/gateway-logging-review.md).
Supersedes envoy_access_log_client_info.py (it includes that field).

  python3 -I envoy_access_log_minimal.py status <lds.template.yaml>
  python3 -I envoy_access_log_minimal.py apply  <in> <out>
  python3 -I envoy_access_log_minimal.py revert <in> <out>

Known states of the one format string (exactly one must be present):
  upstream     self-hosted/v0.8.2: path WITH query string, referer, user agent
  client-info  upstream + "%REQ(X-CLIENT-INFO)%" (envoy_access_log_client_info.py apply)
  minimal      this file's format (below)
apply: upstream | client-info -> minimal. revert: minimal | client-info -> upstream
(byte-identical to the original). Idempotent; anything else refuses and writes nothing.
Prints states only, never file contents. Output mode 0644; in == out allowed.

The minimal line keeps the shape verify-till-readiness.sh parses (`reduce`):
  <peer> - - [<time>] "<METHOD> <path, no query> <proto>" <status> <bytes> "rt=<ms> up=<cluster> rf=<flags>" "<user agent, max 256>" "<x-client-info, max 160>"
%PATH(NQ:ORIG)% is the path the client sent (before any prefix rewrite, like the
upstream X-ENVOY-ORIGINAL-PATH?:PATH) with the query string removed.
"""
import os
import sys

PREFIX = 'inline_string: "'
UPSTREAM = (r'%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT% - - [%START_TIME(%d/%b/%Y:%H:%M:%S %z)%] '
            r'\"%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%\" %RESPONSE_CODE% %BYTES_SENT% '
            r'\"%REQ(REFERER)%\" \"%REQ(USER-AGENT)%\"\n"')
CLIENT_INFO = UPSTREAM.replace(r'\"%REQ(USER-AGENT)%\"\n"', r'\"%REQ(USER-AGENT)%\" \"%REQ(X-CLIENT-INFO)%\"\n"')
MINIMAL = (r'%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT% - - [%START_TIME(%d/%b/%Y:%H:%M:%S %z)%] '
           r'\"%REQ(:METHOD)% %PATH(NQ:ORIG)% %PROTOCOL%\" %RESPONSE_CODE% %BYTES_SENT% '
           r'\"rt=%DURATION% up=%UPSTREAM_CLUSTER% rf=%RESPONSE_FLAGS%\" '
           r'\"%REQ(USER-AGENT):256%\" \"%REQ(X-CLIENT-INFO):160%\"\n"')
FORMATS = {"upstream": UPSTREAM, "client-info": CLIENT_INFO, "minimal": MINIMAL}


def state(text):
    # access-log format strings only (a direct_response body is also an inline_string)
    lines = [l.strip() for l in text.split("\n") if l.strip().startswith(PREFIX) and "%RESPONSE_CODE%" in l]
    hits = [name for name, f in FORMATS.items() for l in lines if l == PREFIX + f]
    if len(lines) == 1 and len(hits) == 1:
        return hits[0], len(lines)
    return "unknown", len(lines)


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("status", "apply", "revert") or len(a) != (2 if a[0] == "status" else 3):
        print(__doc__)
        sys.exit(2)
    text = open(a[1]).read()
    st, n = state(text)
    print(f"access-log format: {st} ({n} format string(s))")
    if a[0] == "status":
        sys.exit(0 if st != "unknown" else 1)
    if st == "unknown":
        print("REFUSE: unknown state - nothing written")
        sys.exit(1)
    want = "minimal" if a[0] == "apply" else "upstream"
    if st != want:
        new = text.replace(PREFIX + FORMATS[st], PREFIX + FORMATS[want], 1)
        if state(new)[0] != want:
            print("REFUSE: result check failed - nothing written")
            sys.exit(1)
        print(f"{a[0]}: {st} -> {want}")
        text = new
    else:
        print(f"already {want} (no change)")
    with open(a[2], "w") as f:
        f.write(text)
    os.chmod(a[2], 0o644)


if __name__ == "__main__":
    main()
