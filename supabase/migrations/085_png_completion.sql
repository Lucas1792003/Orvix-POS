-- ============================================================
-- Migration 085: phone-upload completion accepts image/png
--                (finding: docs/selfhost-migration/evidence/G10/
--                2026-10-16-migration-083-headers.md "Finding"; design,
--                tests and deploy order: docs/selfhost-migration/phase-f/
--                migration-085-png.md)
--
-- WHY
--   083 allows image/jpeg, image/png and image/webp in the product-images
--   bucket and the phone-upload-token function validates PNG bytes, but
--   complete_product_image_upload_session (075/079/080) still accepted only
--   image/webp and image/jpeg. A valid PNG was therefore refused at
--   completion. Supported types are now the same everywhere: JPEG, PNG, WebP.
--
-- WHAT IT DOES
--   complete_product_image_upload_session: the 080 body (= production's,
--   md5(prosrc) 7c9c65a96a057189ee84ff850183b627) with exactly ONE change,
--   made twice: the type list of the caller-value check and of the
--   stored-object check becomes ('image/webp', 'image/jpeg', 'image/png').
--   The size rule is unchanged and the same for every type (1..102400 bytes,
--   from the object's own metadata). Signature, return shape, SECURITY
--   DEFINER, search_path, owner (postgres) unchanged. Grants re-asserted
--   exactly as 083 left them: EXECUTE for service_role only (the function
--   phone-upload-token is the only caller). The COMMENT keeps its '083:'
--   prefix (084's readiness guard looks for it) and names 085.
--   Nothing else: no table, row, bucket or policy is touched. Does NOT
--   depend on 084; applies on 083 and on 083+084 alike.
--
-- GUARDS (DO blocks; production applies with --single-transaction, so any
--   failure rolls everything back)
--   * before: the function exists, 083 is applied (comment '083:', no
--     anon/authenticated EXECUTE), and its current body is either the 080
--     body or this 085 body (by md5) - any other body (drift, a hotfix)
--     aborts with nothing changed; for the 080 body, the 085 body must be
--     exactly the 080 body with the two type-list replacements (proves the
--     change is only the type check);
--   * product_image_upload_sessions and storage.objects are fingerprinted
--     (count + md5 over every column of every row) before and after: no
--     session or object row changes;
--   * after: body md5 = the 085 body, owner postgres, SECURITY DEFINER,
--     search_path=public, EXECUTE service_role only, comment '083:...085'.
--
-- DEPLOY ORDER (doc "Deploy order"): either order is safe; recommended
--   FIRST the phone-upload-token function (PNG byte check + cleanup of
--   refused objects), THEN this migration. With the new function on 083 a
--   PNG is refused by the RPC and the function deletes the object; with the
--   old function on 085 a PNG is refused by the old byte check (and deleted).
--
-- ROLLBACK (doc "Rollback")
--   Re-run 080's block "3/5 complete_product_image_upload_session" (the 080
--   body), then 083's grant block (REVOKE ... FROM PUBLIC, anon,
--   authenticated; GRANT ... TO service_role; COMMENT '083: ...'). No data
--   changed. Sessions completed with image/png stay COMPLETED (valid images).
-- FORWARD RECOVERY: idempotent (CREATE OR REPLACE; the guard accepts the 085
--   body). Re-run.
--
-- VERIFICATION
--   SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.complete_product_image_upload_session(text,text,text,integer,text)'::regprocedure;
--     -- dc822a6435c3e512acdc933c4a2995a8
--   SELECT has_function_privilege('anon', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE');  -- f | t
--   -- harness: bash supabase/tests/phase-d/run.sh   (t22_png_completion)
--
-- NOT applied anywhere by this change.
-- ============================================================

DO $$
DECLARE
  c_sig     constant text := 'public.complete_product_image_upload_session(text,text,text,integer,text)';
  c_md5_080 constant text := '7c9c65a96a057189ee84ff850183b627';
  c_md5_085 constant text := 'dc822a6435c3e512acdc933c4a2995a8';
  v_src text;
  v_md5 text;
BEGIN
  IF to_regprocedure(c_sig) IS NULL THEN
    RAISE EXCEPTION '085: % not found (apply 080 and 083 first)', c_sig;
  END IF;
  IF coalesce(obj_description(to_regprocedure(c_sig), 'pg_proc'), '') NOT LIKE '083:%'
     OR has_function_privilege('anon', c_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', c_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '085: migration 083 is not applied (completion must be service_role only first) - nothing changed';
  END IF;
  SELECT prosrc, md5(prosrc) INTO v_src, v_md5 FROM pg_proc WHERE oid = to_regprocedure(c_sig);
  IF v_md5 NOT IN (c_md5_080, c_md5_085) THEN
    RAISE EXCEPTION '085: complete_product_image_upload_session has an unexpected body (md5 %, expected the 080 body % or the 085 body %) - nothing changed', v_md5, c_md5_080, c_md5_085;
  END IF;
  IF v_md5 = c_md5_080
     AND md5(replace(v_src, $q$NOT IN ('image/webp', 'image/jpeg')$q$, $q$NOT IN ('image/webp', 'image/jpeg', 'image/png')$q$)) <> c_md5_085 THEN
    RAISE EXCEPTION '085: the 085 body is not the 080 body with only the type list changed';
  END IF;
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION '085: storage.objects does not exist';
  END IF;
  PERFORM set_config('phf.m085_rows',
    (SELECT count(*)::text || ':' || md5(coalesce(string_agg(s::text, E'\n' ORDER BY s.id), '')) FROM public.product_image_upload_sessions s)
    || '/' ||
    (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o),
    false);
  RAISE NOTICE '085: current completion body is the % body', CASE v_md5 WHEN c_md5_080 THEN '080' ELSE '085 (re-run)' END;
END $$;

-- the 080 body; only the two type lists differ
CREATE OR REPLACE FUNCTION "public"."complete_product_image_upload_session"("p_token" "text", "p_storage_path" "text", "p_public_url" "text", "p_bytes" integer, "p_mime_type" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_session product_image_upload_sessions;
  -- 080: what is stored and returned comes from the server, not the caller
  v_object_meta jsonb;
  v_public_url text;
  v_bytes integer;
  v_mime_type text;
BEGIN
  IF COALESCE(length(p_token), 0) < 32 THEN
    RAISE EXCEPTION 'Invalid upload link';
  END IF;

  SELECT * INTO v_session
    FROM product_image_upload_sessions
   WHERE token_hash = product_image_upload_token_hash(p_token)
   FOR UPDATE;

  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Invalid upload link';
  END IF;

  IF v_session.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Upload link is no longer active';
  END IF;

  IF v_session.expires_at <= now() THEN
    -- 075: reject with the same message as every other inactive session.
    -- No UPDATE here: the RAISE rolls back the whole call, so a status
    -- write could never persist (the 019 body's EXPIRED stamp was lost).
    -- Expiry is derived from expires_at by every reader, and the stamping
    -- readers (get_product_image_upload_session_status/_by_token) persist it.
    RAISE EXCEPTION 'Upload link is no longer active';
  END IF;

  -- 080: p_storage_path is only ever compared with the session's own,
  -- server-minted path, never used. Rejected first, explicitly: NULL or
  -- empty, '?', '#', '%' (any percent-encoding: %2F, %2e%2e, ...), '\',
  -- whitespace / control characters, anything outside printable ASCII
  -- (unicode lookalikes), '..', '//', a leading or trailing '/'. The
  -- equality below is an exact byte comparison (deterministic collation; no
  -- lower()/btrim()/normalize() anywhere), so case variants never match.
  IF COALESCE(p_storage_path, '') = ''
     OR p_storage_path !~ '^[A-Za-z0-9/_.-]+$'
     OR p_storage_path ~ '[?#%\\[:space:][:cntrl:]]'
     OR position('..' in p_storage_path) > 0
     OR position('//' in p_storage_path) > 0
     OR left(p_storage_path, 1) = '/' OR right(p_storage_path, 1) = '/'
     OR v_session.storage_path !~ '^(org/[A-Za-z0-9_-]+/)?temp/[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Upload path does not match this session';
  END IF;

  IF p_storage_path IS DISTINCT FROM v_session.storage_path THEN
    RAISE EXCEPTION 'Upload path does not match this session';
  END IF;

  IF p_bytes IS NULL OR p_bytes <= 0 OR p_bytes > 102400 THEN
    RAISE EXCEPTION 'Uploaded image must be 100 KB or smaller';
  END IF;

  IF p_mime_type NOT IN ('image/webp', 'image/jpeg', 'image/png') THEN
    RAISE EXCEPTION 'Unsupported uploaded image type';
  END IF;

  IF COALESCE(btrim(p_public_url), '') = '' OR lower(p_public_url) LIKE 'data:%' THEN
    RAISE EXCEPTION 'Uploaded image URL must be a Storage URL';
  END IF;

  IF position('/storage/v1/object/public/product-images/' in p_public_url) = 0 THEN
    RAISE EXCEPTION 'Uploaded image URL must point to the product-images bucket';
  END IF;

  -- 080: p_public_url is NOT stored and its host is never used (079 only
  -- checked the suffix, so https://<any host>/<same path> was accepted). For
  -- existing phone pages (getPublicUrl(storagePath)) it must still be a plain
  -- http(s) URL whose PATH is exactly this session's object; the URL stored
  -- and handed to the desktop is derived below from trusted configuration.
  IF p_public_url !~ '^[\x21-\x7e]+$'
     OR p_public_url ~ '[?#%\\]'
     OR substring(p_public_url from '^https?://[^/]+(/.*)$')
        IS DISTINCT FROM '/storage/v1/object/public/product-images/' || v_session.storage_path THEN
    RAISE EXCEPTION 'Uploaded image URL does not match this upload session';
  END IF;

  -- 080: the object must exist in the authoritative bucket under exactly the
  -- session's path (created by the phone's uploadToSignedUrl). Size and type
  -- come from storage-api's own metadata when present, then re-validated.
  SELECT o.metadata INTO v_object_meta
    FROM storage.objects o
   WHERE o.bucket_id = 'product-images'
     AND o.name = v_session.storage_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded image was not found in storage';
  END IF;
  v_bytes := CASE WHEN v_object_meta->>'size' ~ '^[0-9]{1,9}$'
                  THEN (v_object_meta->>'size')::integer ELSE p_bytes END;
  v_mime_type := COALESCE(v_object_meta->>'mimetype', p_mime_type);
  IF v_bytes IS NULL OR v_bytes <= 0 OR v_bytes > 102400 THEN
    RAISE EXCEPTION 'Uploaded image must be 100 KB or smaller';
  END IF;
  IF v_mime_type IS NULL OR v_mime_type NOT IN ('image/webp', 'image/jpeg', 'image/png') THEN
    RAISE EXCEPTION 'Unsupported uploaded image type';
  END IF;

  -- 080: trusted base (public.app_config, service_role only) + bucket + the
  -- session's own path. Fails closed until the environment is configured.
  v_public_url := public.app_upload_session_public_url(v_session.storage_path);
  IF v_public_url IS NULL THEN
    RAISE EXCEPTION 'Phone image upload is not configured on this server';
  END IF;

  UPDATE product_image_upload_sessions
     SET status = 'COMPLETED',
         storage_path = v_session.storage_path,  -- 080: server values only
         public_url = v_public_url,
         bytes = v_bytes,
         mime_type = v_mime_type,
         signed_upload_token = NULL,
         completed_at = now()
   WHERE id = v_session.id
   RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'storagePath', v_session.storage_path,
    'publicUrl', v_session.public_url,
    'bytes', v_session.bytes,
    'mimeType', v_session.mime_type,
    'expiresAt', v_session.expires_at,
    'status', v_session.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) TO service_role;
COMMENT ON FUNCTION public.complete_product_image_upload_session(text, text, text, integer, text) IS
  '083: service_role only. Phones complete through the phone-upload-token Edge Function {action:"complete"}, which validates the stored bytes first (G5). 085: accepts image/jpeg, image/png and image/webp, 1..102400 bytes.';

DO $$
DECLARE
  c_sig     constant text := 'public.complete_product_image_upload_session(text,text,text,integer,text)';
  c_md5_085 constant text := 'dc822a6435c3e512acdc933c4a2995a8';
  v_p       record;
  v_rows    text;
BEGIN
  SELECT p.prosrc, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
    INTO v_p FROM pg_proc p WHERE p.oid = to_regprocedure(c_sig);
  IF md5(v_p.prosrc) <> c_md5_085 THEN
    RAISE EXCEPTION '085: completion body after the change has md5 %, expected %', md5(v_p.prosrc), c_md5_085;
  END IF;
  IF NOT v_p.prosecdef OR v_p.owner IS DISTINCT FROM 'postgres'
     OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION '085: completion must stay SECURITY DEFINER, owned by postgres, search_path=public (got %, %, %)', v_p.prosecdef, v_p.owner, v_p.proconfig;
  END IF;
  IF has_function_privilege('anon', c_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', c_sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', c_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '085: unexpected EXECUTE grants on complete_product_image_upload_session';
  END IF;
  IF coalesce(obj_description(to_regprocedure(c_sig), 'pg_proc'), '') NOT LIKE '083:%085:%' THEN
    RAISE EXCEPTION '085: completion comment must keep the 083: prefix and name 085';
  END IF;
  v_rows := (SELECT count(*)::text || ':' || md5(coalesce(string_agg(s::text, E'\n' ORDER BY s.id), '')) FROM public.product_image_upload_sessions s)
            || '/' ||
            (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o);
  IF v_rows IS DISTINCT FROM current_setting('phf.m085_rows', true) THEN
    RAISE EXCEPTION '085: session / object rows changed during the migration (% -> %)', current_setting('phf.m085_rows', true), v_rows;
  END IF;
  RAISE NOTICE '085: completion accepts image/jpeg, image/png, image/webp; grants service_role only; sessions/objects unchanged (%)', v_rows;
END $$;

NOTIFY pgrst, 'reload schema';
