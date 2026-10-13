# Phase F · Email-based offsite backups — design

Status: **built and tested on synthetic data, 2026-10-13. Not deployed, not
enabled, not scheduled.** Gmail API send-only transport added the same day
(§3.1, §10; tested against a local mock of Google only — no Google account,
OAuth client or token exists yet). Nothing was written to `lucashome`. No mail account,
API key or OpenPGP key was created, and no real email was sent. The only
commands run on the server were read-only: tool inventory, counts, and sizes
piped to `wc -c`.

This design supersedes the R2/rclone + Mac-pull design in
[proposal.md](proposal.md). The owner chose **email** as the offsite channel,
with no object storage, no Mac pull and $0 recurring cost. The `offsite-*`
scripts and `mac-pull.sh` stay in the repo, deployed disabled, and unused.

Companion documents:
- [email-audit.md](email-audit.md): audit of the existing email functions.
- [restore-from-email.md](restore-from-email.md): runbook for rebuilding the stack on a bare server.

Legend: **V** verified · **I** inferred · **U** unknown · **[R]** provider fact from the
research report of 2026-10-13 (official vendor pages; sources listed in §11).

## 0. Decision summary

1. **Weekly encrypted recovery archive by email, Sundays.** One archive is a
   complete logical rebuild kit: database dumps (incl. `auth` users + MFA
   factors, `storage`, migration history, `vault`), roles, storage object
   files, Edge Function source, compose override and non-secret config,
   `app_config`, and a manifest with sha256 + counts. It is tar'd and
   encrypted to the **owner's OpenPGP public key**: AES-256, integrity-protected,
   no compression. It is split into ≤ 15 MiB parts, one email per part, each
   carrying the full index.
2. **Secrets go in a separate encrypted file** (`.env`, pgsodium root key,
   backup config). The default is to **build it on the host every week and
   keep it there**. Mailing it is opt-in (`EMAIL_SECRETS_MODE=email`), and then
   it is mailed only when the secret set changes (§5).
3. **Daily business report by email**, per organization. It is read-only,
   idempotent per day, and carries a backup-health block, so a failed backup
   shows up in the mail the owner already reads.
4. **Transport: Gmail API from a dedicated SENDER Gmail, OAuth scope
   `gmail.send` only** (recommended since 2026-10-13: no domain needed,
   DKIM-aligned gmail.com sender, $0; see
   [email-sender-options.md](email-sender-options.md)). Resend (send-only API
   key) and SMTP via `curl` remain as alternatives. The server holds **only** a
   send-only credential and the owner's **public** key. The receiving
   (BACKUP) mailbox's credentials never touch the server.
5. **Recipient: a dedicated backup mailbox** (e.g. a new free Gmail with 2SV on
   and **no app password ever created**). A compromised server can then send
   junk but cannot read or delete past backups.
6. **Fits email today with a wide margin**: one message of ≈ 8.5 MB encoded,
   against a 25 MB limit. Splitting starts at about 15 MiB of ciphertext,
   roughly 3–5 months into real trading. The design scales to about
   12 parts (≈ 180 MiB). Beyond that the job **fails closed** and email is no
   longer the right channel (§4).
7. **$0 recurring**: two free Gmail accounts (sender + backup inbox, 15 GB
   each) **[R]**, a free Google Cloud project with the Gmail API (no billing
   account, **I**), or alternatively Resend Free (100/day, 3,000/month) **[R]**;
   plus `gpg`, `curl` and `python3`, which are already on the host (**V**).
   Nothing needs installing. No SLA: free consumer services (§3.3).
8. **Owner approvals needed** are listed in §10: two Gmail accounts, a Cloud
   project + Desktop OAuth client, the token mint on the owner's Mac, the key
   pair, then gated steps (selftests single/multipart, first real archive,
   schedule).

## 1. Architecture

```
lucashome (backup user, cron when enabled)                         provider            owner
┌───────────────────────────────────────────────────────────┐
│ email-archive.sh (Sun 04:30 UTC)                           │
│   db container: pg_dump -Fc postgres/_supabase, roles,     │
│   settings, counts, app_config  ─┐                         │
│   volumes/storage  (tar.gz)     ─┤ 0700 staging (removed)  │
│   volumes/functions (tar.gz)    ─┤                         │
│   override, conf.d, pg_hba      ─┘                         │
│   tar | gpg -e (owner PUBLIC key, AES256, MDC, no zip)     │      Gmail API          dedicated
│   split 15 MiB → parts + INDEX.txt/index.json              │ ───▶ (gmail.send only, ─▶ backup mailbox
│   one mail per part (+index) — resume-aware, idempotent    │      sender Gmail) or   (2nd Gmail, 2SV)
│                                                            │      Resend / SMTP
│   state.json per build; status.json "email-archive"        │                            │
│ email-secrets.sh (Sun 04:40): .env + pgsodium key → gpg    │ ──(only if mode=email)──▶   │
│ email-report.sh (daily 01:00 UTC, retry 03:00):            │                            │
│   READ ONLY SQL per org → text+html, backup-health block   │ ───────────────────────▶ owner inbox
│ backup-status.sh (*/30) embeds email-status.sh lines       │                            │
│ failure → small alert mail (no data) + status FAIL         │ ───────────────────────▶ alert address
└───────────────────────────────────────────────────────────┘                            ▼
                                                     owner device: email-unpack.py → gpg -d → restore
                                                     (private key: device + password manager + paper)
```

Files (all in `deploy/lucashome/backup/`, deployed by `deploy.sh`, `tests/` never deployed):

| File | Role |
|---|---|
| `email-lib.sh` | config + defaults (all placeholders; host/paths/addresses from `backup.env`), gate, credential file checks, `mail_send` (Gmail API, Resend API or SMTP via curl), `mail_alert`, `gpg_pubkey_check`, `gpg_encrypt_stream`, `gpg_integrity_ok` |
| `gmail-oauth-mint.py` | **owner's Mac**: mints the `gmail.send`-only refresh token (Desktop-app flow, loopback, PKCE, state); **server**: `--check` does one refresh and prints scope/expiry only |
| `email-mime.py` | builds one message: RFC 5322 `.eml` for SMTP or the Resend JSON payload (stdlib) |
| `email-archive.sh` | weekly archive: build → encrypt → verify packet integrity → split → send → state/status; `--dry-run`, `--force`, `--build-only`, `--week`, `--selftest [--selftest-parts N] [--selftest-mib M]` |
| `email-unpack.py` | **owner side**: reassemble parts from `.eml`, mbox (Takeout) or raw part files; verify every part + total sha256; never decrypts |
| `email-secrets.sh` | separate encrypted secrets file; `off|local|email` modes; change detection by keyed HMAC |
| `email-report.sh` / `.sql` / `.py` | daily report: per-org read-only query → render → send; `--render-only`, `--date`, `--force` |
| `email-status.sh` | email-tier health as JSON; embedded by `backup-status.sh` |
| `backup-status.sh` | +1 block: email lines/problems. **While `EMAIL_ENABLED=false` the only change is one line `email tier: disabled`** (test-proven: same exit code, identical problem list) |
| `backup.env.example`, `crontab.lucario`, `deploy.sh` | email section (disabled), commented cron lines, deploy now also copies `email-*.py`/`email-*.sql` |
| `tests/email/` | harness (§9) |

Existing jobs are untouched: hourly logical dumps, daily base backups,
WAL archiving, the weekly drill, prune, and the offsite scripts (still disabled).
The archive does a **fresh** `pg_dump` and does not touch `dump/`, `base/` or `wal_archive/`.

## 2. Archive contents and format

