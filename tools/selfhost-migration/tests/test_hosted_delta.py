"""hosted-delta.sql + hosted_delta_compare.py.

Fixtures in fixtures/hosted_delta/ were produced by running the real
hosted-delta.sql and sql/manifest.sql against a throwaway local PostgreSQL 16
with the hosted column layout (migration 061, from the export's schema dump)
and synthetic rows: delta_same.json = nothing changed since the manifest;
delta_changed.json = after one sale (+1 sale_items row), one product_units
update, one inventory row deleted and re-created, a shift closed, a sign-in and
storage reads (last_accessed_at, which must NOT count).
"""
import contextlib
import csv
import io
import json
import os
import re
import tempfile
import unittest

from tests.helpers import TOOLS_DIR, fixture, read_text
import gen_manifest
import hosted_delta_compare as hdc

SQL = os.path.join(TOOLS_DIR, "hosted-delta.sql")
MANIFEST = fixture("hosted_delta/manifest_mock.txt")
SAME = fixture("hosted_delta/delta_same.json")
CHANGED = fixture("hosted_delta/delta_changed.json")


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = hdc.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


def write_tmp(d, name, text):
    p = os.path.join(d, name)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)
    return p


def statuses(out):
    return {m.group(1): m.group(2) for m in re.finditer(r"^(\w+\.\w+)\s+(NO-CHANGE|CHANGED|INFO)\b", out, re.M)}


