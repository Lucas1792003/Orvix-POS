#!/usr/bin/env python3
"""email-unpack.py - reassemble and verify an emailed encrypted recovery archive.

Runs on the owner's device or a replacement server (python3 stdlib only; no
key needed - it never decrypts).

  email-unpack.py --out DIR INPUT [INPUT...]   [--archive ID] [--list]

INPUT may be: .eml files ("Download original" / "Show original" in Gmail),
an mbox file (Google Takeout), directories containing either, or the raw part
files themselves (<id>.tar.gpg.NNN) next to <id>.index.json.

Checks, all fatal:
  * the index (<id>.index.json, attached to every part mail) is present and
    every copy of it is identical;
  * every part listed in the index is present and its sha256 matches
    (duplicates with the same hash are fine; a part with a wrong hash is
    reported by number and ignored if a good copy exists);
  * the concatenation's sha256 equals the index's total_sha256.
On success writes DIR/<id>.tar.gpg and DIR/<id>.index.json and prints the
next command. Exit 1 on any problem.

Decrypt afterwards to a FILE and check gpg's exit status BEFORE extracting:
gpg streams plaintext before it has verified the integrity tag, so
`gpg -d | tar -x` can unpack manipulated data before gpg reports it.
"""
import argparse
import email
import email.policy
import hashlib
import json
import mailbox
import os
import re
import sys

PART_RE = re.compile(r"^(?P<id>[A-Za-z0-9_-]+-\d{4}-W\d{2}(?:-r\d{8}T\d{6}Z)?)\.tar\.gpg\.(?P<n>\d{3})$")
INDEX_RE = re.compile(r"^(?P<id>[A-Za-z0-9_-]+-\d{4}-W\d{2}(?:-r\d{8}T\d{6}Z)?)\.index\.json$")


def sha256(b):
    return hashlib.sha256(b).hexdigest()


class Collector:
    def __init__(self):
        self.parts = {}    # (id, n) -> list of bytes
        self.indexes = {}  # id -> list of bytes
        self.sources = 0

    def add_file(self, name, data):
        m = PART_RE.match(name)
        if m:
            self.parts.setdefault((m["id"], int(m["n"])), []).append(data)
            return
        m = INDEX_RE.match(name)
        if m:
            self.indexes.setdefault(m["id"], []).append(data)

    def add_message(self, msg):
        self.sources += 1
        for part in msg.walk():
            fn = part.get_filename()
            if fn:
                payload = part.get_payload(decode=True)
                if payload is not None:
                    self.add_file(os.path.basename(fn), payload)

    def add_path(self, path):
        if os.path.isdir(path):
            for root, _dirs, files in os.walk(path):
                for f in sorted(files):
                    self.add_path(os.path.join(root, f))
            return
        base = os.path.basename(path)
        if PART_RE.match(base) or INDEX_RE.match(base):
            with open(path, "rb") as fh:
                self.add_file(base, fh.read())
            return
        with open(path, "rb") as fh:
            head = fh.read(5)
        if head == b"From ":
            for msg in mailbox.mbox(path, factory=lambda f: email.message_from_binary_file(f, policy=email.policy.default)):
                self.add_message(msg)
        elif path.endswith(".eml") or head[:1].isalpha():
            with open(path, "rb") as fh:
                self.add_message(email.message_from_binary_file(fh, policy=email.policy.default))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", required=False)
    ap.add_argument("--archive", help="archive id to reassemble (default: the only/newest one found)")
    ap.add_argument("--list", action="store_true", help="list archives found and exit")
    a = ap.parse_args()

    c = Collector()
    for p in a.inputs:
        if not os.path.exists(p):
            sys.exit(f"input not found: {p}")
        c.add_path(p)

    ids = sorted(set(c.indexes) | {k[0] for k in c.parts})
    if a.list or not ids:
        for i in ids:
            n = len({k[1] for k in c.parts if k[0] == i})
            print(f"{i}: {n} distinct part number(s) found, index {'present' if i in c.indexes else 'MISSING'}")
        if not ids:
            print("no archive parts found", file=sys.stderr)
            return 1
        return 0

    aid = a.archive or ids[-1]
    problems = []
    copies = c.indexes.get(aid, [])
    if not copies:
        print(f"FAIL {aid}: no index found (every part mail carries {aid}.index.json)", file=sys.stderr)
        return 1
    if len({sha256(x) for x in copies}) != 1:
        print(f"FAIL {aid}: index copies differ between mails - possible tampering", file=sys.stderr)
        return 1
    index = json.loads(copies[0])
    if index.get("archive_id") != aid:
        print(f"FAIL {aid}: index names a different archive ({index.get('archive_id')})", file=sys.stderr)
        return 1

    chunks = []
    for p in index["parts"]:
        cands = c.parts.get((aid, p["n"]), [])
        good = [x for x in cands if sha256(x) == p["sha256"] and len(x) == p["bytes"]]
        bad = len(cands) - len(good)
        if not cands:
            problems.append(f"part {p['n']}/{index['part_count']} MISSING ({p['file']})")
        elif not good:
            problems.append(f"part {p['n']}/{index['part_count']} sha256 MISMATCH ({bad} copy/copies, none valid) - corrupted or tampered")
        else:
            if bad:
                print(f"WARN part {p['n']}: ignored {bad} copy/copies with a wrong hash; a valid copy exists", file=sys.stderr)
            chunks.append(good[0])
            print(f"ok   part {p['n']}/{index['part_count']}  {p['bytes']} bytes  sha256 {p['sha256'][:16]}...")
    extra = sorted(k[1] for k in c.parts if k[0] == aid and k[1] > index["part_count"])
    if extra:
        problems.append(f"unexpected part numbers {extra} beyond part_count {index['part_count']}")
    if problems:
        for pr in problems:
            print(f"FAIL {pr}", file=sys.stderr)
        return 1

    whole = b"".join(chunks)
    if len(whole) != index["total_bytes"] or sha256(whole) != index["total_sha256"]:
        print("FAIL concatenated archive does not match total_sha256/total_bytes", file=sys.stderr)
        return 1
    print(f"ok   total {len(whole)} bytes  sha256 {index['total_sha256']}")
    if not a.out:
        print("verified (no --out given; nothing written)")
        return 0
    os.makedirs(a.out, exist_ok=True)
    old = os.umask(0o077)
    try:
        target = os.path.join(a.out, f"{aid}.tar.gpg")
        with open(target, "wb") as fh:
            fh.write(whole)
        with open(os.path.join(a.out, f"{aid}.index.json"), "wb") as fh:
            fh.write(copies[0])
    finally:
        os.umask(old)
    print(f"wrote {target}")
    print("next: gpg --output archive.tar --decrypt " + target + "  &&  echo DECRYPT-OK   (extract only after DECRYPT-OK)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
