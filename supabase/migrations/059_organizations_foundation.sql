-- ============================================================
-- Migration 059: Multi-tenant foundation, Phase 1
--
-- See docs/09-roadmap-todo.md's "Future Vision — Multi-Tenant SaaS"
-- section for the full long-term direction. This migration is
-- deliberately narrow: it adds the organizations table and the org_id
-- columns everything else will build on, and re-scopes the one-admin
-- constraint from "one admin in the whole system" to "one admin per
-- organization" — but does NOT touch any RLS policy, any RPC, or the
-- frontend. With exactly one organization existing after this migration,
-- nothing about how the app behaves today changes. Later phases (auth/
-- signup redesign, platform-admin access, the full RLS/RPC org-scoping
-- audit) are separate, out of scope here.
--
-- Run AFTER 001-058. Idempotent (IF NOT EXISTS / IF EXISTS throughout;
-- the backfill UPDATEs are naturally idempotent since they only touch
-- NULL org_id rows).
-- ============================================================

-- ============================================================
-- 1. organizations table.
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (id, name, is_active, created_at)
VALUES ('org-shwe-pha-lar', 'Shwe Pha Lar', true, now())
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. org_id on shops and users — direct columns on both, not one
--    derived from the other. ADMIN rows have shop_id = NULL (global
--    within their org), so users.org_id can't be derived via shop_id
--    for exactly the row type that most needs it.
-- ============================================================
ALTER TABLE shops ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
UPDATE shops SET org_id = 'org-shwe-pha-lar' WHERE org_id IS NULL;
ALTER TABLE shops ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id);
UPDATE users SET org_id = 'org-shwe-pha-lar' WHERE org_id IS NULL;
ALTER TABLE users ALTER COLUMN org_id SET NOT NULL;

-- ============================================================
-- 3. Re-scope the one-admin constraint from migration 020: global ->
--    per-organization. Strict relaxation (allows a second ADMIN only
--    if it's in a *different* org) — cannot break the current
--    single-org setup, which still has exactly one ADMIN in its one org.
-- ============================================================
DROP INDEX IF EXISTS users_only_one_admin;
CREATE UNIQUE INDEX IF NOT EXISTS users_only_one_admin
  ON users (org_id)
  WHERE role = 'ADMIN';

-- ============================================================
-- 4. app_org_id() helper, mirroring app_shop_id() exactly
--    (003_identity_rls_helpers.sql). Not wired into any RLS policy or
--    RPC yet — deliberately deferred to the org-scoping audit phase.
-- ============================================================
CREATE OR REPLACE FUNCTION app_org_id()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT org_id FROM users
  WHERE auth_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION app_org_id() TO authenticated;
