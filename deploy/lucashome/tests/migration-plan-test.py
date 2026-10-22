#!/usr/bin/env python3
"""Unit tests for deploy/lucashome/migration_plan.py (workstation only; no database).

  python3 -I deploy/lucashome/tests/migration-plan-test.py
"""
import contextlib
import hashlib
import io
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import migration_plan as mp  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
REAL_MIG = os.path.join(REPO, "supabase", "migrations")
REAL_RB = os.path.join(REPO, "supabase", "rollbacks")
MD5 = "0" * 32


rd, wr = mp.rd, mp.wr


def sha(path):
    return "sha256:" + hashlib.sha256(rd(path).encode()).hexdigest()


class Plan(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.mig = os.path.join(self.t, "mig")
        self.rb = os.path.join(self.t, "rb")
        os.makedirs(self.mig)
        os.makedirs(self.rb)
        for v in range(1, 87):
            self.add(f"{v:03d}_m{v}.sql", f"CREATE TABLE t{v} (id int);\n")
        wr(os.path.join(self.rb, "086_m86.rollback.sql"), "SELECT 1;\n")

    def tearDown(self):
        shutil.rmtree(self.t)

    def add(self, name, body):
        wr(os.path.join(self.mig, name), body)

    def run_plan(self, mode, ledger, facts=None, *args, mig=None):
        """ledger: list of versions, or (version, sha|'') tuples. Returns (rc, output, out_dir)."""
        lp, fp, out = os.path.join(self.t, "l.tsv"), os.path.join(self.t, "f.tsv"), os.path.join(self.t, "out")
        shutil.rmtree(out, ignore_errors=True)
        lines = []
        for e in ledger:
            v, s = (e, "") if isinstance(e, str) else e
            lines.append(f"{v}\t{s}\t{1 if s else 0}")
        wr(lp, "\n".join(lines) + "\n")
        f = {"ledger_md5": MD5, "ledger_cols": "name,statements,version", "has_op_execute": "f", "has_v87": "f", "has_recovery_v1": "f", "idem_pk": "key"}
        f.update(facts or {})
        wr(fp, "".join(f"{k}\t{v}\n" for k, v in f.items()))
        argv = [mode, "--migrations", mig or self.mig, "--ledger", lp, "--facts", fp, "--out", out, *args]
        if mode == "rollback":
            argv += ["--rollbacks", self.rb]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = mp.main(argv)
        return rc, buf.getvalue(), out

    def upto(self, n, skip=("084",)):
        return [f"{v:03d}" for v in range(1, n + 1) if f"{v:03d}" not in skip]

    def ok(self, r):
        self.assertEqual(r[0], 0, r[1])
        self.assertNotIn("REFUSE", r[1])
        return r

    def refused(self, r, text):
        self.assertEqual(r[0], 2, r[1])
        self.assertIn(text, r[1])
        self.assertFalse(os.path.exists(r[2]), "a refusal writes no bundle")
        return r

    # ---------------------------------------------------------------- valid histories
    def test_083_to_085_skips_held_084(self):
        _, out, d = self.ok(self.run_plan("forward", self.upto(83), None, "--from", "085", "--to", "085"))
        self.assertIn("held (not applied, by design): 084", out)
        self.assertEqual(rd(os.path.join(d, "files.txt")).split(), ["000_runner_guard.sql", "085_m85.sql", "085_zz_runner_check.sql", "zzz_runner_record.sql"])

    def test_085_to_086_records_sha_in_same_bundle(self):
        _, _, d = self.ok(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086"))
        rec = rd(os.path.join(d, "zzz_runner_record.sql"))
        self.assertIn(f"('086', ARRAY['{sha(os.path.join(self.mig, '086_m86.sql'))}']::text[], 'm86')", rec)
        self.assertNotIn("ON CONFLICT", "\n".join(l for l in rec.upper().split("\n") if not l.startswith("--")))
        self.assertIn("RUNNER_TRANSACTION_BROKEN", rec)
        self.assertEqual(rd(os.path.join(d, "files.txt")).split(), ["000_runner_guard.sql", "086_m86.sql", "086_zz_runner_check.sql", "zzz_runner_record.sql"])
        chk = rd(os.path.join(d, "086_zz_runner_check.sql"))
        self.assertIn("RUNNER_TRANSACTION_BROKEN", chk)
        self.assertIn("SET LOCAL lock_timeout = '10s'", chk)
        g = rd(os.path.join(d, "000_runner_guard.sql"))
        for s in ("pg_try_advisory_xact_lock", "RUNNER_BUSY", "LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE",
                  f"<> '{MD5}'", "SET LOCAL lock_timeout = '10s'", "SCHEMA_CHANGED", "set_config('orvix.runner_txid', txid_current()::text, true)"):
            self.assertIn(s, g)

    def test_083_085_086_in_one_run(self):
        _, _, d = self.ok(self.run_plan("forward", self.upto(83), None, "--from", "085", "--to", "086"))
        self.assertEqual(rd(os.path.join(d, "files.txt")).split()[1:4], ["085_m85.sql", "085_zz_runner_check.sql", "086_m86.sql"])

    def test_matching_checksum_is_accepted(self):
        led = self.upto(84) + [("085", sha(os.path.join(self.mig, "085_m85.sql")))]
        self.ok(self.run_plan("forward", led, None, "--from", "086", "--to", "086"))

    def test_held_version_with_allow_skipped(self):
        self.ok(self.run_plan("forward", self.upto(83), None, "--from", "084", "--to", "084", "--allow-skipped"))

    def test_forward_recovery_086_after_rollback(self):
        # after the rollback: (org_id, key) kept, op_execute gone, 086 row removed -> only 086 may run
        self.ok(self.run_plan("forward", self.upto(85), {"idem_pk": "org_id,key"}, "--from", "086", "--to", "086"))

    def test_086_never_rerun_once_087_is_installed(self):
        # audit 2026-10-20: 086's grant step would re-own / revoke op_execute_v87 and op_status_v87
        # (supabase/tests/m086-rerun). Even the documented forward recovery is refused while 087 is present,
        # whatever the ledger says (an 087 installed but not recorded, a hand-edited ledger).
        self.refused(self.run_plan("forward", self.upto(85), {"idem_pk": "org_id,key", "has_v87": "t"}, "--from", "086", "--to", "086"),
                     "must never be re-run after 087")
        self.refused(self.run_plan("forward", self.upto(84, skip=()), {"has_v87": "t"}, "--from", "085", "--to", "086"),
                     "must never be re-run after 087")
        # without 087 the forward recovery is unchanged
        self.ok(self.run_plan("forward", self.upto(85), {"idem_pk": "org_id,key", "has_v87": "f"}, "--from", "086", "--to", "086"))

    def test_has_v87_fact_required_and_validated(self):
        self.refused(self.run_plan("forward", self.upto(85), {"has_v87": "maybe"}, "--from", "086", "--to", "086"), "malformed")

    # ---------------------------------------------------------------- Recovery V1 (final migration integration)
    def test_has_recovery_v1_fact_required_and_validated(self):
        self.refused(self.run_plan("forward", self.upto(85), {"has_recovery_v1": "yes"}, "--from", "086", "--to", "086"), "malformed")
        fp = os.path.join(self.t, "f-missing.tsv")
        wr(fp, f"ledger_md5\t{MD5}\nledger_cols\tname,statements,version\nhas_op_execute\tf\nhas_v87\tf\nidem_pk\tkey\n")
        lp = os.path.join(self.t, "l-missing.tsv")
        wr(lp, "".join(f"{v}\t\t0\n" for v in self.upto(85)))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = mp.main(["forward", "--migrations", self.mig, "--ledger", lp, "--facts", fp, "--out", os.path.join(self.t, "o3"),
                          "--from", "086", "--to", "086"])
        self.assertEqual(rc, 2)
        self.assertIn("has_recovery_v1 missing", buf.getvalue())

    def test_086_and_087_never_after_recovery_v1(self):
        self.add("087_m87.sql", "SELECT 1;\n")
        self.refused(self.run_plan("forward", self.upto(85), {"has_recovery_v1": "t"}, "--from", "086", "--to", "086",
                                   "--recovery-v1-reviewed"), "086 must never run after it")
        led = self.upto(85) + [("086", sha(os.path.join(self.mig, "086_m86.sql")))]
        self.refused(self.run_plan("forward", led, {"has_recovery_v1": "t", "has_op_execute": "t", "idem_pk": "org_id,key"},
                                   "--from", "087", "--to", "087", "--recovery-v1-reviewed"), "087 must never run after it")

    def test_other_migrations_after_recovery_v1_need_review_flag(self):
        self.add("087_m87.sql", "SELECT 1;\n")
        self.add("088_m88.sql", "SELECT 1;\n")
        led = self.upto(85) + [("086", sha(os.path.join(self.mig, "086_m86.sql"))), ("087", sha(os.path.join(self.mig, "087_m87.sql")))]
        f = {"has_recovery_v1": "t", "has_op_execute": "t", "idem_pk": "org_id,key", "has_v87": "t"}
        self.refused(self.run_plan("forward", led, f, "--from", "088", "--to", "088"), "--recovery-v1-reviewed")
        _, _, d = self.ok(self.run_plan("forward", led, f, "--from", "088", "--to", "088", "--recovery-v1-reviewed"))
        self.assertIn("Recovery V1 was installed or removed after planning", rd(os.path.join(d, "000_runner_guard.sql")))
        self.assertIn("<> 'true' THEN", rd(os.path.join(d, "000_runner_guard.sql")))

    def test_reviewed_flag_refused_without_recovery_v1(self):
        self.refused(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086", "--recovery-v1-reviewed"),
                     "Recovery V1 is not installed here")

    def test_real_repo_088_rollback_restores_087_rollbackability(self):
        led = [f"{v:03d}" for v in range(1, 87) if v != 84] + [("087", sha(os.path.join(REAL_MIG, "087_recovery_hold.sql"))),
                                                               ("088", sha(os.path.join(REAL_MIG, "088_retired_number.sql")))]
        f = {"has_op_execute": "t", "idem_pk": "org_id,key", "has_v87": "t"}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            lp, fp = os.path.join(self.t, "l88.tsv"), os.path.join(self.t, "f88.tsv")
            wr(lp, "".join(f"{v}\t{s}\t{1 if s else 0}\n" for v, s in [(e, "") if isinstance(e, str) else e for e in led]))
            base = {"ledger_md5": MD5, "ledger_cols": "name,statements,version", "has_v87": "t", "has_recovery_v1": "f", **f}
            wr(fp, "".join(f"{k}\t{v}\n" for k, v in base.items()))
            rc = mp.main(["rollback", "--migrations", REAL_MIG, "--rollbacks", REAL_RB, "--ledger", lp, "--facts", fp,
                          "--out", os.path.join(self.t, "o88"), "--version", "088", "--owner-confirmed-till-queues-empty"])
        self.assertEqual(rc, 0, buf.getvalue())
        self.assertIn("088_retired_number.rollback.sql", rd(os.path.join(self.t, "o88", "files.txt")))

    def test_guard_rechecks_recovery_v1_absent(self):
        _, _, d = self.ok(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086"))
        g = rd(os.path.join(d, "000_runner_guard.sql"))
        self.assertIn("(to_regnamespace('recovery_v1') IS NOT NULL)::text <> 'false'", g)

    def test_rollback_refused_while_recovery_v1_installed(self):
        self.refused(self.run_plan("rollback", self.rb_ledger(), {"has_op_execute": "t", "idem_pk": "org_id,key", "has_recovery_v1": "t"},
                                   "--version", "086", "--owner-confirmed-till-queues-empty"), "rollback of 086 is refused")

    def test_real_repo_088_is_the_retired_tombstone(self):
        f88 = [f for f in os.listdir(REAL_MIG) if f.startswith("088_")]
        self.assertEqual(f88, ["088_retired_number.sql"])
        body = mp.strip_comments(rd(os.path.join(REAL_MIG, f88[0]))).strip()
        self.assertEqual(body, "SELECT 'migration 088 is a retired number: no-op' AS migration_088;")
        led = [f"{v:03d}" for v in range(1, 88) if v != 84]
        self.ok(self.run_plan("forward", led, {"has_op_execute": "t", "idem_pk": "org_id,key", "has_v87": "t"}, "--from", "088", "--to", "088",
                              mig=REAL_MIG))

    def test_legacy_rows_without_checksum_are_noted_not_hidden(self):
        _, out, _ = self.ok(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086"))
        self.assertIn("carry no checksum", out)

    # ---------------------------------------------------------------- invalid histories
    def test_rerun_062_085_after_086_refused(self):
        led = self.upto(86)
        for f, t in (("062", "085"), ("085", "085"), ("070", "070")):
            self.refused(self.run_plan("forward", led, {"has_op_execute": "t", "idem_pk": "org_id,key"}, "--from", f, "--to", t),
                         "already recorded")

    def test_084_after_086_refused_even_with_allow_skipped(self):
        r = self.run_plan("forward", self.upto(86), {"has_op_execute": "t", "idem_pk": "org_id,key"}, "--from", "084", "--to", "084", "--allow-skipped")
        self.refused(r, "out-of-order")

    def test_lineage_without_086_recorded_refuses_older(self):
        led = [v for v in self.upto(86) if v not in ("085", "086")]
        r = self.run_plan("forward", led, {"idem_pk": "org_id,key"}, "--from", "085", "--to", "085")
        self.refused(r, "lineage is present")
        r = self.run_plan("forward", led, {"has_op_execute": "t"}, "--from", "085", "--to", "086")
        self.refused(r, "only 086 itself")

    def test_086_recorded_without_executor_refused(self):
        self.refused(self.run_plan("forward", self.upto(86), {"idem_pk": "org_id,key"}, "--from", "086", "--to", "086"),
                     "op_execute is missing")

    def test_gap_refused(self):
        led = [v for v in self.upto(85) if v != "082"]
        self.refused(self.run_plan("forward", led, None, "--from", "086", "--to", "086"), "gap: earlier migration 082")

    def test_unrecorded_held_is_not_a_gap_but_083_is(self):
        led = [v for v in self.upto(85) if v != "083"]
        self.refused(self.run_plan("forward", led, None, "--from", "086", "--to", "086"), "gap: earlier migration 083")

    def test_held_without_allow_refused(self):
        self.refused(self.run_plan("forward", self.upto(83), None, "--from", "084", "--to", "085"), "held list")

    def test_out_of_order_refused(self):
        led = [v for v in self.upto(86) if v != "085"]
        self.refused(self.run_plan("forward", led, {"has_op_execute": "t", "idem_pk": "org_id,key"}, "--from", "085", "--to", "085"),
                     "out-of-order")

    def test_checksum_mismatch_refuses_everything(self):
        led = self.upto(85) + [("086", "sha256:" + "a" * 64)]
        r = self.run_plan("forward", led, {"has_op_execute": "t", "idem_pk": "org_id,key"}, "--from", "086", "--to", "086")
        self.refused(r, "CHECKSUM MISMATCH")
        self.add("087_m87.sql", "SELECT 1;\n")
        r = self.run_plan("forward", led, {"has_op_execute": "t", "idem_pk": "org_id,key"}, "--from", "087", "--to", "087")
        self.refused(r, "CHECKSUM MISMATCH")

    def test_duplicate_file_version_refused(self):
        self.add("086_other.sql", "SELECT 1;\n")
        self.refused(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086"), "duplicate migration version 086")

    def test_malformed_file_name_refused(self):
        self.add("87_bad.sql", "SELECT 1;\n")
        self.refused(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086"), "malformed migration file name")

    def test_duplicate_ledger_version_refused(self):
        self.refused(self.run_plan("forward", self.upto(85) + ["085"], None, "--from", "086", "--to", "086"), "more than once")

    def test_unknown_ledger_version_refused(self):
        self.refused(self.run_plan("forward", self.upto(85) + ["20240101120000"], None, "--from", "086", "--to", "086"),
                     "does not know")

    def test_recorded_version_without_file_refused(self):
        self.refused(self.run_plan("forward", self.upto(85) + ["090"], None, "--from", "086", "--to", "086"), "has no 090_*.sql")

    def test_numbering_gap_refused(self):
        os.remove(os.path.join(self.mig, "085_m85.sql"))
        self.refused(self.run_plan("forward", self.upto(84), None, "--from", "086", "--to", "086"), "numbering has gaps (no file for 085)")

    def test_statements_that_are_not_one_checksum_refused(self):
        lp = self.upto(84)
        r = self.run_plan("forward", lp, None, "--from", "085", "--to", "085")
        self.ok(r)
        # a row whose statements hold SQL text (n entries, no checksum)
        lpath = os.path.join(self.t, "l2.tsv")
        wr(lpath, "".join(f"{v}\t\t0\n" for v in self.upto(83)) + "084\t\t3\n")
        fpath = os.path.join(self.t, "f.tsv")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = mp.main(["forward", "--migrations", self.mig, "--ledger", lpath, "--facts", fpath, "--out", os.path.join(self.t, "o2"),
                          "--from", "085", "--to", "085"])
        self.assertEqual(rc, 2)
        self.assertIn("not one sha256", buf.getvalue())

    def test_malformed_checksum_refused(self):
        self.refused(self.run_plan("forward", self.upto(84) + [("085", "sha256:xyz")], None, "--from", "086", "--to", "086"),
                     "malformed or multiple checksums")

    def test_ledger_without_statements_column_refused(self):
        self.refused(self.run_plan("forward", self.upto(85), {"ledger_cols": "version"}, "--from", "086", "--to", "086"),
                     "lacks column")

    def test_malformed_facts_refused(self):
        self.refused(self.run_plan("forward", self.upto(85), {"ledger_md5": "x'; DROP"}, "--from", "086", "--to", "086"),
                     "malformed")

    def test_unbounded_lock_timeout_refused(self):
        rc, out, _ = self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086", "--lock-timeout", "0s")
        self.assertEqual(rc, 2)
        self.assertIn("bounded", out)

    def test_range_must_name_files(self):
        self.refused(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "099"), "must name existing")

    def test_non_transactional_statements_refused(self):
        for body in ("BEGIN;\nSELECT 1;\nCOMMIT;\n", "CREATE INDEX CONCURRENTLY i ON t86 (id);\n", "VACUUM t86;\n",
                     "ALTER SYSTEM SET work_mem = '1MB';\n", "\\i other.sql\n", "ALTER TYPE e ADD VALUE 'x';\n",
                     "SELECT 1;\nCOMMIT\n;\n", "CREATE TABLE a (id int); COMMIT;\n", "SELECT 1;\nCOMMIT\nAND CHAIN;\n", "SELECT format('vacuum %I', 't') \\gexec\n", "SELECT 1; \\c other\n"):
            self.add("086_m86.sql", body)
            self.refused(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086"), "owner review")

    def test_plpgsql_and_comments_are_not_flagged(self):
        self.add("086_m86.sql", "-- VACUUM later; BEGIN;\n/* COMMIT; */\nDO $$ BEGIN\n  PERFORM 1;\nEND $$;\n"
                 "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $f$\nBEGIN\n  RETURN 1;\nEND;\n$f$;\n")
        self.ok(self.run_plan("forward", self.upto(85), None, "--from", "086", "--to", "086"))

    def test_real_migrations_and_rollback_are_transactional(self):
        for f in sorted(os.listdir(REAL_MIG)):
            self.assertEqual(mp.non_transactional(rd(os.path.join(REAL_MIG, f))), [], f)
        for f in sorted(os.listdir(REAL_RB)):
            self.assertEqual(mp.non_transactional(rd(os.path.join(REAL_RB, f))), [], f)

    def test_real_repo_plans_086_after_085(self):
        led = [f"{v:03d}" for v in range(1, 86) if v != 84]
        self.ok(self.run_plan("forward", led, None, "--from", "086", "--to", "086", mig=REAL_MIG))
        self.refused(self.run_plan("forward", led, None, "--from", "084", "--to", "086", mig=REAL_MIG), "held list")

    # ---------------------------------------------------------------- rollback
    def rb_ledger(self):
        return self.upto(85) + [("086", sha(os.path.join(self.mig, "086_m86.sql")))]

    def test_rollback_needs_owner_confirmation(self):
        self.refused(self.run_plan("rollback", self.rb_ledger(), {"has_op_execute": "t", "idem_pk": "org_id,key"}, "--version", "086"),
                     "owner has not confirmed")

    def test_rollback_plan_sets_gate_in_same_transaction(self):
        _, _, d = self.ok(self.run_plan("rollback", self.rb_ledger(), {"has_op_execute": "t", "idem_pk": "org_id,key"},
                                        "--version", "086", "--owner-confirmed-till-queues-empty"))
        self.assertEqual(rd(os.path.join(d, "files.txt")).split(), ["000_runner_guard.sql", "086_m86.rollback.sql"])
        g = rd(os.path.join(d, "000_runner_guard.sql"))
        self.assertIn(f"set_config('orvix.rollback_gate', '{mp.ROLLBACK_GATE}', true)", g)
        self.assertIn("SET LOCAL lock_timeout = '5s'", g)
        self.assertIn("SET LOCAL statement_timeout = '120s'", g)
        self.assertIn("orvix.runner_txid", g)

    def test_rollback_file_name_validated(self):
        os.rename(os.path.join(self.rb, "086_m86.rollback.sql"), os.path.join(self.rb, "086_M86 x.rollback.sql"))
        self.refused(self.run_plan("rollback", self.rb_ledger(), {"has_op_execute": "t", "idem_pk": "org_id,key"},
                                   "--version", "086", "--owner-confirmed-till-queues-empty"), "malformed rollback file name")

    def test_rollback_refused_when_not_recorded_or_not_newest(self):
        f = {"has_op_execute": "t", "idem_pk": "org_id,key"}
        self.refused(self.run_plan("rollback", self.upto(85), f, "--version", "086", "--owner-confirmed-till-queues-empty"),
                     "not recorded")
        self.add("087_m87.sql", "SELECT 1;\n")
        led = self.rb_ledger() + [("087", sha(os.path.join(self.mig, "087_m87.sql")))]
        self.refused(self.run_plan("rollback", led, f, "--version", "086", "--owner-confirmed-till-queues-empty"), "not the newest")

    def test_rollback_refused_without_recorded_checksum(self):
        self.refused(self.run_plan("rollback", self.upto(86), {"has_op_execute": "t", "idem_pk": "org_id,key"},
                                   "--version", "086", "--owner-confirmed-till-queues-empty"), "without a checksum")

    def test_rollback_refused_on_checksum_mismatch(self):
        led = self.upto(85) + [("086", "sha256:" + "b" * 64)]
        self.refused(self.run_plan("rollback", led, {"has_op_execute": "t", "idem_pk": "org_id,key"},
                                   "--version", "086", "--owner-confirmed-till-queues-empty"), "CHECKSUM MISMATCH")

    def test_rollback_file_with_transaction_control_refused(self):
        wr(os.path.join(self.rb, "086_m86.rollback.sql"), "BEGIN;\nSELECT 1;\nCOMMIT;\n")
        self.refused(self.run_plan("rollback", self.rb_ledger(), {"has_op_execute": "t", "idem_pk": "org_id,key"},
                                   "--version", "086", "--owner-confirmed-till-queues-empty"), "transaction control")


if __name__ == "__main__":
    unittest.main(verbosity=1)