| Path in the archive | Source | Why |
|---|---|---|
| `db/postgres.dump` | `pg_dump -Fc --create -d postgres` in the `db` container | every schema: `public`, `auth` (users, identities, **mfa_factors**, sessions), `storage` (buckets, objects metadata), `supabase_migrations.schema_migrations`, `vault`, `cron`, `realtime`, … |
| `db/_supabase.dump` | `pg_dump -Fc --create -d _supabase` | analytics/supavisor metadata (small) |
| `db/globals.sql` | `pg_dumpall --roles-only` | roles, memberships, role settings (includes SCRAM hashes, protected by the encryption) |
| `db/db-settings.sql` | `pg_db_role_setting` | `ALTER DATABASE/ROLE … SET` |
| `db/counts.json` | `COUNTS_SQL` + products, orgs, app users, MFA factors, identities, migrations count, schema version, sales | post-restore comparison |
| `db/app_config.json` | `public.app_config` rows (080) | the trusted public URL; restore check |
| `files/storage.tar.gz` | `stack/volumes/storage` (storage-api file backend) | object bytes (images) |
| `files/functions.tar.gz` | `stack/volumes/functions` | Edge Functions as deployed |
| `config/…` | `docker-compose.override.yml`, `.supabase-version`, `volumes/db/custom-conf.d`, `volumes/db/pg_hba.conf` | non-secret stack config |
| `SHA256SUMS`, `MANIFEST.json` | generated | sha256 + size per file, counts, PG image, stack version |

Not in the archive: `.env`, `pgsodium_root.key`, mail credentials and the
`backup.env` file. The first two go in the secrets file (§5). The mail
credentials are not backed up at all: a rebuilt host gets a fresh send-only
key.

Encryption (**V**, tests):
- `gpg --recipient-file <owner public key> --compress-algo none
  --personal-cipher-preferences 'AES256 AES192 AES' --encrypt`, run with a
  throwaway homedir. Nothing is imported into a keyring. The key file must
  hold exactly one public key, with **no secret material**, an encryption-capable
  subkey that has not expired or been revoked, and a fingerprint equal to the
  pinned `ARCHIVE_GPG_FPR`. Otherwise the job fails before it dumps anything
  (tested).
- After encryption the job reads the packet headers and **refuses** output that
  is not a public-key packet plus SEIPD with `mdc_method: 2` (or AEAD), or that
  carries a symmetric/passphrase packet. With gpg 2.4.8 and a default
  ed25519/cv25519 key the result is SEIPDv1 + MDC (**V**).
- Tampering: flipping one byte makes `email-unpack.py` name the part
  (`part 2/4 sha256 MISMATCH`) and write nothing. If the hashes are bypassed,
  `gpg` exits 2 with "encrypted message has been manipulated" (**V**).
- **Finding (important for the runbook):** on a tampered or corrupted
  message, gpg **still writes the unverified plaintext** to `--output`
  (3,594,240 bytes in the test) **before** reporting the failure. Hence:
  decrypt to a file, check gpg's exit status, and only then extract. **Never
  `gpg -d | tar -x`.** `email-unpack.py` checks every hash first, so a
  tampered part never reaches gpg in the normal flow.
- Authenticity limit: anyone with the public key can produce a valid encrypted
  archive. The MDC proves integrity, not origin. Forging a whole archive would
  require planting mail in the owner's dedicated mailbox, with a sender domain
  that passes DKIM. The owner can also cross-check that the archive id and part count in the
  daily report's backup-health line match what arrived. That line comes from
  the same host. A server-held signing key was **not** added: it would prove only "the
  server signed it", and an attacker on the server would hold it too.
- `age` would be a fine alternative format (smaller, simpler). It is not
  installed on the host; switching would need an install approval. gpg is
  already present.

Splitting and the index:
- `split -b $ARCHIVE_PART_BYTES` (default 15 MiB) produces
  `<id>.tar.gpg.001 … .NNN`. The archive id is `<ARCHIVE_LABEL>-<ISO week>`,
  e.g. `pos-2026-W42`.
- Every part mail carries the part plus `<id>.INDEX.txt` and `<id>.index.json`
  (archive id, created, recipient fingerprint, total bytes, total sha256,
  per-part n/bytes/sha256). The body repeats the index, so the owner can read
  the hashes without opening attachments. Any single mail is enough to know
  what is missing.
- `email-unpack.py` refuses if the index copies differ between mails
  (forged-index test), if a part is missing or has a wrong hash (a good duplicate
  copy is preferred), if extra part numbers appear, or if the concatenation's
  sha256 differs.

Idempotency and resume:
- A per-build `state.json` records each accepted part (provider id or our
  Message-ID, time, provider result). Rerunning a fully sent week is a no-op
  (tested: 0 new mails).
- After a mid-way failure, the rerun **re-uses the same encrypted build** and
  sends only the missing parts (tested: SMTP stub accepted part 1 then went
  away; the rerun sent parts 2–4; parts from both runs reassemble and verify).
- `--force` makes a new id `…-r<ts>`.
- With Resend, every call also carries `Idempotency-Key: <id>-p<n>-<sha prefix>`
  (and `report-<org>-<day>` for reports). A retry after a lost response
  therefore does not create a second message; the fake endpoint in the tests
  honours this. Resend documents idempotency keys for the send endpoint.
  **Verify the retention window of the key** before enabling (**U**).
- SMTP has no such header. A timeout *after* the server accepted DATA can
  produce a duplicate part. The duplicate is harmless: unpack de-duplicates by hash.

## 3. Sending, fail-closed behaviour, credentials

Three transports share one code path (`mail_send` in `email-lib.sh`). The
message is always built by `email-mime.py`; only the hand-over differs.

| Transport | Credential file (0600/0400, owned by the backup user, never in git or `backup.env`) | Format | What a thief can do with it |
|---|---|---|---|
| **`gmail-api`** (recommended without a domain, 2026-10-13) | `GMAIL_OAUTH_FILE` = `/srv/supabase/backup/credentials/gmail-oauth.json` | JSON `{client_id, client_secret, refresh_token, scope, created}` written by `gmail-oauth-mint.py` on the owner's Mac | send mail **as the sender Gmail** until the owner revokes it. **Cannot** read, list, modify or delete any mail: the only scope ever requested or accepted is `https://www.googleapis.com/auth/gmail.send` ("Send email on your behalf", classified *Sensitive*, not *Restricted*) **[G-SCOPES]**. The backup mailbox is a **different** account and is not reachable at all |
| `resend` | `RESEND_KEY_FILE` = `/srv/supabase/backup/credentials/resend.key` | one line: the API key | send mail as the verified domain until revoked. **Cannot** read, list or delete mail (`sending_access`) **[R]** |
| `smtp` (fallback) | `SMTP_NETRC_FILE` = `/srv/supabase/backup/credentials/smtp.netrc` | `machine <smtp host> login <user> password <secret>` | depends on the provider. Use a **send-only** SMTP credential (e.g. SMTP2GO/Brevo SMTP key). **Never** a Gmail app password (see below) |

### 3.1 Gmail API transport (`MAIL_TRANSPORT=gmail-api`)

How a message is sent (**V**, tests T16):
1. Preflight refuses to start unless: `GMAIL_OAUTH_FILE` is a regular file
   owned by the running user with mode 0600 (or 0400), its JSON has
   `client_id`, `client_secret`, `refresh_token` and `scope` exactly
   `…/gmail.send`; `GMAIL_SENDER` is set and the `MAIL_FROM` address equals it
   (`MAIL_FROM` defaults to `POS backups <GMAIL_SENDER>`; Gmail sends as the
   authenticated account, so a different From would be rewritten or refused,
   see §3.3); `MAIL_MAX_ENCODED_BYTES` ≤ the API upload maximum.
