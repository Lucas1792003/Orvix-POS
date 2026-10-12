import contextlib
import io
import json
import os
import tempfile
import unittest

from tests.helpers import read_text, read_bytes, load_json, fake_jwt, fixture, render_data_fixture
from _common import JWT_RE, CopyBlock, parse_dump, read_lines
import scrub_dump


class ScrubDumpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = render_data_fixture(os.path.join(self.tmp.name, "data.sql"))
        self.out = os.path.join(self.tmp.name, "data.scrubbed.sql")

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = scrub_dump.main(list(argv))
        return rc, buf.getvalue()

    def test_scrub_default(self):
        rc, out = self._run(self.data, "--out", self.out)
        self.assertEqual(rc, 0, out)
        text = read_text(self.out, encoding="utf-8")
        # a) cron.job gone from the output, present redacted in the side file
        self.assertNotIn('COPY "cron"."job" (', text)
        cron_file = os.path.join(self.tmp.name, "cron-job.redacted.txt")
        cron = read_text(cron_file, encoding="utf-8")
        self.assertIn("<REDACTED_JWT>", cron)
        self.assertEqual(cron.count("<REDACTED_JWT>"), 2)
        self.assertIsNone(JWT_RE.search(cron))
        self.assertIn("rotate-audit-log", cron)
        # b) default drop list (incl. the hosted-only auth tables and the empty one_time_tokens block)
        for t in ("cron.job_run_details", "net._http_response", "storage.objects", "storage.buckets",
                  "storage.s3_multipart_uploads", "auth.one_time_tokens", "auth.scim_tokens", "auth.mfa_challenges"):
            s, tbl = t.split(".")
            self.assertNotIn(f'COPY "{s}"."{tbl}"', text, t)
        # kept blocks are byte-identical to the input rows
        kept = {b.qualified: b for b in parse_dump(read_lines(self.out)) if isinstance(b, CopyBlock)}
        orig = {b.qualified: b for b in parse_dump(read_lines(self.data)) if isinstance(b, CopyBlock)}
        self.assertEqual(set(kept), {"auth.users", "auth.sessions", "public.products", "public.audit_logs"})
        for k in kept:
            self.assertEqual(kept[k].data_lines, orig[k].data_lines, k)
            self.assertEqual(kept[k].header_line, orig[k].header_line, k)
        # c) no JWT anywhere in the output
        self.assertIsNone(JWT_RE.search(text))
        # d) SET transaction_timeout commented out
        self.assertIn("-- SET transaction_timeout = 0;", text)
        self.assertNotRegex(text, r"(?m)^SET transaction_timeout")
        self.assertIn("SET session_replication_role = replica;", text)
        # f) counts
        self.assertIn("4 COPY block(s) kept (9 rows), 9 dropped", out)
        rep = load_json(self.out + ".report.json")
        self.assertEqual(len(rep["data"]["blocks_kept"]), 4)
        self.assertEqual(len(rep["data"]["blocks_dropped"]), 9)
        self.assertEqual(rep["data"]["cron_job_block"]["rows"], 2)
        self.assertGreater(rep["data"]["bytes_in"], rep["data"]["bytes_out"] > 0)
        dropped = {d["table"]: d for d in rep["data"]["blocks_dropped"]}
        self.assertEqual(dropped["auth.scim_tokens"]["rows"], 0)
        self.assertIn("auth.mfa_recovery_code_sets", scrub_dump.DEFAULT_DROPS)

    def test_hard_stop_on_remaining_jwt(self):
        bad = render_data_fixture(os.path.join(self.tmp.name, "bad.sql"), audit_details=f"token={fake_jwt('z')}")
        rc, out = self._run(bad, "--out", self.out)
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(self.out))
        self.assertIn("HARD STOP", out)
        self.assertIn("jwt:", out)
        self.assertNotIn("z" * 30, out)  # masked

    def test_hard_stop_on_resend_key(self):
        bad = render_data_fixture(os.path.join(self.tmp.name, "bad.sql"), audit_details="key=re_" + "Q1" * 12)
        rc, _ = self._run(bad, "--out", self.out)
        self.assertEqual(rc, 2)

    def test_extra_drop_and_no_defaults(self):
        rc, _ = self._run(self.data, "--out", self.out, "--no-default-drops", "--drop", "public.audit_logs")
        self.assertEqual(rc, 0)
        text = read_text(self.out, encoding="utf-8")
        self.assertNotIn('COPY "public"."audit_logs"', text)
        self.assertIn('COPY "storage"."objects"', text)  # defaults off
        self.assertNotIn('COPY "cron"."job" (', text)  # cron.job always handled

    def test_roles(self):
        roles_out = os.path.join(self.tmp.name, "roles.scrubbed.sql")
        rc, out = self._run("--roles", fixture("fake_roles.sql"), "--roles-out", roles_out)
        self.assertEqual(rc, 0)
        text = read_text(roles_out, encoding="utf-8")
        self.assertNotIn("cli_login_postgres", text)
        self.assertIn('CREATE ROLE "supabase_etl_admin"', text)
        self.assertIn("removed 3 line(s)", out)

    def test_schema(self):
        schema = os.path.join(self.tmp.name, "schema.sql")
        with open(schema, "w") as fh:
            fh.write('SET transaction_timeout = 0;\nCREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";\nSELECT 1;\n')
        schema_out = os.path.join(self.tmp.name, "schema.scrubbed.sql")
        rc, out = self._run("--schema", schema, "--schema-out", schema_out)
        self.assertEqual(rc, 0)
        text = read_text(schema_out)
        self.assertTrue(text.startswith("-- SET transaction_timeout"))
        self.assertIn('"pg_net" WITH SCHEMA "public"', text)  # left in place
        self.assertIn("pg_net is created WITH SCHEMA public", out)


if __name__ == "__main__":
    unittest.main()
