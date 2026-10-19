"""ORVIX witness AUTHORITY for migration 087 (runs OFF the database host; holds the Ed25519 private key).

Design: docs/selfhost-migration/phase-g/migration-087.md ("Witness authority"). Every tick appends signed records to an
append-only series (local state dir AND a mirror on a second store). The database lease is renewed only:
  1. after the database has been re-verified against the last ACCEPTED record and the high-water marks of EVERY signed
     observation (identity, server start / owner anchor, WAL position, till-key fingerprint, lease seq, lease row and
     public canary, every organisation's chain and ledger), and
  2. under a signed INTENT written BEFORE the renewal (record kind 'intent'); a separate signed 'renew' record confirms it.
     Each intent carries sha256 of a one-time secret token that only this process knows and presents to authority_renew;
     the database stores the hash of the token it was given.
A database lease whose seq and token hash do not match a signed intent of ours is a ROGUE renewal (server-wide refusal):
someone holding the database credential cannot pass as the authority, not even by renewing under a seq we signed. A renewal
that committed but whose confirmation was lost (crash) is confirmed later only if its intent is still the head of the series,
the token matches and the database still matches that intent. Any evidence, series or mirror that cannot be read or verified:
a refusal (signed where possible), the lease revoked where possible, never a renewal.

usage:  authority.py tick    STATE MIRROR CONTAINER LEASE_SECONDS
        authority.py genesis STATE MIRROR CONTAINER LEASE_SECONDS     (first record; owner anchor required in the DB)
        authority.py attest  STATE MIRROR NONCE OUT.json               (signed statement of the current series head)
STATE: authority.key (Ed25519 private, mode 600), authority.pub, series/*.json. MIRROR: series/*.json (second store).
env:    AUTH_PGHOST=<host> to connect over TCP; AUTH_PSQL="cmd ..." to replace `docker exec -i CONTAINER psql`.
        TEST ONLY: AUTH_FORCE_REFUSE=<reason>, AUTH_CRASH_AFTER_RENEW=1 (exit between the renewal and its confirmation),
        AUTH_CRASH_AFTER_INTENT=1 (exit between the intent and the renewal), AUTH_TEST_BEFORE_RENEW="cmd" (run between the
        intent and the renewal, with AUTH_TEST_SEQ = the intent's seq and AUTH_TEST_TOKEN = its token: simulates a credential
        holder racing the authority, even one that obtained the token).
needs:  psql 16+ (\\bind: the token travels as a bind parameter and never appears in the SQL text or pg_stat_activity).
"""
import datetime
import fcntl
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile

OPENSSL = os.environ.get("OPENSSL", "/opt/homebrew/opt/openssl@3/bin/openssl")
PER_ORG = ("LOSS:", "FORK:", "LEDGER_UNCHAINED:")


class Unreachable(Exception):
    pass


