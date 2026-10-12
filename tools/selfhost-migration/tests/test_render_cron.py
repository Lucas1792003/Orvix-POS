import contextlib
import io
import os
import stat
import tempfile
import unittest
from unittest import mock

from tests.helpers import read_text, read_bytes, load_json, fake_jwt
import render_cron


class RenderCronTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "recreate_cron.sql")

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, env, *argv):
        buf = io.StringIO()
        err = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False):
            for k in ("SERVICE_ROLE_KEY", "SB_SERVICE_KEY"):
                if k not in env:
                    os.environ.pop(k, None)
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
                rc = render_cron.main(["--out", self.out, *argv])
        return rc, buf.getvalue() + err.getvalue()

    def test_render(self):
        key = fake_jwt("k")
        rc, out = self._run({"SERVICE_ROLE_KEY": key})
        self.assertEqual(rc, 0, out)
        self.assertNotIn(key, out)  # never printed
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o600)
        text = read_text(self.out)
        self.assertNotIn("{{", text)
        self.assertEqual(text.count(f"'Bearer {key}'"), 2)
        self.assertIn("'rotate-audit-log',\n  '*/5 * * * *'", text)
        self.assertIn("'weekly-sales-report',\n  '30 17 * * 0'", text)
        self.assertIn("url     := 'http://api-gw:8000/functions/v1/rotate-audit-log'", text)
        self.assertIn("url     := 'http://api-gw:8000/functions/v1/weekly-sales-report'", text)
        self.assertIn("body    := '{}'::jsonb", text)
        self.assertIn("'Content-Type', 'application/json'", text)

    def test_custom_base_url_and_overwrite_keeps_mode(self):
        with open(self.out, "w") as fh:
            fh.write("old")
        os.chmod(self.out, 0o644)
        rc, _ = self._run({"SB_SERVICE_KEY": fake_jwt("m")}, "--functions-base-url", "http://kong:8000/functions/v1/")
        self.assertEqual(rc, 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o600)
        self.assertIn("'http://kong:8000/functions/v1/rotate-audit-log'", read_text(self.out))

    def test_missing_or_bad_key(self):
        rc, out = self._run({})
        self.assertEqual(rc, 1)
        self.assertFalse(os.path.exists(self.out))
        rc, out = self._run({"SERVICE_ROLE_KEY": "not-a-jwt"})
        self.assertEqual(rc, 1)
        self.assertIn("does not look like a JWT", out)
        rc, _ = self._run({"SERVICE_ROLE_KEY": "not-a-jwt"}, "--allow-non-jwt")
        self.assertEqual(rc, 0)

    def test_mirrors_repo_schedule_files(self):
        """The template must carry the same cron expressions as supabase/schedule_*.sql."""
        repo = os.path.dirname(os.path.dirname(render_cron.HERE))
        pairs = {
            "schedule_audit_rotation.sql": ("rotate-audit-log", "'*/5 * * * *'"),
            "schedule_weekly_sales_report.sql": ("weekly-sales-report", "'30 17 * * 0'"),
        }
        template = read_text(render_cron.DEFAULT_TEMPLATE)
        for fname, (job, expr) in pairs.items():
            src = os.path.join(repo, "supabase", fname)
            if not os.path.exists(src):
                self.skipTest(f"{src} not present")
            self.assertIn(expr, read_text(src))
            self.assertIn(f"'{job}',\n  {expr}", template)


if __name__ == "__main__":
    unittest.main()
