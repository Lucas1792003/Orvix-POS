# Non-secret `.env` settings for `/srv/supabase/stack/.env`

Everything not listed here keeps the upstream `.env.example` value for tag
`self-hosted/v0.8.2`, except the secrets written by `utils/generate-keys.sh`
(`POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
`SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`,
`LOGFLARE_*`, `S3_PROTOCOL_*`, `MINIO_ROOT_PASSWORD`, `DASHBOARD_PASSWORD`),
which are never recorded anywhere but `.env`.

| Key | Value | Reason |
|---|---|---|
| `COMPOSE_FILE` | `docker-compose.yml:docker-compose.override.yml` | apply the override |
| `SUPABASE_PUBLIC_URL` | `https://lucashome.tail8a86e4.ts.net` | Tailscale serve origin |
| `API_EXTERNAL_URL` | `https://lucashome.tail8a86e4.ts.net/auth/v1` | must include `/auth/v1` (upstream 0.7.0 change) |
| `SITE_URL` | `https://lucashome.tail8a86e4.ts.net` | auth redirects |
| `JWT_EXPIRY` | `3600` | hosted parity (decision A6 pending) |
| `DISABLE_SIGNUP` | `false` (planned `true`) | was needed while the app created staff via `auth.signUp`; since the `staff-admin` function (Phase F, [staff-creation.md](../../docs/selfhost-migration/phase-f/staff-creation.md)) the app no longer signs up — set `true` after that function is deployed (not done yet, 2026-10-13) |
| `ENABLE_EMAIL_SIGNUP` | `true` | — |
| `ENABLE_EMAIL_AUTOCONFIRM` | `true` | hosted parity |
| `ENABLE_PHONE_SIGNUP` / `ENABLE_PHONE_AUTOCONFIRM` | `false` / `false` | no SMS provider |
| `ENABLE_ANONYMOUS_USERS` | `false` | hosted parity |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` | `smtp.resend.com` / `465` / `resend` | Resend SMTP relay |
| `SMTP_PASS` / `SMTP_ADMIN_EMAIL` | empty until production (Resend API key / sender) | optional; app does not use GoTrue mail |
| `SMTP_SENDER_NAME` | `Shwe PhaLar POS` | — |
| `MFA_TOTP_ENROLL_ENABLED` / `MFA_TOTP_VERIFY_ENABLED` / `MFA_MAX_ENROLLED_FACTORS` | `true` / `true` / `10` | admin TOTP login |
| `FUNCTIONS_VERIFY_JWT` | `true` | hosted deploys all five functions with verify_jwt |
| `PGRST_DB_MAX_ROWS` | `1000` | hosted parity |
| `STUDIO_DEFAULT_ORGANIZATION` / `STUDIO_DEFAULT_PROJECT` | `Shwe PhaLar` / `pos` | labels |
| `DASHBOARD_USERNAME` | `shwephala-admin` | Studio basic auth user (password generated) |
| `RESEND_API_KEY` / `REPORT_EMAIL_FROM` | empty (appended) | set for Phase C function tests and production; forwarded to functions by the override |
