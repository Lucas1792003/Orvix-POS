#!/usr/bin/env python3
"""Studio isolation as a controlled, reversible edit (docs/selfhost-migration/phase-f/studio-isolation.md).

  python3 -I studio_isolation.py status <lds.template.yaml> [<docker-compose.override.yml>]
  python3 -I studio_isolation.py apply  <lds in> <lds out> [<override in> <override out>]
  python3 -I studio_isolation.py revert <lds in> <lds out> [<override in> <override out>]

LDS (Envoy listener template): in listener "supabase", the four routes that start at
`- name: pg-protected` (/pg/ -> meta, /api/mcp, /mcp, catch-all / -> studio) are replaced
by one last route `phf-not-found` (direct 404, basic auth disabled, RBAC allow-all).
The replaced block must be byte-identical to upstream v0.8.2 (sha256 pinned; the verbatim
copy is upstream-studio-routes.yaml next to this file), otherwise apply refuses. `revert`
puts that verbatim block back in place of phf-not-found. Nothing else in the file is
touched, so the edit composes with the G5 header rule (envoy_storage_headers.py) and the
phone-upload rate limit in any order.

Override (compose): adds to the existing `studio:` service block
    # phf-studio-loopback ...
    ports:
      - "127.0.0.1:54323:3000/tcp"
and revert removes exactly those lines. Refuses if the block already has its own `ports:`.

Idempotent: apply on an applied file and revert on an upstream file are no-ops (exit 0).
Unknown state (block changed, partial edit) -> exit 1, nothing written. Prints structure
only (states, line numbers, sha prefixes), never file contents. Output files are written
only by apply/revert, mode 0644; in == out is allowed (in-place).
"""
import hashlib, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
UPSTREAM_ROUTES = os.path.join(HERE, "upstream-studio-routes.yaml")
UPSTREAM_ROUTES_SHA = "f121d31b2dfc7ad9ca5f732844abeab1eebcf9b88523e9361cfe5d397c9cf25e"
ROUTE_INDENT = 22
START_UPSTREAM = "- name: pg-protected"
START_ISOLATED = "- name: phf-not-found"
MARK = "# ShwePhaLa studio isolation (deploy/lucashome/studio-isolation/):"

NOT_FOUND = """\
# ShwePhaLa studio isolation (deploy/lucashome/studio-isolation/):
# Studio (/), its MCP endpoints (/api/mcp, /mcp) and pg-meta (/pg/)
# are NOT served on the shared API origin. Everything that no route
# above matches gets a plain 404 here, with no basic-auth challenge.
# Studio is published on 127.0.0.1:54323 only (SSH tunnel).
# Keep this route LAST: any route added later goes above it.
- name: phf-not-found
  match:
    prefix: /
  direct_response:
    status: 404
    body:
      inline_string: "not found\\n"
  typed_per_filter_config:
    envoy.filters.http.basic_auth:
      '@type': >-
        type.googleapis.com/envoy.config.route.v3.FilterConfig
      disabled: true
    envoy.filters.http.rbac:
      '@type': >-
        type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBACPerRoute
      rbac:
        rules:
          action: ALLOW
          policies:
            allow_all:
              permissions:
                - any: true
              principals:
                - any: true""".split("\n")

COMPOSE_LINES = [
    "    # phf-studio-loopback: Studio only on the server's loopback; reach it with",
    "    #   ssh -N -L 127.0.0.1:54323:127.0.0.1:54323 <host>  (never 0.0.0.0 / a tailnet address)",
    "    ports:",
    '      - "127.0.0.1:54323:3000/tcp"',
]


def sha(lines):
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def ind(l):
    return len(l) - len(l.lstrip())


def upstream_block():
    lines = [l for l in open(UPSTREAM_ROUTES).read().split("\n")]
    while lines and lines[0].startswith("#"):
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if sha(lines) != UPSTREAM_ROUTES_SHA:
        print("REFUSE: upstream-studio-routes.yaml does not match its pinned sha256")
        sys.exit(1)
    return lines


def isolated_block():
    return [(" " * ROUTE_INDENT + l) if l else "" for l in NOT_FOUND]


def find_block(lines, start_text, with_comment=False):
    """(start, end) of the route block that begins at start_text (indent 22) and runs to
    the first non-blank line with a smaller indent (http_filters:); trailing blanks excluded."""
    hits = [k for k, l in enumerate(lines) if l.strip() == start_text and ind(l) == ROUTE_INDENT]
    if len(hits) != 1:
        return None, len(hits)
    s = hits[0]
    if with_comment:
        while s > 0 and lines[s - 1].strip().startswith("#") and ind(lines[s - 1]) == ROUTE_INDENT:
            s -= 1
    e = next((k for k in range(hits[0] + 1, len(lines)) if lines[k].strip() and ind(lines[k]) < ROUTE_INDENT), None)
    if e is None:
        return None, -1
    while e > s and not lines[e - 1].strip():
        e -= 1
    return (s, e), 1


