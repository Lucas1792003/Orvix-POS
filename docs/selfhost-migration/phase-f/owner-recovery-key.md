# Owner instructions · The backup recovery key

For the owner only. Written 2026-10-13. Technical detail: [email-backup-design.md §10](email-backup-design.md#10-owner-approval-enablement-checklist-gmail-api), restore procedure: [restore-from-email.md](restore-from-email.md).

## What this key is
The weekly recovery archive is encrypted to **your** OpenPGP key. The server holds only the **public** half, which can lock archives but never open them. Only the **private** half, plus its passphrase, can open an archive. Without it, every emailed backup is useless — including to you.

## Rules
- The private key and its passphrase are **never** sent to Claude or any AI tool, never placed in the repository, never put on the server, never emailed, and never stored in the backup mailbox.
- The engineer (and Claude) only ever sees the **public** key and its fingerprint.
- Use a passphrase of at least 6 random words. Store it in your password manager. **Never** write it on or inside the paper-key envelope: paper key + passphrase together = the backups. If you want a written passphrase too, keep it sealed at a **different** place from the paper key.

## 1. Create the key and prove every copy (≈ 30 min, at your Mac, in Terminal)

`gnupg` 2.5 and `paperkey` are already installed on the Mac (engineer, 2026-10-13, for testing the script with a throwaway key that was deleted; your keyring has no key yet). Optional nicer passphrase window: `brew install pinentry-mac` and `echo "pinentry-program $(brew --prefix)/bin/pinentry-mac" >> ~/.gnupg/gpg-agent.conf; gpgconf --kill gpg-agent`.

Sit at the Mac (not over SSH), Wi-Fi may stay on (the script does no network access), then:

```bash
cd ~/Projects/personal/ShwePhaLa
bash deploy/lucashome/backup/owner-key-setup.sh
```
1. gpg asks for a new passphrase twice → use 6+ random words; save it in the password manager **immediately**.
2. The script writes `~/pos-backup-key-<date>/` (folder 0700, files 0600) and then asks for the passphrase again for the round-trip test (it clears gpg's cache first, so this proves you have the passphrase). Expect `round-trip OK` and the fingerprint.
3. Password manager: new entry "POS backup key" → attach `owner-backup.SECRET.asc` and `owner-backup.revoke.asc`, fill in passphrase + fingerprint.
4. **Prove the password-manager copy** — download the attachment back from the password manager (e.g. to `~/Downloads`), then:
   ```bash
   bash deploy/lucashome/backup/owner-key-setup.sh --verify-copy ~/Downloads/owner-backup.SECRET.asc
   rm ~/Downloads/owner-backup.SECRET.asc
   ```
   Expect `OK: this copy restores key <fingerprint> and decrypts`. It uses a throwaway keyring (deleted afterwards), so it proves the copy on its own, not your Mac's keyring.
5. **Paper copy:** print `owner-backup.paper.txt` (about one page), then prove the file you printed restores:
   ```bash
   bash deploy/lucashome/backup/owner-key-setup.sh --verify-copy ~/pos-backup-key-<date>/owner-backup.paper.txt --pub ~/pos-backup-key-<date>/owner-backup.pub.asc
   ```
   For a full test of the printout itself: type (or OCR) the printed page back into a text file and run the same command on it; paperkey checks a CRC on every line and names the line with a typo. Seal the printout; ideally a second copy at another family home.
6. Optional encrypted USB stick: Disk Utility → Erase → format "APFS (Encrypted)" → copy `owner-backup.SECRET.asc` + `owner-backup.revoke.asc` → run step 4's command against the file on the stick → eject and store away from the Mac.
7. Delete the private files from the Mac (the key stays in your keyring):
   ```bash
   rm ~/pos-backup-key-<date>/owner-backup.SECRET.asc ~/pos-backup-key-<date>/owner-backup.paper.txt ~/pos-backup-key-<date>/owner-backup.revoke.asc
   ```
8. Hand over **only** `owner-backup.pub.asc` and the fingerprint (§3).

What the script guarantees (reviewed and tested 2026-10-13 with a throwaway key and passphrase, everything deleted afterwards): refuses root, non-Mac, non-interactive or SSH sessions and cloud-synced output folders; never reads or stores the passphrase (gpg's own prompt); no network calls, no keyserver; output 0700/0600; secret exports stay passphrase-protected (iterated+salted S2K, verified with `gpg --list-packets`); creation refuses to overwrite an existing key or folder; `--verify-copy` detects a wrong key and a one-byte paper typo (CRC error, line named).

**Manual equivalent** (if the script cannot be used):
```bash
gpg --quick-gen-key 'POS backup owner <backup-owner@invalid>' ed25519 sign never
gpg --quick-add-key <FINGERPRINT> cv25519 encr never
gpg --armor --export <FINGERPRINT> > owner-backup.pub.asc
gpg --armor --export-secret-keys <FINGERPRINT> > owner-backup.SECRET.asc
gpg --export-secret-keys <FINGERPRINT> | paperkey --output owner-backup.paper.txt
```
The revocation certificate is in `$(gpgconf --list-dirs homedir)/openpgp-revocs.d/<FINGERPRINT>.rev`.

## 2. Keep three copies of the private key
| Copy | Where | Protects against |
|---|---|---|
| Keyring on your device | your Mac/PC (`~/.gnupg`) | everyday restores and drills |
| Password manager | an entry "POS backup key" with `owner-backup.SECRET.asc` attached, the passphrase, the fingerprint and the `.rev` file | loss of the device |
| Paper | printed `paperkey` output (~ 1 page) in a sealed envelope with important family papers, ideally a second copy at another family home | loss of the device **and** the password manager account |

Also record, in the password manager: the backup mailbox login and its 2-step recovery codes.

## 3. Give the server the public key
Only `owner-backup.pub.asc` and the fingerprint. You can paste the fingerprint to the engineer; it is not secret. Copy the file yourself (commands in design §10 step 11) or hand the `.pub.asc` file to the engineer.

## 4. Test it once (before any real archive)
After the synthetic self-test mails arrive (design §10 steps 16–20: one single-part and one multipart selftest): download them, unpack, decrypt with your key, and confirm the test text is readable. This proves you can open archives **before** you need to.
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
