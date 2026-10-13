# Hosted Supabase — access

Names and locations only.

| What | Where |
|---|---|
| Project | `shwephala`, ref `gzqiukxnzfdouwaotelx`, Supabase org slug `sxsmvqurwprbfitkfcos` |
| Supabase CLI | linked in the repo (`supabase/.temp/`, git-ignored); CLI login token in the macOS keychain (`Supabase CLI`) |
| Read-only queries | `supabase db query --linked "<SELECT …>"` (Management API; no DB password needed) |
| Dumps | `supabase db dump --linked …` (worked without prompting on 2026-10-11 via the CLI login role) |
| Database password | held by the owner only |
| API keys | `supabase projects api-keys --project-ref gzqiukxnzfdouwaotelx` — read into memory only when an approved action needs it |
| Edge function secrets | `RESEND_API_KEY`, `REPORT_EMAIL_FROM` (names from `supabase secrets list`) |
| Client config | `.env.local` in the repo (git-ignored) points at hosted — dev builds without overrides talk to hosted; Electron builds are now host-pinned to lucashome and refuse a hosted URL |
