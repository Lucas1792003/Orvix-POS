# Evidence · Hosted incident cleanup — single orphan QA auth user removed (authorised)

Date: 2026-10-12 (after 05:23 UTC creation; deletion ≈ 06:4x UTC). Authorisation: owner's Phase E acceptance §1 — "deleting ONLY the single orphan QA authentication account". This is the only hosted modification ever made in this project.

## Before (read-only, sanitised)
| Field | Value |
|---|---|
| matching accounts (`email like '%@qa.invalid'`) | **1** |
| id | `0f2974c0…26f6` (full uuid held only in a shell variable) |
| email | `qa-admin-…@qa.invalid` |
| created_at | 2026-10-12 05:23:28 UTC; last_sign_in 05:25:50 UTC |
| identities / sessions / refresh_tokens / mfa_factors | 1 (email identity) / 0 / 0 / 0 |
| `public.users` by auth_id / by email | 0 / 0 |
| audit_logs references | 0 |
| hosted `auth.users` total | 11 |
| hosted business manifest | 154 metrics captured (`manifest-hosted-pre-orphan-delete.json`, Mac workspace) |

## Action
`DELETE https://<ref>.supabase.co/auth/v1/admin/users/<exact-id>` with the hosted service-role key read into memory from `supabase projects api-keys` (never printed, unset afterwards). HTTP 200.

## After (read-only)
| Check | Result |
|---|---|
| hosted `auth.users` total | **10** |
| orphan id exists / QA emails / orphan identities | 0 / 0 / 0 |
| `auth.audit_log_entries` in the last 15 min | 0 (GoTrue produced no audit entry for the admin deletion) |
| business manifest pre vs post | 148 equal; the 6 differences are exclusively `auth.users` and `auth.identities` count/checksum/max_created_at — i.e. the deleted account. No public-schema metric changed |

## Follow-ups
- Root cause (implicit `signUp()` on failed login) is being removed in Phase G (`phase-g/login-signup-fix.md`).
- Test harnesses now hard-fail on any request to `*.supabase.co`.
