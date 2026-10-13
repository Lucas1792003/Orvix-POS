-- ============================================================
-- Migration 060: RLS for the organizations table (migration 059
-- created the table but left RLS disabled — a gap caught before
-- shipping the login-flow wiring that inserts into it).
--
-- Mirrors the existing `users_ins`/`shops_sel` pattern exactly
-- (010_rls_lockdown_phase_1.sql):
--   SELECT: open to all authenticated users, same as shops/suppliers —
--     org name/status is harmless reference data today (one org, no
--     cross-org listing possible yet).
--   INSERT: same bootstrap escape hatch as users_ins — allowed when
--     there are no users yet (first-ever setup creates its own org),
--     otherwise requires user:create (the closest existing permission;
--     there is no dedicated org:create in Phase 1, since the real
--     multi-org signup flow is still future work per the roadmap doc).
--   UPDATE/DELETE: no policy — default deny. Nothing in the app touches
--     these yet.
--
-- Run AFTER 059. Idempotent (DROP POLICY IF EXISTS, RLS enable is a
-- no-op if already enabled).
-- ============================================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organizations_sel" ON organizations;
DROP POLICY IF EXISTS "organizations_ins" ON organizations;

CREATE POLICY "organizations_sel" ON organizations FOR SELECT TO authenticated USING (true);
CREATE POLICY "organizations_ins" ON organizations FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('user:create') OR NOT EXISTS (SELECT 1 FROM users));
