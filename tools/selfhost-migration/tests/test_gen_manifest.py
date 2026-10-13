import os
import unittest

from tests.helpers import TOOLS_DIR
import gen_manifest


class GenManifestTests(unittest.TestCase):
    def test_parse_table_list(self):
        specs = gen_manifest.parse_table_list("# c\npublic.a id created_at\nauth.b id=x||y\nstorage.c\n")
        self.assertEqual([(s.qualified, s.id_expr, s.created_at) for s in specs],
                         [("public.a", "id", True), ("auth.b", "x||y", False), ("storage.c", None, False)])
        with self.assertRaises(ValueError):
            gen_manifest.parse_table_list("nodot\n")

    def test_default_list_has_project_tables(self):
        with open(gen_manifest.DEFAULT_TABLES) as fh:
            specs = gen_manifest.parse_table_list(fh.read())
        public = [s.table for s in specs if s.schema == "public"]
        self.assertEqual(len(public), 31)
        self.assertEqual(len(set(public)), 31)
        for t in ("products", "inventory", "users", "platform_admins", "unit_types"):
            self.assertIn(t, public)
        self.assertEqual([s.qualified for s in specs if s.schema == "auth"],
                         ["auth.users", "auth.identities", "auth.mfa_factors", "auth.sessions", "auth.refresh_tokens"])
        self.assertEqual([s.qualified for s in specs if s.schema == "storage"], ["storage.buckets", "storage.objects"])

    def test_sql_shape(self):
        specs = gen_manifest.parse_table_list("public.products id created_at\npublic.inventory id=product_id||':'||shop_id\n")
        sql = gen_manifest.build_manifest_sql(specs)
        self.assertEqual(sql.count("select object, metric, value from ("), 1)
        self.assertIn("""select 'public.products' as object, 'count' as metric, count(*)::text as value from "public"."products\"""", sql)
        self.assertIn("md5(coalesce(string_agg((id)::text, ',' order by (id)::text), ''))", sql)
        self.assertIn("string_agg((product_id||':'||shop_id)::text", sql)
        self.assertIn("max(created_at) at time zone 'UTC'", sql)
        self.assertIn("from auth.refresh_tokens_id_seq", sql)
        self.assertIn("pg_publication_tables where pubname = 'supabase_realtime'", sql)
        self.assertIn("from pg_policies where schemaname = 'public' and tablename = 'products'", sql)
        self.assertIn("has_function_privilege('anon', p.oid, 'EXECUTE')", sql)
        self.assertIn("supabase_migrations.schema_migrations", sql)
        self.assertTrue(sql.rstrip().endswith("order by object, metric;"))
        # exactly one statement: no stray semicolons
        self.assertEqual(sql.count(";"), 1)

    def test_committed_manifest_is_current(self):
        with open(gen_manifest.DEFAULT_TABLES) as fh:
            specs = gen_manifest.parse_table_list(fh.read())
        expected = gen_manifest.build_manifest_sql(specs)
        with open(os.path.join(TOOLS_DIR, "sql", "manifest.sql")) as fh:
            self.assertEqual(fh.read(), expected, "run gen_manifest.py to refresh sql/manifest.sql")


if __name__ == "__main__":
    unittest.main()
