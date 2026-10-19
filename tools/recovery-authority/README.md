# Recovery witness authority and restore gate (migration 087)

Design: `docs/selfhost-migration/phase-g/migration-087.md` ("Witness authority", "Restore gate").

* `authority.py`: runs **off the database host**, on the owner's second device, with the Ed25519 private key.
  - `tick`: every 60 s by default. Each run verifies the database, appends signed records to the local series and its mirror,
    and renews the lease under a signed intent that carries the sha256 of a one-time renewal token (the token itself is only
    ever sent to `authority_renew`); otherwise it refuses and revokes. A lease whose seq and token do not match one of its
    signed intents is a rogue renewal.
  - `genesis`: first record, after a two-person `owner_anchor`.
  - `attest NONCE`: for the gate.
* `gate.py`: read-only restore gate, run as `recovery_gate`. CONSISTENT requires a fresh attestation from the authority for a
  nonce the gate issued: `gate.py --issue-nonce --pub authority.pub` prints it; the authority attests it (`attest`); the gate
  run then passes `--attest FILE --nonce NONCE`.

Both need OpenSSL 3 with Ed25519 (`OPENSSL=` to override the path), Python 3 (stdlib only) and psql 16+ (the authority
passes the renewal token with `\bind`, so it never appears in the SQL text). They connect with
`docker exec <container> psql` by default; `AUTH_PSQL` / `GATE_PSQL` replace that command, and `AUTH_PGHOST` / `GATE_PGHOST`
select TCP.

In production, use scram credentials for `recovery_authority` / `recovery_gate`, kept only on the authority device, and
per-role `pg_hba.conf` rules: the database image trusts loopback connections without a password.

Never commit or print `authority.key`.

Tested by `tools/m087-verify` (parts x1, x2, x3).
