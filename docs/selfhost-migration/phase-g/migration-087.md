# Migration 087 — recovery hold and rollback detection

Status: **candidate, applied only to disposable test stacks.**
- Migration: `supabase/migrations/087_recovery_hold.sql`.
- Rollback: `supabase/rollbacks/087_recovery_hold.rollback.sql`.
- Off-host tools: `tools/recovery-authority/` (witness authority and restore gate).
- Verification: `tools/m087-verify/` (see "Verification").
- Prepared gateway file: `deploy/lucashome/envoy-recovery-maintenance.yaml` (not applied).

**Scope: hold and detection only.** 087 detects every restore, restart and rollback; holds writes; collects till journals;
reconciles tills; and records *fence* decisions bound to one exact operation, proposed by the organisation's MFA ADMIN and
approved only by the infrastructure owner in a superuser session (two names). It never restores, re-executes or
reprices anything. **It has no normal release of a hold** (see "Not in 087").

**Migration 088** owns the rest: restoring financial outcomes, receipt-number continuity, bulk approval, safe reopening of an
organisation, and `restore` / `re-reject` decisions.

## Host prerequisite (v87.x, 2026-10-19)

087 installs only where the recovery roles are protected from the Supabase privileged role: `recovery_owner`,
`recovery_authority`, `recovery_gate` listed in `supautils.reserved_roles`, no event trigger controlled by a
non-superuser, and an active probe proving no non-superuser can alter or acquire the roles (fail closed; nothing applied
otherwise). The authority refuses to renew while any of this stops holding. Why, the configuration file and the
deployment checklist: [`recovery-roles-prerequisite.md`](./recovery-roles-prerequisite.md).

## Why

A database restored from any backup (physical, PITR, logical, same-server reload) loses the operations committed after that
backup. It keeps serving tills, which then re-send, fence or re-price old work against the restored state. The identity of the
server is no guide: a plain physical restore keeps the same system id, timeline and database OID.

087 does two things:
- Every restore, restart and rollback **fails closed** until people with evidence decide.
- Tills get a **server-issued cutoff** (an epoch per organisation), so nothing created before a recovery can run automatically
  afterwards.

## Architecture

### 1. Server gate (`recovery.assert_server`, on every guarded write)

Checked in order:
1. A `recovery.continuity` row exists (`NO_CONTINUITY`).
2. The live system id, timeline and database OID equal the stored ones (`IDENTITY_CHANGED`).
3. The lease is valid (`LEASE_INVALID`). A valid lease is:
   - present (missing = invalid);
   - unexpired;
   - issued after **this** server start, and for this server start (`pg_postmaster_start_time()`);
   - written by its issuing transaction (`issued_xid mod 2^32 = xmin`): a restored or copied row carries another xmin.
4. State is `'open'` (`RECOVERY_HOLD`).

087 installs with state `'hold'` and no lease.

### 2. Witness authority (off the database host)

`tools/recovery-authority/authority.py` runs on a separate device and holds the **Ed25519 private key**. The database holds
no signing key for it.

Every tick appends signed records to an append-only series, written atomically to the local state **and** to a mirror on a
second store. Records are linked by `seq` and the sha256 of the previous body.

Renewal:
- The database is first verified against the last **accepted** record, and against the **high-water marks of every signed
  observation**, refusals included. It checks:
  - identity;
  - server start, or a two-person owner anchor for a new server start;
  - WAL position;
  - till-key fingerprint;
  - lease row not copied;
  - the public-schema canary;
  - for every organisation: chain head, chain hash, ledger rows = chained rows.
- **M1, signed intent.** Before renewing, the authority appends a signed **intent** record and renews under the intent's
  `seq`; a separate signed `renew` record then confirms it. The accepted records are confirmed intents.
- **M1, renewal token.** For every intent the authority draws a one-time 32-byte secret, puts only its sha256 in the signed
  intent, and presents the secret to `authority_renew` as a **bind parameter** (psql 16+ `\bind`), and the database stores
  its sha256 in the lease row. The secret is never written to disk, a command line or the SQL text, so other sessions do not
  see it in `pg_stat_activity`. Production must not log bind parameters (`log_parameter_max_length = 0`, no pgaudit
  parameter logging). Anyone else who holds the `recovery_authority` credential can still make the database accept a
  renewal, but not one that passes as the authority's:
  - without the secret, the token hash never matches a signed intent;
  - even **with** a stolen secret, the stolen renewal has to commit first, so the database refuses the authority's own
    renewal of that intent (`SEQ_NOT_INCREASING` / `GENESIS_ALREADY_DONE`). The authority records that refusal with
    `renew_failed_for`, and any lease at that `seq` is then rogue (x1 S10).
- `authority_renew` never waits for a lock (`FOR UPDATE NOWAIT`, `lock_timeout` 5 s). A renewal that queued behind another
  session's lock could otherwise commit after the authority had given up and revoked. A credential holder who holds the lock
  makes the authority refuse and revoke (x1 S11): a denial of service, which fails closed.
- A database lease whose `seq` **and** token hash do not match one of the authority's own signed intents is a **rogue
  renewal** (`ROGUE_RENEWAL`): refused server-wide and revoked, and it stays refused until a two-person re-baseline. This
  includes a renewal under a `seq` the authority itself signed: after a crash before the renewal, in a race between the
  authority's intent and its renewal, and a genesis taken first after a re-baseline (x1 S7–S9, x2 M1m–M1r).
