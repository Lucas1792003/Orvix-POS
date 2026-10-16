-- ============================================================
-- Migration 083: product-images upload limits + validated phone completion
--                (security finding G5, docs/selfhost-migration/phase-f/
--                org-isolation-security-audit.md §6 G5; design, measurements
--                and deploy procedure: docs/selfhost-migration/phase-f/
--                migration-083-g5.md)
--
-- WHY
--   Production's public bucket `product-images` has allowed_mime_types =
--   NULL and file_size_limit = NULL (drift from 016, which set webp/jpeg and
--   128 KB). Anyone allowed to write a path (org staff through the storage
--   policies, a phone holding a 60 s signed upload URL for its session path)
--   could store HTML/SVG/any type of any size (up to the server-wide 50 MB),
--   served publicly from the same HTTPS origin as the phone-upload page.
--
-- WHAT IT DOES
--   1. storage.buckets 'product-images':
--        allowed_mime_types = {image/jpeg,image/png,image/webp}
--        file_size_limit    = 5242880 (5 MiB)
--      public stays true (the app stores public object URLs; doc §4).
--      storage-api enforces both on its upload paths (direct, upsert,
--      signed upload URL; tested) against the DECLARED Content-Type and the
--      byte count. 5 MiB is 51x the clients' 100 KB output cap and 128x the
--      largest existing object (40,735 bytes) - doc §1.
--   2. complete_product_image_upload_session: EXECUTE revoked from anon and
--      authenticated (service_role keeps it). The phone completes through
--      the phone-upload-token Edge Function {action:"complete"}, which reads
--      the stored object back and checks its BYTES (magic number, <= 100 KB,
--      no HTML/SVG markup), deletes a refused object, and only then calls
--      this RPC with the service role. Body, signature, SECURITY DEFINER and
--      return shape are unchanged (080).
--
-- GUARD (one DO block; the transaction aborts on any failure)
--   * the bucket must exist;
--   * no existing object may violate the new rules: counted by mimetype /
--     size (missing size, size > limit, type outside the list) - names are
--     never printed;
--   * storage.objects is fingerprinted (count + md5 over every column of
--     every row, all buckets) before and after the bucket UPDATE and must be
--     identical: no object row changes;
--   * afterwards the bucket must hold exactly the new values and stay public.
--
-- DEPLOY ORDER (doc §7): FIRST the functions (phone-upload-token with the
--   completion action, phone-upload-page client), THEN this migration. A
--   phone page from before the function deploy calls the RPC directly and
--   would get 'permission denied' after 083.
--
-- ROLLBACK (doc §8)
--   UPDATE storage.buckets SET allowed_mime_types = NULL, file_size_limit = NULL
--    WHERE id = 'product-images';      -- production's pre-083 values
--   GRANT EXECUTE ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text)
--     TO anon, authenticated;
-- FORWARD RECOVERY: idempotent; re-run.
--
-- VERIFICATION
--   SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets
--    WHERE id = 'product-images';                -- t | 5242880 | {image/jpeg,image/png,image/webp}
--   SELECT has_function_privilege('anon',
--     'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE'); -- f
--   -- harness: bash supabase/tests/phase-d/run.sh   (t20_upload_limits)
--
-- NOT applied anywhere by this change.
-- ============================================================

DO $$
DECLARE
  -- the new rules (single source; t20 asserts the same values)
  c_types constant text[] := ARRAY['image/jpeg', 'image/png', 'image/webp'];
  c_limit constant bigint := 5242880;          -- 5 MiB
  v_bucket record;
  v_bad    bigint;
  v_detail text;
  v_before text;
  v_after  text;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION '083: storage schema not present';
  END IF;
  SELECT id, public INTO v_bucket FROM storage.buckets WHERE id = 'product-images';
  IF NOT FOUND THEN
    RAISE EXCEPTION '083: bucket product-images does not exist (apply 016 first)';
  END IF;

  -- every existing object must already satisfy the new rules
  SELECT coalesce(sum(n), 0),
         string_agg(format('%s x %s (max %s B)', n, coalesce(mt, '<none>'), coalesce(mx::text, '?')), ', ' ORDER BY mt)
    INTO v_bad, v_detail
    FROM (SELECT o.metadata->>'mimetype' AS mt, count(*) AS n,
                 max(CASE WHEN o.metadata->>'size' ~ '^[0-9]{1,18}$' THEN (o.metadata->>'size')::bigint END) AS mx
            FROM storage.objects o
           WHERE o.bucket_id = 'product-images'
             AND (   o.metadata IS NULL
                  OR NOT coalesce(o.metadata->>'mimetype' = ANY (c_types), false)
                  OR coalesce(o.metadata->>'size', '') !~ '^[0-9]{1,18}$'
                  -- CASE: the cast only ever sees a numeric size
                  OR CASE WHEN o.metadata->>'size' ~ '^[0-9]{1,18}$'
                          THEN (o.metadata->>'size')::bigint > c_limit ELSE true END)
           GROUP BY 1) v;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '083: % existing product-images object(s) violate the new limits: % - nothing changed', v_bad, v_detail;
  END IF;

  -- fingerprint of every object row (no names leave the database)
  SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), ''))
    INTO v_before
    FROM storage.objects o;

  UPDATE storage.buckets
     SET allowed_mime_types = c_types,
         file_size_limit    = c_limit
   WHERE id = 'product-images'
     AND (allowed_mime_types IS DISTINCT FROM c_types OR file_size_limit IS DISTINCT FROM c_limit);

  SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), ''))
    INTO v_after
    FROM storage.objects o;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION '083: storage.objects changed during the bucket update (% -> %)', v_before, v_after;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets
                  WHERE id = 'product-images' AND public
                    AND allowed_mime_types = c_types AND file_size_limit = c_limit) THEN
    RAISE EXCEPTION '083: bucket product-images does not hold the new limits after the update';
  END IF;
  RAISE NOTICE '083: product-images limits set (% B, %); storage.objects unchanged (%)', c_limit, c_types, split_part(v_before, ':', 1);
END $$;

-- completion only through the validating Edge Function (service_role)
DO $$
BEGIN
  IF to_regprocedure('public.complete_product_image_upload_session(text,text,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION '083: complete_product_image_upload_session(text,text,text,integer,text) not found (apply 080 first)';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) TO service_role;
COMMENT ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) IS
  '083: service_role only. Phones complete through the phone-upload-token Edge Function {action:"complete"}, which validates the stored bytes first (G5).';

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '083: unexpected EXECUTE grants on complete_product_image_upload_session';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
