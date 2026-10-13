-- Runs as the container superuser BEFORE the baseline dump is loaded.
-- Makes the bare supabase/postgres image look enough like a hosted project
-- for schema.scrubbed.sql to restore: the dump references auth.users (FKs from
-- users/admin_login_codes/platform_admins) and the supabase_realtime
-- publication. auth.uid() ships with the image.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    -- Minimal GoTrue-compatible shape: only id is referenced by the schema.
    CREATE TABLE auth.users (
      id          uuid PRIMARY KEY,
      email       text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    RAISE NOTICE 'created minimal auth.users shim';
  ELSE
    RAISE NOTICE 'auth.users already present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
    RAISE NOTICE 'created supabase_realtime publication';
  END IF;
  -- Phase G: the bare image has no storage schema (storage-api creates it on
  -- a real stack). A minimal shim lets migration 016 (bucket + policies) and
  -- 071 (org-scoped policies) apply so t09 can exercise storage.objects RLS.
  IF to_regclass('storage.objects') IS NULL THEN
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[], created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, owner_id text,
      metadata jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
      LANGUAGE plpgsql IMMUTABLE AS $f$
      DECLARE _parts text[];
      BEGIN SELECT string_to_array(name, '/') INTO _parts; RETURN _parts[1:array_length(_parts, 1) - 1]; END $f$;
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
    GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;
    RAISE NOTICE 'created storage shim (buckets, objects, foldername)';
  ELSE
    RAISE NOTICE 'storage.objects already present';
  END IF;
END $$;

-- Sanity: the platform roles the dump grants to must exist.
SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','postgres') ORDER BY 1;
SELECT pg_get_functiondef('auth.uid'::regproc) AS auth_uid_definition;
