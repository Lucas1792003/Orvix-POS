# Owner instructions · The backup recovery key

For the owner only. Written 2026-10-13. Technical detail: [email-backup-design.md §10](email-backup-design.md#10-owner-approval-enablement-checklist), restore procedure: [restore-from-email.md](restore-from-email.md).

## What this key is
The weekly recovery archive is encrypted to **your** OpenPGP key. The server holds only the **public** half, which can lock archives but never open them. Only the **private** half, plus its passphrase, can open an archive. Without it, every emailed backup is useless — including to you.

## Rules
- The private key and its passphrase are **never** sent to Claude or any AI tool, never placed in the repository, never put on the server, never emailed, and never stored in the backup mailbox.
- The engineer (and Claude) only ever sees the **public** key and its fingerprint.
- Use a passphrase of at least 6 random words. Store it in your password manager and write it on the paper copy's envelope only if the envelope is kept somewhere safe (see below).

## 1. Create the key (≈ 15 min, on your own Mac or PC, not the server)

**Guided (recommended):** in Terminal on your Mac, from the repository folder:
```bash
brew install gnupg pinentry-mac paperkey
bash deploy/lucashome/backup/owner-key-setup.sh
```
It refuses to run over SSH or inside iCloud-synced folders, creates the key in your keyring (gpg asks for the passphrase in its own window), writes the five files to `~/pos-backup-key-<date>/`, and proves the key with an encrypt/decrypt round trip. Then follow the printed steps. The manual equivalent is below.

**Manual:**
```bash
brew install gnupg paperkey                         # Mac; on Windows use Gpg4win
gpg --quick-gen-key 'POS backup owner <backup-owner@invalid>' default default never
#   → enter the passphrase twice
gpg --fingerprint 'POS backup owner'                # write down the 40-character fingerprint
gpg --armor --export <FINGERPRINT> > owner-backup.pub.asc                  # PUBLIC — this goes to the server
gpg --armor --export-secret-keys <FINGERPRINT> > owner-backup.SECRET.asc   # PRIVATE — password manager, then delete the file
gpg --export-secret-keys <FINGERPRINT> | paperkey --output owner-backup.paper.txt   # print it, then delete the file
```
The revocation certificate is created automatically in `~/.gnupg/openpgp-revocs.d/<FINGERPRINT>.rev`; attach it to the same password-manager entry.

## 2. Keep three copies of the private key
| Copy | Where | Protects against |
|---|---|---|
| Keyring on your device | your Mac/PC (`~/.gnupg`) | everyday restores and drills |
| Password manager | an entry "POS backup key" with `owner-backup.SECRET.asc` attached, the passphrase, the fingerprint and the `.rev` file | loss of the device |
| Paper | printed `paperkey` output (~ 1 page) in a sealed envelope with important family papers, ideally a second copy at another family home | loss of the device **and** the password manager account |

Also record, in the password manager: the backup mailbox login and its 2-step recovery codes.

## 3. Give the server the public key
Only `owner-backup.pub.asc` and the fingerprint. You can paste the fingerprint to the engineer; it is not secret. Copy the file yourself (commands in design §10 step 7) or hand the `.pub.asc` file to the engineer.

## 4. Test it once (before any real archive)
After the synthetic self-test mail arrives (design §10 step 11): download it, unpack, decrypt with your key, and confirm the test text is readable. This proves you can open archives **before** you need to.
Repeat a decrypt test every 3 months (restore runbook §5) so you still remember the passphrase.

## 5. If the server is completely lost
You need only: the backup mailbox, your private key + passphrase, and any computer.
1. Sign in to the backup mailbox; search `[pos-backup] archive`; download **every part** of the newest archive id (Gmail ⋮ → *Download message*).
2. Rejoin the parts. With the repository: `email-unpack.py` (restore runbook §2). **Without** the repository: each mail body lists every part's sha256 and the total sha256 — save each attachment, check `shasum -a 256 <part>` against the body, then `cat` the parts in order (`<id>.tar.gpg.001`, `<id>.tar.gpg.002`, …) into one `<id>.tar.gpg` file and check the total hash: `cat <id>.tar.gpg.0* > <id>.tar.gpg && shasum -a 256 <id>.tar.gpg`.
3. Decrypt: `gpg --output archive.tar --decrypt <id>.tar.gpg; echo $?` — continue **only** if it prints `0`; otherwise delete `archive.tar` and try the previous week.
4. Hand the decrypted archive (and the secrets from the password manager) to whoever rebuilds the server, following [restore-from-email.md](restore-from-email.md) §3–§4. Keep it on an encrypted disk; delete it when done.

## 6. If the key is lost or exposed
- **Lost** (all three copies): past archives cannot be opened. Create a new key (step 1), give the server the new public key, and send a fresh archive immediately.
- **Exposed** (someone else may have the private key and passphrase): create a new key, give the server the new public key, send a fresh archive, then delete old archive mails from the backup mailbox, and revoke the old key (`gpg --import <old>.rev`).
- **Passphrase forgotten but key copies exist:** the key cannot be used. Treat it as lost.
