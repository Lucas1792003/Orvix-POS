#!/usr/bin/env python3
"""Apply the G5 public-image header rule (envoy-storage-public-headers.yaml) to an
Envoy listener template, idempotently and without hand editing.

  python3 -I envoy_storage_headers.py status <lds.template.yaml>
  python3 -I envoy_storage_headers.py apply  <in lds.template.yaml> <out file>

EDIT 1 (filter) is inserted immediately before `- name: envoy.filters.http.router`
of listener "supabase"; EDIT 2 (route) immediately before the route whose match is
`prefix: /storage/v1/`. Both blocks are taken verbatim from the snippet file next to
this script and re-indented to the anchor's indentation. Refuses if an anchor is
missing or ambiguous; no-op (exit 0, 'already applied') if both markers exist.
Prints only structure, never file contents. Validate the result with
`docker compose run --rm --no-deps -v <out>:/etc/envoy/lds.template.yaml api-gw --mode validate`
before installing it.
"""
import re, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
SNIPPET = os.path.join(HERE, "envoy-storage-public-headers.yaml")
FILTER_MARK = "- name: phf.storage_public_headers"
ROUTE_MARK = "- name: storage-v1-object-public"


def blocks():
    lines = open(SNIPPET).read().splitlines()
    def grab(start_mark, stop_pred):
        i = next(k for k, l in enumerate(lines) if l.strip() == start_mark)
        out = []
        for l in lines[i:]:
            if out and stop_pred(l):
                break
            out.append(l)
        while out and not out[-1].strip():
            out.pop()
        return out
    f = grab(FILTER_MARK, lambda l: l.startswith("#"))
    r = grab(ROUTE_MARK, lambda l: False)
    return f, r


def reindent(block, indent):
    base = len(block[0]) - len(block[0].lstrip())
    return [(" " * indent + l[base:]) if l.strip() else "" for l in block]


def anchors(lines):
    router = [k for k, l in enumerate(lines) if l.strip() == "- name: envoy.filters.http.router"]
    storage = []
    for k, l in enumerate(lines):
        if l.strip() == "prefix: /storage/v1/" and k > 0 and lines[k - 1].strip() == "- match:":
            storage.append(k - 1)
    return router, storage


def status(path):
    t = open(path).read()
    lines = t.splitlines()
    router, storage = anchors(lines)
    f, r = FILTER_MARK in t, ROUTE_MARK in t
    print(f"router anchors: {len(router)}  storage route anchors: {len(storage)}  filter present: {f}  route present: {r}")
    return lines, router, storage, f, r


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("status", "apply"):
        print(__doc__); sys.exit(2)
    lines, router, storage, f, r = status(sys.argv[2])
    if sys.argv[1] == "status":
        sys.exit(0 if (f and r) or (not f and not r) else 1)
    if f and r:
        print("already applied"); sys.exit(0)
    if f != r:
        print("REFUSE: partially applied"); sys.exit(1)
    if len(router) != 1 or len(storage) != 1:
        print("REFUSE: anchors missing or ambiguous"); sys.exit(1)
    fb, rb = blocks()
    ri, si = router[0], storage[0]
    f_ind = len(lines[ri]) - len(lines[ri].lstrip())
    s_ind = len(lines[si]) - len(lines[si].lstrip())
    new = list(lines)
    # insert the later anchor first so the earlier index stays valid
    for idx, block in sorted([(ri, reindent(fb, f_ind)), (si, reindent(rb, s_ind) + [""])], key=lambda x: -x[0]):
        new[idx:idx] = block
    out = "\n".join(new) + ("\n" if open(sys.argv[2]).read().endswith("\n") else "")
    open(sys.argv[3], "w").write(out)
    os.chmod(sys.argv[3], 0o644)
    print(f"applied: +{len(fb)} filter lines before line {ri + 1}, +{len(rb) + 1} route lines before line {si + 1}")


if __name__ == "__main__":
    main()
