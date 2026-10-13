-- Runs as supabase_admin BEFORE the schema baseline. Gives the bare supabase/postgres image the
-- GoTrue / storage-api / CLI objects a real stack has, in a reduced but realistic shape, so the
-- archive must carry auth users + MFA factors, storage rows and migration history.
-- Synthetic test database only.
\set ON_ERROR_STOP on
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid, id uuid PRIMARY KEY, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS auth.identities (
  provider_id text NOT NULL, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, identity_data jsonb NOT NULL,
  provider text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, friendly_name text,
  factor_type text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), secret text, last_challenged_at timestamptz);
GRANT USAGE ON SCHEMA auth TO postgres;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF to_regclass('storage.objects') IS NULL THEN
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, owner uuid, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[], created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text,
      owner uuid, owner_id text, metadata jsonb, version text, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), last_accessed_at timestamptz DEFAULT now());
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $f$
      DECLARE _parts text[];
      BEGIN SELECT string_to_array(name, '/') INTO _parts; RETURN _parts[1:array_length(_parts, 1) - 1]; END $f$;
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role, postgres;
    GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role, postgres;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