- A renewal that committed under the authority's last intent, but whose confirmation was lost (a crash), is confirmed late
  **only** if that intent is still the **head** of the series, the lease carries its token, and the database still matches it.
  Per-organisation findings already recorded in that intent, for organisations that are still held, do not block the late
  confirmation (x1 D10r-5/6). Otherwise the database is verified against the last accepted record as usual.
- **M4.** If the database answers but its evidence cannot be read or verified, the authority writes a signed refusal
  (`EVIDENCE_UNREADABLE`, `AUTHORITY_ERROR`) and revokes the lease. If the database is unreachable it writes an `unreachable`
  record and attempts a revoke. If its own series, mirror or signing tool fails (unreadable or corrupt record, missing
  `openssl`), it revokes the lease and exits with `REFUSED AUTHORITY_FAILED` (no signed record can be written then; x1 MB1–MB2).
  It never renews from incomplete evidence.
- The mirror must equal the local series, or be at most one record behind it (a crash between the two writes), in which case
  the missing record is copied to the mirror before anything else (x1 MD1). An empty, missing or behind-by-more mirror is
  `AUTHORITY_ROLLED_BACK` (revoke); an unreadable one is `AUTHORITY_FAILED` (revoke).
- Only one authority process runs at a time (file lock).

What the database enforces on renewal (`recovery.authority_renew(seq, seconds, postmaster_start, genesis, token)`):
- one genesis per install or re-baseline (`GENESIS_ALREADY_DONE`, `NO_GENESIS`);
- increasing `seq` (`SEQ_NOT_INCREASING`), with jumps capped (`SEQ_JUMP_TOO_LARGE`);
- an owner anchor after any server start (`ANCHOR_REQUIRED`);
- a renewal that would not take effect is never reported (`LEASE_NOT_EFFECTIVE`, e.g. inside a savepoint);
- a 64-hex-digit token (`BAD_TOKEN`), whose sha256 it stores in the lease row;
- a length of 30 s to 1 h (`BAD_LENGTH`). The authority uses 10 minutes (D1); a credential holder can ask for up to 1 hour.

Every renewal also rewrites the public canary `public.zz_recovery_canary`. A reload of the public schema brings back an
old or copied row.

When a per-organisation finding does not stop the whole server:
- `LOSS`, `FORK` and `LEDGER_UNCHAINED` (more ledger rows than chained rows) hold **only that organisation** and the lease is
  renewed for the others, **only if** the same tick proves the whole server continuous: same server start, lease `seq` =
  last accepted `seq`, canary intact, lease row not copied, WAL not behind.
- Otherwise they become server-wide (`ROLLBACK_SCOPE_UNPROVEN`).
- `LEDGER_ROWS_VANISHED` (fewer ledger rows than chained rows: public data replaced under an intact chain) is always
  server-wide.
- After an anchored restart, findings **identical** to the last accepted record's, for organisations that are still held,
  stay per-organisation. Any new or changed finding does not.

### 3. Restore gate (`tools/recovery-authority/gate.py`)

Read-only, as the non-superuser `recovery_gate` (`recovery.gate_evidence()`). It fails closed.

What it checks:
- Every record of every copy is signature-verified, with a contiguous `seq` and `prev` links.
- Copies must agree. Otherwise `SERIES_FORK`, or `AUTHORITY_COPY_ROLLED_BACK` when the authority copy is shorter.
- With no authority copy at all: `EMAIL_ONLY_NOT_PROOF`.
- **CONSISTENT requires a fresh, single-use attestation** of the authority's current head, for a nonce **the gate issued**
  (`gate.py --issue-nonce`; any other nonce is `NONCE_NOT_ISSUED`). The issued and used lists live in `--nonce-dir`
  (default: next to the public key), which belongs to the gate operator; copying a key into a fresh directory starts empty
  lists, so the real replay bound is the 120-second attestation age. `--max-gap-s` can only tighten freshness; there is no
  operator-chosen incident time.
- Database checks:
  - WAL behind the highest observation on the same system and timeline;
  - loss or fork against every signed observation;
  - every organisation's chain recomputed;
  - ledger rows = chained rows for every organisation;
  - organisations never witnessed;
  - the lease `seq` must be a signed intent, carry that intent's token hash, and not be an intent whose renewal the database
    refused: `ROGUE_RENEWAL` (CONFLICT) otherwise, and
    `LEASE_ON_UNCONFIRMED_INTENT` (INCONCLUSIVE) in a crash window;
  - a copied lease row (`LEASE_ROW_REPLACED`) or an old or copied public canary (`PUBLIC_CANARY_ROLLED_BACK`): CONFLICT;
  - a different database OID on the same system (`DATABASE_REPLACED`): INCONCLUSIVE;
  - an authority refusal **after the last accepted record** that reports a rollback or a foreign renewal (rogue renewal,
    lease seq mismatch, copied lease or canary, vanished ledger rows, WAL behind, loss, fork, or its own renewal refused as
    `SEQ_NOT_INCREASING` / `GENESIS_ALREADY_DONE`): `AUTHORITY_SAW_ROLLBACK`
    (INCONCLUSIVE at least). Other refusals (identity changed, restart not anchored, errors) are notes, so a full PITR replay
    can still be judged CONSISTENT (x3 G2);
  - till witnesses are verified only when the till-key fingerprint is the witnessed one.

