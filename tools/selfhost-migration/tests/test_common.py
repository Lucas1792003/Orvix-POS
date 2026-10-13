import os
import tempfile
import unittest

from tests.helpers import fake_jwt, render_data_fixture
from _common import CopyBlock, TextLine, find_secrets, parse_dump, parse_rows, read_lines, split_column_list, SECRET_PATTERNS


class ParseDumpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = render_data_fixture(os.path.join(self.tmp.name, "data.sql"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_blocks_and_rows(self):
        segs = list(parse_dump(read_lines(self.data)))
        blocks = {s.qualified: s for s in segs if isinstance(s, CopyBlock)}
        self.assertEqual(
            set(blocks),
            {"auth.users", "auth.sessions", "auth.one_time_tokens", "auth.scim_tokens", "auth.mfa_challenges",
             "cron.job", "cron.job_run_details", "net._http_response", "public.products", "public.audit_logs",
             "storage.buckets", "storage.objects", "storage.s3_multipart_uploads"},
        )
        self.assertEqual(len(blocks["public.products"].data_lines), 3)
        self.assertEqual(len(blocks["auth.scim_tokens"].data_lines), 0)  # empty block: header then \.
        self.assertTrue(all(b.terminated for b in blocks.values()))
        # a data line starting with '--' is data, not a comment
        self.assertTrue(blocks["public.products"].data_lines[0].split("\t")[2].startswith("-- not a comment"))
        # a data line that is '\\.' (escaped backslash + dot) must not terminate the block
        self.assertEqual(blocks["public.products"].data_lines[2].split("\t")[2], "\\\\.")
        # trailing SQL after the last block still arrives as text
        texts = [s.text for s in segs if isinstance(s, TextLine)]
        self.assertIn("RESET ALL;", texts)
        self.assertIn("SET session_replication_role = replica;", texts)

    def test_columns_parsed(self):
        segs = list(parse_dump(read_lines(self.data)))
        prod = next(s for s in segs if isinstance(s, CopyBlock) and s.table == "products")
        self.assertEqual(prod.columns[:3], ["id", "sku", "name"])
        self.assertEqual(prod.render_header(), prod.header_line)

    def test_unterminated_block_flagged(self):
        lines = ['COPY "public"."x" ("id") FROM stdin;', "1", "2"]
        segs = list(parse_dump(lines))
        self.assertEqual(len(segs), 1)
        self.assertFalse(segs[0].terminated)

    def test_split_column_list_quotes(self):
        self.assertEqual(split_column_list('"id", "a,b", c, "we""ird"'), ["id", "a,b", "c", 'we"ird'])


class ParseRowsTests(unittest.TestCase):
    def test_cli_json(self):
        rows = parse_rows('{"rows":[{"object":"a","metric":"count","value":3},{"object":"b","metric":"x","value":null}]}')
        self.assertEqual(rows, [{"object": "a", "metric": "count", "value": "3"}, {"object": "b", "metric": "x", "value": ""}])

    def test_json_list(self):
        rows = parse_rows('[{"a":1}]')
        self.assertEqual(rows, [{"a": "1"}])

    def test_psql_with_header_and_footer(self):
        rows = parse_rows("object|metric|value\nx|count|1\n(1 row)\n", default_header=["object", "metric", "value"])
        self.assertEqual(rows, [{"object": "x", "metric": "count", "value": "1"}])

    def test_psql_tuples_only(self):
        rows = parse_rows("x|count|1\ny|names|a|b\n", default_header=["object", "metric", "value"])
        self.assertEqual(rows[1]["value"], "a|b")  # separator inside the last column survives


class SecretPatternTests(unittest.TestCase):
    def test_patterns(self):
        hits = {n for n, _ in find_secrets(f"Authorization Bearer {fake_jwt()}", SECRET_PATTERNS)}
        self.assertEqual(hits, {"jwt"})
        # assembled at runtime so this file itself scans clean with check_secrets.py
        self.assertEqual({n for n, _ in find_secrets("postgres" + "://user:pw@host/db")}, {"postgres_url"})
        self.assertEqual({n for n, _ in find_secrets("tskey" + "-auth-abc123")}, {"tailscale_key"})
        self.assertEqual({n for n, _ in find_secrets("re_" + "A1" * 12)}, {"resend_key"})
        self.assertEqual({n for n, _ in find_secrets("sb_secret_" + "x" * 10)}, {"sb_secret"})
        self.assertEqual({n for n, _ in find_secrets("sk_live_" + "x" * 20)}, {"sk_key"})
        self.assertEqual(find_secrets("select 1 from products where id = 'p-001'"), [])
        # masked output never contains the full token
        for _, masked in find_secrets(fake_jwt()):
            self.assertNotIn("a" * 30, masked)


if __name__ == "__main__":
    unittest.main()
