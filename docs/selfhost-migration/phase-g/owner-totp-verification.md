# Owner procedure — verify the migrated ADMIN account with your existing authenticator

You perform this yourself. Nobody asks for your password, authenticator secret,
recovery codes, or one-time codes; nothing is reset or re-enrolled. The app's own
login page is used, pointed at the self-hosted backend. Hosted is not involved.

## 1. Start the app against lucashome (your Mac, repo root)

```
cd /Users/waiyan/Projects/personal/ShwePhaLa
export VITE_SUPABASE_URL=https://lucashome.tail8a86e4.ts.net
export VITE_SUPABASE_ANON_KEY="$(ssh lucashome 'grep "^ANON_KEY=" /srv/supabase/stack/.env | cut -d= -f2-')"
npm run dev
```
The anon key is public by design (it ships inside the app); it is read into
your shell only. Leave `.env.local` untouched.

## 2. Log in

Open http://localhost:5173 in a browser. Sign in with your ADMIN email and
password as usual. The app will take you to the `/verify` page and ask for a
6-digit code from your authenticator app, because your account has a TOTP
factor and the email-code path is disabled on the self-hosted stack (no email
provider). Enter the code from the app on your phone.

Expected: you land on the Dashboard. Passwords and factors were migrated as-is.

## 3. What to tell me

Only the outcome: "dashboard reached" or the exact error text shown on screen.
Then stop the dev server (Ctrl+C) and `unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY`.

## 4. What I verify afterwards (read-only, on lucashome)

`auth.sessions` for your account shows `aal = aal2` and a fresh `created_at`,
`auth.mfa_challenges` shows a verified challenge, and `auth.mfa_factors` still
has the same 2 factors with the same ids. I will then delete nothing; the
session is yours.

## If it fails

- "Invalid login credentials": the password hash did not migrate for this
  account. Stop and tell me; do not reset anything yet.
- Code rejected: check the phone's clock (TOTP tolerates ±30 s); try the next
  code once. If it still fails, the factor did not migrate; stop and tell me.
- Stuck on `/verify` with "email code" only: the app did not see a TOTP factor;
  tell me and I will check `auth.mfa_factors` for your user.
