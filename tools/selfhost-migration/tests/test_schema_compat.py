import contextlib
import io
import os
import tempfile
import unittest

from tests.helpers import fixture, render_data_fixture
from _common import CopyBlock, parse_dump, read_lines
import schema_compat


class SchemaCompatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = render_data_fixture(os.path.join(self.tmp.name, "data.sql"))
        self.hosted = fixture("hosted_columns.json")
        self.selfhost = fixture("selfhost_columns.txt")

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = schema_compat.main(list(argv))
        return rc, buf.getvalue()

    def test_findings(self):
        hosted = schema_compat.index_columns(schema_compat.load_rows(self.hosted, default_header=schema_compat.COLS_HEADER))
        selfhost = schema_compat.index_columns(schema_compat.load_rows(self.selfhost, default_header=schema_compat.COLS_HEADER))
        f = {(x["kind"], x["table"], x["column"]): x["level"] for x in schema_compat.compare(hosted, selfhost)}
        self.assertEqual(f[("table_only_hosted", "auth.scim_tokens", "")], "WARN")
        self.assertEqual(f[("table_only_selfhost", "auth.oauth_clients", "")], "INFO")
        self.assertEqual(f[("column_only_hosted", "auth.sessions", "legacy_col")], "FAIL")
        self.assertEqual(f[("column_only_hosted", "auth.one_time_tokens", "expires_at")], "FAIL")
        self.assertEqual(f[("column_only_selfhost", "auth.sessions", "new_col")], "ok")  # nullable
        self.assertEqual(f[("column_only_selfhost", "storage.objects", "level")], "ok")  # nullable
        self.assertEqual(f[("column_only_selfhost", "storage.buckets", "type")], "ok")  # has default
        self.assertEqual(f[("type_mismatch", "storage.buckets", "file_size_limit")], "FAIL")

    def test_exit_1_without_fix(self):
        rc, out = self._run("--hosted", self.hosted, "--selfhost", self.selfhost)
        self.assertEqual(rc, 1)
        self.assertIn("column_only_hosted", out)

    def test_fix_dump(self):
        out_path = os.path.join(self.tmp.name, "data.fixed.sql")
        rc, out = self._run("--hosted", self.hosted, "--selfhost", self.selfhost,
                            "--ignore", "storage.buckets.file_size_limit",
                            "--fix-dump", self.data, "--out", out_path)
        self.assertEqual(rc, 0, out)
        self.assertIn("removed column(s) legacy_col from auth.sessions (2 rows rewritten)", out)
        self.assertIn("removed column(s) expires_at from auth.one_time_tokens (0 rows rewritten)", out)
        self.assertIn("dropped COPY block auth.scim_tokens (0 rows)", out)

        before = {b.qualified: b for b in parse_dump(read_lines(self.data)) if isinstance(b, CopyBlock)}
        after = {b.qualified: b for b in parse_dump(read_lines(out_path)) if isinstance(b, CopyBlock)}
        self.assertNotIn("auth.scim_tokens", after)
        sess = after["auth.sessions"]
        self.assertEqual(sess.columns, ["id", "user_id", "created_at", "updated_at", "user_agent", "ip"])
        self.assertNotIn("legacy_col", sess.header_line if False else sess.render_header())
        row0 = sess.data_lines[0].split("\t")
        self.assertEqual(len(row0), 6)
        self.assertEqual(row0[4], "Mozilla/5.0 (tab\\tinside) back\\\\slash")  # escaped \t and \\ untouched
        self.assertEqual(row0[5], "10.0.0.1")
        self.assertEqual(sess.data_lines[1].split("\t"), [
            "aaaaaaaa-0000-0000-0000-000000000002", "22222222-2222-2222-2222-222222222222",
            "2026-02-02 00:00:00+00", "\\N", "\\N", "\\N"])
        ott = after["auth.one_time_tokens"]
        self.assertNotIn("expires_at", ott.columns)
        self.assertEqual(ott.data_lines, [])
        # untouched blocks are byte-identical (public.* is never rewritten)
        for k in ("auth.users", "public.products", "public.audit_logs", "cron.job", "storage.objects"):
            self.assertEqual(after[k].data_lines, before[k].data_lines, k)
            self.assertEqual(after[k].columns, before[k].columns, k)
        self.assertEqual(after["public.products"].header_line, before["public.products"].header_line)

    def test_fix_dump_still_fails_on_other_fail(self):
        out_path = os.path.join(self.tmp.name, "data.fixed.sql")
        rc, out = self._run("--hosted", self.hosted, "--selfhost", self.selfhost, "--fix-dump", self.data, "--out", out_path)
        self.assertEqual(rc, 1)  # the type mismatch is not fixable
        self.assertIn("1 FAIL", out)

    def test_strip_columns_rejects_bad_row(self):
        b = CopyBlock("auth", "x", ["a", "b"], "", ["1\t2\t3"])
        with self.assertRaises(ValueError):
            schema_compat.strip_columns(b, {"b"})

    def test_constraints(self):
        h = os.path.join(self.tmp.name, "ch.json")
        s = os.path.join(self.tmp.name, "cs.txt")
        with open(h, "w") as fh:
            fh.write('{"rows":[{"table_schema":"auth","table_name":"users","kind":"index","name":"users_email_idx","detail":""}]}')
        with open(s, "w") as fh:
            fh.write("table_schema|table_name|kind|name|detail\nauth|users|index|users_email_idx|\nauth|users|index|users_new_idx|\n(2 rows)\n")
        rc, out = self._run("--hosted", self.hosted, "--selfhost", self.selfhost, "--constraints-hosted", h,
                            "--constraints-selfhost", s, "--ignore", "storage.buckets.file_size_limit",
                            "--ignore", "auth.sessions.legacy_col", "--ignore", "auth.one_time_tokens.expires_at")
        self.assertEqual(rc, 0, out)
        self.assertIn("constraint_only_selfhost", out)
        self.assertIn("index:users_new_idx", out)


if __name__ == "__main__":
    unittest.main()
