# Disaster recovery and backup verification (2026-10-18)

Scope: can Orvix POS recover from database loss or corruption, loss of the server, missing or
damaged backups, interrupted backup/restore, loss of configuration and secrets, and recovery while
tills hold unsynchronised work? Local audit + disposable drills only — nothing here touched
`lucashome`, a real backup, a real credential or a cloud service.

Evidence classes: **C** confirmed in this repository / by a disposable drill run on 2026-10-18;
**D** documentation claim (the ops record — `lucashome` was not accessed); **U** unverified.

**Synthetic, not production evidence.** Every **C** below comes from disposable local stacks seeded with
synthetic organisations, local compose models and fake `tailscale`/`ssh`/`docker` stand-ins. None of it
was taken from production data, a real backup, `lucashome`, a real mailbox or a real Tailscale node. A **C**
shows that the scripts and the procedure behave as described on those copies. It does not show that
production backups restore, or that the production host behaves the same. Only a restore of a real
backup on another machine (§9) can show that.

**Restore validation alone never authorizes reopening the API.** The gate (§5) only reads: whatever it
answers, reopening is a separate, manual, owner-authorised step (README §R), taken only after:
- the results were reviewed;
- every till was reconciled or quarantined (§6).

## 1. Backup coverage

| Component | Backup source | Frequency | Retention | Offsite? | Restore tested? | Evidence |
|---|---|---|---|---|---|---|
| PostgreSQL `postgres` db (every schema: public, auth incl. password hashes + MFA secrets, storage, migrations ledger, vault, cron) | `backup-logical.sh` `pg_dump -Fc --create` | hourly | 48 h / 14 daily / 8 weekly | **No** (same NVMe) **D** | weekly `restore-test.sh` compares **counts only** **D**; drills: restored into fresh servers with identical row + schema fingerprints **C** | `tests/dr` S1/S2 |
| Roles (with SCRAM **password hashes**), memberships, role/db settings | `globals.sql`, `db-settings.sql` | hourly | as above | No | **C** (roles, memberships, effective grants identical) | `dr-schema-fingerprint.sql` |
| `_supabase` db (pooler/analytics metadata) | `_supabase.dump` | hourly | as above | No | restored **C** | — |
| PGDATA (physical) | `backup-base.sh` (`pg_basebackup` + `pg_verifybackup`) | daily | 14 | No | weekly physical restore, DR drill 2026-10-13 123/0 (on `lucashome` itself) **D** | status.md |
| WAL (point in time) | `archive_command`, `archive_timeout=300` | ≤ 5 min | back to the oldest base (~14 d) | **No** | `pitr-test.sh`, DR drill PITR **D** | WAL-ARCHIVING.md |
| **Storage objects** (product image bytes) | **none in operation**: no active job copies `stack/volumes/storage` (the base backup is PGDATA only; `offsite-sync.sh storage` is commented out; the email archive that carries `files/storage.tar.gz` is disabled) | — | — | **No** | the archive path is proven **C** (S2: every object's bytes identical) — but it is not running | `crontab.lucario` **C** |
| Edge Functions source | git + `files/functions.tar.gz` in the (disabled) archive | on change | git history | git **D** | archive contents verified **C** | — |
| Stack config (compose override, version, conf.d, pg_hba) | git (`deploy/lucashome/`) + archive `config/` (disabled) | on change | — | git | contents verified **C** | — |
| **Secrets**: the whole stack `.env` (JWT secret, anon/service keys, service + dashboard passwords, SMTP/provider settings, function secrets, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`), `pgsodium_root.key` | `email-secrets.sh` (separate gpg file, same owner key) — **not sent** (`EMAIL_SECRETS_MODE` local, email tier off); `backup-base.sh` copies the pgsodium key **in plaintext next to each base backup** on the same disk | weekly / on change | 14 local | **No** | **No** real rebuild from it; drill: losing the JWT secret makes every installed till's anon key fail (401) **C** | §4 |
| Owner gpg private key (decrypts every offsite copy AND the secrets) | the owner only | — | — | owner | wrong key cannot decrypt **C** | owner-recovery-key.md **D** |
| Tailscale identity/serve config, gateway, functions router | git (`deploy/lucashome/*`); R2 secrets bundle (disabled, superseded) | — | — | git | not tested | — |
| Mail credentials (backup sender) | not backed up by design (re-minted) | — | — | — | — | README |
| Realtime | stateless | — | — | — | — | — |
| Tills' work (unsynced sales, unknown payments) | each till's IndexedDB; encrypted **queue export** by staff (unresolved work only) | on demand | — | per device | m086 suites, recovery tool **C** | queue-export.md |

**Headline (D, ops record 2026-10-16): every copy is on `lucashome`'s single NVMe, and storage
objects have no copy at all.** The email tier (the chosen offsite channel) is installed disabled.
**A disk or host loss today is a total loss of server data and of every product image.**

## 2. Weaknesses

| # | Weakness | Severity | Status |
|---|---|---|---|
| W1 | No offsite copy in operation; all copies on one disk | CRITICAL (production) | owner: enable the email tier |
| W2 | Secrets (`.env`, pgsodium key) not offsite; losing the JWT secret forces a **new build for every till** (proven 401) | CRITICAL (production) | owner: `EMAIL_SECRETS_MODE=email` or an offline copy |
| W3 | Offsite cadence weekly → host-loss RPO up to 7 days | HIGH | owner decision (§3) |
| W4 | Storage objects: no backup in operation, even locally (images lost with the volume) | HIGH | owner: enable the archive, or a local storage copy job |
| W5 | A production restore has no independent reference (no fingerprint captured in the dump's own snapshot): a lost tombstone or ledger row is undetectable once the source is gone | MEDIUM — financial | **not accepted; owner decision**: implement a snapshot-consistent fingerprint at backup time (`pg_export_snapshot` + `pg_dump --snapshot`) |
| W6 | A killed backup job did not record the failure or remove its partial output | LOW | **fixed** (TERM/INT/HUP traps; cleanup ignores further signals). Verified **by execution only for `backup-logical.sh`** (drill: killed mid-dump → no `.partial`, `last_result: fail`); `backup-base.sh` and `email-archive.sh` carry the same traps, verified **by inspection only** (§5.5). A cleanup that hangs can then only be stopped with SIGKILL |
| W7 | Nothing told "PostgreSQL started" apart from "this restore may serve tills". The runbooks reopened the API, or never closed it | HIGH | **Corrected in the repository (snapshot 24); not deployed, verified only on local models.** Snapshot 23 called this "fixed", but it was not: README §B/§B2 only stopped `db` (the gateway kept serving); README §A step 6 `up -d` everything but `api-gw` started the gateway again through `functions → api-gw`; restore-from-email.md started everything, re-enabled Tailscale Serve and let a till sync before any gate. Now `restore-api-guard.sh` closes and confirms every entry point before PostgreSQL is touched (§5.6), the database starts only with `--no-deps`, the gate (§5) runs, and reopening is the manual README §R. Checked by `tests/dr/api-isolation-test.sh` and `tests/dr/runbook-check.sh` |
| W14 | `deploy.sh` never copied any `dr-*.sql`: on the server the gate could not run its checks and `dr-restore-fixups.sql` was missing (`dr-drill.sh` likewise lacked its SQL) | HIGH | **corrected in the repository** (§5.2): `deploy-manifest.txt`; the package is staged and verified before any `ssh`; the migration source is shipped; the server copy is re-verified. `tests/dr/packaging-test.sh`. Not deployed |
| W15 | A malformed `--count-tolerance` (e.g. `abc`) made every tolerant count comparison error out and **pass**; any tolerance also applied to sales, payments, ledger and migration counts; a failed checksum query passed as "0 recorded"; an empty invariant output passed | HIGH — financial | **corrected** (§5.1): validated tolerance (else exit 2), strict equality except GoTrue session churn, failed/empty queries FAIL. `tests/dr/gate-unit-test.sh` |
| W8 | **Tills cannot detect a restored server** (same URL); work recorded after the backup is lost silently | **BLOCKER** | §6 — needs a migration + client change. **Phase 0 (client, 2026-10-19)**: every financial operation is journaled on the till and kept after acknowledgement (key, request, the server's reply); a full load that no longer returns sales / supplier payments this till had loaded keeps them as evidence and pauses automatic sync until an owner acknowledges. Detects only rollbacks that lose rows this till had loaded, and only when the same user, role, shop and permissions make the next full load (another user's view is never compared); restoring the lost operations on the server is not automated |
| W9 | No full rebuild on another machine from the offsite copy has been done | HIGH | owner prerequisite |
| W10 | **The first drain after a restore FENCES every in-doubt key** (`outbox.ts` lookup with `fence: true`): a sale that really happened before the restore can then never be replayed under its key, and the till tells the cashier it "never ran" (proven R6) | **BLOCKER** (part of W8) | §6. **Phase 0 (client)**: no automatic fence on "not found" (drain, Confirm with server, recovery tool without `--fence-unfound`) — held as "Reconciliation required" for an owner (Stop on server with a statement); proven by `run.sh tills` R6. Builds before Phase 0 still fence |
| W11 | A **logical** restore loses the USAGE grants on the schemas `graphql` / `graphql_public` (C: the dump has no schema ACL entries for them; the cause is **U** — likely their privileges sit in `pg_init_privs` of the image's init, which pg_dump treats as the default; pg_graphql is not installed here) | HIGH | **found by the drill, fixed**: `dr-restore-fixups.sql` (runbook §A step 5); an invariant in `dr-financial-checks.sql` detects a skipped step even without a reference. Whether other objects behave alike: the schema fingerprint compares functions outside public, sequences, column and database grants (C: nothing else differed) |
| W12 | A restore brings back every login role's **password hash** (`globals.sql`): after a theft, the stolen passwords keep working unless rotated | MEDIUM | runbook: rotate EVERY login role (§4) |
| W13 | `restore-test.sh` (weekly, production) still compares counts only | MEDIUM | recommendation: run the gate's invariants there too |

Pre-existing, not a restore issue (noted for a separate look): `anon` holds `arwdDxt` (incl. TRUNCATE)
on `public.audit_logs` in both source and restore; PostgREST cannot issue TRUNCATE.

## 3. Recovery objectives (proposal — for owner approval)

| Event | Proposed RPO | Proposed RTO | Achievable today? |
|---|---|---|---|
| Database corrupted / bad migration, disk healthy | ≤ 5 min (PITR) | ≤ 30 min | yes, locally (D) |
| Database volume lost, disk healthy | ≤ 1 h (hourly dump) / ≤ 5 min (base + WAL) | ≤ 30 min | yes (D); a logical restore needs the fix-ups step (W11) |
| **Host or disk lost** | **≤ 24 h** | ≤ 4 h core POS | **No**: everything lost today (W1, W4); ≤ 7 days with the weekly archive (W3); ≤ 24 h needs a daily archive |
| Secrets lost with the host | — | ≤ 4 h only with the secrets offsite | **No** (W2) |
| Any restore while tills hold or recently synced work | — | — | **No safe automatic path** (W8, W10); manual control only (§6) |

Tills keep selling offline during an outage, so RTO is "until the server accepts work again".

## 4. What a complete rebuild needs

1. The newest offsite archive (`email-unpack.py` verifies every part and the whole, then gpg).
2. The owner's **private** key — it opens the data AND the secrets (one key for everything).
3. The **whole stack `.env`**: the JWT secret (else every installed till's anon key is refused and
   every till needs a new build — proven), anon/service keys (re-mintable from the same secret; old
   ones stay valid), GoTrue SMTP/email-code provider settings (admin sign-in codes), dashboard and
   service passwords, function secrets, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`.
4. **Rotate every login role's password** after restoring `globals.sql` (it restores the source's
   SCRAM hashes): `authenticator`, `supabase_auth_admin`, `supabase_storage_admin`, `postgres`,
   `supabase_admin`, `pgbouncer`, `supabase_functions_admin`, … — write the new ones into the new `.env`.
   The drill rotated `authenticator` and proved PostgREST serves the restored database with it.
5. `pgsodium_root.key` (vault; `vault.secrets = 0` today).
6. The **same backend URL** (Tailscale identity/serve config): the URL is built into every till; a
   different URL needs a new build and quarantines every queued entry (§6).
7. The repo at the deployed commit; a fresh backup-sender credential.

Proven by the drills: the S2 restore used nothing from the source (its containers, volumes and the
local backups were deleted first) — database **and** storage bytes from the offsite copy alone.
**Not** proven: GoTrue password / TOTP sign-in on a restored database (no MFA factor in the drill
data), storage-api serving the restored objects, a whole stack on a second machine.

## 5. The restore gate — `deploy/lucashome/backup/dr-verify-restore.sh`

`RESULT: HEALTHY` only when every check passes **and** the restore was compared with an independent
reference; otherwise `FAILED` or `INCONCLUSIVE` (exit 1): do not promote, keep the API closed.
Read-only; prints counts, md5s and object names only.

- `backup --dir SET --expect-version NNN`: both layouts (hourly dump set; unpacked email archive) —
  SHA256SUMS, required components (dumps, globals, settings, counts; storage tarball for the
  archive), completion time (stale refused unless `--accept-stale`; future refused), **every data
  block** readable (`pg_restore` to /dev/null), the schema version inside the dump, no JWT secret
  in the database settings.
- `fingerprint`: rows of every public table, auth, storage, migrations + roles, memberships,
  extensions, function definitions/owners/effective grants/settings, table columns, tables of
  public/auth/storage (RLS, effective grants as a set, owners), schemas (owner, effective grants),
  constraints, policies, triggers, default privileges, database and role settings.
- `restore --expect-version NNN --migrations DIR [--reference REF] [--counts counts.json]`:
  fingerprint equal to the reference; counts equal to the backup's own `counts.json`; every
  invariant of `dr-drill-consistency.sql` and `dr-financial-checks.sql` 0 (PO paid = its non-voided
  payments, paid ≤ total, eleven cross-organisation links: PO shop/supplier, sale shop/cashier, sale
  item product, PO item product, stock movement, inventory, shift, transfer, supplier payment author,
  ledger row vs actor, users without org; stock movement arithmetic; 086 state/tombstone rules and
  the validated constraint; key ledger ↔ payments; roles; RLS); migration ledger exactly the repo's
  versions minus the held 084 **and** its recorded sha256 checksums equal to the repo files; schema
  version NNN; storage objects present with their sizes and their number equal to the backup's.
- Without `--reference` the verdict is **INCONCLUSIVE** (invariants cannot tell an empty or
  partial restore from a complete one). `--accept-no-reference --counts counts.json` is the
  production fallback until W5 exists: it requires the backup's **per-table row counts** (`rows`,
  recorded since this pass by `backup-lib.sh COUNTS_SQL`) and answers at best
  **ACCEPTED-WITHOUT-REFERENCE** (exit 3) — counts, not content, were compared (a changed amount or a
  replaced tombstone with the same row count is not detected; W5). Drill: a restore that lost the whole
  public data section is FAILED on this path.
- `preflight --migrations DIR --expect-version NNN`: before any database access, the gate's SQL files,
  `dr-restore-fixups.sql`, the tools and the migration source are present. `restore` runs the same check
  first and FAILs without querying anything when a file is missing.

### 5.1 Verdicts and exit codes

| Exit | RESULT | Meaning | Next |
|---|---|---|---|
| 0 | `HEALTHY` | every check passed **and** the fingerprint equals an independent `--reference`. Only a drill has one today (W5) | review; tills (§6); separate owner authorization; README §R |
| 3 | `ACCEPTED-WITHOUT-REFERENCE` | no reference. Passed: per-table row counts against the backup's own `counts.json`, every invariant, the migration ledger, the schema version. **Content was not compared.** A changed amount, or a replaced row with the same count, passes. This is an owner decision, not a proof | the owner accepts or rejects it in writing; then as for 0 |
| 1 | `FAILED` / `INCONCLUSIVE` | a check failed, or nothing independent was compared. `NOTE  COUNTS-ONLY` marks a FAILED whose only failures are count differences (or a backup without per-table counts) while every other check passed — never a failed or garbled query, never an INCONCLUSIVE run, never when a table that had rows is now empty (`NOTE  emptied …`: lost data) | the API stays closed; investigate (§5.3). Only a COUNTS-ONLY result may be overridden, by the owner, in writing |
| 2 | — | usage error (also `-h`, an unknown or malformed argument such as `--count-tolerance abc`) | nothing was checked; fix the command |

Count comparison: **strict equality** for every summary key (sales, users, products, organisations,
storage objects, migrations, roles, …) and every table of `public`, `auth`, `storage` and
`supabase_migrations` (all financial tables, `idempotency_keys`, `audit_logs`, the migration ledger).

The only exception is `--count-tolerance N`:
- `N` must be a non-negative integer; any other value exits 2;
- it applies only to GoTrue's session churn: `auth.sessions`, `auth.refresh_tokens`,
  `auth.audit_log_entries`, `auth.flow_state`, `auth.one_time_tokens`, `auth.mfa_challenges`,
  `auth.mfa_amr_claims`. These are rows that sign-ins add between `counts.json` and the dump (W5), and
  they carry no business state;
- a tolerated difference is printed in the PASS line.

A count, checksum, ledger or invariant query that fails or returns nothing is a FAIL. An invariant file
that returns fewer rows than it has checks is a FAIL.

### 5.2 Packaging and the migration source the gate needs

On the server, the gate reads its SQL from its own directory (`/srv/supabase/backup/bin/`). It reads
`--migrations` from `/srv/supabase/backup/migrations/`. `deploy.sh` copies `supabase/migrations/NNN_*.sql`
of the commit it is run from, because the server has no repo checkout. That must be the commit whose
migrations are applied in production:
- the gate requires the ledger to equal exactly the deployed files up to `--expect-version`, minus the
  held `084`;
- it requires each recorded `sha256:` to equal the file.

A checkout that is older than the backup fails preflight. One with different file contents fails the
checksum check. `deploy.sh` refuses before any `ssh` when a `deploy-manifest.txt` entry is missing or
empty, or when an unlisted file would be copied. It then re-verifies `MANIFEST.sha256` and the
migrations' `SHA256SUMS` on the server and runs `preflight` there.

### 5.3 When only the counts check fails

Typical case (W5): `counts.json` is captured just **before** the dump starts, so on a live system the
writes of that moment are in the dump but not in the counts. A restore of a production backup taken
under load can therefore FAIL the counts check alone, with every invariant, the ledger and the schema
passing.

Investigate before deciding:
1. List the differing keys (the FAIL line names each `table(expected->restored)`).
   - **Only session-churn tables differ:** rerun with `--count-tolerance N`, N being the largest
     difference, and record it.
   - **Any other table differs:** never use a tolerance.
2. Check whether the difference is in the backup or in the restore. Restore the **same** set into a
   throwaway (README §C) and count there:
   - same numbers as the failed restore: the difference is in the backup (timing);
   - otherwise: the restore lost data, so restore again.
3. For a timing difference, compare the rows created between `counts.json.captured_at` and the dump's
   start (`meta.json`, the job log), e.g. `sales`/`audit_logs` by `created_at`, with the difference. Check
   the neighbouring backup sets.
4. The owner decides, in writing. Only a result marked `NOTE  COUNTS-ONLY` can be overridden this way
   (README §R); any other failure is fixed and the gate re-run. Without a decision the API stays closed.

**Backups made before the per-table counts existed (`rows`, added 2026-10-18 and not yet deployed) — every
production backup today — cannot reach ACCEPTED-WITHOUT-REFERENCE.** The gate answers FAILED ("needs
per-table row counts", with `NOTE  COUNTS-ONLY` when everything else passed). The same holds for a PITR
(B2), whose counts legitimately differ from the base's, and for a single-table restore. For such a backup the decision rests on the invariants, the ledger, the summary
counts and the owner's reconciliation with the tills and the daily report. That evidence is weaker: take
a new backup soon after deploying this pass.

### 5.4 Runbook order (README §0/§A/§B/§B2/§R, restore-from-email.md §3–§4)

1. API exposure closed and **confirmed** (`restore-api-guard.sh close` → `verify` exit 0) before
   PostgreSQL is restored, stopped or restarted; every till **disconnected from the network** (a closed
   server is not enough: when Serve returns, every connected till reconnects at once).
2. Database restored; the database is the only container started (`start-db` = `up -d --no-deps db`).
3. Fix-ups (logical restores).
4. The gate.
5. The results reviewed.
6. Tills reconciled or quarantined (§6).
7. A separate owner authorization.
8. Reopening by hand (README §R): `--no-deps` services, then the gateway, then Tailscale Serve last.

Restore validation alone never authorizes reopening the API. No till signs in or syncs before step 8.

### 5.5 Cleanup and failure paths: executed or only inspected

| Path | Verified by |
|---|---|
| `backup-logical.sh` killed mid-dump: no `.partial`, recorded failed | **execution** (drill, in-runner) |
| `backup-base.sh`, `email-archive.sh` killed: same traps | **inspection** only |
| `email-archive.sh --no-send`: no plaintext staging left after a successful run | **execution** |
| `tests/dr/run.sh` cleanup: owner key, plaintext dumps and the offsite copy removed; containers, volume and networks removed | **execution** (every run) |
| `restore-api-guard.sh close`/`verify`/`start-db` on a compose model (db stop, start, restart; dependency start; foreign containers; Tailscale states; boot unit) | **execution** (local model; not `lucashome`) |
| `deploy.sh` refusals before any `ssh` (missing/empty/unlisted file, no migrations) | **execution** (fake `ssh`, `.invalid` host) |
| `deploy.sh` remote steps (copy, remote manifest check, remote preflight) | **inspection** only (never run: no `lucashome` access) |
| The `deploy.sh` stage directory's removal on exit | **inspection** |
| The manual reopening (README §R) | **not executed** (documented only, by instruction) |

### 5.6 API entry points closed during a restore

| Entry point | During a restore |
|---|---|
| Tailscale Serve (`https://<host>.ts.net` → 127.0.0.1:8000) | `tailscale serve reset`; `verify` requires `serve status --json` empty (Funnel included) |
| Gateway `api-gw` (127.0.0.1:8000) | stopped; port must refuse connections |
| Studio (127.0.0.1:54323, SSH tunnel; talks to the database) | stopped; port must refuse |
| `auth`, `rest`, `storage`, `realtime`, `meta`, `functions`, `imgproxy` (no published ports; behind the gateway) | stopped; only `db` may run |
| Any container publishing 8000/54323, or any foreign container on the stack network | `verify` fails |
| A boot unit that runs `docker compose up` (`supabase-stack.service`, H-D3, not installed) | `verify` fails while it is enabled |
| nginx (0.0.0.0:80) and playit (outbound tunnel) on the same host | they cannot reach the API while nothing listens on 8000. Their configuration is **not** verified (no `lucashome` access) |

## 6. Offline tills and a restored server (`src/live/dr-tills.live.test.ts`, 9/9, production executor path)

The real client modules against an 086 stack; a backup is taken; the till keeps working; the server
is restored to the backup at the **same URL**. Observed:

| Till state at restore | Current behaviour | Verdict |
|---|---|---|
| Sale queued offline, never sent | sent once on reconnect | correct |
| Sale **in doubt** (committed after the backup, reply lost) | before Phase 0: **not resent**, the first drain asks the restored server with a **fence** → `abandoned/FENCED`, "never ran". **Phase 0**: looked up read-only, **held for an owner** (ledger untouched) | before: lost and unrecoverable under its key (**W10**); Phase 0: still recordable under its key, an owner decides |
| Sale recorded after the backup (reply received) | nothing: no queue entry (acknowledged rows are deleted), no unresolved operation, no warning | **silent loss** (W8) |
| Lump sum **unknown** (committed after the backup) | online-only, never drained; stays unknown and blocks new supplier payments; Check with server → no decision | safe by default; "Send the same payment again" (same key) would be the correct recovery — but nobody knows a restore happened |
| Lump sum **refused** after the backup | stays final on the till; the server's tombstone is gone | a late copy of that request, or a recovery-tool replay of its key, **would now execute** |
| Restore detection | none (identity = build-time URL) | **BLOCKER** |
| Replacement backend at a different URL (or port) | needs a new build; queued/unresolved entries for the old origin are quarantined, never sent | correct for queued work; settled work is lost exactly as above |
| An 085 backup restored while tills run the 086 client | tills that ever reached 086 hold every executor operation (`OP_SCHEMA_UNAVAILABLE`) — nothing double-executes, nothing syncs | re-apply 086 with the runner before reopening the API |
| Browser sessions without persistent storage | their unsynced work cannot be reconciled at all (Phase 0 asks for persistent storage at start; the browser may refuse) | document |

**Blocker (W8 + W10) — design for a future migration + client change.** Phase 0 implemented the client-only parts of
items 2–4 (journal; no automatic fence; owner decision); the server parts (1, the hold, generation, reconciliation RPCs)
are migration 087+ (not implemented):

1. **Server-side hold, not only client-side.** The restore procedure writes a new
   `restore_generation` (and the backup time) and sets a **restore hold**; while it is set, `op_execute`
   and the legacy RPCs refuse with a code every existing client treats as **wait and retry**
   (`WAITING_BACKEND`-class, never a final refusal), and `op_status` refuses to **fence**. Installed
   tills (which will never check a generation) are thereby stopped too. The gate refuses HEALTHY
   unless the generation differs from the one inside the dump.
2. **Client:** every till and browser checks the generation before any RPC (lookups included); on a
   change it holds all automatic sending and every fencing path (drain, Confirm with server, the
   replacement flows), and shows a reconciliation screen.
3. **A journal of applied operations on the till** (key, rpc, args, actor, server reply time), kept
   at least as long as the worst restore window (today: unbounded; with a weekly archive: ≥ 7 days)
   — acknowledged queue rows are deleted; since Phase 0 the journal (`opj:` records) keeps them, with the server's reply.
4. **Reconciliation, owner-approved, server state not till clocks:** for each journal entry and each
   in-doubt/unknown operation, a **non-fencing** `op_status`; `not_found` = lost by the restore →
   **replay with the original key and actor** (nothing new minted) or record manually; keys the
   till holds as refused/abandoned are **re-fenced** (`op_status(fence)`) so a late copy can never run.
5. Lift the hold only when every till has reconciled. **Never** a new key automatically.

**Until then (manual control):** after any restore, keep the API closed (§5.4) until every till is
reconciled or quarantined:
- **Reconciled:** the till's queue was exported and reconciled by the owner, and the restored data was
  compared with the till's receipts and with the daily report for the window after the backup.
- **Quarantined:** the till is kept offline and listed in the incident record, and it may connect only
  after its queue is resolved.

Every till is disconnected from the network for the whole restore (README §0 step 3). No till signs in or
syncs before the owner-authorised reopening (README §R). On builds before Phase 0 a first drain fences (W10). After
reopening, reconnect tills one at a time: reconciled tills first, quarantined ones only once resolved. A Phase 0 till
holds an in-doubt key the server has no record of for an owner (never fenced automatically); an older till still drains
and fences its in-doubt keys, so its reconciliation record must list them.

## 7. What a correct 086 restore must preserve (proven by the 086 drill)

- `idempotency_keys` rows of every organisation with their **original keys**, `org_id`, `actor_id`,
  `rpc`, `request_hash`, `state`, `outcome_code`, `decided_at`, responses / `response_purged_at`.
- Tombstones (`rejected` `R:` + outcome code; `abandoned` `A:`): a lost one lets a refused or fenced
  operation execute if its request arrives again.
- PK `(org_id, key)`, the `'!unattributed'` namespace, the validated state constraint, the 086
  functions with their owners, effective grants and settings; the migration ledger rows with their
  `sha256:` checksums.
- Drill: after restore, `op_status` answers the original committed / rejected / abandoned keys as
  before; **replaying** them through the API (`op_execute`) answers from the ledger without executing
  (`replayed: true`); a committed legacy sale key returns the original sale id; the sales count is
  unchanged; organisation B's lookup of A's key answers `not_found`. A deleted tombstone, a
  tombstone turned committed and an altered ledger checksum are each detected.

## 8. Drills — `deploy/lucashome/backup/tests/dr/run.sh`

`run.sh 085` / `run.sh 086`: stack at that schema, two synthetic organisations through the real RPCs
(sales, a stock adjustment, two received orders, a voided payment, a single payment, a lump sum
spanning both orders, a refused lump sum; on 086 committed/rejected/abandoned outcomes), the real
`backup-logical.sh` and `email-archive.sh --no-send`, every fault on its own fresh restore, the
source destroyed before S1/S2. `run.sh tills`: §6. Numbers: the final report of this pass.

These run in seconds and need no stack:
- `tests/dr/gate-unit-test.sh`: gate decisions through a fake `docker`;
- `tests/dr/packaging-test.sh`: the `deploy.sh` package, built locally only;
- `tests/dr/runbook-check.sh`: the runbook order.

`tests/dr/api-isolation-test.sh` runs the guard against a disposable local compose model of the stack.

These are **local simulations** on synthetic data at the repository's schema — **not** an offsite
backup, **not** a test of the email tier against a real mailbox, **not** a restore of production data.

## 9. Production prerequisites (owner)

1. Enable the email tier; `--selftest`; one real archive; **restore it on another machine** with the
   fix-ups and the gate (W1, W4, W9).
2. Ship the secrets offsite; record where the JWT secret lives (W2).
3. Decide the host-loss RPO (daily archive for ≤ 24 h) (W3).
4. Deploy this pass's backup changes with `deploy.sh`: traps, the gate and its SQL, fix-ups,
   `restore-api-guard.sh`, and the migration source. Then:
   - take a new backup, so a backup with per-table counts exists (§5.3);
   - check that `restore-api-guard.sh verify` works on `lucashome` with the live stack (expect exit 1:
     the API is open), and that `tailscale serve status --json` is readable with `sudo`.
5. Decide W5 (snapshot-consistent fingerprint at backup time).
6. Implement and test §6 (server-side hold, journal, non-fencing reconciliation) before trusting any
   restore with real tills.
