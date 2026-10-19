"""ORVIX restore GATE for migration 087 (read-only against the database; FAILS CLOSED).

  exit 0  CONSISTENT    a complete, verified series with an AUTHORITY copy, a fresh signed attestation of its current head for
                        this gate's nonce, and every organisation, every signed observation and every till witness agreeing
  exit 10 INCONCLUSIVE  missing / stale / email-only / unverifiable / unwitnessed / unconfirmed evidence
  exit 20 LOSS_DETECTED committed history the database does not have
  exit 30 CONFLICT      contradictory evidence (forked chain or series, rolled-back copy, rogue renewal, unchained ledger rows)
CONSISTENT never reopens anything; it covers history only up to the last signed observation (see NOTE_UNWITNESSED_TAIL).
Accepted records are signed renewal INTENTS confirmed by a later 'renew' record (design: migration-087.md, "Witness authority").
Evidence is read as the non-superuser role recovery_gate (recovery.gate_evidence()). No operator-chosen incident time;
--max-gap-s can only tighten the freshness rule (cap 180 s). Nonces are ISSUED by the gate (--issue-nonce) and are single use;
the issued/used lists live in --nonce-dir (default: the directory of the public key), which belongs to the gate operator.

usage: gate.py --issue-nonce --pub AUTHORITY.pub [--nonce-dir DIR]          (prints a fresh nonce for the authority to attest)
       gate.py --db CONTAINER --pub AUTHORITY.pub --copy authority:DIR [--copy email:DIR ...] [--till FILE ...]
               [--attest FILE --nonce NONCE] [--max-gap-s N<=180] [--nonce-dir DIR]
env:   GATE_PGHOST=<host> (TCP), GATE_PSQL="cmd ..." to replace `docker exec -i CONTAINER psql`
"""
import argparse, datetime, hashlib, hmac, json, os, shlex, subprocess, sys, tempfile

OPENSSL = os.environ.get("OPENSSL", "/opt/homebrew/opt/openssl@3/bin/openssl")
INC, LOSS, CONFLICT = 10, 20, 30
# authority refusal reasons that mean "this database was rolled back or renewed by someone else"
ROLLBACK_REASONS = ("ROGUE_RENEWAL", "LEASE_SEQ_MISMATCH", "LEASE_ROW_REPLACED", "PUBLIC_CANARY_ROLLED_BACK", "LEDGER_ROWS_VANISHED",
                    "WAL_BEHIND", "LOSS:", "FORK:", "SEQ_NOT_INCREASING", "GENESIS_ALREADY_DONE")


def canonical(b):
    return json.dumps(b, sort_keys=True, separators=(",", ":")).encode()


def verify(pub, body, sig_hex):
    with tempfile.NamedTemporaryFile() as m, tempfile.NamedTemporaryFile() as s:
        m.write(canonical(body)); m.flush(); s.write(bytes.fromhex(sig_hex)); s.flush()
        r = subprocess.run([OPENSSL, "pkeyutl", "-verify", "-pubin", "-inkey", pub, "-rawin", "-in", m.name, "-sigfile", s.name],
                           capture_output=True)
        return r.returncode == 0


def psql(c, sql):
    host = ["-h", os.environ["GATE_PGHOST"]] if os.environ.get("GATE_PGHOST") else []
    base = shlex.split(os.environ["GATE_PSQL"]) if os.environ.get("GATE_PSQL") else ["docker", "exec", c, "psql"]
    r = subprocess.run(base + ["-X", *host, "-U", "recovery_gate", "-d", "postgres", "-At", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:160])
    return [l.split("\x1f") for l in r.stdout.splitlines() if l]