CONSISTENT never reopens anything. `NOTE_UNWITNESSED_TAIL` says what it does not cover.

### 4. Epochs and the cutoff

- `recovery.org_state(org_id, epoch_no, epoch uuid, held)`, with history in `recovery.epoch_history`.
- The epoch advances, and the organisation is **held**, on:
  - `owner_begin` (all organisations, two names);
  - an authority LOSS / FORK / LEDGER_UNCHAINED for that organisation;
  - a valid till witness ahead of the server (once per incident).
- Nothing in 087 releases a hold after an epoch change.
- **HIGH-1.** `recovery_epoch` issues the epoch (and a witness) **only** to:
  - a till reconciled for the current epoch,
  - of an organisation that is **not held**,
  - on a server that accepts writes.

  A till can therefore never hold an epoch that a later release would make valid for operations it staged during a hold.
- An operation is **old** if any of these is true:
  - its `op_epoch` (stamped once, at creation, by the client) is not the current epoch;
  - its key is listed in any uploaded journal of the organisation (quarantine; `uuid`, case-normalised);
  - it is a UUIDv7 minted more than 5 minutes before the current epoch began. This check can only refuse: client clocks
    never allow anything.
- Old operations are **never executed** by 087. They can only be fenced, through a decision (section 6).

### 5. Tills and reconciliation

- A till is registered by the organisation's MFA ADMIN. The server returns a secret once and stores only its sha256.
- A new till starts **unreconciled**.
- Reconciliation for the current epoch needs both:
  - the till's **complete** journal: chunks 1..n all stored and chunk n `final`. A chunk refused on quota or never sent leaves
    a gap, and the till stays unreconciled (`RECOVERY_JOURNAL_INCOMPLETE`, x2 L5e);
  - approval by an MFA ADMIN who submitted none of that till's journal.

  An organisation has exactly one ADMIN (`users_only_one_admin`), so in practice the cashier submits and the ADMIN approves.
- Journal upload:
  - is accepted during holds, but only from a till that needs reconciliation (`not_required` otherwise);
  - is idempotent per chunk; a conflicting chunk is never overwritten;
  - is capped by an organisation quota and never deleted on quota (`quota_exceeded`, one event per till per epoch);
  - refuses the whole upload if any key is not a UUID.
- Reconciliation does **not** reopen anything.

### 6. Fence decisions (M2)

- **Proposed** by the organisation's MFA ADMIN, only for an operation **listed in that till's uploaded journal**
  (`RECOVERY_DECISION_NOT_JOURNALED` otherwise).
- **Bound to** organisation, key, RPC, sha256 of the arguments, actor, op epoch and **till**. One open decision per key;
  consumed exactly once, under the row lock.
- **Withdrawn** (`recovery_withdraw_decision`) by an MFA ADMIN of the same organisation while not consumed, so a mistaken
  proposal does not block the key forever. Withdrawal only removes fencing power.
- **Approved only by the infrastructure owner** through `recovery.owner_approve_decision(id, key, rpc, args, actor,
  op_epoch_no, till, a, b)`: a **superuser session**, two different names, and the whole operation restated. It is refused
  unless every restated field equals the proposal (`RECOVERY_DECISION_NOT_APPROVABLE`). There is **no API approval**: no API
  role, `service_role`, JWT (even one minted with `JWT_SECRET`, which the edge-functions container holds), GoTrue identity,
  platform admin or `postgres` session can approve (x2 A1–A1e, D3–D4c).
- The **proposer** side is weaker: `service_role` can create a `public.users` row with role `OWNER` for an account it
  controls, and `postgres` can act as any organisation admin (§8). A proposal alone has no effect.
- A fence that does not take effect (in flight, expired, not authorised, already decided) raises `FENCE_NOT_APPLIED` and
  rolls the consumption back.
- `decision IN ('fence')` only: there is no execute.
- **Fences are reachable in practice only after 088** releases a hold. In 087 the organisation stays held, and the hold check
  runs before the decision.
- Two-person checks compare **names**: one superuser can type two names. The second person is a procedure, not a control the
  database can enforce (D4).

### 7. Hold enforcement and tenant isolation

- **Guards.** `AFTER INSERT/UPDATE/DELETE FOR EACH ROW` guards plus `BEFORE TRUNCATE` guards on 30 organisation tables, and
  server-wide-only guards on `app_config` and `platform_admins`.
  - All are `ENABLE ALWAYS`: the non-superuser `postgres` can set `session_replication_role = replica` through supautils.
  - The guard sees the final row, after every BEFORE trigger.
- **Organisation resolution.** A row is resolved to the organisations of its own org column and of the parents listed in
  `recovery.org_of` (shop, product, supplier, price level, sale, transfer **from and to** shop, purchase order) and refused if
  any of them is held. Not every foreign key is followed: for example `product_barcodes.product_id`, `products.brand_id`,
  `sales.shift_id` / `cashier_id`, `sale_items.product_unit_id`, `supplier_payments.purchase_order_id` are not resolved. This
  is safe only while the 086 RPCs prevent cross-organisation parents; a direct cross-tenant row written by `postgres` or
  `service_role` is not caught through those columns.
  - A row that resolves to no organisation is refused while **any** organisation is held (`ORG_UNRESOLVED`). That is a
    cross-tenant effect for unattributable rows (`'!unattributed'` ledger rows, audit rows without shop and actor) and for
    cascade deletes whose parent is already gone.
  - The coverage test shows every row of every guarded table resolves (x2 MT4).
