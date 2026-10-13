#!/usr/bin/env bash
# owner-key-setup.sh — run BY THE OWNER, on the owner's own Mac, in Terminal. Never on the server.
# Creates (or verifies a recovery copy of) the OpenPGP key that the weekly backup archive is
# encrypted to. Nothing leaves this Mac: no network, no keyserver, no upload.
#
#   bash deploy/lucashome/backup/owner-key-setup.sh                      # create the key
#   bash deploy/lucashome/backup/owner-key-setup.sh --verify-copy <file> # prove a recovery copy works
#        <file> = owner-backup.SECRET.asc (password-manager copy)  or
#                 owner-backup.paper.txt  (paper copy, typed back in) — needs --pub owner-backup.pub.asc
#
# Create mode:
#   1. ed25519 signing key + cv25519 encryption subkey in YOUR keyring; gpg asks for the passphrase
#      in its own pinentry window/prompt — this script never sees it
#   2. writes into ~/pos-backup-key-<date>/ (0700 dir, 0600 files, outside iCloud-synced folders):
#        owner-backup.pub.asc     PUBLIC key   -> give to the server (not secret)
#        fingerprint.txt          fingerprint  -> not secret
#        owner-backup.SECRET.asc  PRIVATE key, still protected by the passphrase -> password manager, then delete
#        owner-backup.paper.txt   PRIVATE key for printing (paperkey; still passphrase-protected) -> print, then delete
#        owner-backup.revoke.asc  revocation certificate -> password manager, then delete
#   3. proves the key: clears gpg-agent's cached passphrase, then encrypts a random line to the
#      public key and decrypts it (you must type the passphrase from memory/password manager)
# Verify mode: imports the copy into a THROWAWAY keyring (temp dir, deleted afterwards), decrypts a
#   fresh test message encrypted to your public key, and reports OK/FAILED. Your main keyring is untouched.
#
# Never send the private key, the passphrase, SECRET.asc or paper.txt to Claude, the engineer, the
# repository, the server or any email. Guide: docs/selfhost-migration/phase-f/owner-recovery-key.md
set -euo pipefail

UID_STR="${OWNER_KEY_UID:-POS backup owner <backup-owner@invalid>}"
OUT="${OWNER_KEY_DIR:-$HOME/pos-backup-key-$(date +%Y%m%d)}"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -ne 0 ]] || die "do not run as root"
[[ "$(uname -s)" == Darwin ]] || die "this script is for the owner's Mac"
[[ -t 0 && -t 1 ]] || die "run this interactively in Terminal (not over SSH, not piped)"
[[ -z "${SSH_CONNECTION:-}${SSH_TTY:-}" ]] || die "do not run this over SSH; sit at the Mac"
command -v gpg >/dev/null || die "gpg missing — install first: brew install gnupg pinentry-mac paperkey"
command -v paperkey >/dev/null || die "paperkey missing — install first: brew install paperkey"
umask 077