def psql(container, sql, **vars_):
    host = ["-h", os.environ["AUTH_PGHOST"]] if os.environ.get("AUTH_PGHOST") else []
    base = shlex.split(os.environ["AUTH_PSQL"]) if os.environ.get("AUTH_PSQL") else ["docker", "exec", "-i", container, "psql"]
    args = base + ["-X", "-q", *host, "-U", "recovery_authority", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]
    for k, v in vars_.items():
        args += ["-v", f"{k}={v}"]
    try:
        # every statement ends server-side well before this client gives up (60 s): nothing can commit after a timeout here
        r = subprocess.run(args, input="set statement_timeout = '30s';\n" + sql, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Unreachable(type(e).__name__)
    if r.returncode:
        err = r.stderr.strip()
        if any(m in err for m in ("could not connect", "Connection refused", "No such container", "is not running", "timeout expired",
                                  "the database system is", "Error response from daemon")):
            raise Unreachable(err[:160])
        raise RuntimeError(err[:200])
    return r.stdout.strip()


def canonical(b):
    return json.dumps(b, sort_keys=True, separators=(",", ":")).encode()


def sign(state, data):
    with tempfile.NamedTemporaryFile() as m, tempfile.NamedTemporaryFile() as s:
        m.write(data); m.flush()
        subprocess.run([OPENSSL, "pkeyutl", "-sign", "-inkey", f"{state}/authority.key", "-rawin", "-in", m.name, "-out", s.name], check=True)
        return open(s.name, "rb").read().hex()


def verify(pub, body, sig):
    with tempfile.NamedTemporaryFile() as m, tempfile.NamedTemporaryFile() as s:
        m.write(canonical(body)); m.flush(); s.write(bytes.fromhex(sig)); s.flush()
        return subprocess.run([OPENSSL, "pkeyutl", "-verify", "-pubin", "-inkey", pub, "-rawin", "-in", m.name, "-sigfile", s.name],
                              capture_output=True).returncode == 0


def load(d):
    d = f"{d}/series"
    return [json.load(open(f"{d}/{f}")) for f in sorted(os.listdir(d)) if f.endswith(".json")] if os.path.isdir(d) else []


def write_atomic(d, doc):
    os.makedirs(f"{d}/series", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=f"{d}/series", prefix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(doc, f, indent=1); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, f"{d}/series/{doc['body']['seq']:010d}.json")


def append(state, mirror, kind, extra):
    recs = load(state)
    prev = recs[-1] if recs else None
    body = {"v": 87, "seq": (prev["body"]["seq"] + 1) if prev else 1,
            "prev": hashlib.sha256(canonical(prev["body"])).hexdigest() if prev else None,
            "kind": kind, "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), **extra}
    doc = {"body": body, "sig": sign(state, canonical(body))}
    write_atomic(state, doc)
    write_atomic(mirror, doc)          # second store (another device / mailbox): a rolled-back local state cannot hide it
    return body


def new_token():
    """a one-time renewal secret (hex, never stored) and the sha256 the signed intent carries"""
    t = os.urandom(32)
    return t.hex(), hashlib.sha256(t).hexdigest()


def renew(container, intent, tok, genesis):
    if os.environ.get("AUTH_CRASH_AFTER_INTENT"):
        print(f"seq {intent['seq']} intent; simulated crash before the renewal", flush=True); os._exit(31)
    if os.environ.get("AUTH_TEST_BEFORE_RENEW"):
        subprocess.run(os.environ["AUTH_TEST_BEFORE_RENEW"], shell=True, check=False,
                       env={**os.environ, "AUTH_TEST_SEQ": str(intent["seq"]), "AUTH_TEST_TOKEN": tok})
    # the token (hex from os.urandom) goes through stdin as a BIND PARAMETER: never on a command line, never in the SQL text
    # that other sessions see in pg_stat_activity
    assert all(c in "0123456789abcdef" for c in tok) and len(tok) == 64
    return psql(container, "select recovery.authority_renew($1::int, $2::int, $3::timestamptz, $4::boolean, $5::text) "
                           f"\\bind :seq :len :'pm' {'true' if genesis else 'false'} {tok} \\g",
                seq=intent["seq"], len=intent["lease_seconds"], pm=intent["observed"]["postmaster_start"])


def mirror_ok(state, mirror, genesis=False):
    """local must equal the mirror or be at most ONE record ahead (a crash between the two writes); an empty, missing or
    unverifiable mirror is a failure except at genesis"""
    local, mir = load(state), load(mirror)
    if genesis:
        return not local and not mir
    if not mir or not local:
        return False
    head = mir[-1]
    if not verify(f"{state}/authority.pub", head["body"], head["sig"]):
        return False
    mine = {r["body"]["seq"]: r for r in local}.get(head["body"]["seq"])
    if mine is None or canonical(mine["body"]) != canonical(head["body"]):
        return False
    return local[-1]["body"]["seq"] - head["body"]["seq"] <= 1


def accepted(bodies):
    """intents confirmed by a later 'renew' record, in order"""
    confirmed = {b["confirms"] for b in bodies if b["kind"] == "renew"}
    return [b for b in bodies if b["kind"] == "intent" and b["seq"] in confirmed]


def lsn(s):
    a, b = s.split("/")
    return (int(a, 16) << 32) + int(b, 16)


def revoke(container):
    try:
        psql(container, "select recovery.authority_revoke()")
        return "revoked"
    except Exception as e:  # noqa: BLE001 — best effort; the refusal is recorded either way
        return f"revoke failed ({type(e).__name__})"


def refuse(state, mirror, container, obs, reasons, held=(), renew_failed_for=None):
    for org in held:
        try:
            psql(container, "select recovery.authority_hold(:'org', 'authority: chain behind, diverged or unchained')", org=org)
        except Exception:  # noqa: BLE001
            reasons = reasons + [f"HOLD_FAILED:{org}"]
    rv = revoke(container)
    extra = {"renew_failed_for": renew_failed_for} if renew_failed_for is not None else {}   # the DB refused OUR renewal of that intent
    b = append(state, mirror, "refuse", {"observed": obs, "reasons": reasons, "revoke": rv, **extra})
    print(f"seq {b['seq']} REFUSED {' '.join(reasons)}" + (f"; held {','.join(held)}" if held else "") + f"; lease {rv}")
    sys.exit(20)


def verify_db(container, obs, base, seen):
    """reasons why `obs` is not a continuation of the accepted record `base` and of every signed observation `seen`"""
    reasons, held = [], []
    if (obs["sysid"], obs["timeline"], obs["db_oid"]) != (base["sysid"], base["timeline"], base["db_oid"]):
        reasons.append("IDENTITY_CHANGED")
    if obs["postmaster_start"] != base["postmaster_start"] and not obs["anchor_permit"]:
        reasons.append("RESTART_NOT_ANCHORED")
    same = [o for o in seen if o.get("sysid") == obs["sysid"] and o.get("timeline") == obs["timeline"]]
    if same and lsn(obs["lsn"]) < max(lsn(o["lsn"]) for o in same):
        reasons.append("WAL_BEHIND")
    if obs["till_key_fp"] != base["till_key_fp"]:
        reasons.append("TILL_KEY_CHANGED")
    if obs.get("lease_copied"):
        reasons.append("LEASE_ROW_REPLACED")
    if not obs.get("canary_ok", False):
        reasons.append("PUBLIC_CANARY_ROLLED_BACK")
    hw = {}
    for o in [x for x in seen if x.get("sysid") == obs["sysid"]]:
        for org, v in o["heads"].items():
            if org not in hw or v["n"] > hw[org]["n"]:
                hw[org] = v
    for org, v in sorted(hw.items()):
        cur = obs["heads"].get(org)
        h = psql(container, "select recovery.authority_hash_at(:'org', :n)", org=org, n=int(v["n"])) if cur else ""
        if not cur or cur["n"] < v["n"]:
            reasons.append(f"LOSS:{org}"); held.append(org)
        elif v["n"] > 0 and h != v["h"]:
            reasons.append(f"FORK:{org}"); held.append(org)
    for org in sorted(set(obs.get("ledger", {})) | set(obs["heads"])):
        nl, nc = int(obs.get("ledger", {}).get(org, 0)), int(obs["heads"].get(org, {"n": 0})["n"])
        if nl < nc:
            reasons.append(f"LEDGER_ROWS_VANISHED:{org}")      # public data replaced under an intact chain: server-wide
        elif nl > nc:
            reasons.append(f"LEDGER_UNCHAINED:{org}"); held.append(org)
    return reasons, sorted(set(held))


def main():
    cmd, state, mirror = sys.argv[1], sys.argv[2], sys.argv[3]
    lock = open(f"{state}/.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit("another authority run holds the lock; nothing done")
    if cmd == "attest":
        nonce, out = sys.argv[4], sys.argv[5]
        if not mirror_ok(state, mirror):
            sys.exit("AUTHORITY_ROLLED_BACK: will not attest")
        head = load(state)[-1]["body"]
        body = {"nonce": nonce, "head_seq": head["seq"], "head_sha256": hashlib.sha256(canonical(head)).hexdigest(),
                "at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        json.dump({"body": body, "sig": sign(state, canonical(body))}, open(out, "w"))
        print(f"attested head seq {head['seq']}"); return
    container, lease_s = sys.argv[4], int(sys.argv[5])
    if not mirror_ok(state, mirror, genesis=(cmd == "genesis")):
        if cmd == "genesis":
            sys.exit("genesis refused: a series already exists (archive it with the owner re-baseline procedure first)")
        rv = revoke(container)
        print(f"REFUSED AUTHORITY_ROLLED_BACK: local series is behind, ahead by more than one, or differs from the mirror; lease {rv}")
        sys.exit(20)
    if cmd != "genesis":   # a crash between the local and the mirror write: copy the one missing record (never more) to the mirror
        local, mir = load(state), load(mirror)
        if local[-1]["body"]["seq"] == mir[-1]["body"]["seq"] + 1:
            r = local[-1]
            if not verify(f"{state}/authority.pub", r["body"], r["sig"]) or r["body"]["prev"] != hashlib.sha256(canonical(mir[-1]["body"])).hexdigest():
                rv = revoke(container)
                print(f"REFUSED AUTHORITY_ROLLED_BACK: the local record missing from the mirror is not signed or not linked; lease {rv}"); sys.exit(20)
            write_atomic(mirror, r); print(f"mirror repaired: seq {r['body']['seq']} copied")
    try:
        obs = json.loads(psql(container, "select recovery.authority_observe()"))
    except Unreachable as e:
        rv = revoke(container)                                   # usually fails too; the lease then simply expires
        b = append(state, mirror, "unreachable", {"error": str(e)[:160], "revoke": rv})
        print(f"seq {b['seq']} UNREACHABLE; lease {rv}"); sys.exit(21)
    except Exception as e:  # noqa: BLE001 — the database answered but its evidence is unreadable (M4): fail closed
        refuse(state, mirror, container, None, [f"EVIDENCE_UNREADABLE:{type(e).__name__}:{str(e)[:80]}"])
    try:
        body_all = [r["body"] for r in load(state)]
        if cmd == "genesis":
            nxt = 1
            tok, tok_h = new_token()
            intent = append(state, mirror, "intent", {"observed": obs, "lease_seconds": lease_s, "genesis": True, "baseline_seq": None,
                                                      "token_sha256": tok_h})
            r = renew(container, intent, tok, True)
            if r != "RENEWED":
                refuse(state, mirror, container, obs, [r], renew_failed_for=intent["seq"])
            b = append(state, mirror, "renew", {"confirms": intent["seq"], "late": False})
            print(f"seq {intent['seq']}+{b['seq']} genesis lease=RENEWED heads=" + ",".join(f"{o}:{v['n']}" for o, v in sorted(obs["heads"].items())))
            return
        acc = accepted(body_all)
        seen = [b["observed"] for b in body_all if b.get("observed")]
        # a renewal that committed under our last intent but was never confirmed (crash): confirm it only if that intent is still
        # the HEAD of the series (nothing refused or observed since), the lease carries its token, and nothing changed since,
        # apart from per-org findings already recorded in that intent for organisations that are still held
        p = body_all[-1] if body_all else None
        if (p and p["kind"] == "intent" and obs.get("lease_seq") == p["seq"] and p.get("token_sha256")
                and obs.get("lease_token_sha256") == p["token_sha256"]):
            rs, _ = verify_db(container, obs, p["observed"], seen)
            rs = [r for r in rs if not (r.startswith(PER_ORG) and r in p.get("org_findings", []) and r.split(":", 1)[1] in obs.get("held", []))]
            if not rs and obs["postmaster_start"] == p["observed"]["postmaster_start"]:
                append(state, mirror, "renew", {"confirms": p["seq"], "late": True})
                print(f"seq {p['seq']} intent confirmed LATE (renewal committed before a crash; database unchanged since)")
                body_all = [r["body"] for r in load(state)]
                acc = accepted(body_all)
            # otherwise the intent stays unconfirmed and the database is verified below against the last ACCEPTED record
        if not acc:
            refuse(state, mirror, container, obs, ["NO_GENESIS"])
        last_acc = acc[-1]
        reasons, held = verify_db(container, obs, last_acc["observed"], seen)
        ls = obs.get("lease_seq")
        if ls is not None:
            own = next((b for b in body_all if b["kind"] == "intent" and b["seq"] == ls), None)
            lost = any(b["kind"] == "refuse" and b.get("renew_failed_for") == ls for b in body_all)
            if own is None or not own.get("token_sha256") or own["token_sha256"] != obs.get("lease_token_sha256") or lost:
                # (lost: the database refused OUR renewal of intent ls, so a lease at ls was made by someone else, even with
                # our token: a stolen token cannot be laundered)
                # no signed intent of ours with this seq AND this token: whoever renewed did not hold our one-time secret
                reasons.append(f"ROGUE_RENEWAL:{ls}" if ls >= last_acc["seq"] else f"LEASE_SEQ_MISMATCH:{ls}!={last_acc['seq']}")
            elif ls < last_acc["seq"]:
                reasons.append(f"LEASE_SEQ_MISMATCH:{ls}!={last_acc['seq']}")    # an older lease of ours: a restored copy
            # ls > last_acc: our own renewal (token matches) whose confirmation was lost; never proof of continuity (below)
        if os.environ.get("AUTH_FORCE_REFUSE"):
            reasons.append("TEST_FORCED:" + os.environ["AUTH_FORCE_REFUSE"])
        per_org = [r for r in reasons if r.startswith(PER_ORG)]
        server = [r for r in reasons if not r.startswith(PER_ORG)]
        continuous = (not server and obs["postmaster_start"] == last_acc["observed"]["postmaster_start"] and ls == last_acc["seq"])
        # (an unconfirmed own intent is never proof of continuity: per-org findings then become server-wide)
        # after an anchored restart, findings IDENTICAL to the last accepted record's, for orgs still held, are not new evidence
        known = set(last_acc.get("org_findings", []))
        stale_only = bool(per_org) and set(per_org) <= known and all(r.split(":", 1)[1] in obs.get("held", []) for r in per_org)
        if per_org and not continuous and not (stale_only and not server and ls == last_acc["seq"]):
            reasons.append("ROLLBACK_SCOPE_UNPROVEN")
            server.append("ROLLBACK_SCOPE_UNPROVEN")
        if server:
            refuse(state, mirror, container, obs, reasons, held)
        for org in held:
            psql(container, "select recovery.authority_hold(:'org', 'authority: chain behind, diverged or unchained')", org=org)
        tok, tok_h = new_token()
        intent = append(state, mirror, "intent", {"observed": obs, "lease_seconds": lease_s, "genesis": False, "baseline_seq": last_acc["seq"],
                                                  "org_findings": per_org, "held_orgs": held, "token_sha256": tok_h})
        r = renew(container, intent, tok, False)
        if r != "RENEWED":
            refuse(state, mirror, container, obs, [r], renew_failed_for=intent["seq"])
        if os.environ.get("AUTH_CRASH_AFTER_RENEW"):
            print(f"seq {intent['seq']} intent; renewal COMMITTED; simulated crash before the confirmation", flush=True); os._exit(30)
        b = append(state, mirror, "renew", {"confirms": intent["seq"], "late": False})
        print(f"seq {intent['seq']}+{b['seq']} renew lease=RENEWED" + (f" HELD {' '.join(per_org)}" if held else "") + " heads="
              + ",".join(f"{o}:{v['n']}" for o, v in sorted(obs["heads"].items())))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — anything unexpected mid-tick: signed refusal + revoke, never a renewal (M4)
        refuse(state, mirror, container, None, [f"AUTHORITY_ERROR:{type(e).__name__}:{str(e)[:80]}"])


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — series / mirror / signing failed outside the tick's own handler (M4): revoke, never renew
        c = sys.argv[4] if len(sys.argv) > 5 and sys.argv[1] in ("tick", "genesis") else None
        print(f"REFUSED AUTHORITY_FAILED:{type(e).__name__}:{str(e)[:80]}; no signed record written; lease {revoke(c) if c else 'not touched (attest)'}")
        sys.exit(22)
