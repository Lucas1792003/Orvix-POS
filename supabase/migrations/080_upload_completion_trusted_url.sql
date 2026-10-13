-- ============================================================
-- Migration 080: phone-upload completion - the stored image URL is derived
--                server-side from trusted configuration; the object must
--                exist (docs/selfhost-migration/phase-g/migration-080.md,
--                self-host risk register "Upload completion checks
--                the path suffix, not the host")
--
-- WHY
--   079 required p_public_url to END with the session's object path, so a
--   phone-token holder could still submit https://<any host>/storage/v1/
--   object/public/product-images/<session path>; it was stored as
--   public_url, returned to the desktop poll and saved by the desktop into
--   products.image_url (confirmed live 2026-10-13). Completion also never
--   checked that the object had been uploaded.
--
-- WHAT IT DOES
--   1. public.app_config (key, value): one-row-per-setting configuration,
--      service_role-only (no anon/authenticated grants, RLS on, no policies),
--      owned by postgres. Key allowed: 'supabase_public_url' = the
--      environment's public API origin (the same value as VITE_SUPABASE_URL /
--      SUPABASE_PUBLIC_URL), shape-checked: https://<lower-case host>[:port]
--      (http only for localhost/127.0.0.1), no path, query, fragment or
--      trailing slash. THIS MIGRATION SEEDS NO VALUE: the host differs per
--      environment and is set by the operator right after applying (doc
--      "Configuration"). Until it is set, completion fails closed with
--      'Phone image upload is not configured on this server' (session stays
--      PENDING) and the readers return publicUrl = null.
--   2. public.app_upload_session_public_url(path): base || '/storage/v1/
--      object/public/product-images/' || path, only for a session-shaped
--      path ((org/<id>/)temp/<id>); NULL otherwise or when unconfigured.
--      SECURITY INVOKER, EXECUTE: service_role only (the definer RPCs below,
--      owned by postgres, call it as its owner).
--   3. complete_product_image_upload_session (079 body + 4 generated hunks):
--      a. p_storage_path: explicit rejection of NULL/empty, '?', '#', '%'
--         (any percent-encoding: %2F, %2e%2e ...), '\', whitespace/control
--         characters, non-ASCII (unicode lookalikes), '..', '//', a leading
--         or trailing '/'; then the existing exact (byte) equality with the
--         session's server-minted storage_path. No case folding anywhere.
--      b. p_public_url: never stored, host never used. Kept as a compatibility
--         check only: printable ASCII, no '?', '#', '%', '\', and its path
--         (after scheme://authority) must equal exactly '/storage/v1/object/
--         public/product-images/' || session path. Replaces 079's suffix test.
--      c. storage.objects must hold bucket_id = 'product-images' AND name =
--         session.storage_path, else 'Uploaded image was not found in
--         storage' (session stays PENDING). bytes / mime_type come from the
--         object's storage-api metadata (size, mimetype) when present, and
--         are re-validated (<= 100 KB, image/webp|image/jpeg).
--      d. public_url := app_upload_session_public_url(session.storage_path);
--         storage_path/public_url/bytes/mime_type are written from server
--         values only.
--      Repeated completion, expired and cancelled sessions: unchanged -
--      rejected with 'Upload link is no longer active' (075/079).
--   4. get_product_image_upload_session_status (desktop poll) and
--      get_product_image_upload_session_by_token (phone): snapshot bodies +
--      1 hunk each - 'publicUrl' is the derived URL for a COMPLETED session
--      (null otherwise), never the stored column, so a pre-080 row that holds
--      a caller-supplied URL is not handed to the desktop again.
--   Signatures, return keys, SECURITY DEFINER, search_path and grants of the
--   three RPCs are unchanged (anon keeps EXECUTE on complete_ and _by_token).
--
-- PRE-CONDITIONS (asserted at the end; the transaction aborts otherwise)
--   The RPC owner (postgres) can SELECT storage.objects and bypasses RLS
--   (supabase/postgres image: postgres BYPASSRLS; storage-api migration
--   0049 grants ALL on storage.objects to postgres).
--
-- CLIENT IMPACT: none required. The desktop already takes publicUrl from the
--   status poll (ProductImagePhoneUploadModal -> onUploaded -> image_url);
--   the phone page already sends getPublicUrl(storagePath), which passes 3b
--   whatever host it was built for. See the doc for recommended clean-ups.
--
-- ROLLBACK
--   Re-run 079's complete_product_image_upload_session block (with its
--   grants) and the snapshot/019 bodies of get_product_image_upload_session_
--   status / _by_token. app_config and the helper can stay (unused) or be
--   dropped: DROP FUNCTION public.app_upload_session_public_url(text);
--   DROP TABLE public.app_config;  Sessions completed under 080 keep their
--   derived public_url.
-- FORWARD RECOVERY
--   Idempotent (IF NOT EXISTS / CREATE OR REPLACE / REVOKE+GRANT). Re-run.
--
-- VERIFICATION
--   SELECT proname, prosrc LIKE '%080%' FROM pg_proc WHERE proname IN
--     ('complete_product_image_upload_session','get_product_image_upload_session_status',
--      'get_product_image_upload_session_by_token');                     -- 3 x t
--   SELECT has_function_privilege('anon',
--     'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE');  -- t
--   SELECT has_table_privilege('anon', 'public.app_config', 'SELECT'),
--          has_table_privilege('authenticated', 'public.app_config', 'SELECT');  -- f, f
--   SELECT key, value FROM public.app_config;   -- after configuration: 1 row
--   -- harness: bash supabase/tests/phase-d/run.sh   (t16_completion_url)
--
-- NOT applied anywhere by this change. Generated by gen080.py (session
-- scratchpad; inputs: production snapshot, 079).
-- ============================================================

