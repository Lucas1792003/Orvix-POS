-- ============================================================
-- Migration 084: product-images - staff can no longer write objects
--                directly; every image goes through the validated upload
--                session (G5 follow-up, docs/selfhost-migration/phase-f/
--                g5-followups.md §1; finding: org-isolation-security-audit.md
--                §6 G5, residual risk 1 of migration-083-g5.md §9)
--
-- WHY
--   After 083 the phone path is byte-validated (phone-upload-token
--   {action:"complete"}), but staff with product:create/update could still
--   POST/PUT objects to product-images with their own JWT (078 policies
--   product_images_insert / product_images_update; supabase-js upload with
--   upsert). storage-api only checks the DECLARED type, so markup / polyglot
--   bytes declared image/jpeg could be stored and served from the public
--   origin. The desktop build from the G5 follow-up uploads through the same
--   validated session flow as the phone (create session -> phone-upload-token
--   signs the server-minted path with the service role -> signed PUT ->
--   validating completion). Once every till runs that build, nothing needs a
--   staff write policy any more.
--
-- WHAT IT DOES
--   1. DROP POLICY product_images_insert, product_images_update on
--      storage.objects. Afterwards no API role may INSERT or UPDATE (incl.
--      upsert, move, copy-into) product-images objects; only signed upload
--      URLs minted by phone-upload-token (service role) can create them.
--      Unchanged: product_images_read (listing/signing downloads of the own
--      org's objects) and product_images_delete (staff may still delete their
--      own org's objects, e.g. cleanup), public URL reads of the public bucket.
--   2. app_storage_can_write_path(text) stays (no policy uses it any more);
--      its COMMENT carries the 084 marker the test suites read.
--
-- READINESS GUARD (only AFTER all clients use the validated flow)
--   The rollout order is: ship the validated-upload client to every till ->
--   wait -> apply 084 (g5-followups.md §4). This migration cannot see client
--   versions, so it looks for the footprint of an old client instead: a
--   product-images object created in the last 14 days at a DIRECT-upload path
--   ((org/<org>/)products/<id>/<file>) with an uploader (owner) set - the
--   574 migrated objects have no owner. The validated flow only ever writes
--   org/<org>/temp/<session>. If such recent objects exist, the migration
--   ABORTS (count + newest timestamp only, never names). An operator who has
--   confirmed every till is updated can override for this transaction:
--       SET phf.g5_084_force = 'on';    (or PGOPTIONS='-c phf.g5_084_force=on')
--
-- GUARDS (one DO block each; the transaction aborts on any failure)
--   * storage schema present; bucket product-images exists;
--   * 083 is applied (the completion RPC carries its '083:' comment), because
--     the validated flow depends on it;
--   * RLS stays ENABLED on storage.objects (with no INSERT/UPDATE policy,
--     RLS is what denies the write);
--   * afterwards: no INSERT / UPDATE / ALL policy on storage.objects that
--     names product-images or lacks a bucket_id restriction, and the read +
--     delete policies are still present;
--   * storage.objects rows are fingerprinted (count + md5 over every row)
--     before and after: no object row changes.
--
-- IMPACT
--   * Clients built before the G5 follow-up can no longer upload product
--     images or the logo from the desktop (403 from storage), and their
--     desktop-signed phone flow (createSignedUploadUrl as the staff user,
--     pre-JIT builds) stops working too. That is why the rollout order is
--     mandatory.
--   * Existing objects, products.image_url and business_profile.logo_url are
--     untouched and keep resolving.
--
-- ROLLBACK
--   Re-run the product_images_insert and product_images_update blocks of
--   078_storage_org_paths.sql (they are idempotent), or the whole 078 file;
--   optionally COMMENT ON FUNCTION public.app_storage_can_write_path(text) back
--   to its 078 text. No data changed.
-- FORWARD RECOVERY
--   Idempotent (DROP POLICY IF EXISTS). Re-run.
--
-- VERIFICATION
--   SELECT policyname, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects' ORDER BY 1;
--     -- product_images_delete DELETE, product_images_read SELECT (2 rows)
--   -- harness: bash supabase/tests/phase-d/run.sh   (t21_validated_writes_only)
--   -- audit:   tools/security-audit/run.sh --max-migration 084
--
-- NOT applied anywhere by this change.
-- ============================================================

DO $$
DECLARE
  c_window constant interval := interval '14 days';
  v_force  boolean := lower(coalesce(current_setting('phf.g5_084_force', true), '')) IN ('on', 'true', '1', 'yes');
  v_recent bigint;
  v_newest timestamptz;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION '084: storage schema not present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'product-images') THEN
    RAISE EXCEPTION '084: bucket product-images does not exist (apply 016 first)';
  END IF;
  IF to_regprocedure('public.complete_product_image_upload_session(text,text,text,integer,text)') IS NULL
     OR coalesce(obj_description(to_regprocedure('public.complete_product_image_upload_session(text,text,text,integer,text)'), 'pg_proc'), '') NOT LIKE '083:%' THEN
    RAISE EXCEPTION '084: migration 083 is not applied (the validated completion it relies on is missing) - apply 083 and deploy the functions first';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    RAISE EXCEPTION '084: row level security is not enabled on storage.objects - refusing (without RLS, dropping policies would not deny writes)';
  END IF;

  -- readiness: no recent direct (old-client) uploads, unless the operator forces it
  SELECT count(*), max(o.created_at) INTO v_recent, v_newest
    FROM storage.objects o
   WHERE o.bucket_id = 'product-images'
     AND o.name ~ '^(org/[^/]+/)?products/[^/]+/[^/]+$'
     -- a staff upload is stamped with its uploader; the 574 migrated objects
     -- (copied 2026-10-12) and service-role writes carry no owner
     AND (o.owner IS NOT NULL OR o.owner_id IS NOT NULL)
     AND o.created_at > now() - c_window;
  IF v_recent > 0 AND NOT v_force THEN
    RAISE EXCEPTION '084: % product-images object(s) were uploaded directly by a client in the last 14 days (newest %); some till may still run a build without the validated upload flow - update every till first, or SET phf.g5_084_force = ''on'' after confirming - nothing changed',
      v_recent, v_newest;
  ELSIF v_recent > 0 THEN
    RAISE NOTICE '084: % recent direct upload(s) (newest %) - proceeding because phf.g5_084_force is on', v_recent, v_newest;
  END IF;
END $$;

DO $$
DECLARE
  v_before text;
  v_after  text;
  v_bad    text;
BEGIN
  SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), ''))
    INTO v_before FROM storage.objects o;

  EXECUTE 'DROP POLICY IF EXISTS "product_images_insert" ON storage.objects';
  EXECUTE 'DROP POLICY IF EXISTS "product_images_update" ON storage.objects';

  -- nothing else may still admit an INSERT / UPDATE into product-images
  SELECT string_agg(policyname || ' (' || cmd || ')', ', ' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND cmd IN ('INSERT', 'UPDATE', 'ALL')
     AND (   coalesce(with_check, '') || ' ' || coalesce(qual, '') LIKE '%product-images%'
          OR coalesce(with_check, '') || ' ' || coalesce(qual, '') NOT LIKE '%bucket_id%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '084: storage.objects still has write policies that can reach product-images: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname IN ('product_images_read', 'product_images_delete')) <> 2 THEN
    RAISE EXCEPTION '084: product_images_read / product_images_delete must stay in place (apply 078 first)';
  END IF;

  SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), ''))
    INTO v_after FROM storage.objects o;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION '084: storage.objects changed during the policy change (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE '084: staff INSERT/UPDATE on product-images removed; read + delete kept; storage.objects unchanged (%)', split_part(v_before, ':', 1);
END $$;

COMMENT ON FUNCTION public.app_storage_can_write_path(text) IS
  '084: no policy uses this any more - staff cannot write product-images directly; uploads go through the validated session flow (phone-upload-token). 078 INSERT rule kept for rollback.';
