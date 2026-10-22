#!/usr/bin/env python3
"""Unit tests for tools/migration-sequence/verify.py (workstation only; no database).

  python3 -I tools/migration-sequence/verify-test.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import verify as v  # noqa: E402

PIN, _ = v.v1_pins()


def facts(**kw):
    f = {"schema": "orvix-migration-facts-v1", "ledger": None, "has_086": False, "has_087": False, "PSAFE-A": False,
         "PFIN-A": False, "PFIN-B": False, "PCOST-A": False, "PFIN-C": False, "RECOVERY_V1": False, "adapter_087": None,
         "v1_integrity": None, "m087_state": None, "m087_fingerprint": None}
    f.update(kw)
    return f


class Plan(unittest.TestCase):
    def run_plan(self, f):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
            json.dump(f, t)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = v.main(["plan", "--facts", t.name])
        os.unlink(t.name)
        return rc, buf.getvalue()

    def line(self, out, sid):
        return next(l for l in out.splitlines() if l.strip().startswith(sid + " "))

    def test_repo_is_consistent(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(v.main(["check-repo"]), 0, buf.getvalue())

    def test_production_085_next_is_086_only(self):
        rc, out = self.run_plan(facts(ledger=",".join(f"{n:03d}" for n in range(1, 86) if n != 84)))
        self.assertEqual(rc, 0, out)
        self.assertIn("allowed", self.line(out, "086"))
        for sid in ("PSAFE-A", "PFIN-A", "PFIN-B", "PCOST-A", "087"):
            self.assertRegex(self.line(out, sid), r"REFUSED( \(optional\))?: needs 086")
        self.assertIn("allowed", self.line(out, "RECOVERY_V1"))      # V1 supports 085 (with its own blockers as gates)
        self.assertIn("OWNER BLOCKER", out)

    def test_v1_then_087_is_a_violation(self):
        rc, out = self.run_plan(facts(has_086=True, has_087=True, RECOVERY_V1=True, adapter_087="0",
                                      v1_integrity="migration_087_present_adapter_required", m087_fingerprint=PIN, m087_state="hold"))
        self.assertEqual(rc, 1)
        self.assertIn("applied AFTER V1", out)
        self.assertIn("QUARANTINED", out)

    def test_adopted_087_is_clean_and_closes_086_087_pcost(self):
        rc, out = self.run_plan(facts(has_086=True, has_087=True, RECOVERY_V1=True, adapter_087="1", v1_integrity="none",
                                      m087_fingerprint=PIN, m087_state="hold", **{"PSAFE-A": True, "PFIN-A": True, "PFIN-B": True}))
        self.assertEqual(rc, 0, out)
        self.assertIn("never after RECOVERY_V1", self.line(out, "PCOST-A"))

    def test_unknown_087_is_a_violation(self):
        rc, out = self.run_plan(facts(has_086=True, has_087=True, m087_fingerprint="0" * 32, m087_state="hold"))
        self.assertEqual(rc, 1)
        self.assertIn("not the reviewed 087", out)

    def test_adopted_087_removed_is_a_violation(self):
        rc, out = self.run_plan(facts(has_086=True, RECOVERY_V1=True, adapter_087="1", v1_integrity="migration_087_changed_or_removed"))
        self.assertEqual(rc, 1)
        self.assertIn("no longer present", out)

    def test_pcost_needs_087_open(self):
        rc, out = self.run_plan(facts(has_086=True, has_087=True, m087_fingerprint=PIN, m087_state="hold"))
        self.assertEqual(rc, 0, out)
        self.assertIn("needs 087 OPEN", self.line(out, "PCOST-A"))
        rc, out = self.run_plan(facts(has_086=True, has_087=True, m087_fingerprint=PIN, m087_state="open"))
        self.assertIn("allowed", self.line(out, "PCOST-A"))

    def test_086_never_after_087(self):
        rc, out = self.run_plan(facts(has_086=False, has_087=True, m087_fingerprint=PIN, m087_state="hold"))
        self.assertEqual(rc, 1)                                   # 087 without 086 executors
        self.assertIn("never after 087", self.line(out, "086"))

    def test_pfinc_needs_pfin_b(self):
        rc, out = self.run_plan(facts(has_086=True))
        self.assertIn("needs PFIN-B", self.line(out, "PFIN-C"))
        rc, out = self.run_plan(facts(has_086=True, **{"PFIN-B": True}))
        self.assertIn("HELD", self.line(out, "PFIN-C"))             # held unless the owner decisions are recorded
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
            json.dump(facts(has_086=True, **{"PFIN-B": True}), t)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            v.main(["plan", "--facts", t.name, "--allow-held"])
        os.unlink(t.name)
        self.assertIn("allowed (optional)", self.line(buf.getvalue(), "PFIN-C"))
        self.assertIn("P-6", buf.getvalue())

    def test_provisionals_only_before_v1(self):
        rc, out = self.run_plan(facts(has_086=True, RECOVERY_V1=True, v1_integrity="none"))
        for sid in ("PSAFE-A", "PFIN-A", "PFIN-B", "PCOST-A"):
            self.assertIn("only before RECOVERY_V1", self.line(out, sid))

    def test_ledger_baseline_and_null_strings(self):
        rc, out = self.run_plan(facts(ledger="null", has_086="null"))
        self.assertIn("ledger = (none)", out)
        rc, out = self.run_plan(facts(ledger="062,063"))           # a ledger below 085 does not satisfy V1's baseline
        self.assertIn("needs 085|086", self.line(out, "RECOVERY_V1"))

    def test_unreadable_facts(self):
        rc, _ = self.run_plan({"schema": "other"})
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
