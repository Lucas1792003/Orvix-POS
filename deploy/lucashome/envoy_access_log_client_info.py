#!/usr/bin/env python3
"""PREPARED, NOT APPLIED. Adds the request header x-client-info as a last quoted field
to the Envoy access-log line of listener "supabase", so verify-till-readiness.sh can read
the app's "shwephala-pos/<version> (validated-uploads)" per request
(docs/selfhost-migration/phase-f/till-readiness-084.md §3.2).

  python3 -I envoy_access_log_client_info.py status <lds.template.yaml>
  python3 -I envoy_access_log_client_info.py apply  <in> <out>
  python3 -I envoy_access_log_client_info.py revert <in> <out>

Exactly one access-log format string must end in \\"%REQ(USER-AGENT)%\\"\\n (upstream v0.8.2);
apply appends \\" \\"%REQ(X-CLIENT-INFO)%\\"\\" before the newline. Idempotent; unknown state
refuses. Missing header logs "-". The header carries no secret (version + capability).
Prints structure only. Validate the result like the other gateway edits
(`... api-gw --mode validate`), then install with a backup and recreate api-gw.
"""
import sys, os

OLD = r'\"%REQ(USER-AGENT)%\"\n"'
NEW = r'\"%REQ(USER-AGENT)%\" \"%REQ(X-CLIENT-INFO)%\"\n"'


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("status", "apply", "revert") or len(a) != (2 if a[0] == "status" else 3):
        print(__doc__); sys.exit(2)
    t = open(a[1]).read()
    n_old, n_new = t.count(OLD), t.count(NEW)   # NEW does not contain OLD
    state = "applied" if (n_new == 1 and n_old == 0) else "upstream" if (n_old == 1 and n_new == 0) else "unknown"
    print(f"access-log format: {state} (plain {n_old}, with x-client-info {n_new})")
    if a[0] == "status":
        sys.exit(0 if state != "unknown" else 1)
    if state == "unknown":
        print("REFUSE: unknown state - nothing written"); sys.exit(1)
    want = "applied" if a[0] == "apply" else "upstream"
    if state != want:
        t = t.replace(OLD, NEW) if want == "applied" else t.replace(NEW, OLD)
        print(f"{a[0]}: -> {want}")
    else:
        print(f"already {want} (no change)")
    open(a[2], "w").write(t)
    os.chmod(a[2], 0o644)


if __name__ == "__main__":
    main()