2. Access token: `POST https://oauth2.googleapis.com/token` with
   `grant_type=refresh_token`. Python turns the JSON into a form body in a
   0600 file inside a 0700 temp dir; curl sends it with `--data-binary @file`;
   the file is deleted immediately after. The returned `scope` must again be
   exactly `gmail.send`, otherwise the token is discarded and the run fails
   ("grants more than gmail.send"). The access token (≈ 1 h) is kept in a 0600
   file in the same 0700 dir, which lives inside the job's 0700 work dir and is
   removed with it by the job's EXIT trap. It is reused for the rest of that run
   only (1 refresh for a 3-part archive, tested), renewed a minute before it expires.
3. Send: `POST https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media`
   with `Content-Type: message/rfc822` and the complete MIME message as the body.
   The `Authorization: Bearer` header reaches curl as a config line on **stdin**
   (`curl --config -`, fed by the shell builtin `printf`).
4. **Success only on HTTP 200 with a JSON `id`.** The Gmail message id and
   `threadId` go into `state.json` (`sent[n] = {id, thread_id, at, result}`) and
   the ids into `status.json` `message_ids`, as for the other transports.

Size: the API's media upload maximum is **35 MiB** (`maxSize: 36700160`,
accepted media `message/*`) **[G-DISC]**. The binding limit is the personal
Gmail **25 MB** message limit **[G-SIZE]**, so every message is checked
locally against `MAIL_MAX_ENCODED_BYTES` (alias `MAIL_MAX_BYTES`, default
24,000,000 bytes) before anything is uploaded, and a configured value above
35 MiB is refused for `gmail-api`. A 15 MiB part is ≈ 20.5 MB encoded.
(The brief suggested a 24 MiB default; 24 MiB = 25,165,824 bytes would exceed
a 25 MB = 25,000,000-byte reading of Google's limit, so the existing
24,000,000 stays.)

Error handling (each row tested against the mock, T16):

| Google answer | What the job does |
|---|---|
| 200 + `id` | part recorded as accepted |
| 401 on send | drop the access token, refresh **once**, retry **once**; a second 401 fails |
| token endpoint `invalid_grant` (refresh token revoked/expired) | **FAIL**, reason `gmail oauth token invalid — owner must re-mint` in the log, `status.json` message, `email-status.sh` and `backup-status.sh`; **no further send in that run** (not even the alert: one token request, zero send requests) |
| token endpoint `invalid_client` / `unauthorized_client` / `deleted_client` / `invalid_scope` | FAIL, `gmail oauth client invalid — owner must re-mint`, no further sends |
| granted scope ≠ exactly `gmail.send` | FAIL, token discarded, no further sends |
| 403 `insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | FAIL, no retry ("the token lacks the gmail.send scope — owner must re-mint") |
| 403 `dailyLimitExceeded` / `quotaExceeded` | FAIL, no retry |
| 429, 403 `rateLimitExceeded` / `userRateLimitExceeded`, 5xx | retried with bounded exponential back-off: `MAIL_RETRIES` attempts (default 3), sleeps `MAIL_RETRY_SLEEP_S`, 2×, 4× … (default 30 s, 60 s), each capped at `MAIL_RETRY_MAX_SLEEP_S` (300 s); a numeric `Retry-After` is honoured up to that cap. Then FAIL. Google's guidance for these codes is exponential back-off **[G-ERR]** |
| 413 / other 4xx | FAIL, no retry |
| network error (connect, TLS, timeout, connection dropped mid-upload) | FAIL, **not** retried in the same run, because the upload may already have been accepted. The 06:30 resume run sends only the parts without an id. A duplicate part is harmless (unpack de-duplicates by hash) |

Never OK on a partial send: the run is "ok" only when every part has an id;
the resume logic (`state.json`) is transport-independent and re-sends only
the missing parts (tested with a dropped upload: part 1 kept, the rerun sent
parts 2–3, all mails reassemble).

The two Google URLs are **not** configuration. `GMAIL_TOKEN_URL` and
`GMAIL_API_BASE` exist only so the test harness can point at its mock; any
value other than Google's own URL must be `http(s)://127.0.0.1[:port]/…`,
otherwise preflight refuses (tested). The mint helper applies the same rule
to its test overrides.

What never contains a secret (asserted by T16 over every Gmail run of the
suite): the argv of every curl call (a shim records it), the process list
sampled every 50 ms during the runs (`ps -eo args`), all job logs,
`status.json`, every `state.json`, the messages Google receives, the mint
helper's output, the test output, and any file left on disk afterwards.
Every token dir seen at curl time was 0700 with 0600 files, no copy of an
access token existed outside it at any curl call, and none was left after
the runs.

### 3.2 All transports

- Keys never appear in argv or the environment. The Resend key reaches `curl` through
  `--config -` on stdin. SMTP uses `--netrc-file`. Gmail: form body file +
  stdin config (above). The scripts check the owner and mode of each file and
  never read it in the log path. A file with mode 0644 fails preflight (tested).
- **Gmail app passwords are excluded.** Since Jan 2025 IMAP is always on, so
  an app password used for SMTP would also give full IMAP access to that
  mailbox, including deleting old backups **[R]**. Gmail SMTP with OAuth
  needs the full-mail scope `https://mail.google.com/` **[G-XOAUTH]**, so the
  only send-only way into Gmail is the REST API with `gmail.send` (§3.1).
- Acceptance: success means **Gmail HTTP 200 with an id**, **Resend HTTP 200
  with an id**, or **curl exit 0 with SMTP final reply 250**. A single
  non-accepted part fails the run. Retries happen only on transient errors
  (Resend/SMTP: curl connect/timeout/TLS codes, HTTP 429/5xx; Gmail: see §3.1),
  `MAIL_RETRIES` times with exponential back-off from `MAIL_RETRY_SLEEP_S`.
  A 4xx other than 429 is permanent.
- Local size guard: a message larger than `MAIL_MAX_ENCODED_BYTES` (default
  24,000,000) is refused before it is handed over (tested for SMTP and Gmail).
- Every failure, whether preflight, dump, disk, encrypt, split or send, results in:
  exit 1, `status.json` `jobs["email-archive"].last_result = "fail"` with the
  provider reason in `message`, `last_success` unchanged, no "sent" log line,
  the plaintext staging dir removed, any `.partial` build removed, and a
  **failure notification mail** (job, reason, log path; no data, no
  attachment) to `ALERT_MAIL_TO`, sent best-effort through the **same**
  transport. The matrix in §9 (T8, T9, T16) is test-proven.
- **When the transport itself is broken, no alert can be sent.** With
  `gmail-api` that is exactly the case for a revoked/expired refresh token or
  a deleted client: the job records `gmail oauth token invalid — owner must
  re-mint` and does not even try the alert. The dead-man signals are then:
  1. the owner **not receiving the Sunday archive** (Sunday ≈ 11:00 Yangon) or
     the **daily report** (by 09:00 Yangon) — rule: *a missing mail means
     check the server*;
  2. `backup-status.sh` on the server, which prints `PROBLEM: email-archive:
     last run failed: … gmail oauth token invalid — owner must re-mint` (and
     pings healthchecks if `HEALTHCHECKS_URL` is set);
  3. `python3 -I gmail-oauth-mint.py --check …` on the server, which says
     `owner must re-mint` directly.

