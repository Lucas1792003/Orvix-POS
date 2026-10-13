# Owner setup checklist · backup key + Gmail send-only (2026-10-13)

For the owner. One page, in order. Everything here happens on **your** Mac or in **your** browser. Nothing on this page is ever sent to Claude, the engineer, the repository or any chat: not the private key, the passphrase, the paper key, the OAuth client JSON, the token file, or any password.

What the engineer may receive from you: **the key fingerprint** (40 hex characters), the **public key file** `owner-backup.pub.asc`, the two **Gmail addresses**, and "done" messages. That's all.

## Part 1 — Backup encryption key (≈ 30 min) · details: [owner-recovery-key.md §1](owner-recovery-key.md)
- [ ] 1. Terminal on the Mac, sitting at it (not over SSH): `cd ~/Projects/personal/ShwePhaLa && bash deploy/lucashome/backup/owner-key-setup.sh`
- [ ] 2. Choose a passphrase of 6+ random words; save it in the password manager immediately. Expect `round-trip OK`.
- [ ] 3. Password manager entry "POS backup key": attach `owner-backup.SECRET.asc` + `owner-backup.revoke.asc`; passphrase; fingerprint.
- [ ] 4. Download that attachment back and run `bash deploy/lucashome/backup/owner-key-setup.sh --verify-copy ~/Downloads/owner-backup.SECRET.asc` → `OK`; delete the download.
- [ ] 5. Print `owner-backup.paper.txt`; run the `--verify-copy … --pub …` command on it → `OK`; seal the printout (never with the passphrase).
- [ ] 6. Delete `SECRET.asc`, `paper.txt`, `revoke.asc` from `~/pos-backup-key-<date>/` (the key stays in your keyring).
- [ ] 7. Send the engineer: the fingerprint, and `owner-backup.pub.asc`.

## Part 2 — Two Gmail accounts (≈ 20 min) · details: [email-backup-design.md §10 A](email-backup-design.md#10-owner-approval-enablement-checklist-gmail-api)
- [ ] 8. New Gmail **BACKUP mailbox** (receives backups). 2-Step Verification on, recovery phone/email, backup codes in the password manager. Never create an app password, OAuth client or token for it.
- [ ] 9. New Gmail **SENDER account** (sends backups). 2-Step Verification on, recovery set, credentials in the password manager. **No app password.**
- [ ] 10. In the BACKUP mailbox: filter From = sender → *Never send it to Spam* + label `pos-backup`.

## Part 3 — Google Cloud, in the SENDER account (≈ 15 min, free, no billing) · details: §10 B
- [ ] 11. console.cloud.google.com **as the sender** → new project `pos-backup-mail`; decline any billing/free-trial prompt.
- [ ] 12. Enable **Gmail API**.
- [ ] 13. OAuth consent: External; add sender as test user; scope **only** `…/auth/gmail.send`; then **Publish app → In production** (do not submit for verification; the "unverified app" warning is expected).
- [ ] 14. Create client → **Desktop app** → download the JSON; store it in the password manager.

## Part 4 — Mint the send-only token on the Mac (≈ 5 min) · details: §10 C
- [ ] 15. `mkdir -m 700 -p ~/pos-backup-keys && python3 -I deploy/lucashome/backup/gmail-oauth-mint.py ~/Downloads/client_secret_*.json ~/pos-backup-keys/gmail-oauth.json` — pick the **sender** account, allow only "Send email on your behalf". The helper refuses any other scope and prints no token.
- [ ] 16. Copy to the server yourself (the engineer never sees the file):
  `ssh lucashome 'mkdir -p -m 0700 /srv/supabase/backup/credentials'` →
  `scp ~/pos-backup-keys/gmail-oauth.json lucashome:/srv/supabase/backup/credentials/` →
  `ssh lucashome 'chmod 0600 /srv/supabase/backup/credentials/*'`
- [ ] 17. Check it: `ssh lucashome 'python3 -I /srv/supabase/backup/bin/gmail-oauth-mint.py --check /srv/supabase/backup/credentials/gmail-oauth.json'` → `ok, scope=…gmail.send, expires_in=…`
- [ ] 18. Delete `~/pos-backup-keys/gmail-oauth.json` and `~/Downloads/client_secret_*.json` from the Mac (`rm`; the client JSON stays in the password manager).
- [ ] 19. Tell the engineer: "token installed, check ok", plus the two Gmail addresses.

## Then (engineer, each step needs your approval)
Configure `backup.env` (still disabled) → synthetic single-part and multipart self-tests to the BACKUP mailbox (zero business data) → you download, unpack, decrypt and run the go-live checklist (§10 E) → only then the first real archive (§10 F) → only then schedules (§10 G).

The scripts are already installed on the server, **disabled** (2026-10-13 18:46 UTC): `EMAIL_ENABLED=false`, no credentials directory, no schedule.