- **Ledger evidence (M3).** `public.idempotency_keys` rows cannot be deleted or truncated (by any role, including the
  superuser, while the triggers are enabled; only a superuser who disables them can, which is infrastructure trust), and an UPDATE may change only `response` / `response_purged_at` (`LEDGER_EVIDENCE_PROTECTED`).
  - 086's `prune_idempotency_keys` therefore deletes nothing while 087 is installed: it raises, nothing changes, and it
    causes no outage. No cron job calls it.
  - 086's `op_purge_responses` still works (x2 M3f), but fails as a whole if any eligible row belongs to a held
    organisation (`RECOVERY_HOLD`); it is owner-run and unscheduled.
  - 087 also revokes it from `service_role`.
  - Chain-aware archival pruning is 088.
- **Legacy paths closed at install.**
  - An executor RPC writes the ledger only through `op_execute_v87` / `op_status_v87`: a per-transaction token, set by a
    recovery-owned function and removed before return. Otherwise `CLIENT_UPGRADE_REQUIRED`.
  - Every PostgREST write by `anon` / `authenticated` must carry `x-orvix-epoch` = the epoch **under which the write was
    created**, which must be the organisation's current epoch. Missing header: `CLIENT_UPGRADE_REQUIRED`; old epoch:
    `PRE_EPOCH_OPERATION`.
  - `service_role` (edge functions) and SQL sessions are subject to the hold rules only.
  - When the written row resolves to no organisation, the header is required but cannot be compared.
- **Not guarded:** `storage.objects` (product images). A held organisation's legacy client (v1.0.15 uploads with upsert) can
  still overwrite or delete product images after install; the follow-up `products` update is refused, so nothing financial
  changes. Edge functions that run as `service_role` (for example `phone-upload-token`) skip the epoch check by design and
  are subject to the hold rules only.
- **Committed hold.** A valid till witness ahead of the server advances the epoch, holds the organisation, and answers
  **HTTP 200 `{outcome:'held', code:'CONTINUITY_ROLLBACK', sig}`**, from the v87 functions only, with no epoch in the reply.

### 8. Privileges

- `recovery_owner` (NOLOGIN, non-superuser, BYPASSRLS, read-only grants on 11 public tables) owns schema `recovery`, all its
  data and the 8 public 087 functions. Default privileges revoke EXECUTE from PUBLIC on functions it creates there later.
- The DDL guard lives in schema **`recovery_guard`**, owned by the superuser with all its objects, as supautils requires for
  the event trigger, and so that `recovery_owner` (owner of schema `recovery`) cannot drop or empty it:
  - `recovery_guard.ddl_guard` (the event-trigger function);
  - `recovery_guard.fingerprint`;
  - `recovery_guard.register_guards`;
  - the tables `recovery_guard.snapshot` and `recovery_guard.functions`.

  They read catalogs and their own tables only.
- Every 087 function pins `search_path = pg_catalog, pg_temp`. No SECURITY DEFINER 087 function calls a function outside
  schema `recovery`: HMAC-SHA256 and randomness are built from `pg_catalog`, so nothing depends on schema `extensions`, which
  `postgres` owns.
- The client entry points `op_execute_v87` / `op_status_v87` are **SECURITY INVOKER**. A replaced 086 function runs with
  `postgres`'s rights only (x2 P2).
- **DDL guard** (`ddl_command_end`, `ENABLE ALWAYS`):
  - A non-superuser session may not run DDL whose object is a guarded table, or its index, trigger, rule, policy, default or
    constraint, or that makes it a parent or child.
  - A per-table **fingerprint** covers triggers, columns and defaults, the table ACL, policies, indexes, rules, inheritance,
    name and schema. It also catches commands that report no object: GRANT/REVOKE, DROP POLICY, DROP INDEX
    (x2 P6j–P6m).
  - The **canary** is registered like a guarded table, and the **8 public 087 functions** by OID, signature and owner: a
    `DROP`, a `DROP` + `CREATE` (new OID or owner) or a new overload of one of their names is refused (x2 P8d–P9e).
  - Superuser sessions (migrations, the owner) are infrastructure trust. After a superuser DDL change,
    `recovery_guard.register_guards()` refreshes the snapshot; until then every non-superuser DDL anywhere is refused (fail
    closed).
- **What `postgres` can still do:**
  - it is a member of `authenticated` in Supabase, so it inherits the API functions;
  - through `pg_read_all_data` it reads `recovery.keys`, the till-witness and reply MAC keys, and can forge till witnesses
    or reply signatures. The effect is false holds or false evidence, which fail closed; rotate keys per epoch.
  - it owns the 086/072 business functions and could replace them;
  - it owns schema `public` (through `pg_database_owner`), but the DDL guard refuses dropping or re-creating the canary and
    the 087 functions;
  - with `SET ROLE authenticated` and `set_config('request.jwt.claims', ...)` it can act as **any organisation's admin or
    cashier** in one session: register a till, upload a journal, approve a till, propose a decision. It cannot approve a
    decision (owner-only), and it can write `auth.users` / `auth.mfa_factors`.

  It **cannot** write any recovery table or the canary; drop or replace the 087 functions; change the guards; or run owner
  or authority functions. `postgres` remains infrastructure trust (D11, D13).