Delivery confirmation beyond provider acceptance: the server holds **no
IMAP or read credential**, by design (`gmail.send` cannot read). Confirmation
works on the owner side:
- the daily report's health block shows `weekly email archive: last sent <id>
  (<n> part(s)) <age> ago`;
- the owner checks the mailbox has `<id> part 1/n … n/n`, weekly at a glance
  and monthly by running `email-unpack.py --list` on the downloaded mails
  (§8).

### 3.3 Verified Google facts for the Gmail API transport

Retrieved 2026-10-13 from official Google pages (sources at the end of this
section). Quotes are close to verbatim; re-open the page before quoting
them elsewhere.

| Fact | Consequence here | Source |
|---|---|---|
| A refresh token stops working when: the user revokes the app's access; it **has not been used for six months**; the user **changed their password and the token contains Gmail scopes**; the account exceeds the **limit of 100 refresh tokens per Google Account per OAuth client ID** (a new one silently invalidates the oldest); the project's consent screen is **External + "Testing"** — then refresh tokens **expire in 7 days**; time-based access expired | Weekly use prevents the 6-month expiry. **Re-mint after any password change of the sender account.** Mint rarely (each mint makes a new token; >100 would silently kill the oldest — irrelevant at 1–2 mints/year). Publish the app **In production** | [G-OAUTH] |
| Testing status: up to 100 test users; "authorizations by a test user will expire seven days from the time of consent" | same | [G-AUD] |
| Unverified apps: personal-use apps (< 100 users) may skip verification; users click through an "unverified app" screen; cap of "100 new users in total" | one user (the sender account) ever consents; the warning is expected | [G-UNV], [G-EXC] |
| `gmail.send` = "Send email on your behalf", classification **Sensitive** | send-only; no restricted-scope security assessment | [G-SCOPES] |
| `users.messages.send` media upload: `maxSize` 36,700,160 bytes (35 MiB), accepted `message/*`, URI `/upload/gmail/v1/users/{userId}/messages/send` | local guard far below it | [G-DISC], [G-UPL] |
| Quota: `messages.send` costs **100 units**; per user **6,000 units per minute** (= 60 sends/min); per project 1,200,000 units/min | 1–7 sends/week + reports: irrelevant | [G-QUOTA] |
| Errors: 401 → refresh the access token; 403 `rateLimitExceeded`/`userRateLimitExceeded` and 429 and 500/503 `backendError` → exponential back-off; 403 `dailyLimitExceeded` → quota | implemented as in §3.1 | [G-ERR] |
| Consumer Gmail: limit hit when sending "more than 500 emails … in a day" (or > 500 recipients in one mail); sending resumes "within 1 to 24 hours" | ≈ 10 mails/day max | [G-LIM] |
| Personal Gmail message limit **25 MB** (stated for sending; Google does not state a separate receiving limit for personal accounts — treat 25 MB as the ceiling at the recipient too) | parts ≤ 15 MiB raw ≈ 20.5 MB encoded | [G-SIZE] |
| Consumer services carry no SLA: "The only commitments we make about our services (including … their reliability, availability, or ability to meet your needs) are provided in" the warranty section, service-specific terms and law; warranty = "reasonable skill and care" | **no guarantee of business-grade delivery.** Free consumer service, no SLA; spam filtering is possible even for mail between two Gmail accounts. Mitigation: a filter in the backup mailbox `from:(<sender>)` → **Never send it to Spam** + label `pos-backup` [G-SPAM]; the dead-man rules above; the local tiers stay primary | [G-TOS] |
| Desktop clients use a loopback redirect `http://127.0.0.1:port` with PKCE (S256); loopback is deprecated only for Android/iOS/Chrome-app clients; for installed apps "the client secret is obviously not treated as a secret" | the mint helper uses exactly this flow; the client secret is still kept off logs and argv | [G-NATIVE], [G-OAUTH] |
| **Not found in official docs:** what Gmail does with a `From` that is neither the account nor a verified send-as alias (widely reported: replaced by the primary address) (**U**) | preflight requires `MAIL_FROM` = `GMAIL_SENDER`; the go-live check (§10 G) confirms the received From | [G-SENDAS] |

Sources (retrieved 2026-10-13):
[G-OAUTH] https://developers.google.com/identity/protocols/oauth2 (Refresh token expiration; Installed applications) ·
[G-AUD] https://support.google.com/cloud/answer/15549945 (Manage App Audience) ·
[G-UNV] https://support.google.com/cloud/answer/7454865 ·
[G-EXC] https://support.google.com/cloud/answer/13464323 ·
[G-SCOPES] https://developers.google.com/workspace/gmail/api/auth/scopes ·
[G-DISC] https://gmail.googleapis.com/$discovery/rest?version=v1 (`users.messages.send` → `mediaUpload`) ·
[G-UPL] https://developers.google.com/workspace/gmail/api/guides/uploads ·
[G-QUOTA] https://developers.google.com/workspace/gmail/api/reference/quota ·
[G-ERR] https://developers.google.com/workspace/gmail/api/guides/handle-errors ·
[G-LIM] https://support.google.com/mail/answer/22839 ·
[G-SIZE] https://support.google.com/mail/answer/6584 ·
[G-TOS] https://policies.google.com/terms ·
[G-SPAM] https://support.google.com/mail/answer/16457426 ·
[G-NATIVE] https://developers.google.com/identity/protocols/oauth2/native-app ·
[G-SENDAS] https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs ·
[G-XOAUTH] https://developers.google.com/workspace/gmail/imap/xoauth2-protocol ·
[G-AUTH] https://support.google.com/mail/answer/180707 (authentication: "Mailed by"/"Signed by", SPF/DKIM) ·
[G-ORIG] https://support.google.com/mail/answer/29436 (Show original).

## 4. Sizes — measured, projected, and whether email fits

Measured on `lucashome` 2026-10-13, read-only (streams piped to `wc -c`;
nothing written; **V**). Data: schema 080, 1 org, 539 products, 10 auth users,
2 MFA factors, 574 storage objects, 0 sales, DB 20.5 MB on disk.

| Component | Bytes |
|---|---|
| `pg_dump -Fc postgres` | 1,007,657 |
| `pg_dump -Fc _supabase` | 1,246 |
| roles (`pg_dumpall --roles-only`, gzip) | 1,812 |
| storage tree, tar | 6,666,240 |
| storage tree, tar.gz (as archived) | 5,148,146 |
| functions, tar.gz | 19,098 |
| config files | < 20,000 |
| **payload ≈** | **≈ 6.2 MB** |
| encrypted (gpg overhead ≈ 0.7 % incl. tar headers, measured in tests) | ≈ 6.25 MB |
| one email, base64 MIME (× ≈ 1.37 **[R]**) | **≈ 8.5 MB** |

**Fit today: yes.** One message of about 8.5 MB, about a third of the 25 MB
Gmail ceiling. Storage images (≈ 9 KB each on average) are 83 % of it.

Provider and mailbox limits **[R]**:

| | Per-message limit | Volume limit | Notes |
|---|---|---|---|
| Gmail (consumer), receiving | treat **25 MB encoded** as the ceiling (Workspace documents 50 MB after encoding; consumer receive limit not stated) | 15 GB shared with Drive/Photos; a full account cannot receive | inactive 2 years → deleted |
| Resend Free | **40 MB** incl. base64 (~29 MB raw) | **100/day, 3,000/month**, each recipient counts; hard stop, no bill | `onboarding@resend.dev` only delivers to the account owner's own address; other recipients need a verified domain; Free keeps content 30 days |
| SMTP2GO Free (fallback) | 50 MB | 200/day, 1,000/month | verified sender required |
| Brevo Free (fallback) | 25 MB (API) | 300/day | sender verification |
| Outlook.com | 25 MB (as recipient) | — | not usable as a sender (OAuth2) |

Chosen ceiling: **15 MiB raw per part** (≈ 21.5 MB encoded + body + index ≈
21.6 MB), under 25 MB with ≈ 3 MB margin. The binding constraint is the
receiving mailbox, not Resend.

Growth model. Assumptions, labelled **I**: docs 04 estimates 8–15 MB/month of
raw sales data; `pg_dump -Fc` compresses row data 3–5× (≈ 2–4 MB/month of
dump growth); about 10 KB per new product image.

| When | Archive (encrypted) | Parts at 15 MiB | Mails/week | Mailbox use (8 weekly + 12 monthly kept) |
|---|---|---|---|---|
| today | ≈ 6.3 MB | 1 | 1 | ≈ 125 MB |
| when splitting starts | > 15.7 MB | 2 | 2 | — |
| ≈ month 3 (busy) – month 5 (quiet) | ≈ 15–16 MB | 1→2 | | |
| month 12 | ≈ 30–55 MB | 2–4 | 2–4 | ≈ 0.6–1.1 GB |
| month 24 | ≈ 55–100 MB | 4–7 | 4–7 | ≈ 1.1–2 GB |
| `ARCHIVE_MAX_PARTS=12` reached | ≈ 189 MB | 12 | 12 | ≈ 3.8 GB |

Verdict:
- **Complete encrypted backups fit email reliably now and for roughly the next
  2–3 years** on the busy-shop assumption, longer if quieter. Resend's quota is
  not a constraint: at most 7 parts/week plus about 14 reports/week plus alerts.
- They stop fitting when the archive passes about 12 parts, or earlier if the
  owner's mailbox fills. The job **warns** from `ARCHIVE_WARN_PARTS=4` (warning
  in the status JSON and logs) and **fails closed** above `ARCHIVE_MAX_PARTS`
  with an explicit message, so the problem cannot go unnoticed. The
  options at that point are: drop storage from the weekly mail and send it
  monthly or incrementally, keep only N weekly archives, or move to a
  different medium. The owner decides then.
- RPO at the offsite tier is **one week**. Hourly dumps, daily base backups
  and WAL (RPO ≈ 5 min) remain **local only**: same machine, same disk. If the
  owner wants a tighter offsite RPO, a cheap option is a daily DB-only archive
  (≈ 1 MB today; same script, storage excluded). It is not built yet and would
  be a small change.

## 5. The secrets file

`email-secrets.sh` streams `stack/.env`, the `db-config` volume
(`pgsodium_root.key`, conf.d; read through a read-only throwaway container,
as `secrets-bundle.sh` does), `backup.env` and `report-targets.conf` into
`gpg` to the same owner key. The output is `$BACKUP_ROOT/email-secrets/<ts>.tar.gpg`
(0600, newest 4 kept). Plaintext is never written. The mail credential files
are excluded.

Options for the owner:

| Mode | What happens | Pros | Cons |
|---|---|---|---|
| `local` (**default**) | built weekly, kept on the host only | secrets never leave the host, even encrypted | if the host is lost, the secrets file is lost with it. The owner must already hold `.env` + pgsodium key elsewhere (password manager), or rebuild with **new** secrets (§restore 2b: new JWT secret ⇒ all users sign in again; new pgsodium key ⇒ vault secrets unreadable, and vault has 0 rows today, **V**) |
| `email` | also mailed, **only when the secret set changed** (keyed-HMAC fingerprint, no content revealed), subject `[pos-backup] secrets <ts>` | full rebuild possible from the mailbox + private key alone; mailed rarely (secrets change rarely) | ciphertext of every secret sits in the mailbox. That is acceptable only because the private key is offline. Rotating the owner key does not re-protect old mails |
| manual | owner copies one `<ts>.tar.gpg` off the host after each secret change and stores it with the password manager | no secrets in the mailbox | relies on discipline |

**Recommendation:** `email` once the owner key has been tested by the selftest,
with a Gmail filter that labels these mails `pos-backup/secrets` and keeps
them indefinitely. Otherwise, at minimum, store `.env` and `pgsodium_root.key`
in the password manager now. The engineer does not need to see them for that:
the owner copies them over SSH to their device.

## 6. Daily business report

Built server-side rather than from the Edge Functions, for the reasons in
[email-audit.md](email-audit.md) §0/§4: no service-role key in the database,
no pg_cron/pg_net, access to local backup status, and the existing functions
are not org-safe.

- **Routing:** `REPORT_TARGETS_FILE` (owner-maintained, 0600):
  `org_id  recipients  [health]`. One mail per organization. Nothing goes to
  "all admins". `health` adds the backup block and is meant only for the
  operator's own org.
- **Query:** `email-report.sql` runs in `BEGIN … REPEATABLE READ READ ONLY`
  with a 60 s statement timeout. Every row is scoped through `shops.org_id`
  (transactions) or the catalog `org_id` (products, suppliers), matching
  068–080. No staff/customer names, emails or phone numbers are selected.
  Shops appear as code + name, products by name.
- **Day:** the business day in `REPORT_TZ` (Asia/Yangon, +06:30). The default
  is "yesterday", run at 01:00 UTC = 07:30 Yangon, retried at 03:00 (no double
  send).
- **Contents:** sales (completed / refunded / void, revenue excluding voids,
  discounts, average ticket, units, estimated COGS from the sale-time cost
  snapshot with fallback to current cost, estimated gross margin, by payment
  method, by shop, top 5 products); refund/void requests (created today by
  type/status, pending total); **expenses: not supported** (the app has no
  expenses table; stated in the mail); inventory (tracked lines, low stock
  with top 15 items, negative stock, value at cost and at retail, lines
  without cost, movements by type); purchases (POs created/received, open
  orders, supplier debt on received unpaid POs, supplier payments excluding
  voided); shifts (opened, closed, open now by shop, cash variance); transfers;
  audit event count.
- **Backup health** (with `health`): logical/base/restore-test last
  result and age, `backup-status` result and problem count, and the
  **last weekly email archive id, parts and age**. Any problem puts
  `[ACTION NEEDED]` in the subject and a red block at the top.
- **Idempotency:** `REPORT_STATE_DIR/<day>/<org>.json` plus the provider
  idempotency key. A rerun sends nothing (tested), and `--force` re-sends.
  `--render-only DIR` renders without sending, which also works while the
  tier is disabled. Use it to preview on the server.
- **Provider retention:** Resend Free keeps message content for 30 days
  **[R]**. The report carries business totals and product names only.

## 7. Alerting

| Signal | Where it appears | Who sees it |
|---|---|---|
| any email job fails | status FAIL + alert mail to `ALERT_MAIL_TO` | owner (unless transport down) |
| weekly archive missing/failed/older than 8 d | `email-status.sh` → `backup-status.sh` PROBLEM (→ healthchecks ping if `HEALTHCHECKS_URL` set) and the daily report's health block (`[ACTION NEEDED]`) | owner |
| daily report missing/failed (> 26 h) | `backup-status.sh` PROBLEM | logs / healthchecks |
| transport completely down (no mail at all), e.g. Gmail refresh token revoked/expired (`gmail oauth token invalid — owner must re-mint`) | **the daily report and the Sunday archive stop arriving**; no alert mail is possible (same path); `backup-status.sh` PROBLEM line on the server | owner. Rule: *no report by 09:00 Yangon, or no archive on Sunday = check the server* |
| local backups failing (existing) | daily report health block, from `status.json` | owner. The email tier makes the existing local failures visible without any new service |
| archive approaching the email limit | warning from 4 parts; fail above 12 parts | owner |

## 8. Retention

Mailbox (owner, manual, in the Gmail web UI):
1. Filters:
   - `subject:"[pos-backup] archive"` → label `pos-backup/archive`, skip inbox.
   - `subject:"[pos-backup] secrets"` → label `pos-backup/secrets`.
   - `subject:"[pos-backup] FAILED"` → label `pos-backup/alerts`, keep in inbox, star.
   - Daily reports stay in the inbox, or get their own label.
2. Policy: **keep 8 weekly + 12 monthly**. On the first Sunday of each month,
   star all parts of that week's archive (the "monthly"). Once a month, search
   `label:pos-backup/archive older_than:56d -is:starred` and delete. Delete
   starred archives older than 12 months the same way. Never delete secrets
   mails until a newer one has been verified.
3. Quarterly restore drill from the mailbox (runbook §5).
4. Log in at least once a year (2-year inactivity deletion **[R]**) — to
   **both** accounts with `gmail-api` (backup mailbox and sender). Watch the
   15 GB quota; at the current size it is about 1 % per year.
5. `gmail-api`: the sender account probably keeps a copy of every sent part
   under *Sent* (**U**, check in the go-live verification). The `gmail.send`
   token cannot delete it, so the owner prunes the sender's Sent folder about
   yearly (`in:sent older_than:1y` → delete).
Automating step 2 with Google Apps Script is possible, but it runs as the
mailbox owner, so a bug could delete backups. Manual deletion is recommended.

On the server: `KEEP_EMAIL_ARCHIVE=4` complete encrypted builds in
`$BACKUP_ROOT/email-archive/` (ciphertext + index + state only, about 25 MB today),
pruned only after a newer build was fully sent. Secrets: newest 4. Reports:
one small state file per day and org, not pruned (a few KB per year).

## 9. Tests

`deploy/lucashome/backup/tests/email/run.sh` (Mac, Docker; bash 3.2-safe)
builds an Ubuntu 26.04 runner (gpg 2.4.8, curl 8.18, python 3.14, the same
versions as the host, **V**). It then runs `suite.sh` inside the runner with
synthetic data only:

- a disposable `supabase/postgres:17.6.1.136` seeded with the hosted
  **schema-only** baseline, migrations 062–080 and synthetic rows. The seed
  includes `auth.users`, `auth.identities`, `auth.mfa_factors` (TOTP secrets
  as canaries), `storage.objects`, 80 migration-history rows, `app_config`,
  and two organizations with a known business day;
- a fake server tree whose `.env`, storage files and product names contain canary strings;
- a throwaway gpg key in a tmpfs;
- a mailpit SMTP catcher (3 MB limit), an SMTP fault stub, and a fake Resend
  endpoint (key check, idempotency keys, injected 401/422/500);
- a mock Google (`fake-google.py`, plain HTTP on 127.0.0.1 via the test-only
  URL overrides): OAuth token endpoint (refresh + PKCE code exchange), a
  consent-redirect stand-in, and the Gmail media-upload send endpoint, with
  scenario switches (happy path, token revoked mid-run → 401, `invalid_grant`,
  `insufficientPermissions`, 429 / 403 rate limit, persistent 503, 413,
  connection dropped mid-upload, broader scope granted, state mismatch);
- a `curl` shim (Gmail runs only) that records every argv, the token-dir
  modes and any stray token copy at each call, plus a 50 ms `ps -eo args` sampler.

All containers are named `$PHF_PREFIX-*` (default `phf-mail-*`; the Gmail
end-to-end restore uses `phf-gm-e2e-restore`) and removed at the end, along
with the network and key tmpfs (verified: none left).

Result 2026-10-13 (Gmail API transport added): **340 passed, 0 failed**
(the 210 checks of T1–T15 unchanged + 130 new in T16), shellcheck clean, no
container or network left. Run: `PHF_PREFIX=phf-gm deploy/lucashome/backup/tests/email/run.sh`.

| Group | What is proven |
|---|---|
| T1 | disabled gate: archive and report exit 0, send and build nothing; dry-run builds nothing |
| T2 | build → encrypt → split (4 parts at 1 MiB) → one mail per part; state/status with message ids; no plaintext left; OpenPGP public-key + MDC, no symmetric packet |
| T3 | mails fetched from the catcher → `email-unpack.py` → sha256 equal to the build → decrypt → `SHA256SUMS` ok → **restore into a fresh container exactly per the runbook** (`ALTER DATABASE … RENAME`, `pg_restore --create --exit-on-error` **succeeds**) → row checksums equal for auth users, MFA factors, identities, migration history, orgs, products, sales, sale items, inventory, audit logs, buckets, objects, app_config, plus table/function/policy counts; storage files and functions **byte-identical**; MFA secret intact |
| T4 | 31 outgoing messages (archive, alerts, secrets, selftest; raw and every decoded part, Resend payloads incl. base64 attachments) scanned: **0 hits** for data/secret canaries, API key or private-key markers; positive control: the canary is inside the decrypted payload |
| T5 | one flipped byte → unpack names part 2, writes nothing; bypassing hashes → gpg exit 2 "manipulated"; forged index → refused |
| T6 | rerun of a sent week → nothing sent; `--force` → new id |
| T7 | SMTP accepts part 1 then fails → exit 1, FAIL, state "built" with 1 part; rerun sends only parts 2–4; reassembly from both runs ok |
| T8 | fail-closed matrix (§3), each: exit ≠ 0, FAIL, `last_success` unchanged, no success line; alerts arrive |
| T9 | Resend transport: one call per part, Idempotency-Key on each, provider ids recorded, attachments reassemble; rerun no-op; 401/500(retried)/422 fail closed |
| T10 | report numbers equal the hand-computed day (Yangon boundaries incl. 06:20 local = previous UTC day, voids excluded, COGS fallback, voided payment excluded, …); org A ↔ org B no cross-data; health block only for the operator target; correct recipients; rerun no-op; `--force`; unknown org → FAIL; read-only |
| T11 | secrets file: local mode not mailed; decrypts to the `.env`; MDC; email mode mails once, not again when unchanged, again after a change |
| T12 | `backup-status.sh`: identical exit code and problem list with the tier disabled, plus one `email tier: disabled` line; enabled → email failures become problems |
| T13 | renderer unit tests (escaping, `[ACTION NEEDED]`, stale/missing archive, no health without the option, empty day) |
| T14 | `--selftest`: synthetic-only payload mailed, unpacks and decrypts, holds no DB/storage, separate status job, no local build left |
| T15 | `--no-send` / `--output-dir`: drill builds, never sends or alerts, separate status job |
| T16 | **Gmail API** against the mock: preflight refusals reach Google with **zero** requests (non-127.0.0.1 URL override, foreign https API base, 0644 file, file owned by another user, scope ≠ gmail.send in the file, From ≠ sender, size limit > 35 MiB); selftest 1 part and `--selftest-parts 3` (1 token refresh for 3 sends; From = sender; unpack + decrypt); **real synthetic archives sent as 1 part and as exactly 3 parts → raw RFC 822 captured by the mock → `email-unpack.py` → sha256 = build → decrypt → SHA256SUMS → storage byte-identical → restore into a fresh `phf-gm-e2e-restore` with all T3 row checksums equal** (2 × 24 checks); Gmail id + threadId in `state.json`/`status.json`; 401 mid-run → one refresh → all parts sent; `invalid_grant` → FAIL with "gmail oauth token invalid — owner must re-mint" in status, `email-status.sh`, `backup-status.sh`, one token request and **zero** sends (no alert), build kept; 403 `insufficientPermissions` → FAIL, not retried; 429 and 403 `userRateLimitExceeded` → back-off then ok; persistent 503 → 3 attempts with 1 s/2 s back-off then FAIL; local size guard and provider 413 → FAIL without retry; upload dropped mid-way → FAIL, not retried, rerun sends only parts 2–3, all reassemble; mint helper: full PKCE/state flow → 0600 file with scope gmail.send, `--check` prints only `ok, scope=…, expires_in=…`, the minted file sends a selftest, refuses 0644 / invalid_grant / broader scope / state mismatch / Desktop / iCloud / non-127.0.0.1 override / overwrite; **leak scan** over 26 secret values (client secret, 4 refresh tokens, 22 access tokens): none in any curl argv, sampled `ps` argv, job log, status/state, received message, mint output, test output or leftover file; token dirs always 0700/0600 and gone afterwards; client id nowhere in argv/logs/mail; positive control for the leak scanner |

Side finding (existing script, not changed): `backup-status.sh` exits silently
under `set -e`/`pipefail` when the WAL archive directory exists but is
**empty** (`grep` on an empty listing). That never happens on the live host
(the archive always has segments). It is noted in the test, which gives the
fake tree one segment.

## 10. Owner-approval enablement checklist (Gmail API)

Rewritten 2026-10-13 for `MAIL_TRANSPORT=gmail-api` (the Resend/SMTP variant
is kept at the end as an alternative). Every step is gated. Steps marked
**owner** are done by the owner personally. The engineer never sees the
private key, the OAuth client secret or refresh token, any mailbox
password or the stack secrets; the engineer only ever checks file metadata
(`stat -c '%U %a %s' <file>`), never contents.

**A. Two Gmail accounts (owner, ≈ 20 min)**
1. **BACKUP mailbox (recipient):** a new free Gmail used only to receive
   backups, e.g. `pos.backup.box@gmail.com`. 2-Step Verification on;
   recovery phone/email set; backup codes printed and in the password
   manager. **Never** create an app password, OAuth client or token for it:
   its credentials never touch the server.
2. **SENDER account:** a second new free Gmail used only to send, e.g.
   `pos.backup.sender@gmail.com`. 2-Step Verification on (not
   security-key-only); recovery phone/email set; credentials in the password
   manager. Sign in by hand a few times over the first days (warm-up; **I**).
3. In the BACKUP mailbox: Settings → Filters → *Create a new filter*:
   From = the sender address → **Never send it to Spam**, **Apply the label**
   `pos-backup` (plus the §8 sub-labels). This is the main defence against
   spam filtering, which Google does not rule out for a free account **[G-SPAM]**.
4. Decisions: report targets (which org → which address; `health` on the
   owner's org) and secrets mode (`local` default or `email`, §5).

**B. Google Cloud project in the SENDER account (owner, ≈ 15 min, free)**
5. Open https://console.cloud.google.com signed in **as the sender account**
   (check the avatar). Create a project, e.g. `pos-backup-mail`. **No billing
   account** is needed for the Gmail API; decline any billing or free-trial
   prompt (**I**: Gmail API quota is free, [G-QUOTA]; nothing in this flow asks for billing).
6. APIs & Services → Library → **Gmail API** → Enable.
7. Google Auth Platform (OAuth consent screen):
   - *Branding*: app name `POS backup sender`, user support email = the sender address.
   - *Audience*: user type **External**. Add the sender address as a **test user**.
   - *Data access* → Add or remove scopes → tick **only**
     `https://www.googleapis.com/auth/gmail.send` ("Send email on your behalf").
     No `gmail.readonly`, `gmail.modify`, `https://mail.google.com/`, `openid`
     or `email`.
   - *Audience* → **Publish app** → status **In production**. Do **not**
     submit for verification. Why: with status *Testing* Google issues refresh
     tokens that **expire after 7 days** **[G-OAUTH][G-AUD]**, which would
     silently kill the weekly job. In production but unverified, the consent
     screen shows **"Google hasn't verified this app"**; that is expected for a
     personal-use app (Advanced → *Go to POS backup sender (unsafe)*), and an
     unverified app is capped at **100 users in total** **[G-UNV][G-EXC]** —
     here exactly one account (the sender) ever consents.
8. *Clients* → **Create client** → Application type **Desktop app** → name
   `pos-backup-mint` → Create → **Download JSON** (`client_secret_….json`).
   Put the JSON into the password manager (it is needed again to re-mint).

**C. Owner keys on the Mac (owner)**
9. OpenPGP recovery key: [owner-recovery-key.md](owner-recovery-key.md)
   (`owner-key-setup.sh`). Note the 40-hex fingerprint.
10. Mint the send-only token (repository checkout on the Mac; python3 stdlib only):
    ```bash
    mkdir -m 700 -p ~/pos-backup-keys
    python3 -I deploy/lucashome/backup/gmail-oauth-mint.py ~/Downloads/client_secret_*.json ~/pos-backup-keys/gmail-oauth.json
    ```
    The browser opens Google's consent page (loopback redirect to
    `http://127.0.0.1:<random port>`, PKCE S256, state check). Choose the
    **sender** account, click through the unverified-app warning, and allow
    only *Send email on your behalf*. The helper refuses unless the granted
    scope is exactly `gmail.send`; it refuses Desktop, Documents, iCloud Drive
    and `~/Library/CloudStorage` as the output location; it writes a new 0600
    file and prints no token. On error it exits non-zero and writes nothing.
11. Copy both files to the server (the backup jobs run as the SSH user, so the
    file must be owned by that user with mode 0600 — the jobs refuse anything else):
    ```bash
    ssh lucashome 'mkdir -p -m 0700 /srv/supabase/backup/credentials'
    scp ~/pos-backup-keys/gmail-oauth.json lucashome:/srv/supabase/backup/credentials/gmail-oauth.json
    scp owner-backup.pub.asc               lucashome:/srv/supabase/backup/credentials/owner-backup.pub.asc
    ssh lucashome 'chmod 0600 /srv/supabase/backup/credentials/* && stat -c "%U %a %s %n" /srv/supabase/backup/credentials/*'
    rm -P ~/pos-backup-keys/gmail-oauth.json ~/Downloads/client_secret_*.json   # after the --check below is ok
    ```
12. Check the token **on the server, as the backup user** (one token refresh,
    no mail sent; requires step D13's deploy, which copies the helper):
    ```bash
    ssh lucashome 'python3 -I /srv/supabase/backup/bin/gmail-oauth-mint.py --check /srv/supabase/backup/credentials/gmail-oauth.json'
    # expected: ok, scope=https://www.googleapis.com/auth/gmail.send, expires_in=3599
    ```

**D. Install, disabled (engineer, after approval)**
13. Merge this branch per the usual process. `deploy/lucashome/backup/deploy.sh`
    (**without** `--cron`) copies the scripts and `gmail-oauth-mint.py`.
    `backup.env` is not overwritten.
14. Append the email section of `backup.env.example` to the live `backup.env`:
    `EMAIL_ENABLED=false`, `MAIL_TRANSPORT=gmail-api`,
    `GMAIL_SENDER=<sender address>` (`MAIL_FROM` then defaults to
    `POS backups <sender>`), `ARCHIVE_MAIL_TO=<backup mailbox>`,
    `ALERT_MAIL_TO=<backup mailbox or the owner's personal address>`,
    `ARCHIVE_GPG_FPR=<owner fingerprint>`. Write `report-targets.conf` (0600).
    Never set `GMAIL_TOKEN_URL`/`GMAIL_API_BASE` (test-only; refused unless 127.0.0.1).
15. Checks, all without sending: `email-archive.sh --dry-run`,
    `email-report.sh --render-only /tmp/r --date <yesterday>` (read on the server,
    then `rm -rf /tmp/r`), `email-status.sh`, `backup-status.sh` (expect one
    `email tier: disabled` line, otherwise unchanged), and step 12.

**E. First live sends: synthetic only, zero business data (owner approval)**
16. Single part: `EMAIL_ENABLED=true /srv/supabase/backup/bin/email-archive.sh --selftest`
17. Multipart: `EMAIL_ENABLED=true /srv/supabase/backup/bin/email-archive.sh --selftest --selftest-parts 3`
18. Realistic size (optional, recommended once): `EMAIL_ENABLED=true … --selftest --selftest-parts 2 --selftest-mib 28`
    (two parts of ≈ 14 MiB random data ≈ 19.5 MB encoded each, close to the real 15 MiB part size).
19. Each run must end with `archive pos-selftest-… sent: N part(s)`; status job
    `email-selftest` is `ok` with one Gmail message id per part.
20. The owner downloads every received mail on the Mac (Gmail → ⋮ → *Download
    message* → `.eml`) and runs the restore runbook §2 on them:
    `email-unpack.py --out ~/selftest ~/Downloads/*.eml` (every part and the
    total verified), `gpg --output st.tar --decrypt ~/selftest/*.tar.gpg; echo $?`
    (must print 0), `tar -xOf st.tar ./SELFTEST.txt` (readable). Then go through
    the **go-live verification** below.

**Go-live verification (owner, in the BACKUP mailbox, for each selftest mail)**
- [ ] It is in the **Inbox / label `pos-backup`, not in Spam**, and shows no
      warning banner ("Be careful with this message", "This message seems
      dangerous", "suspicious attachment").
- [ ] Sender shown is the sender account; the subject carries `SELFTEST (synthetic, no data)` and `part i/N`.
- [ ] Attachments are listed with their full names (`…tar.gpg.001`,
      `….INDEX.txt`, `….index.json`) and sizes; none is blocked or flagged as
      unscannable.
- [ ] ⋮ → **Show original**: `SPF: PASS`, `DKIM: 'PASS' with domain gmail.com`
      (and `DMARC: 'PASS'`), i.e. "Mailed by / Signed by gmail.com"
      **[G-ORIG][G-AUTH]**.
- [ ] The multipart run delivered **all** N parts; `email-unpack.py` reports
      every part `ok` and the total sha256 matches the body.
- [ ] `gpg` exit 0; the selftest note is readable.
- [ ] In the SENDER account, the messages appear under *Sent* (**U**: expected
      Gmail behaviour; if so, prune Sent yearly, §8).
- [ ] Record date, part counts and results in the ops log.

**F. First real archive (owner approval)**
21. Set `EMAIL_ENABLED=true` in `backup.env`. Run `email-archive.sh` by hand.
    The owner confirms receipt of all parts and runs the restore runbook
    verification: unpack + decrypt + `sha256sum -c SHA256SUMS`, and the
    **full disposable restore** (runbook §5 drill) on the Mac.
22. `email-secrets.sh` (local mode). If mode `email`: confirm the mail arrives and decrypts.
23. `email-report.sh` for yesterday: the owner checks the figures against the app and the health block.

**G. Schedule (owner approval)**
24. Uncomment the email lines in `crontab.lucario` (weekly archive Sun
    04:30 UTC + 06:30 resume attempt, secrets 04:40, report 01:00 + 03:00) and
    install with `deploy.sh --cron` (this installs the whole file; review the
    diff with `crontab -l` first).
25. After the first scheduled Sunday: `backup-status.sh` shows the archive
    line OK, and the Monday report shows the archive id. Record the date in
    `docs/lucashome-selfhost/status.md` and close the roadmap item.

**Re-mint the token (steps 10–12)** after: any password change of the sender
account (Google revokes refresh tokens with Gmail scopes on password change),
removal of the app under the sender's *Third-party connections*, the client
being deleted, or six months without a successful send **[G-OAUTH]**. The
symptom is always `gmail oauth token invalid — owner must re-mint` in
`backup-status.sh`, and **no mail at all** (alerts travel the same broken
path, §3.2): a missing Sunday archive or daily report means "check the server".

**Rollback at any point:** set `EMAIL_ENABLED=false` (scripts become no-ops),
comment the cron lines, and revoke the token: sender account →
myaccount.google.com → Security → *Third-party apps & services* → POS backup
sender → *Delete all connections*; optionally delete the OAuth client in the
Cloud console. Nothing in the database or in the existing backups changes.

**Alternative transports (unchanged):** Resend (`MAIL_TRANSPORT=resend`, a
`sending_access` key in `resend.key`, sender domain or `onboarding@resend.dev`
to the account owner only) or a send-only SMTP relay (`smtp.netrc`). Same
install/selftest/schedule gates; the key goes to
`/srv/supabase/backup/credentials/` with mode 0600
(`ssh lucashome 'umask 077; cat > …/resend.key'`, paste, Ctrl-D).

**Never** part of this: Gmail app passwords, any scope other than
`gmail.send`, credentials of the BACKUP mailbox on the server,
`rotate-audit-log`, pg_cron jobs, `net.http_post`, service-role keys in the
database, or any change to hosted Supabase.

**What remains unverifiable until the owner's accounts exist:** real inbox
placement (Inbox vs Spam, banners) and SPF/DKIM/DMARC results; whether Gmail
scans or flags 15–20 MB `.gpg` attachments; that the Cloud project really
asks for no billing; the exact consent-screen wording; Google's actual token
response (scope string, `expires_in`); whether API-sent mail lands in the
sender's Sent folder; and Gmail's behaviour for a From that is not the
account (the preflight never lets that happen).

## 11. Risks and open items

| # | Item | Mitigation / status |
|---|---|---|
| R1 | Offsite RPO = 7 days (weekly) | daily DB-only archive option (§4), not built |
| R2 | Resend changes its free tier | SMTP fallback already implemented (SMTP2GO 50 MB/200/day, Brevo) **[R]** |
| R3 | Owner loses the private key **and** the paper copy | archives become useless; quarterly drill verifies the owner can still decrypt |
| R4 | Mailbox fills or is deleted for inactivity | retention routine (§8); yearly login |
| R5 | gpg emits unverified plaintext on failure | runbook: file output + exit status gate (§2) |
| R6 | Archive authenticity relies on mailbox integrity (public-key encryption is not a signature) | dedicated mailbox, DKIM, daily-report cross-check of id/parts |
| R7 | Splitting relies on all parts arriving | every mail carries the full index; `--list` shows gaps; resume re-sends only missing parts, `--force` makes a new set |
| R8 | Resend idempotency-key retention window | **U**: verify in the API docs before enabling |
| R9 | Secrets kept `local` only → lost with the host | owner stores `.env` + pgsodium key in the password manager, or chooses `email` mode |
| R10 | `weekly-sales-report` / `rotate-audit-log` not org-safe | not used, not scheduled (email-audit.md) |
| R11 | Gmail refresh token dies (password change of the sender, user revocation, 6 months unused, client deleted, Testing status) | publish **In production**; re-mint procedure §10; fails closed with a named reason; dead-man = missing Sunday archive / daily report + `backup-status.sh` (§3.2) |
| R12 | Free consumer Gmail: no SLA, possible spam filtering, account suspension or policy change | "never send to Spam" filter + label; go-live verification; local tiers stay primary; Resend/SMTP alternatives already implemented |
| R13 | A compromised server can mail-bomb the backup mailbox (any send credential can) | accepted; owner notices; the backup mailbox credentials are never on the server |

Sources for **[R]** (retrieved 2026-10-13): Gmail size/limits
support.google.com/mail/answer/6584, /a/answer/1366776, /mail/answer/22839,
/mail/answer/7126229 (IMAP always on), /accounts/answer/185833 (app passwords),
/mail/answer/6374270 (storage), /accounts/answer/12418290 (inactivity);
Resend resend.com/pricing, /docs/knowledge-base/account-quotas-and-limits,
/docs/dashboard/emails/attachments (40 MB), /docs/knowledge-base/403-error-resend-dev-domain,
/docs/api-reference/api-keys/create-api-key (`sending_access`); SMTP2GO
support.smtp2go.com free plan; Brevo brevo.com/free-smtp-server; Outlook.com
support.microsoft.com (POP/IMAP/SMTP settings, OAuth2). Full research notes are kept
outside the repo.
