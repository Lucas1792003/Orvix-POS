-- ============================================================
-- Migration 078: product-images storage - organization-scoped object paths
--                and path-based authorization (Phase G follow-up,
--                docs/selfhost-migration/phase-g/upload-security-and-077.md §2)
--
-- PURPOSE
--   (a) 071 left INSERT on the public `product-images` bucket permission-only:
--       any user with product:create/update of ANY organization could create
--       objects under another organization's product folder
--       (`products/<their productId>/...`).
--   (b) 071 authorizes SELECT/UPDATE/DELETE by the object's uploader
--       (owner_id/owner -> users.org_id). The 574 objects migrated from the
--       hosted project (573 `temp/<sessionId>`, 1 `products/<productId>/...`)
--       have owner = owner_id = NULL, so NO organization can list, replace or
--       delete them - not even their own ADMIN.
--   Object paths gain the organization:
--       org/<orgId>/products/<productId>/<file>   desktop upload / logo
--                                                 (logo: productId = 'brand')
--       org/<orgId>/temp/<sessionId>              phone upload (path minted by
--                                                 create_product_image_upload_session, 079)
--   and authorization follows the PATH, not the uploader.
--
-- WHAT IT DOES
--   * public.app_storage_object_org(name) -> text   (internal, service_role)
--       The organization an object path belongs to:
--         org/<org>/...            -> <org>
--         temp/<sessionId>         -> org of the session's creator, only when
--                                     product_image_upload_sessions has that id
--                                     WITH storage_path = name (server-minted)
--         products/<productId>/... -> products.org_id of that product
--         products/brand/...       -> the org whose business_profile.logo_url
--                                     ends with '/product-images/<name>' (only
--                                     when exactly one org matches)
--         anything else            -> NULL (unresolved)
--       products.image_url is deliberately NOT trusted (any catalog editor can
--       point it anywhere); sessions and products.id are server-side facts.
--       Production: all 533 products.image_url values are temp/<sessionId>
--       paths of a session row (data snapshot 2026-10-11), so all of them
--       resolve to the real organization without moving any object.
--   * public.app_storage_object_in_my_org(name) -> boolean (authenticated)
--       resolved org = app_org_id(); NULL when unresolved. Never returns the
--       org id itself.
--   * public.app_storage_can_write_path(name) -> boolean (authenticated)
--       org/<my org>/products/<productId>/<file>: the product id is not a
--         product of ANOTHER organization (new, not-yet-saved products have
--         no row yet - ProductFormPage uploads before the first save);
--       org/<my org>/temp/<sessionId>: an own (created_by = me), PENDING,
--         unexpired session whose storage_path is exactly this name;
--       legacy products/<productId>/<file> and temp/<sessionId> (clients
--         built before this change; Electron builds update on their own
--         schedule): the same two rules without the org prefix - writing
--         under ANOTHER org's product id or session is refused;
--       anything else: refused.
--   * Policies (same four names as 016/071, all TO authenticated):
--       product_images_read   SELECT USING  bucket AND manageable
--       product_images_insert INSERT CHECK  bucket AND perm AND can_write_path
--       product_images_update UPDATE USING/CHECK bucket AND perm AND manageable
--       product_images_delete DELETE USING  bucket AND perm AND manageable
--     where manageable = COALESCE(app_storage_object_in_my_org(name),
--                                 app_storage_owner_in_org(owner_id, owner))
--     i.e. the path decides when it resolves; only unresolved legacy objects
--     fall back to 071's uploader rule. UPDATE's CHECK uses the NEW name, so a
--     move/rename into another org's prefix or product folder is refused.
--     perm = app_has_perm('product:create') OR app_has_perm('product:update')
--     (unchanged since 016).
--   * Public URL reads of the public bucket do not go through RLS: every
--     existing products.image_url keeps resolving. NO object is moved,
--     renamed or rewritten; storage.objects data is not modified.
--   * Phone uploads: storage-api checks INSERT RLS when the DESKTOP (signed
--     in) calls createSignedUploadUrl (uploader.canUpload, as the caller's
--     role); the phone's uploadToSignedUrl then writes as the storage
--     superuser with owner = the desktop user. So the temp/ rule gates the
--     ISSUING of the signed upload token: no token for an expired, cancelled,
--     completed or foreign session. It cannot revoke a token already issued
--     (see the doc: signed upload tokens are stateless JWTs).
--   Guarded by to_regclass('storage.objects') (harness without storage
--   schema: helpers created, policies skipped with a NOTICE).
--
-- COMPATIBILITY
--   * Old client + 078: desktop uploads to products/<own or new productId>/
--     and logo uploads keep working; phone sessions keep working (path comes
--     from the server).
--   * New client (org/ paths) without 078: 071's INSERT is permission-only,
--     read/update/delete by uploader - works.
--   * After every client is on the org/ build, the legacy INSERT branch can be
--     dropped (doc §2, follow-up SQL; not part of this file).
--
-- ROLLBACK
--   Re-run 071 (re-creates the four policies; helper functions may stay), or
--   additionally: DROP FUNCTION public.app_storage_can_write_path(text),
--   public.app_storage_object_in_my_org(text), public.app_storage_object_org(text);
--   Objects already written under org/... keep working under 071 (uploader rule).
-- FORWARD RECOVERY
--   Idempotent (CREATE OR REPLACE, DROP POLICY IF EXISTS). Re-run the file.
--
-- VERIFICATION (self-host, storage schema present)
--   SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY 1;     -- 4 rows, {authenticated}
--   -- every migrated object resolves to the production org:
--   SELECT public.app_storage_object_org(name) AS org, count(*) FROM storage.objects
--    WHERE bucket_id = 'product-images' GROUP BY 1;
--     -- expect 573 temp objects -> the org; the 1 products/<id>/ object -> the org
--     -- if its product still exists, otherwise NULL (falls back to the uploader rule)
--   -- live: desktop image upload, phone QR upload, logo upload, product image
--   -- delete as the org ADMIN; old images still display.
--
-- Run AFTER 068 and 071. NOT applied anywhere by this change.
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_storage_object_org(p_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parts text[] := string_to_array(COALESCE(p_name, ''), '/');
  v_len   integer := COALESCE(array_length(string_to_array(COALESCE(p_name, ''), '/'), 1), 0);
  v_org   text;
  v_n     integer;
BEGIN
  IF v_len = 0 OR EXISTS (SELECT 1 FROM unnest(v_parts) AS s(p) WHERE p = '') THEN
    RETURN NULL;
  END IF;

  IF v_parts[1] = 'org' THEN
    RETURN CASE WHEN v_len >= 3 THEN v_parts[2] END;
  END IF;

  IF v_parts[1] = 'temp' AND v_len = 2 THEN
    SELECT u.org_id INTO v_org
      FROM product_image_upload_sessions s
      JOIN users u ON u.id = s.created_by
     WHERE s.id = v_parts[2] AND s.storage_path = p_name;
    RETURN v_org;
  END IF;

  IF v_parts[1] = 'products' AND v_len = 3 THEN
    SELECT p.org_id INTO v_org FROM products p WHERE p.id = v_parts[2];
    IF v_org IS NOT NULL THEN
      RETURN v_org;
    END IF;
    IF v_parts[2] = 'brand' THEN
      SELECT count(DISTINCT b.org_id), min(b.org_id) INTO v_n, v_org
        FROM business_profile b
       WHERE b.logo_url IS NOT NULL
         AND right(b.logo_url, length(p_name) + 16) = '/product-images/' || p_name;
      RETURN CASE WHEN v_n = 1 THEN v_org END;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.app_storage_object_org(text) IS
  'Organization a product-images object path belongs to (org/<org>/..., or legacy temp/<session>, products/<product>/..., products/brand/<logo>); NULL if unresolved. Internal. Migration 078.';

CREATE OR REPLACE FUNCTION public.app_storage_object_in_my_org(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN o IS NULL THEN NULL ELSE o = app_org_id() END
    FROM (SELECT public.app_storage_object_org(p_name) AS o) x;
$$;

COMMENT ON FUNCTION public.app_storage_object_in_my_org(text) IS
  'True when the object path resolves to the caller''s organization, false for another organization, NULL when unresolved. Migration 078.';

CREATE OR REPLACE FUNCTION public.app_storage_can_write_path(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parts text[] := string_to_array(COALESCE(p_name, ''), '/');
  v_len   integer := COALESCE(array_length(string_to_array(COALESCE(p_name, ''), '/'), 1), 0);
  v_org   text := app_org_id();
  v_rel   text[];
BEGIN
  IF v_org IS NULL OR v_len = 0
     OR EXISTS (SELECT 1 FROM unnest(v_parts) AS s(p) WHERE p = '' OR p = '.' OR p = '..') THEN
    RETURN false;
  END IF;

  IF v_parts[1] = 'org' THEN
    IF v_len < 4 OR v_parts[2] IS DISTINCT FROM v_org THEN
      RETURN false;
    END IF;
    v_rel := v_parts[3:v_len];
  ELSE
    v_rel := v_parts;   -- legacy layout (clients built before 078)
  END IF;

  -- products/<productId>/<file>
  IF v_rel[1] = 'products' AND array_length(v_rel, 1) = 3 THEN
    RETURN NOT EXISTS (SELECT 1 FROM products p WHERE p.id = v_rel[2] AND p.org_id IS DISTINCT FROM v_org);
  END IF;

  -- temp/<sessionId>: an own, live session minted this exact path
  IF v_rel[1] = 'temp' AND array_length(v_rel, 1) = 2 THEN
    RETURN EXISTS (
      SELECT 1 FROM product_image_upload_sessions s
       WHERE s.id = v_rel[2]
         AND s.storage_path = p_name
         AND s.created_by = app_user_id()
         AND s.status = 'PENDING'
         AND s.expires_at > now());
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.app_storage_can_write_path(text) IS
  'INSERT rule for product-images: org/<own org>/products/<product not of another org>/<file>, org/<own org>/temp/<own live session>, or the same legacy (unprefixed) shapes. Migration 078.';

REVOKE ALL ON FUNCTION public.app_storage_object_org(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_storage_object_org(text) TO service_role;
REVOKE ALL ON FUNCTION public.app_storage_object_in_my_org(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_storage_object_in_my_org(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.app_storage_can_write_path(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_storage_can_write_path(text) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '078: storage.objects not present - storage policies skipped';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_read" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_read" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'product-images'
        AND COALESCE(public.app_storage_object_in_my_org(name),
                     public.app_storage_owner_in_org(owner_id, owner))
      )
  $p$;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_insert" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_insert" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
        AND public.app_storage_can_write_path(name)
      )
  $p$;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_update" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_update" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
        AND COALESCE(public.app_storage_object_in_my_org(name),
                     public.app_storage_owner_in_org(owner_id, owner))
      )
      WITH CHECK (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
        AND COALESCE(public.app_storage_object_in_my_org(name),
                     public.app_storage_owner_in_org(owner_id, owner))
      )
  $p$;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_delete" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "product_images_delete" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'product-images'
        AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update'))
        AND COALESCE(public.app_storage_object_in_my_org(name),
                     public.app_storage_owner_in_org(owner_id, owner))
      )
  $p$;
END $$;
