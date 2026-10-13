# Phase F · Email-based offsite backups — design

Status: **built and tested on synthetic data, 2026-10-13. Not deployed, not
enabled, not scheduled.** Nothing was written to `lucashome`. No mail account,
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
4. **Transport: Resend HTTPS API with a `sending_access` key restricted to the
   sender domain** (recommended). SMTP via `curl` is a provider-agnostic
   fallback. The server holds **only** that send-only key and the owner's
   **public** key. The receiving mailbox's credentials never touch the server.
5. **Recipient: a dedicated backup mailbox** (e.g. a new free Gmail with 2SV on
   and **no app password ever created**). A compromised server can then send
   junk but cannot read or delete past backups.
6. **Fits email today with a wide margin**: one message of ≈ 8.5 MB encoded,
   against a 25 MB limit. Splitting starts at about 15 MiB of ciphertext,
   roughly 3–5 months into real trading. The design scales to about
   12 parts (≈ 180 MiB). Beyond that the job **fails closed** and email is no
   longer the right channel (§4).
7. **$0 recurring**: Resend Free (100/day, 3,000/month, no card, hard stop
   rather than a bill) **[R]**, a free Gmail inbox (15 GB) **[R]**, and `gpg`,
   `curl` and `python3`, which are already on the host (**V**). Nothing needs installing.
