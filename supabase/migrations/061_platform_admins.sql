-- ============================================================
-- Migration 061: platform_admins — internal super-admin identity
--
-- Backs the new platform console (docs/09-roadmap-todo.md's
-- "platform-admin access" item, previously undecided). Structurally
-- separate from `users` — no org_id, no overlap with any org role
-- (ADMIN/MANAGER/CASHIER/BUYER). Locked exactly like
-- `admin_login_codes` (migration 042): RLS enabled, ZERO policies,
-- ALL privileges revoked from anon/authenticated. No client-side
-- Supabase call (.from()/.rpc()) can ever read or write this table —
-- not even a compromised org ADMIN session, not even a bug in an RLS
-- policy elsewhere, since there is no policy to have a bug in. The
-- only way in is the platform-console Edge Function using the
-- service-role key.
--
-- Run AFTER 001-060. Idempotent (IF NOT EXISTS + REVOKE).
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Supabase auth user this platform admin signs in as. Entirely
  -- separate from any org's users.auth_id link.
  auth_id     uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON platform_admins FROM anon, authenticated;