class SqlShapeTests(unittest.TestCase):
    def setUp(self):
        self.sql = read_text(SQL)
        self.code = "\n".join(l.split("--", 1)[0] for l in self.sql.splitlines())

    def test_read_only_first_statement(self):
        first = next(s.strip() for s in self.code.split(";") if s.strip())
        self.assertEqual(first.lower(), "set transaction read only")
        self.assertIn("'read_only', current_setting('transaction_read_only')", self.code)

    def test_no_writes_or_ddl(self):
        for kw in ("insert", "update", "delete", "truncate", "create", "alter", "drop", "grant",
                   "revoke", "copy", "merge", "call", "do", "vacuum", "lock", "commit", "begin"):
            self.assertIsNone(re.search(rf"\b{kw}\b", self.code, re.I), kw)

    def test_no_row_values_selected(self):
        # only aggregates are built into the per-table query; no personal column is named
        for col in ("email", "phone", "raw_user_meta_data", "encrypted_password", "metadata", "image_url", "receipt_no"):
            self.assertIsNone(re.search(rf"\b{col}\b", self.code), col)
        self.assertIn("select count(*) as n", self.code)

    def test_expected_list_matches_manifest_tables(self):
        with open(gen_manifest.DEFAULT_TABLES) as fh:
            specs = gen_manifest.parse_table_list(fh.read())
        want = {(s.schema, s.table, s.id_expr) for s in specs
                if s.schema == "public" or s.qualified in hdc.SCOPE_EXTRA}
        block = self.code.split("expected(s, t, id_expr) as (values", 1)[1].split("\ncols as (", 1)[0]
        got = set()
        for m in re.finditer(r"\('(\w+)', '(\w+)', (?:'([^']*)'|\$\$(.*?)\$\$)\)", block):
            got.add((m.group(1), m.group(2), m.group(3) if m.group(3) is not None else m.group(4)))
        self.assertEqual(got, want)
        self.assertEqual(len(want), 36)

    def test_cutoff_is_export_time(self):
        self.assertIn("timestamptz '2026-10-11 23:47:00+00'", self.code)
        self.assertIn(f"'cutoff', '{hdc.CUTOFF}'", self.code)


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.raw = read_text(SAME).strip()

    def test_bare_cell(self):
        self.assertEqual(hdc.parse_pasted(self.raw)["kind"], hdc.KIND)

    def test_with_surrounding_text(self):
        d = hdc.parse_pasted("here it is:\n\n" + self.raw + "\n\nthanks")
        self.assertEqual(d["n_tables"], len(d["tables"]))

    def test_editor_copy_as_json(self):
        d = hdc.parse_pasted(json.dumps([{"hosted_delta": self.raw}]))
        self.assertEqual(d["kind"], hdc.KIND)

    def test_editor_csv_export(self):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["hosted_delta"])
        w.writerow([self.raw])
        self.assertIn('""kind""', buf.getvalue())
        self.assertEqual(hdc.parse_pasted(buf.getvalue())["kind"], hdc.KIND)

    def test_not_our_output(self):
        with self.assertRaises(hdc.InputError):
            hdc.parse_pasted('{"rows": [{"count": 3}]}')

    def test_truncated(self):
        with self.assertRaises(hdc.InputError):
            hdc.parse_pasted(self.raw[: len(self.raw) // 2])


class CompareTests(unittest.TestCase):
    def test_no_change(self):
        rc, out, _ = run(SAME, "--manifest", MANIFEST)
        self.assertEqual(rc, 0, out)
        self.assertIn("VERDICT: NO DELTA - all 36 tables match the export. OK to cut over", out)
        st = statuses(out)
        self.assertEqual(len(st), 36)
        self.assertEqual(set(st.values()), {"NO-CHANGE"})
        self.assertNotIn("public.functions", out)  # manifest non-table objects are not compared

    def test_changed(self):
        rc, out, _ = run(CHANGED, "--manifest", MANIFEST)
        self.assertEqual(rc, 1, out)
        st = statuses(out)
        changed = sorted(k for k, v in st.items() if v == "CHANGED")
        self.assertEqual(changed, ["auth.users", "public.inventory", "public.product_units",
                                   "public.sale_items", "public.sales", "public.shifts"])
        self.assertRegex(out, r"public\.sales\s+CHANGED \(\+1 since cutoff\)\s+0->1\s+\+1 created since cutoff")
        self.assertRegex(out, r"public\.sale_items\s+CHANGED \(\+1 since cutoff\)\s+2->3\s+count 2 -> 3 \(\+1\)")
        self.assertRegex(out, r"public\.product_units\s+CHANGED .* 1 updated since cutoff")
        self.assertRegex(out, r"public\.inventory\s+CHANGED .* same count but different ids")
        self.assertRegex(out, r"public\.shifts\s+CHANGED .* another timestamp after cutoff")
        self.assertEqual(st["storage.objects"], "NO-CHANGE")  # reads (last_accessed_at) are not changes
        self.assertIn("VERDICT: CHANGED - 6 table(s)", out)
        self.assertIn("Needs a delta migration plan", out)

    def test_json_output(self):
        rc, out, _ = run(CHANGED, "--manifest", MANIFEST, "--json")
        self.assertEqual(rc, 1)
        doc = json.loads(out)
        self.assertEqual(doc["verdict"], "CHANGED")
        self.assertEqual(len(doc["tables"]), 36)

    def _delta(self):
        return json.loads(read_text(SAME))

    def test_created_after_cutoff_but_in_export(self):
        d = self._delta()
        d["tables"]["public.products"]["c_after"] = 2  # same count, same ids
        res = {r["table"]: r for r in hdc.compare(d, hdc.load_manifest(MANIFEST))}
        self.assertEqual(res["public.products"]["status"], "NO-CHANGE")
        self.assertIn("in the export", res["public.products"]["notes"][0])

    def test_missing_and_new_tables(self):
        d = self._delta()
        del d["tables"]["auth.mfa_factors"]
        d["missing"] = ["auth.mfa_factors"]
        d["tables"]["public.app_config"] = {"n": 0, "ids": ""}
        d["tables"]["public.idempotency_keys"] = {"n": 4, "ids": "x", "max_c": "2026-10-13T00:00:00.000000Z", "c_after": 4}
        d["n_tables"] = len(d["tables"])
        res = {r["table"]: r for r in hdc.compare(d, hdc.load_manifest(MANIFEST))}
        self.assertEqual(res["auth.mfa_factors"]["status"], "CHANGED")
        self.assertIn("missing on hosted", res["auth.mfa_factors"]["reasons"][0])
        self.assertEqual(res["public.app_config"]["status"], "INFO")
        self.assertEqual(res["public.idempotency_keys"]["status"], "CHANGED")

    def test_input_problems_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = self._delta()
            d["n_tables"] = 99
            rc, _, err = run(write_tmp(tmp, "t.json", json.dumps(d)), "--manifest", MANIFEST)
            self.assertEqual(rc, 2)
            self.assertIn("truncated", err)
            d = self._delta()
            d["cutoff"] = "2026-10-12T00:00:00Z"
            rc, _, err = run(write_tmp(tmp, "c.json", json.dumps(d)), "--manifest", MANIFEST)
            self.assertEqual(rc, 2)
            self.assertIn("cutoff", err)
            rc, _, err = run(SAME, "--manifest", os.path.join(tmp, "nope.json"))
            self.assertEqual(rc, 2)

    def test_not_read_only_is_noted(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = self._delta()
            d["read_only"] = "off"
            rc, out, _ = run(write_tmp(tmp, "r.json", json.dumps(d)), "--manifest", MANIFEST)
            self.assertEqual(rc, 0)
            self.assertIn("did not report a read-only transaction", out)

    def test_cli_json_manifest_shape(self):
        # the real export manifest is CLI JSON ({"rows": [...]}); same numbers -> same verdict
        rows = []
        for line in read_text(MANIFEST).splitlines():
            obj, metric, value = line.split("|", 2)
            rows.append({"object": obj, "metric": metric, "value": value})
        with tempfile.TemporaryDirectory() as tmp:
            m = write_tmp(tmp, "m.json", json.dumps({"boundary": "x", "rows": rows, "warning": "w"}))
            rc, out, _ = run(SAME, "--manifest", m)
            self.assertEqual(rc, 0, out)


if __name__ == "__main__":
    unittest.main()
