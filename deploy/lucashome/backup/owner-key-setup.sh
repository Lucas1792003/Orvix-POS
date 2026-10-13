#!/usr/bin/env bash
# owner-key-setup.sh — run BY THE OWNER, on the owner's own Mac, in Terminal.
# Creates the OpenPGP key that the weekly backup archive is encrypted to.
#
#   bash deploy/lucashome/backup/owner-key-setup.sh
#
# What it does (nothing leaves this Mac; no network access):
#   1. creates an ed25519 signing key + cv25519 encryption subkey in YOUR keyring;
#      gpg asks you for a passphrase in its own window (pinentry) — this script never sees it
#   2. writes, into ~/pos-backup-key-<date>/ (mode 0700, outside iCloud-synced folders):
#        owner-backup.pub.asc        PUBLIC key   -> give to the server (not secret)
#        fingerprint.txt             fingerprint  -> not secret
#        owner-backup.SECRET.asc     PRIVATE key, passphrase-protected -> password manager, then delete
#        owner-backup.paper.txt      PRIVATE key for printing (paperkey) -> print, then delete
#        owner-backup.revoke.asc     revocation certificate -> password manager, then delete
#   3. proves the key works: encrypts a random test line to the public key and decrypts it
#      (gpg asks for the passphrase), then compares
#
# Never send the private key, the passphrase, SECRET.asc or paper.txt to Claude, the engineer,
# the repository, the server or any email. Instructions: docs/selfhost-migration/phase-f/owner-recovery-key.md
set -euo pipefail

UID_STR="${OWNER_KEY_UID:-POS backup owner <backup-owner@invalid>}"
OUT="${OWNER_KEY_DIR:-$HOME/pos-backup-key-$(date +%Y%m%d)}"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ -t 0 && -t 1 ]] || die "run this interactively in Terminal (not over SSH, not piped)"
[[ -z "${SSH_CONNECTION:-}" ]] || die "do not run this over SSH; sit at the Mac"
command -v gpg >/dev/null || die "gpg missing — install first: brew install gnupg pinentry-mac paperkey"
command -v paperkey >/dev/null || die "paperkey missing — install first: brew install paperkey"
case "$OUT" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Library/Mobile Documents"*) die "choose a folder outside Desktop/Documents/iCloud: OWNER_KEY_DIR=~/pos-backup-key";;
esac
[[ ! -e "$OUT" ]] || die "$OUT already exists — move it away or set OWNER_KEY_DIR"

if gpg --list-secret-keys --with-colons "$UID_STR" >/dev/null 2>&1; then
  die "a secret key for '$UID_STR' already exists in your keyring; reuse it or set OWNER_KEY_UID"
fi

echo "== 1/3 creating the key (gpg will ask for a passphrase: use 6+ random words, store it in your password manager)"
gpg --quick-gen-key "$UID_STR" ed25519 sign never
FPR="$(gpg --list-keys --with-colons "$UID_STR" | awk -F: '/^fpr:/{print $10; exit}')"
[[ ${#FPR} -eq 40 ]] || die "could not read the new key's fingerprint"
gpg --quick-add-key "$FPR" cv25519 encr never

echo "== 2/3 writing files to $OUT"
umask 077
mkdir -m 0700 "$OUT"
gpg --armor --export "$FPR" > "$OUT/owner-backup.pub.asc"
echo "$FPR" > "$OUT/fingerprint.txt"
gpg --armor --export-secret-keys "$FPR" > "$OUT/owner-backup.SECRET.asc"
gpg --export-secret-keys "$FPR" | paperkey --output "$OUT/owner-backup.paper.txt"
REV="$HOME/.gnupg/openpgp-revocs.d/$FPR.rev"
[[ -f "$REV" ]] && cp "$REV" "$OUT/owner-backup.revoke.asc"

echo "== 3/3 proving the key works (gpg asks for the passphrase once)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
head -c 24 /dev/urandom | base64 > "$T/plain"
gpg --batch --yes --trust-model always --recipient "$FPR" --output "$T/enc" --encrypt "$T/plain"
gpg --output "$T/dec" --decrypt "$T/enc"
cmp -s "$T/plain" "$T/dec" || die "round-trip FAILED — do not use this key; ask for help"
echo "round-trip OK"

cat <<EOF

DONE. Fingerprint: $FPR   (safe to share)

Next, in this order (see owner-recovery-key.md):
  1. Password manager: new entry "POS backup key" — attach owner-backup.SECRET.asc and
     owner-backup.revoke.asc, and store the passphrase and the fingerprint.
  2. Print owner-backup.paper.txt (one page). Seal it in an envelope with important papers;
     ideally a second copy at another family home. Never photograph it into a cloud photo library.
  3. Optional offline copy: an encrypted USB stick (Disk Utility → Erase → "APFS (Encrypted)"),
     copy SECRET.asc + revoke.asc there, eject, store away from the Mac.
  4. Delete the private files from this Mac (the key stays in your keyring):
       rm "$OUT/owner-backup.SECRET.asc" "$OUT/owner-backup.paper.txt" "$OUT/owner-backup.revoke.asc"
  5. Give ONLY "$OUT/owner-backup.pub.asc" and the fingerprint to the server setup.
EOF
