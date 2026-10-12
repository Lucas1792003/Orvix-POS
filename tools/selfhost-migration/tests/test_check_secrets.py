import contextlib
import io
import os
import tempfile
import unittest

from tests.helpers import fake_jwt
import check_secrets


class CheckSecretsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = check_secrets.main(list(argv))
        return rc, buf.getvalue()

    def _write(self, name, content, mode="w"):
        p = os.path.join(self.tmp.name, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, mode) as fh:
            fh.write(content)
        return p

    def test_clean_tree(self):
        self._write("a/clean.sql", "select 1;\n-- nothing here\n")
        rc, out = self._run(self.tmp.name)
        self.assertEqual(rc, 0)
        self.assertIn("0 secret-shaped hit(s)", out)

    def test_hits_reported_masked(self):
        # secret-shaped strings are assembled at runtime so this file itself scans clean
        pg_url = "postgres" + "://u:secretpw@db:5432/x"
        ts_key = "tskey" + "-auth-k1234567890"
        p = self._write("dump/data.sql", f"line1\nAuthorization Bearer {fake_jwt('q')}\n{pg_url}\n")
        self._write("dump/notes.txt", f"{ts_key}\nre_" + "Z9" * 12 + "\nsb_secret_abcdefghij\nsk_live_" + "k" * 20 + "\n")
        rc, out = self._run(self.tmp.name)
        self.assertEqual(rc, 1)
        self.assertIn(f"{p}:2: jwt", out)
        self.assertIn(f"{p}:3: postgres_url", out)
        self.assertNotIn("q" * 30, out)
        self.assertNotIn("secretpw", out)
        for name in ("tailscale_key", "resend_key", "sb_secret", "sk_key"):
            self.assertIn(name, out)
        self.assertIn("6 secret-shaped hit(s)", out)

    def test_binary_skipped_and_exclude(self):
        self._write("img.webp", b"RIFF\x00\x00" + fake_jwt().encode(), mode="wb")
        p = self._write("x.sql", fake_jwt() + "\n")
        rc, _ = self._run(self.tmp.name)
        self.assertEqual(rc, 1)
        rc, out = self._run(self.tmp.name, "--exclude", "*.sql")
        self.assertEqual(rc, 0, out)
        self.assertTrue(p)


if __name__ == "__main__":
    unittest.main()