- **The two LOGIN roles** (`recovery_authority`, `recovery_gate`) receive whatever `PUBLIC` has in this database, for example
  the `pg_net` tables (`net.http_request_queue`, outbound HTTP from the database host) where `pg_net` is installed. The gate
  also receives the full till-witness MAC key through `gate_evidence()`. The image's `pg_hba.conf` trusts loopback
  (`host all all 127.0.0.1/32 trust`), so "credentials only on the authority device" holds only for remote connections:
  production needs per-role `pg_hba` rules (scram, the authority's address only) and should revoke `PUBLIC` on `net` (D15).

## Refusal contract

| Code | Meaning |
|---|---|
| `NO_CONTINUITY` | the `recovery.continuity` row is missing |
| `IDENTITY_CHANGED` | system id, timeline or database OID differs from the stored identity |
| `LEASE_INVALID` | the lease is missing, expired, from before this server start, or a copied row |
| `RECOVERY_HOLD` | the server or the organisation is held |
| `ORG_UNRESOLVED` | the row resolves to no organisation while some organisation is held |
| `CLIENT_UPGRADE_REQUIRED` | a legacy executor or direct path, or an API write without the epoch header |
| `PRE_EPOCH_OPERATION` | the operation was created before the current epoch (see §4) |
| `TILL_UNKNOWN` | the till id or secret is wrong |
| `TILL_NOT_RECONCILED` | the till is not reconciled for the current epoch, or sent no or a stale witness |
| `WITNESS_INVALID` | the till witness does not verify |
| `FENCE_NOT_APPLIED` | a fence did not take effect; everything rolled back |
| `API_GUARD` | the Envoy maintenance listener answered |

All of these are HTTP **429**, `application/json`, ASCII only:
`{"code":"PT429","message":"ORG_SUSPENDED: server recovery in progress [CODE]"}`.

Other refusals:
- **403 `42501`:** `RECOVERY_ADMIN_MFA_REQUIRED`, `RECOVERY_SELF_APPROVAL`, `OP_NOT_AUTHENTICATED`,
  `LEDGER_EVIDENCE_PROTECTED`, `RECOVERY_GUARD_PROTECTED`, `V87_TOKEN_REQUIRED`.
- **400:** `22023` `RECOVERY_JOURNAL_INCOMPLETE` / `RECOVERY_DECISION_NOT_JOURNALED` / `RECOVERY_DECISION_NOT_WITHDRAWABLE`;
  `22P02` a journal key that is not a UUID; `23514` an invalid decision type.
- **409 `23505`:** a second open proposal for the same key (`decisions_one_open_per_key`).
- **Owner and authority SQL only** (never seen by a client): `OWNER_ONLY`, `TWO_PEOPLE_REQUIRED`, `LEASE_INVALID` from
  `owner_open`, `RECOVERY_DECISION_NOT_APPROVABLE`; `authority_renew` returns `BAD_LENGTH`, `BAD_TOKEN`, `STALE_OBSERVATION`,
  `GENESIS_ALREADY_DONE`, `NO_GENESIS`, `SEQ_NOT_INCREASING`, `SEQ_JUMP_TOO_LARGE`, `ANCHOR_REQUIRED` and raises
  `LEASE_NOT_EFFECTIVE`.
- **HTTP 200 `{outcome:'held'}`:** v87 only (§7).

## API (PostgREST, `authenticated`)

| RPC | Contract |
|---|---|
| `op_execute_v87(p_key, p_rpc, p_args, p_actor_id, p_ctx)` | `p_ctx = {till, till_secret, op_epoch, witness}`. Returns 086's reply plus `signed{org,key,rpc,request_hash,actor,epoch_no,outcome,response_sha256}`, `sig`, and a `witness` that already covers this operation; or the committed held reply. |
| `op_status_v87(p_key, p_rpc, p_fence, p_expected_actor_id, p_args, p_ctx)` | A lookup is 086's read-only `op_status`. A fence follows §4 and §6. |
| `recovery_epoch(p_ctx)` | `{epoch, epoch_no, witness}`, only for a reconciled till of an open, writable organisation. |
| `recovery_register_till(p_till)` | MFA org ADMIN; returns `{till, till_secret}` once. |
| `recovery_submit_journal(p_ctx, p_chunk_no, p_chunk, p_final)` | `stored` / `already_stored` / `conflict` / `quota_exceeded` / `chunk_too_large` / `not_required`. |
| `recovery_approve_till(p_till)` | MFA org ADMIN, not a submitter; the journal is complete (§5). |
| `recovery_propose_decision(p_key, p_rpc, p_args, p_actor_id, p_op_epoch_no, p_till, 'fence')` | MFA org ADMIN; the key must be journaled by `p_till`. |
| `recovery_withdraw_decision(p_id)` | MFA org ADMIN of the decision's organisation; not yet consumed. |

**Owner functions** (superuser session; two different names where shown):
- `owner_anchor(reason, a, b)`
- `owner_open(a, b)`
- `owner_begin(reason, a, b)`
- `owner_rebaseline(reason, a, b)`
- `owner_approve_decision(id, key, rpc, args, actor, op_epoch_no, till, a, b)`
- `owner_hold_org(org, reason)`
- `recovery_guard.register_guards()`

**Authority functions** (`recovery_authority` only): `authority_observe`, `authority_hash_at`, `authority_renew`,
`authority_revoke`, `authority_hold`.

**Gate function** (`recovery_gate` only): `gate_evidence`.

## Client contract (v87 client — not part of this migration)

There are **no client changes in this checkpoint**. The current Phase 0 client is refused at install (`CLIENT_UPGRADE_REQUIRED`).
It classifies the 429 as ORG_SUSPENDED and keeps its queue, so 087 cannot go to production before a v87 client exists. That
client must:
- call only the v87 functions, and map PGRST202/203 to "wait for the server";
- stamp `op_epoch` and `x-orvix-epoch` **once, at creation**, and never re-stamp. Queued table writes carry their creation
  epoch;
- never sell before its first epoch;
- enter a persisted recovery mode on every 429 and on `{outcome:'held'}`, blocking online and offline sales until
  `recovery_epoch` succeeds;
- keep the last witness from each reply;
- **journal** every operation since its last witnessed point: pending, in doubt **and committed**, with key, rpc, args,
  actor, epoch, the receipt number printed, the raw reply bytes and local time. 088 needs this to avoid reusing printed
  receipt numbers (F5);
- send the price charged on every line;
- mark queues inherited from older builds as legacy. They have no `op_epoch`, are never executed and **can never be fenced**
  in 087 or by a bound decision.

Also required:
- never re-stamp an inherited queue entry: the server's clock rule only catches UUIDv7 keys, and RC3 direct-path keys are v4;
- the `staff-admin` edge function must forward `x-orvix-epoch` for `create_app_user` **and pass a 429 through** (today it
  turns it into `500 server_error`, so a client never sees the hold there);
- **legacy builds must be withdrawn.** Every legacy build can keep selling locally while 087 refuses its writes, and those
  sales are never journaled; neither 087 nor 088 can see them:
  - every legacy build sells offline on network errors;
  - Phase 0 and Batch 2A stage sales offline on provisional shifts;
  - Phase 0 also stages a sale locally **while online** whenever the till has earlier queued work the sale depends on, and
    any queued table write counts. An entry refused with 429 stays pending, so one queued catalogue edit makes every later
    sale on that till local-only during a hold (`93ad308:src/stores/data/writeAhead.ts:299-310`);
  - Phase 0 / Batch 2A keep a refused entry with the same key and retry it; RC3 retries with backoff; v1.0.15 marks a
    refused entry as a conflict a user can dismiss (its keyless sales get `400 IDEMPOTENCY_KEY_REQUIRED` from 086, not 429).

## Deployment (production preconditions first)

**Preconditions:**
- Studio isolation applied, and `SUPABASE_DB_URL` (`postgres`) removed from edge functions.
- Every self-hosted till on the **v87.x** client (offline financial operations switched off on 087 servers; `v87-client.md`,
  "Offline financial operations"). The earlier v87 build, RC1–RC3, v1.0.15, Batch 2A and Phase 0 builds withdrawn and unable
  to log in to the self-hosted server (D7, D10); the server cannot tell v87 from v87.x, so a till downgraded to v87 regains
  offline sales — withdraw the v87 installer. Till queues drained before cutover.
- v87.x: the **host prerequisite** done and verified first (`recovery-roles-prerequisite.md`: reserved-roles file mounted, db
  container recreated — a short restart outside this window — `show supautils.reserved_roles` lists the three roles without
  `*`). Without it, step 3 refuses and nothing is applied.
- v87.x cutover: every till **online and signed in** when the window starts, and kept from offline trading for at least
  `ABSENT_OFFLINE_TRUST_MS` (30 min) before step 3. A till's earlier "no 087" answer keeps the pre-087 offline rules for up to
  30 minutes; an offline sale it takes in that time reaches the 087 server as a legacy operation (held for owner review).
- The authority on a real second device: key generated there; mirror on another store; scram credentials for
  `recovery_authority` and `recovery_gate` only on that device; $0 alerting on every refusal or unreachable record and before
  the lease expires.
- `synchronous_commit=on` for application roles.

**Window:**
1. Swap the gateway to `deploy/lucashome/envoy-recovery-maintenance.yaml` (HTTP 429 `API_GUARD`, CORS-correct).
2. Pinned backup.
3. `apply-migrations.sh --from 087 --to 087` (one transaction plus its ledger row; installs held, no lease).
4. `owner_anchor` (two people).
5. v87.x: provision the `recovery_authority` / `recovery_gate` credentials (087 clears any password on these roles, also on a
   re-install after a rollback). Authority `genesis` (it refuses with `PREREQ_*` while the host prerequisite does not hold). If it fails **before** the database committed the genesis (`authority_observe` still shows no lease),
   archive its state and mirror and retry. If the database committed it (a crash before the confirmation), do **not** retry
   genesis (it would get `GENESIS_ALREADY_DONE`): run a normal tick, which confirms it late, or re-baseline (two people).
6. MFA admins register tills; each till uploads a complete journal and is approved.
7. Smoke test with a v87 till.
8. v87.x: before `owner_open`, every till has seen the 087 server (registered and reconciled in step 6; its offline badge
   shows `data-financial-blocked="true"`), or 30 minutes have passed since step 3 — an unregistered till's earlier "no 087"
   answer has then aged out. `owner_open` (two people).
9. Restore the normal gateway.

## Rollback

Tested: x2 B0–B9.
1. Maintenance listener on; authority stopped.
2. `pg_dump -n recovery`, exported off the host.
3. `apply-migrations.sh --rollback 087 --owner-confirmed-till-queues-empty`. One DO block inside the runner's transaction:
   - drops the event trigger, every `zz_recovery_*` trigger, the 8 API functions, every function in `recovery` and schema
     `recovery_guard` (configuration, not evidence);
   - **renames** the schema to `recovery_archived_087_<utc>` and moves the canary there (all evidence kept; repeatable);
   - sets `recovery_authority` / `recovery_gate` NOLOGIN;
   - restores the pre-087 ACLs exactly from the install-time snapshot and removes `recovery_owner`'s read grants. Grant
     options are not re-granted; if a pre-087 ACL had one, the post-check aborts the rollback (fail-safe). None exist today;
   - proves the ledger and the archived evidence unchanged;
   - removes the 087 ledger row last.
4. 086 behaves as before (x2 B6).
5. Re-applying 087 is supported (x2 B7, B9), and so is a second rollback (B8).
6. Before a re-apply, archive the authority series and mirror, and **rotate the `recovery_authority` / `recovery_gate`
   credentials**: a re-apply (v87.x) sets both roles LOGIN again with their passwords **cleared** — provision new ones before
   genesis.
7. The archived schemas keep `USAGE` for `authenticated`, `recovery_authority` and `recovery_gate`; no table grants and no
   functions remain, so this is hygiene only. A re-apply accepts the kept roles only while every archive still has the
   shape the rollback left (allow-list: `recovery-roles-prerequisite.md`, item 4); a changed archive refuses the re-apply
   until a superuser reverts the change.

## Verification (`tools/m087-verify/run.sh`, disposable only)

| Part | What |
|---|---|
| `x2` | The real migration through the real runner: coverage gate (G1–G6), held install (I0–I4b), owner-only approval (A1–A1e), tills, outcomes incl. a rejected one, and legacy closure (T, O), multi-tenant isolation incl. a full DR seed under an unrelated hold, row-by-row checks and a transfer item into a held org (MT1–MT6), committed hold (C1–C3), HIGH-1 incl. a server that is not writable (H1a–H1m), M3 (M3a–M3g), M1 incl. laundering through a signed seq (M1a–M1r), M4 (M4a–M4h), privileges and DDL bypasses incl. dropping the canary or the 087 functions (P1–P16), M2 / decisions / withdrawal / journal completeness / cutoff (L1–L16, D1–D9g), restart (R1–R5), Envoy 429 and CORS (E0–E5d), rollback / re-apply (B0–B9). |
| `browser` | Real Chromium: the maintenance listener's 429 is readable from http and `file://` origins (B1, B2, B4); B3 records whether this Chromium accepts a wildcard allow-headers with `Authorization` (an observation: the Fetch spec excludes `Authorization` from `*`, but the tested Chromium accepted it, so the listener lists headers explicitly); the pinned upstream Envoy delivers 429s and lets `x-orvix-epoch` through (B5, B6). |
| `legacy` | The real error handling of v1.0.15, RC3, Batch 2A and Phase 0 against every captured 429. |
| `compat` | 086's own live SQL suite with 087 installed (legacy switch open for the run). Expected result: 19 passed, 1 failed. The one failure is intentional: FS.10's own **cleanup** step deletes a ledger row directly (`src/live/m086-sql.live.test.ts:305`), which 087's ledger protection refuses (`LEDGER_EVIDENCE_PROTECTED`, M3), after all of FS.10's behavioural assertions have passed. `compat.sh` accepts exactly that single failure and fails on any other. |
| `x3` | The real migration on the real image: a plain physical restore (cold copy) refused at once, judged LOSS, refused server-wide even when anchored with WAL pushed ahead (R1); PITR to the end refused, gate CONSISTENT with a timeline note (R2); a same-server ledger-only reload refused server-wide (R3). |
| `x1` | Restore matrix on plain PostgreSQL with the real authority and gate: base backup, PITR, logical into a new server, same-server reload, restarts, rolled-back / re-created / empty / corrupt / one-behind mirror, rogue renewals (direct, through a signed seq after a crash, in a race, at genesis), crash windows incl. one with a held organisation, missing / tampered / gapped / stale / forked / email-only witnesses, gate-issued nonces, till witnesses. |

## Not in 087 (088)

- Restoring lost outcomes.
- Receipt-number continuity: the counter must move past the highest **printed** number before any reopening.
- Bulk evidence approval.
- `restore` / `re-reject` decisions.
- Chain-aware archival pruning.
- **Releasing a hold.**

Break-glass before 088 exists (owner-run, two people, outside the API) is not part of 087.

## Limits (what 087 cannot detect or prevent)

- **Unwitnessed tail.** A rollback to a state taken after the last signed observation, applied before the next tick, cannot
  be told apart from normal operation. The tail is **up to one lease length** whenever ticks are missed (authority down,
  network loss, crash window). The default lease is 10 minutes (D1). A holder of the `recovery_authority` credential can set
  a lease of up to **1 hour** and keep renewing while the authority is down; the authority detects it at its next tick
  (`ROGUE_RENEWAL`), so the tail is then up to the time until that tick. Only till journals, till witnesses and 088 can
  recover it.
- **Non-ledger restores.** Restoring only non-ledger tables (catalogue, prices, users, auth, storage) without touching
  `public.idempotency_keys` or the canary leaves no signal (x3 R1h shows such a silent price rollback inside a full restore,
  which *is* detected).
  - Control: no table-level restore without `owner_begin`.
  - 088 may extend the chain to catalogue and price tables.
- **Infrastructure trust.**
  - A superuser, or `postgres` acting through business functions it owns, can forge the canary, the lease and the chain
    together.
  - Anyone holding the `recovery_authority` credential can make the database accept a renewal. Without the authority's
    one-time token it never matches a signed intent, so the authority's next tick refuses it server-wide and keeps refusing
    until a re-baseline, and the gate reports CONFLICT. Until that tick, writes continue.
  - `pg_read_all_data` members can read the MAC keys.
- **A failed revoke** (database unreachable) leaves the lease running until it expires.
- **One-person businesses.** Where the org ADMIN and the infrastructure owner are one person, two-person control is not real
  (D4).
- **Legacy offline sales** (see "Client contract").
- **Storage** (`storage.objects`) is not guarded (§7).

## Owner decisions

| | Decision | Default |
|---|---|---|
| D1 | Lease length and tick interval | 10 min / 60 s |
| D2 | Restart policy | two-person anchor after every server start |
| D3 | Authority device and private-key custody/backup | $0, an existing device |
| D4 | One-person businesses | — |
| D5 | Keep 087's revocations after a rollback | today: exact restore |
| D6 | Remove `pg_read_all_data` from the read-only/ETL roles, or accept the key exposure | — |
| D7 | Legacy paths closed at install | the `recovery.settings.legacy_paths` switch is an owner SQL decision; tests use it only to run legacy suites |
| D8 | Journal quota | 50 MB per organisation; never automatic deletion; export before any prune |
| D9 | Witness retention | at least the oldest restorable backup (~190 days) |
| D10 | Pre-install queued operations count as old | drain queues before cutover |
| D11 | `postgres` as infrastructure trust | — |
| D12 | Where the authority mirror lives | — |
| D13 | `postgres` membership in `authenticated` | — |
| D14 | Re-baseline procedure | two people; gate CONSISTENT with attestation; archive the old series |
| D15 | `pg_hba` per role for `recovery_authority` / `recovery_gate`; revoke `PUBLIC` on `net` | — |

## Review history

Design Revisions 2–3.4 and their reviews are summarised in the final report. The final Revision 3.4 review's conditions are
resolved here:
- **HIGH-1:** no epoch while held (§4, x2 H1).
- **M1:** signed renewal intents (§2, x2 M1, x1 S5–S6).
- **M2:** journal-bound decisions (§6, x2 D1–D8).
- **M3:** ledger evidence protected, so pruning deletes nothing (§7, x2 M3).
- **M4:** unreadable evidence → signed refusal and revoke (§2, x2 M4).
- **Documentation corrections:**
  - no release in 087;
  - legacy queue entries cannot be fenced;
  - the tail extends to the lease length;
  - DDL and `postgres` descriptions corrected;
  - the refusal list completed;
  - test names corrected; assertions no longer pass on empty output;
  - the maintenance listener lists `x-retry-count`, `x-upsert` and `cache-control`.

The implementation reviews (financial, PostgreSQL security, legacy/offline, DR) found two HIGH issues. Both are fixed:
- **M2 approver identity controllable by the service tier** (financial, security): approval was a JWT `aal2` call by a
  registered GoTrue account, which `JWT_SECRET` (held by the edge-functions container) or the GoTrue admin API could
  produce. Approval is now owner-only (superuser session, two names, the whole operation restated), and the API approval
  function and the approver table are gone (§6, x2 A1–A1e, D3–D4c).
- **M1 rogue renewal laundered as a late confirmation** (DR): a credential holder could renew under a seq the authority had
  signed and have it confirmed late. Renewals now carry a one-time token whose hash the signed intent holds, late confirmation
  needs the series head and the token, and the gate checks the token (§2, x1 S7–S9, x2 M1m–M1r). A re-verification of the
  fixes then showed the token could be read from `pg_stat_activity` (it was in the SQL text) while a held lock made the
  authority lose the race (HIGH). Fixed: the token is a bind parameter; a lease at a seq whose own renewal the database
  refused is rogue even with the right token; `authority_renew` never waits for a lock (x1 S10–S11).

Their MEDIUM findings are fixed or documented: late confirmation with a held organisation (x1 D10r-5/6); failures of the
series, mirror or signing tool revoke (x1 MB1–MB2); the gate checks the canary, a copied lease, the database OID and
refusals that saw a rollback (x1 C1g, G14); a one-record mirror hole is repaired (x1 MD1); nonces are issued by the gate
(x1 G6b); proposals can be withdrawn (x2 D9–D9g); journals must be complete (x2 L5e); `postgres` cannot drop or replace the
canary or the 087 functions (x2 P8d–P9e); the guard moved to a superuser-owned schema; transfer items resolve both shops
(x2 MT6); storage, org resolution, the LOGIN roles' `PUBLIC` rights, loopback trust, `postgres` acting as any admin, the
Phase 0 online local selling, the `staff-admin` 500 and v4 keys are documented.