# ---------------------------------------------------------------- verify a recovery copy
if [[ "${1:-}" == --verify-copy ]]; then
  COPY="${2:-}"; [[ -f "$COPY" ]] || die "usage: $0 --verify-copy <SECRET.asc|paper.txt> [--pub <pub.asc>]"
  PUB=""; [[ "${3:-}" == --pub ]] && PUB="${4:-}"
  # short path on purpose: gpg-agent's socket path must stay under ~100 chars on macOS
  V="$(mktemp -d "$HOME/.pos-key-verify.XXXXXX")"; trap 'gpgconf --homedir "$V/home" --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$V"' EXIT
  mkdir -m 0700 "$V/home"
  # keep the owner's pinentry choice (e.g. pinentry-mac) for the throwaway keyring
  MAINCONF="$(gpgconf --list-dirs homedir)/gpg-agent.conf"
  [[ -f "$MAINCONF" ]] && grep -E '^pinentry-program ' "$MAINCONF" > "$V/home/gpg-agent.conf" || true
  G=(gpg --homedir "$V/home" --no-auto-key-retrieve --no-auto-key-locate)
  if grep -q 'BEGIN PGP PRIVATE KEY BLOCK' "$COPY"; then
    "${G[@]}" --batch --import "$COPY" 2>/dev/null || die "import of $COPY failed"
  else
    [[ -f "$PUB" ]] || die "a paper copy needs --pub owner-backup.pub.asc"
    # paperkey needs the public key in binary form
    "${G[@]}" --dearmor < "$PUB" > "$V/pub.gpg" 2>/dev/null || cp "$PUB" "$V/pub.gpg"
    paperkey --pubring "$V/pub.gpg" --secrets "$COPY" --output "$V/restored.gpg" \
      || die "paperkey restore failed (typo in the typed-back text? paperkey names the bad line above)"
    "${G[@]}" --batch --import "$V/restored.gpg" 2>/dev/null || die "import of the paper-restored key failed"
  fi
  FPR="$("${G[@]}" --list-secret-keys --with-colons | awk -F: '/^fpr:/{print $10; exit}')"
  [[ ${#FPR} -eq 40 ]] || die "no secret key found in the copy"
  head -c 24 /dev/urandom | base64 > "$V/plain"
  "${G[@]}" --batch --yes --trust-model always --recipient "$FPR" --output "$V/enc" --encrypt "$V/plain" 2>/dev/null \
    || die "this copy's key cannot encrypt (no encryption subkey?) — it is not the backup key"
  echo "Decrypting a test message with the COPY — type the passphrase when asked."
  "${G[@]}" --output "$V/dec" --decrypt "$V/enc" || die "decrypt FAILED with this copy"
  cmp -s "$V/plain" "$V/dec" || die "round-trip FAILED with this copy"
  echo "OK: this copy restores key $FPR and decrypts. (Throwaway keyring removed.)"
  exit 0
fi
[[ $# -eq 0 ]] || die "unknown argument: $1"

# ---------------------------------------------------------------- create the key
case "$OUT" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Library/Mobile Documents"*|*iCloud*|*Dropbox*|*OneDrive*|*"Google Drive"*)
    die "choose a folder that is not synced to a cloud: e.g. OWNER_KEY_DIR=~/pos-backup-key";;
esac
[[ ! -e "$OUT" ]] || die "$OUT already exists — move it away or set OWNER_KEY_DIR"
if gpg --list-secret-keys --with-colons "$UID_STR" >/dev/null 2>&1; then
  die "a secret key for '$UID_STR' already exists in your keyring; reuse it or set OWNER_KEY_UID"
fi
GHOME="$(gpgconf --list-dirs homedir)"

echo "== 1/3 creating the key (gpg asks for a passphrase: 6+ random words; save it in your password manager NOW)"
gpg --quick-gen-key "$UID_STR" ed25519 sign never
FPR="$(gpg --list-keys --with-colons "$UID_STR" | awk -F: '/^fpr:/{print $10; exit}')"
[[ ${#FPR} -eq 40 ]] || die "could not read the new key's fingerprint"
gpg --quick-add-key "$FPR" cv25519 encr never

echo "== 2/3 writing files to $OUT"
mkdir -m 0700 "$OUT"
gpg --armor --export "$FPR" > "$OUT/owner-backup.pub.asc"
echo "$FPR" > "$OUT/fingerprint.txt"
gpg --armor --export-secret-keys "$FPR" > "$OUT/owner-backup.SECRET.asc"
gpg --export-secret-keys "$FPR" | paperkey --output "$OUT/owner-backup.paper.txt"
REV="$GHOME/openpgp-revocs.d/$FPR.rev"
[[ -f "$REV" ]] && cp "$REV" "$OUT/owner-backup.revoke.asc"
chmod 0600 "$OUT"/*

echo "== 3/3 proving the key works (cached passphrase cleared: type it from your password manager)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
head -c 24 /dev/urandom | base64 > "$T/plain"
gpg --batch --yes --trust-model always --recipient "$FPR" --output "$T/enc" --encrypt "$T/plain"
gpgconf --reload gpg-agent
gpg --output "$T/dec" --decrypt "$T/enc"
cmp -s "$T/plain" "$T/dec" || die "round-trip FAILED — do not use this key; ask for help"
echo "round-trip OK"

cat <<EOF

DONE. Fingerprint: $FPR   (safe to share)

Next, in this order (details: owner-recovery-key.md):
  1. Password manager: entry "POS backup key" — attach owner-backup.SECRET.asc and
     owner-backup.revoke.asc; store the passphrase and the fingerprint.
  2. Prove the password-manager copy (download it back from the password manager first):
       bash $0 --verify-copy <downloaded SECRET.asc>
  3. Print owner-backup.paper.txt. Prove the paper works before deleting the file:
       bash $0 --verify-copy "$OUT/owner-backup.paper.txt" --pub "$OUT/owner-backup.pub.asc"
     Seal the printout with important papers; ideally a second copy at another family home.
     Never photograph it into a cloud photo library.
  4. Optional offline copy: encrypted USB stick (Disk Utility → Erase → "APFS (Encrypted)"),
     copy SECRET.asc + revoke.asc there, verify it with step 2's command from the stick, eject.
  5. Delete the private files from this Mac (the key stays in your keyring):
       rm "$OUT/owner-backup.SECRET.asc" "$OUT/owner-backup.paper.txt" "$OUT/owner-backup.revoke.asc"
  6. Give ONLY "$OUT/owner-backup.pub.asc" and the fingerprint to the server setup.
EOF