8. **Owner approvals needed** are listed in §10: sender domain/key, backup
   mailbox, key pair, then three gated steps (selftest, first real archive,
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
│   tar | gpg -e (owner PUBLIC key, AES256, MDC, no zip)     │      Resend API        dedicated
│   split 15 MiB → parts + INDEX.txt/index.json              │ ───▶ (send-only key) ──▶ backup mailbox
│   one mail per part (+index) — resume-aware, idempotent    │      or SMTP fallback   (Gmail, 2SV)
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
| `email-lib.sh` | config + defaults (all placeholders; host/paths/addresses from `backup.env`), gate, credential file checks, `mail_send` (Resend API or SMTP via curl), `mail_alert`, `gpg_pubkey_check`, `gpg_encrypt_stream`, `gpg_integrity_ok` |
| `email-mime.py` | builds one message: RFC 5322 `.eml` for SMTP or the Resend JSON payload (stdlib) |
| `email-archive.sh` | weekly archive: build → encrypt → verify packet integrity → split → send → state/status; `--dry-run`, `--force`, `--build-only`, `--week`, `--selftest` |
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

| Transport | Credential file (0600/0400, owned by the backup user, never in git or `backup.env`) | Format | What a thief can do with it |
|---|---|---|---|
| `resend` (default) | `RESEND_KEY_FILE` = `/srv/supabase/backup/credentials/resend.key` | one line: the API key | send mail as the verified domain until revoked. **Cannot** read, list or delete mail (`sending_access`) **[R]** |
| `smtp` (fallback) | `SMTP_NETRC_FILE` = `/srv/supabase/backup/credentials/smtp.netrc` | `machine <smtp host> login <user> password <secret>` | depends on the provider. Use a **send-only** SMTP credential (e.g. SMTP2GO/Brevo SMTP key). **Never** a Gmail app password (see below) |

- Keys never appear in argv or the environment. The Resend key reaches `curl` through
  `--config -` on stdin. SMTP uses `--netrc-file`. The scripts check the owner and
  mode of each file and never read it in the log path. A file with mode 0644 fails
  preflight (tested).
- **Gmail app passwords are excluded.** Since Jan 2025 IMAP is always on, so
  an app password used for SMTP would also give full IMAP access to that
  mailbox, including deleting old backups **[R]**. Outlook.com SMTP requires
  OAuth2 **[R]**. A **dedicated sender** therefore keeps the receiving mailbox
  out of reach: Resend with a domain key, or an SMTP relay account whose key
  can only send.
- Acceptance: success means **Resend HTTP 200 with an id**, or **curl exit 0 with
  SMTP final reply 250**. A single non-accepted part fails the run. Retries
  happen only on transient errors (curl connect/timeout/TLS codes, HTTP
  429/5xx), `MAIL_RETRIES` times with `MAIL_RETRY_SLEEP_S` between them. A 4xx
  other than 429 is permanent.
- Local size guard: a message larger than `MAIL_MAX_ENCODED_BYTES` (default
  24,000,000) is refused before it is handed over (tested).
- Every failure, whether preflight, dump, disk, encrypt, split or send, results in:
  exit 1, `status.json` `jobs["email-archive"].last_result = "fail"`,
  `last_success` unchanged, no "sent" log line, the plaintext staging dir
  removed, any `.partial` build removed, and a **failure notification mail**
  (job, reason, log path; no data, no attachment) to `ALERT_MAIL_TO`, sent
  best-effort through the same transport. The matrix in §9 (T8) is
  test-proven for SMTP unreachable, provider oversize rejection (552), the local
  size guard, fingerprint mismatch, missing key, a secret key in the key file,
  disk full in staging, disk full in the archive dir, loose credential
  permissions, Resend 401, Resend 500 (retried) and Resend 422.
- If the transport itself is down, the alert cannot be sent either. The
  backstops are `backup-status.sh` (which flags an `email-archive` failure or
  an archive older than 8 days, and pings healthchecks if configured) and the
  daily report's health block. The report travels the same channel, so a total
  transport outage is caught by **the owner not receiving the daily report**
  (§7).

Delivery confirmation beyond provider acceptance: the server holds **no IMAP
credential**, by design. Confirmation works on the owner side:
- the daily report's health block shows `weekly email archive: last sent <id>
  (<n> part(s)) <age> ago`;
- the owner checks the mailbox has `<id> part 1/n … n/n`, weekly at a glance
  and monthly by running `email-unpack.py --list` on the downloaded mails
  (§8).

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
| transport completely down (no mail at all) | **the daily report stops arriving** | owner. Rule: *no report by 09:00 Yangon = check the server* |
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
4. Log in at least once a year (2-year inactivity deletion **[R]**). Watch the
   15 GB quota; at the current size it is about 1 % per year.
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
  endpoint (key check, idempotency keys, injected 401/422/500).

All containers are named `phf-mail-*` and removed at the end, along with the
network and key tmpfs (verified: none left).

Result 2026-10-13: **194 passed, 0 failed**, shellcheck clean:

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

Side finding (existing script, not changed): `backup-status.sh` exits silently
under `set -e`/`pipefail` when the WAL archive directory exists but is
**empty** (`grep` on an empty listing). That never happens on the live host
(the archive always has segments). It is noted in the test, which gives the
fake tree one segment.

## 10. Owner-approval enablement checklist

Every step below is gated. Steps marked **owner** are done by the owner
personally. The engineer never sees the private key, the API key, the mailbox
password or the secrets.

**A. Decisions (owner)**
1. Sender: is there already a **verified Resend domain** (the app's
   `REPORT_EMAIL_FROM` on hosted)? (**U**)
   - Yes: `MAIL_FROM = "POS backups <backups@<domain>>"`.
   - No, and no domain wanted: create a **separate** free Resend account whose
     login email **is** the new backup mailbox. Send from
     `onboarding@resend.dev`, which Resend delivers only to that address
     **[R]**. The weekly archive works. Daily reports then also go to that
     mailbox only, so the owner reads them there or sets a Gmail forward.
2. Backup mailbox: a new free Gmail used only for this, 2SV on, **never** an
   app password, recovery phone/email set, credentials in the password manager.
3. Report targets: which org(s) to which address(es); `health` on the
   owner's org.
4. Secrets mode: `local` (default) or `email` (§5).

**B. Accounts and keys (owner, ≈ 30 min)**
5. Resend → API Keys → Create: name `pos-backup-host`, permission **Sending
   access**, domain = the sender domain. Keep it in the password manager.
   It is separate from any key used by the app's Edge Functions.
6. Owner key pair, on the owner's own device (Mac: `brew install gnupg paperkey`):
   ```
   gpg --quick-gen-key 'POS backup owner <backup-owner@invalid>' default default never   # ed25519 + cv25519; set a strong passphrase
   gpg --fingerprint 'POS backup owner'                                                   # note the 40-hex fingerprint
   gpg --armor --export <FPR> > owner-backup.pub.asc                                      # public key → server
   gpg --armor --export-secret-keys <FPR> > owner-backup.SECRET.asc                       # → password manager (attachment), then delete the file
   gpg --export-secret-keys <FPR> | paperkey --output owner-backup.paper.txt               # print, store with important papers, delete the file
   # the revocation certificate is in ~/.gnupg/openpgp-revocs.d/<FPR>.rev → password manager too
   ```
   The private key exists in three places: the device keyring, the password
   manager (passphrase-protected export) and paper. It never goes to the
   server, the repo or email. Recovery if `lucashome` is lost needs only the
   private key, its passphrase and the mailbox (runbook).
7. Put the two files on the server (owner, over SSH; content never shown to the engineer):
   ```
   ssh lucashome 'mkdir -p -m 0700 /srv/supabase/backup/credentials'
   scp owner-backup.pub.asc lucashome:/srv/supabase/backup/credentials/owner-backup.pub.asc
   ssh lucashome 'umask 077; cat > /srv/supabase/backup/credentials/resend.key'     # paste the key, Enter, Ctrl-D
   ssh lucashome 'chmod 0600 /srv/supabase/backup/credentials/*'
   ```
   For the SMTP fallback instead: `smtp.netrc` with one `machine … login …
   password …` line, a **send-only** SMTP key, mode 0600.

**C. Install, disabled (engineer, after approval)**
8. Merge this branch per the usual process. `deploy/lucashome/backup/deploy.sh`
   (**without** `--cron`): copies the scripts. `backup.env` is not
   overwritten.
9. Append the email section of `backup.env.example` to the live `backup.env`,
   with `EMAIL_ENABLED=false`, `MAIL_FROM`, `ARCHIVE_MAIL_TO`, `ALERT_MAIL_TO`,
   `ARCHIVE_GPG_FPR=<owner fingerprint>`. Write `report-targets.conf` (0600).
10. Checks, all without sending: `email-archive.sh --dry-run`,
    `email-report.sh --render-only /tmp/r --date <yesterday>` (read the
    rendered text on the server, then `rm -rf /tmp/r`), `email-status.sh`,
    `backup-status.sh` (expect one `email tier: disabled` line, otherwise unchanged).

**D. First live send: synthetic only (owner approval)**
11. `EMAIL_ENABLED=true email-archive.sh --selftest` (env override for this one
    run). The owner downloads the mail ("Download original" → `.eml`), runs
    `email-unpack.py --out ~/selftest ~/Downloads/*.eml`, then
    `gpg --output st.tar --decrypt ~/selftest/*.tar.gpg && tar -xOf st.tar ./SELFTEST.txt`.
    The message must be readable. This proves the key, transport, mailbox and
    tooling with **zero business data**.

**E. First real archive (owner approval)**
12. Set `EMAIL_ENABLED=true` in `backup.env`. Run `email-archive.sh` by hand.
    The owner confirms receipt of all parts and runs the runbook's
    verification: at minimum unpack + decrypt + `sha256sum -c SHA256SUMS`;
    ideally the full Docker restore drill on their device.
13. `email-secrets.sh` (local mode). If mode `email`: confirm the mail
    arrives and decrypts.
14. `email-report.sh` for yesterday: the owner checks the figures against the
    app and the health block.

**F. Schedule (owner approval)**
15. Uncomment the email lines in `crontab.lucario` (weekly archive Sun
    04:30 UTC + 06:30 resume attempt, secrets 04:40, report 01:00 + 03:00) and
    install with `deploy.sh --cron` (this installs the whole file; review the
    diff with `crontab -l` first).
16. After the first scheduled Sunday: `backup-status.sh` shows the archive
    line OK, and the Monday report shows the archive id. Record the date in
    `docs/lucashome-selfhost/status.md` and close the roadmap item.

**Rollback at any point:** set `EMAIL_ENABLED=false` (scripts become no-ops),
comment the cron lines, and revoke the Resend key in the dashboard. Nothing in
the database or in the existing backups changes.

**Never** part of this: `rotate-audit-log`, pg_cron jobs, `net.http_post`,
service-role keys in the database, or any change to hosted Supabase.

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