def lsn(s):
    a, b = s.split("/")
    return (int(a, 16) << 32) + int(b, 16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db"); ap.add_argument("--pub", required=True)
    ap.add_argument("--issue-nonce", action="store_true"); ap.add_argument("--nonce-dir")
    ap.add_argument("--copy", action="append", default=[]); ap.add_argument("--till", action="append", default=[])
    ap.add_argument("--max-gap-s", type=int, default=180)
    ap.add_argument("--attest"); ap.add_argument("--nonce")
    a = ap.parse_args()
    a.max_gap_s = min(a.max_gap_s, 180)
    ndir = a.nonce_dir or os.path.dirname(os.path.abspath(a.pub))
    issued_f, used_f = os.path.join(ndir, ".gate-issued"), os.path.join(ndir, ".gate-nonces")
    if a.issue_nonce:
        n = os.urandom(16).hex()
        with open(issued_f, "a") as fh:
            fh.write(n + "\n")
        print(n); return
    if not a.db:
        ap.error("--db is required")
    F = []
    f = lambda sev, code, d="": F.append((sev, code, d))

    # ---- public key must be a real Ed25519 public key
    r = subprocess.run([OPENSSL, "pkey", "-pubin", "-in", a.pub, "-noout", "-text"], capture_output=True, text=True)
    if r.returncode or "ED25519" not in r.stdout.upper():
        f(INC, "AUTHORITY_KEY_INVALID", a.pub); return finish(F)

    # ---- every copy: every record signed, seq contiguous from 1, prev-hash linked
    copies = {}
    for spec in a.copy:
        origin, d = spec.split(":", 1)
        if not os.path.isdir(d) or not os.listdir(d):
            f(INC, "COPY_MISSING", spec); continue
        recs, ok = [], True
        for i, name in enumerate(sorted(os.listdir(d)), 1):
            try:
                doc = json.load(open(os.path.join(d, name))); b = doc["body"]
            except Exception as e:
                f(INC, "RECORD_UNREADABLE", f"{spec}/{name}: {type(e).__name__}"); ok = False; break
            if not verify(a.pub, b, doc.get("sig", "")):
                f(INC, "RECORD_SIGNATURE_INVALID", f"{spec}/{name}"); ok = False; break
            if b["seq"] != i or b["prev"] != (hashlib.sha256(canonical(recs[-1])).hexdigest() if recs else None):
                f(INC, "SERIES_GAP_OR_RELINK", f"{spec} at seq {b['seq']}"); ok = False; break
            recs.append(b)
        if ok:
            copies[spec] = (origin, recs)
    if not copies:
        f(INC, "NO_VERIFIED_SERIES"); return finish(F)
    longest = max((r for _, r in copies.values()), key=len)
    for spec, (origin, recs) in copies.items():
        for x, y in zip(recs, longest):
            if canonical(x) != canonical(y):
                f(CONFLICT, "SERIES_FORK", f"{spec} differs at seq {x['seq']}"); break
    auth = [r for o, r in copies.values() if o == "authority"]
    if not auth:
        f(INC, "EMAIL_ONLY_NOT_PROOF", "no authority copy: an email copy alone never proves continuity")
    elif len(auth[0]) < len(longest):
        f(CONFLICT, "AUTHORITY_COPY_ROLLED_BACK", f"authority copy ends at {len(auth[0])}, another copy at {len(longest)}")
    last = longest[-1]
    gap = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(last["generated_at"])).total_seconds()
    if gap > a.max_gap_s:
        f(INC, "AUTHORITY_STALE", f"last record {int(gap)} s ago (max {a.max_gap_s})")
    if gap < -60:
        f(CONFLICT, "RECORD_FROM_FUTURE", f"{int(-gap)} s ahead")
    # freshness proof: a signed attestation, for OUR nonce, of the authority's current head = the head of the series we verified
    if a.attest and a.nonce:
        seen_n = set(open(used_f).read().split()) if os.path.exists(used_f) else set()
        issued = set(open(issued_f).read().split()) if os.path.exists(issued_f) else set()
        if a.nonce in seen_n:
            f(INC, "NONCE_REUSED"); a.attest = None
        elif a.nonce not in issued:
            f(INC, "NONCE_NOT_ISSUED", "the nonce was not issued by this gate (--issue-nonce)"); a.attest = None
        else:
            open(used_f, "a").write(a.nonce + "\n")
    if a.attest:
        try:
            att = json.load(open(a.attest)); ab = att["body"]
            if not verify(a.pub, ab, att["sig"]):
                f(INC, "ATTESTATION_INVALID", "signature")
            elif ab["nonce"] != a.nonce:
                f(INC, "ATTESTATION_INVALID", "nonce is not the one this gate issued")
            elif abs((datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(ab["at"])).total_seconds()) > 120:
                f(INC, "ATTESTATION_STALE")
            elif ab["head_seq"] != last["seq"] or ab["head_sha256"] != hashlib.sha256(canonical(last)).hexdigest():
                f(CONFLICT if ab["head_seq"] > last["seq"] else INC, "ATTESTED_HEAD_MISMATCH",
                  f"authority head seq {ab['head_seq']}, verified copies end at {last['seq']}")
        except Exception as e:
            f(INC, "ATTESTATION_INVALID", type(e).__name__)
    else:
        f(INC, "NO_FRESH_ATTESTATION", "the authority did not attest its current head for this gate run")
    confirmed = {b["confirms"] for b in longest if b["kind"] == "renew"}
    accepted = [b for b in longest if b["kind"] == "intent" and b["seq"] in confirmed]
    if not accepted:
        f(INC, "NO_ACCEPTED_RECORD"); return finish(F)
    for b in longest[len(longest) - 5:]:
        if b["kind"] == "refuse":
            f(0, "NOTE_AUTHORITY_REFUSED", f"seq {b['seq']}: {' '.join(b.get('reasons', []))[:120]}")
    for b in longest:          # since the last accepted record the authority saw a rollback or a foreign renewal: never CONSISTENT
        if b["kind"] == "refuse" and b["seq"] > accepted[-1]["seq"] and any(r.startswith(ROLLBACK_REASONS) for r in b.get("reasons", [])):
            f(INC, "AUTHORITY_SAW_ROLLBACK", f"seq {b['seq']}: {' '.join(r for r in b['reasons'] if r.startswith(ROLLBACK_REASONS))[:120]}")
    w = accepted[-1]["observed"]

    # ---- database (read-only)
    try:
        ev = json.loads(psql(a.db, "select recovery.gate_evidence()")[0][0])
        obs = ev["observe"]; log = {}
        for o, n, h, p in ev["chain"]:
            log.setdefault(o, []).append((int(n), h, p))
        ledger = {o: int(c) for o, c in obs.get("ledger", {}).items()}
        tkey = bytes.fromhex(ev["till_key"])
    except Exception as e:
        f(INC, "DB_EVIDENCE_UNREADABLE", str(e)); return finish(F)

    if obs["lease_seq"] is not None:
        rec = next((b for b in longest if b["seq"] == obs["lease_seq"]), None)
        if rec is None:
            f(CONFLICT if obs["lease_seq"] > last["seq"] else INC, "ROGUE_RENEWAL" if obs["lease_seq"] > last["seq"] else "SERIES_INCOMPLETE",
              f"database lease issued under seq {obs['lease_seq']}, series ends at {last['seq']}")
        elif rec["kind"] != "intent":
            f(CONFLICT, "ROGUE_RENEWAL", f"database lease seq {obs['lease_seq']} is a {rec['kind']} record, not a signed renewal intent")
        elif not rec.get("token_sha256") or rec["token_sha256"] != obs.get("lease_token_sha256"):
            f(CONFLICT, "ROGUE_RENEWAL", f"database lease seq {obs['lease_seq']} was renewed without the signed intent's one-time token")
        elif any(b["kind"] == "refuse" and b.get("renew_failed_for") == rec["seq"] for b in longest):
            f(CONFLICT, "ROGUE_RENEWAL", f"database lease seq {obs['lease_seq']}: the authority's own renewal of that intent was refused, "
                                         "so this lease was made by someone else")
        elif rec["seq"] not in confirmed:
            f(INC, "LEASE_ON_UNCONFIRMED_INTENT", f"seq {rec['seq']}: renewal intent not confirmed yet (crash residue until the next tick)")
    if obs.get("lease_copied"):
        f(CONFLICT, "LEASE_ROW_REPLACED", "the lease row was not written by its issuing transaction (a restored or copied row)")
    if not obs.get("canary_ok", False):
        f(CONFLICT, "PUBLIC_CANARY_ROLLED_BACK", "the public-schema canary is not the one written with the current lease")
    if obs["sysid"] == w["sysid"] and obs.get("db_oid") != w.get("db_oid"):
        f(INC, "DATABASE_REPLACED", f"database OID {w.get('db_oid')} -> {obs.get('db_oid')} on the same system")
    same = [b["observed"] for b in longest if b.get("observed") and b["observed"].get("sysid") == obs["sysid"]
            and b["observed"].get("timeline") == obs["timeline"]]
    if same:
        top = max(same, key=lambda o: lsn(o["lsn"]))
        if lsn(obs["lsn"]) < lsn(top["lsn"]):      # review r31 (d): high-water mark over EVERY signed observation
            f(LOSS, "WAL_BEHIND", f"database WAL {obs['lsn']} < highest witnessed {top['lsn']} on the same system and timeline")
    if obs["sysid"] != w["sysid"]:
        f(0, "NOTE_REPLACEMENT_SERVER")
    elif obs["timeline"] != w["timeline"]:
        f(0, "NOTE_TIMELINE_CHANGED", f"{w['timeline']} -> {obs['timeline']}")

    for o, rows in log.items():                       # internal chain of EVERY organisation
        h = bytes(32)
        for i, (n, hh, p) in enumerate(rows, 1):
            h = hashlib.sha256(h + p.encode()).digest()
            if n != i or h.hex() != hh:
                f(CONFLICT, "DB_CHAIN_BROKEN", f"org {o[:8]} n={n}"); break
    for o in set(ledger) | set(log):                  # ledger rows = chained rows, for every organisation
        if ledger.get(o, 0) != len(log.get(o, [])):
            f(CONFLICT, "LEDGER_UNCHAINED_ROWS", f"org {o[:8]} ledger {ledger.get(o, 0)} chain {len(log.get(o, []))}")

    def point(src, o, n, hh):
        rows = log.get(o, [])
        if len(rows) < n:
            f(LOSS, "LOSS", f"{src}: org {o[:8]} witnessed n={n}, database n={len(rows)} ({n - len(rows)} missing)")
        elif n > 0 and rows[n - 1][1] != hh:
            f(CONFLICT, "FORK", f"{src}: org {o[:8]} at n={n}")

    for o, v in w["heads"].items():
        point(f"seq {accepted[-1]['seq']}", o, v["n"], v["h"])
    # every signed observation counts as evidence, including refusals written after the last accepted record
    for b in longest:
        if b["kind"] in ("refuse", "intent") and b.get("observed") and b["observed"].get("sysid") == w["sysid"]:
            for o, v in b["observed"]["heads"].items():
                rows = log.get(o, [])
                if len(rows) < v["n"]:
                    point(f"seq {b['seq']} ({b['kind']})", o, v["n"], v["h"])
                elif v["n"] > 0 and rows[v["n"] - 1][1] != v["h"]:
                    point(f"seq {b['seq']} ({b['kind']})", o, v["n"], v["h"])
    f(0, "NOTE_UNWITNESSED_TAIL", f"operations after seq {last['seq']} ({last['generated_at']}) are not covered by any signed observation: "
                                  "reconcile them from till journals")
    for o in set(log) - set(w["heads"]):
        f(INC, "ORG_NOT_WITNESSED", f"org {o[:8]} has {len(log[o])} chained operation(s) never covered by an accepted record")

    seen = {}
    for path in a.till:
        try:
            t = json.load(open(path)); mac = t.pop("mac")
            if obs["till_key_fp"] != w["till_key_fp"]:
                f(INC, "TILL_KEY_CHANGED", "database till key differs from the witnessed fingerprint"); break
            # the server MACs jsonb::text of a flat object: keys ordered by (byte length, bytes), ", " and ": " separators
            body = "{" + ", ".join(f"{json.dumps(k)}: {json.dumps(t[k])}" for k in sorted(t, key=lambda k: (len(k.encode()), k))) + "}"
            if not hmac.compare_digest(hmac.new(tkey, body.encode(), hashlib.sha256).hexdigest(), mac):
                f(INC, "TILL_WITNESS_INVALID", os.path.basename(path)); continue
        except Exception as e:
            f(INC, "TILL_WITNESS_INVALID", f"{os.path.basename(path)}: {type(e).__name__}"); continue
        k = (t["org"], t["n"])
        if k in seen and seen[k] != t["h"]:
            f(CONFLICT, "TILL_WITNESSES_DISAGREE", f"org {t['org'][:8]} n={t['n']}")
        seen[k] = t["h"]
        point(f"till witness {os.path.basename(path)}", t["org"], int(t["n"]), t["h"])
    return finish(F)


def finish(F):
    worst = max([s for s, _, _ in F] + [0])
    print(f"VERDICT {({0: 'CONSISTENT', INC: 'INCONCLUSIVE', LOSS: 'LOSS_DETECTED', CONFLICT: 'CONFLICT'})[worst]} (exit {worst})")
    for s, c, d in sorted(F, key=lambda x: -x[0]):
        print(f"  [{c}] {d}")
    sys.exit(worst)


if __name__ == "__main__":
    main()