def lds_state(lines):
    up, nu = find_block(lines, START_UPSTREAM)
    iso, ni = find_block(lines, START_ISOLATED, with_comment=True)
    studio_routes = sum(1 for l in lines if l.strip() == "cluster: studio")
    if up and not ni and sha(lines[up[0]:up[1]]) == UPSTREAM_ROUTES_SHA and studio_routes == 3:
        nxt = next((lines[k].strip() for k in range(up[1], len(lines)) if lines[k].strip()), "")
        if nxt == "http_filters:":
            return "upstream", up
    if iso and not nu and lines[iso[0]:iso[1]] == isolated_block() and studio_routes == 0:
        nxt = next((lines[k].strip() for k in range(iso[1], len(lines)) if lines[k].strip()), "")
        if nxt == "http_filters:":
            return "isolated", iso
    return "unknown", None


def compose_state(lines):
    try:
        svc = next(k for k, l in enumerate(lines) if l.rstrip() == "services:")
    except StopIteration:
        return "unknown", None
    hits = [k for k in range(svc + 1, len(lines)) if lines[k].rstrip() == "  studio:"]
    if len(hits) != 1:
        return "unknown", None
    s = hits[0]
    e = next((k for k in range(s + 1, len(lines)) if lines[k].strip() and ind(lines[k]) <= 2), len(lines))
    while e > s + 1 and not lines[e - 1].strip():
        e -= 1
    block = lines[s + 1:e]
    n = len(COMPOSE_LINES)
    if block[-n:] == COMPOSE_LINES and not any(l.strip().startswith("ports:") for l in block[:-n]):
        return "isolated", (s, e)
    if not any(l.strip().startswith("ports:") or "phf-studio-loopback" in l for l in block):
        return "upstream", (s, e)
    return "unknown", None


def read(path):
    t = open(path).read()
    return t.split("\n"), t.endswith("\n")


def write(path, lines, nl):
    t = "\n".join(lines)
    if nl and not t.endswith("\n"):
        t += "\n"
    with open(path, "w") as f:
        f.write(t)
    os.chmod(path, 0o644)


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("status", "apply", "revert") or (a[0] == "status" and len(a) not in (2, 3)) \
            or (a[0] != "status" and len(a) not in (3, 5)):
        print(__doc__)
        sys.exit(2)
    cmd = a[0]
    lds_in = a[1]
    lines, nl = read(lds_in)
    st, rng = lds_state(lines)
    print(f"lds: {st}" + (f" (route block lines {rng[0] + 1}-{rng[1]})" if rng else "")
          + f"; studio routes: {sum(1 for l in lines if l.strip() == 'cluster: studio')}; sha256 {hashlib.sha256(open(lds_in, 'rb').read()).hexdigest()[:8]}")
    ov = None
    if cmd == "status" and len(a) == 3:
        ov = (a[2], None)
    elif cmd != "status" and len(a) == 5:
        ov = (a[3], a[4])
    if ov:
        olines, onl = read(ov[0])
        ost, orng = compose_state(olines)
        print(f"override: {ost}" + (f" (studio block lines {orng[0] + 1}-{orng[1]})" if orng else ""))
    if cmd == "status":
        sys.exit(0 if st != "unknown" and (not ov or ost != "unknown") else 1)
    if st == "unknown" or (ov and ost == "unknown"):
        print("REFUSE: unknown state (block changed by hand or partial edit) - nothing written; compare with upstream-studio-routes.yaml")
        sys.exit(1)

    want = "isolated" if cmd == "apply" else "upstream"
    new = list(lines)
    if st != want:
        s, e = rng
        new[s:e] = isolated_block() if cmd == "apply" else upstream_block()
        st2, _ = lds_state(new)
        if st2 != want:
            print(f"REFUSE: result check failed (lds {st2}) - nothing written")
            sys.exit(1)
        print(f"lds: {cmd} -> {want}: {e - s} lines replaced by {len(new) - len(lines) + e - s}")
    else:
        print(f"lds: already {want} (no change)")

    onew = None
    if ov:
        onew = list(olines)
        if ost != want:
            s, e = orng
            if cmd == "apply":
                onew[e:e] = COMPOSE_LINES
            else:
                onew[e - len(COMPOSE_LINES):e] = []
            if compose_state(onew)[0] != want:
                print("REFUSE: override result check failed - nothing written")
                sys.exit(1)
            print(f"override: {cmd} -> {want}")
        else:
            print(f"override: already {want} (no change)")
    # both results checked: write
    write(a[2], new, nl)
    if ov:
        write(ov[1], onew, onl)

if __name__ == "__main__":
    main()
