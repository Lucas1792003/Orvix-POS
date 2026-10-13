import contextlib
import io
import unittest

from tests.helpers import fixture
import manifest_diff


class ManifestDiffTests(unittest.TestCase):
    def _run(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = manifest_diff.main(list(argv))
        return rc, buf.getvalue()

    def test_mismatch_detected(self):
        rc, out = self._run(fixture("manifest_hosted.json"), fixture("manifest_selfhost.txt"))
        self.assertEqual(rc, 1)
        self.assertIn("storage.objects", out)
        self.assertIn("MISMATCH", out)
        self.assertIn("3 different", out)
        self.assertNotIn("public.products", out)  # equal rows hidden by default

    def test_ignore_rules(self):
        rc, out = self._run(fixture("manifest_hosted.json"), fixture("manifest_selfhost.txt"),
                            "--ignore", "object=storage.objects",
                            "--ignore", "object=public.functions,metric=anon_executable")
        self.assertEqual(rc, 0, out)
        self.assertIn("3 ignored, 0 different", out)

    def test_missing_side(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "short.txt")
            with open(p, "w") as fh:
                fh.write("auth.users|count|10\n")
            rc, out = self._run(fixture("manifest_hosted.json"), p)
            self.assertEqual(rc, 1)
            self.assertIn("MISSING_RIGHT", out)
            rc, out = self._run(fixture("manifest_hosted.json"), p, "--ignore", "object=*")
            self.assertEqual(rc, 0)

    def test_bad_ignore(self):
        with self.assertRaises(ValueError):
            manifest_diff.parse_ignore("table=x")


if __name__ == "__main__":
    unittest.main()
