import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from tests.helpers import read_text, read_bytes, load_json, FakeStorage, make_objects_dir, sha256_file
import upload_objects
import verify_objects


class UploadVerifyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = FakeStorage(key="test-service-key").start()

    @classmethod
    def tearDownClass(cls):
        cls.store.stop()

    def setUp(self):
        self.store.objects.clear()
        self.store.attempts.clear()
        self.store.fail_first.clear()
        self.store.corrupt.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir, self.rows = make_objects_dir(self.tmp.name)
        self.meta = os.path.join(self.tmp.name, "storage-objects.json")
        with open(self.meta, "w") as fh:
            json.dump({"rows": self.rows}, fh)
        self.report = os.path.join(self.tmp.name, "upload-report.json")
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def _upload(self, *extra, key="test-service-key"):
        buf = io.StringIO()
        env = {"SB_SERVICE_KEY": key} if key is not None else {}
        with mock.patch.dict(os.environ, env, clear=False), contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            if key is None:
                os.environ.pop("SB_SERVICE_KEY", None)
            rc = upload_objects.main([self.dir, self.meta, self.store.base_url, "--report", self.report,
                                      "--backoff", "0.01", *extra])
        return rc, buf.getvalue()

    def _verify(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = verify_objects.main(list(argv))
        return rc, buf.getvalue()

    def test_dry_run_makes_no_calls(self):
        rc, out = self._upload("--dry-run", key=None)
        self.assertEqual(rc, 0)
        self.assertIn("dry-run: 3 to upload, 0 skipped", out)
        self.assertEqual(self.store.objects, {})

    def test_missing_key(self):
        rc, _ = self._upload(key=None)
        self.assertEqual(rc, 1)

    def test_upload_then_verify_roundtrip(self):
        # a missing local file -> skipped; one transient 500 -> retried
        self.rows.append({"name": "temp/missing.webp", "mime": "image/webp", "size": "1", "cc": ""})
        with open(self.meta, "w") as fh:
            json.dump({"rows": self.rows}, fh)
        self.store.fail_first.add("temp/abc/two.webp")

        rc, out = self._upload()
        self.assertEqual(rc, 0, out)
        self.assertIn("uploaded 3, skipped 1, failed 0", out)
        self.assertEqual(self.store.attempts["temp/abc/two.webp"], 2)
        obj = self.store.objects["temp/abc/one.webp"]
        self.assertEqual(obj["content_type"], "image/webp")
        self.assertEqual(obj["cache_control"], "max-age=3600")
        self.assertEqual(obj["upsert"], "true")
        self.assertEqual(obj["body"], read_bytes(os.path.join(self.dir, "temp", "abc", "one.webp")))
        self.assertIsNone(self.store.objects["products/p-003.jpg"]["cache_control"])
        rep = load_json(self.report)
        self.assertEqual(rep["counts"], {"uploaded": 3, "skipped": 1, "failed": 0})
        two = next(r for r in rep["results"] if r["name"] == "temp/abc/two.webp")
        self.assertEqual(two["attempts"], 2)
        self.assertNotIn("test-service-key", json.dumps(rep))

        # --only-missing skips everything now
        rc, out = self._upload("--only-missing")
        self.assertEqual(rc, 0)
        self.assertIn("uploaded 0, skipped 4", out)

        # manifest from the local dir, then verify through the public URLs
        manifest = os.path.join(self.tmp.name, "storage-manifest.sha256")
        rc, out = self._verify("--make-manifest", self.dir, "--out", manifest)
        self.assertEqual(rc, 0)
        lines = read_text(manifest).splitlines()
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0], f"{sha256_file(os.path.join(self.dir, 'products', 'p-003.jpg'))}  products/p-003.jpg")

        vreport = os.path.join(self.tmp.name, "verify-report.json")
        rc, out = self._verify(manifest, self.store.base_url, "--dir", self.dir, "--objects", self.meta, "--report", vreport)
        self.assertEqual(rc, 0, out)
        self.assertIn("3/3 ok", out)

        # md5 manifest with a bucket prefix (runbook style) also works
        import hashlib
        md5m = os.path.join(self.tmp.name, "storage-manifest.md5")
        with open(md5m, "w") as fh:
            for r in self.rows[:3]:
                p = os.path.join(self.dir, *r["name"].split("/"))
                fh.write(f"{hashlib.md5(read_bytes(p)).hexdigest()}  product-images/{r['name']}\n")
        rc, out = self._verify(md5m, self.store.base_url, "--report", vreport)
        self.assertEqual(rc, 0, out)
        self.assertIn("3/3 ok", out)

        # corrupted object and a missing object -> failure
        self.store.corrupt.add("temp/abc/one.webp")
        del self.store.objects["products/p-003.jpg"]
        rc, out = self._verify(manifest, self.store.base_url, "--report", vreport)
        self.assertEqual(rc, 1)
        self.assertIn("1/3 ok", out)
        self.assertIn("FAIL temp/abc/one.webp: sha256 mismatch", out)
        self.assertIn("FAIL products/p-003.jpg: HTTP 404", out)

    def test_wrong_key_fails_without_retry(self):
        rc, out = self._upload(key="wrong")
        self.assertEqual(rc, 1)
        self.assertIn("failed 3", out)
        self.assertEqual(max(self.store.attempts.values(), default=0), 0)  # 401 happens before the store counts
        rep = load_json(self.report)
        self.assertTrue(all(r["attempts"] == 1 for r in rep["results"]))
        self.assertIn("HTTP 401", rep["results"][0]["error"])

    def test_retries_exhausted(self):
        class AlwaysFail(upload_objects.Uploader):
            def _request(self, method, url, data=None, headers=None):
                raise OSError("connection refused")

        sleeps = []
        up = AlwaysFail("http://127.0.0.1:1", "b", "k", retries=3, backoff=1.0, sleep=sleeps.append)
        r = up.upload("x", b"1", "image/webp", None)
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["attempts"], 4)
        self.assertEqual(sleeps, [1.0, 2.0, 4.0])


if __name__ == "__main__":
    unittest.main()