-- 1/5 trusted configuration (service_role only)
CREATE TABLE IF NOT EXISTS public.app_config (
  key        text PRIMARY KEY CONSTRAINT app_config_key_known CHECK (key IN ('supabase_public_url')),
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_config_supabase_public_url_shape CHECK (
    key <> 'supabase_public_url'
    OR value ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$'
    OR value ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$')
);
ALTER TABLE public.app_config OWNER TO postgres;
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
-- default privileges (Supabase: ALL to anon, authenticated, service_role) are
-- replaced by exactly these four for service_role
REVOKE ALL ON TABLE public.app_config FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_config TO service_role;
COMMENT ON TABLE public.app_config IS
  '080: per-environment server configuration (service_role only). supabase_public_url = public API origin used to derive phone-upload image URLs.';

-- 2/5 derived public URL of an upload session's object
CREATE OR REPLACE FUNCTION public.app_upload_session_public_url(p_storage_path text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  -- 080: trusted base (app_config) + the authoritative bucket + a
  -- session-shaped, server-minted path. NULL when unconfigured.
  SELECT c.value || '/storage/v1/object/public/product-images/' || p_storage_path
    FROM public.app_config c
   WHERE c.key = 'supabase_public_url'
     AND p_storage_path ~ '^(org/[A-Za-z0-9_-]+/)?temp/[A-Za-z0-9_-]+$';
$$;
ALTER FUNCTION public.app_upload_session_public_url(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.app_upload_session_public_url(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_upload_session_public_url(text) TO service_role;

-- 3/5 complete_product_image_upload_session (079 body + 4 hunks)
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

  IF p_mime_type NOT IN ('image/webp', 'image/jpeg') THEN
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
  IF v_mime_type IS NULL OR v_mime_type NOT IN ('image/webp', 'image/jpeg') THEN
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

-- 4/5 get_product_image_upload_session_status (snapshot body + 1 hunk)
CREATE OR REPLACE FUNCTION "public"."get_product_image_upload_session_status"("p_session_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users;
  v_session product_image_upload_sessions;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_session
    FROM product_image_upload_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF v_session.id IS NULL OR v_session.created_by <> v_user.id THEN
    RAISE EXCEPTION 'Upload session not found';
  END IF;

  IF v_session.status = 'PENDING' AND v_session.expires_at <= now() THEN
    UPDATE product_image_upload_sessions
       SET status = 'EXPIRED',
           signed_upload_token = NULL
     WHERE id = v_session.id
     RETURNING * INTO v_session;
  END IF;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'storagePath', v_session.storage_path,
    -- 080: derived from trusted configuration + the session's own path, never
    -- the stored column (a pre-080 row may hold a caller-supplied URL)
    'publicUrl', CASE WHEN v_session.status = 'COMPLETED'
                      THEN public.app_upload_session_public_url(v_session.storage_path) END,
    'bytes', v_session.bytes,
    'mimeType', v_session.mime_type,
    'expiresAt', v_session.expires_at,
    'status', v_session.status
  );
END;
$$;

-- 5/5 get_product_image_upload_session_by_token (snapshot body + 1 hunk)
CREATE OR REPLACE FUNCTION "public"."get_product_image_upload_session_by_token"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_session product_image_upload_sessions;
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

  IF v_session.status = 'PENDING' AND v_session.expires_at <= now() THEN
    UPDATE product_image_upload_sessions
       SET status = 'EXPIRED',
           signed_upload_token = NULL
     WHERE id = v_session.id
     RETURNING * INTO v_session;
  END IF;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'storagePath', v_session.storage_path,
    -- 080: derived from trusted configuration + the session's own path, never
    -- the stored column (a pre-080 row may hold a caller-supplied URL)
    'publicUrl', CASE WHEN v_session.status = 'COMPLETED'
                      THEN public.app_upload_session_public_url(v_session.storage_path) END,
    'bytes', v_session.bytes,
    'mimeType', v_session.mime_type,
    'uploadToken', CASE WHEN v_session.status = 'PENDING' THEN v_session.signed_upload_token ELSE NULL END,
    'expiresAt', v_session.expires_at,
    'status', v_session.status
  );
END;
$$;

REVOKE ALL ON FUNCTION "public"."complete_product_image_upload_session"(text, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."complete_product_image_upload_session"(text, text, text, integer, text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "public"."get_product_image_upload_session_status"(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION "public"."get_product_image_upload_session_status"(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION "public"."get_product_image_upload_session_by_token"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."get_product_image_upload_session_by_token"(text) TO anon, authenticated, service_role;

-- pre-conditions: the RPC owner can read storage.objects past RLS, and owns
-- app_config + the helper (fails the whole transaction otherwise)
DO $$
DECLARE
  v_owner name;
  v_ok boolean;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION '080: storage.objects does not exist';
  END IF;
  SELECT pg_get_userbyid(proowner) INTO v_owner FROM pg_proc
   WHERE oid = 'public.complete_product_image_upload_session(text,text,text,integer,text)'::regprocedure;
  IF v_owner IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION '080: complete_product_image_upload_session is owned by %, expected postgres', v_owner;
  END IF;
  IF NOT has_table_privilege(v_owner, 'storage.objects', 'SELECT') THEN
    RAISE EXCEPTION '080: % cannot SELECT storage.objects', v_owner;
  END IF;
  SELECT r.rolsuper OR r.rolbypassrls
         OR pg_get_userbyid(c.relowner) = v_owner OR NOT c.relrowsecurity
    INTO v_ok
    FROM pg_roles r, pg_class c
   WHERE r.rolname = v_owner AND c.oid = 'storage.objects'::regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION '080: % is subject to RLS on storage.objects (needs BYPASSRLS)', v_owner;
  END IF;
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.app_config'::regclass) <> v_owner
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc
          WHERE oid = 'public.app_upload_session_public_url(text)'::regprocedure) <> v_owner THEN
    RAISE EXCEPTION '080: app_config / app_upload_session_public_url must be owned by %', v_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_config WHERE key = 'supabase_public_url') THEN
    RAISE NOTICE '080: public.app_config.supabase_public_url is NOT set - phone-upload completion fails closed until the operator sets it (migration-080.md, Configuration)';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
