-- ============================================================
-- Migration 071: organization isolation, part 4 of 4 - product-images
--                storage policies (Phase G backend security audit:
--                docs/selfhost-migration/phase-g/org-isolation-audit.md)
--
-- PURPOSE
--   016 gates writes on the public `product-images` bucket by permission only
--   (`app_has_perm('product:create' OR 'product:update')`) and lets EVERY
--   role (anon included) SELECT - i.e. list - every object. Object paths are
--   `products/<productId>/<ts>.<ext>`, `products/brand/...` (business logo)
--   and `temp/<sessionId>` (phone uploads), none of which carries an org. So
--   a MANAGER of org A can list org B's objects (product ids, upload volume),
--   overwrite them (the app uploads with `upsert: true`) or delete them.
--   The bucket itself stays public: a thumbnail URL is embedded in product
--   rows and receipts and is not sensitive (docs/03-database-security.md);
--   what changes is who can enumerate, replace and delete objects.
--
-- WHAT IT DOES
--   * public.app_storage_owner_in_org(owner_id, owner): true when the object
--     was uploaded by a user of the caller's organization (storage-api stamps
--     `owner_id`/`owner` with the uploader's auth uid; for a phone upload
--     through a signed upload URL that is the desktop user who created the
--     session).
--   * product_images_read   SELECT  TO authenticated: bucket AND own-org owner
--                           (was `TO public USING (bucket)`; public-URL reads
--                           of a public bucket do not go through this policy).
--   * product_images_insert INSERT: unchanged terms (bucket AND permission).
--   * product_images_update UPDATE: USING and WITH CHECK add own-org owner
--                           (upsert onto another org's path is refused).
--   * product_images_delete DELETE: USING adds own-org owner.
--   Guarded by `to_regclass('storage.objects')`: on a database without the
--   storage schema (the Phase D harness image, a bare Postgres) the policy
--   part is skipped with a NOTICE and the helper is still created.
--
-- NOT COVERED (frontend change, see the audit doc): org-prefixed object
--   paths (`<orgId>/products/...`) would let INSERT be scoped too; today a
--   fresh path under another org's product id can still be created (it does
--   not affect that org's rows).
--
-- ROLLBACK
--   Re-run the four CREATE POLICY blocks of 016 (idempotent), then
--   DROP FUNCTION public.app_storage_owner_in_org(text, uuid).
--
-- VERIFICATION (on the self-host, storage schema present)
--   SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY 1;
--     -- 4 rows, all TO {authenticated}
--   -- live: upload a product image from the desktop, a phone upload through
--   -- the QR flow, and a logo upload from Profile - all three must still work.
--
-- Run AFTER 068. Idempotent (CREATE OR REPLACE / DROP POLICY IF EXISTS).
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_storage_owner_in_org(p_owner_id text, p_owner uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u
     WHERE u.auth_id::text = COALESCE(p_owner_id, p_owner::text)
       AND u.org_id = app_org_id()
  );
$$;
REVOKE ALL ON FUNCTION public.app_storage_owner_in_org(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_storage_owner_in_org(text, uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '071: storage.objects not present - storage policies skipped';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_read" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_read" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'product-images'
        AND public.app_storage_owner_in_org(owner_id, owner)
      )
  $p$;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_insert" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_insert" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
      )
  $p$;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_update" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_update" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
        AND public.app_storage_owner_in_org(owner_id, owner)
      )
      WITH CHECK (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
        -- review fix: the updated row must still be owned inside the org
        -- (storage-api re-stamps owner with the uploader on upsert)
        AND public.app_storage_owner_in_org(owner_id, owner)
      )
  $p$;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_delete" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_delete" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
        AND public.app_storage_owner_in_org(owner_id, owner)
      )
  $p$;
END $$;
