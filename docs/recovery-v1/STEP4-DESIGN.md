# Step 4: financial completion, offline selling under V1, owner-authorized upgrades

**Status: local implementation only** on `ws/final-migrations` (uncommitted). Nothing here has been applied to any real
database, no real key has been enrolled, no e-mail has been sent. Every key used in tests is synthetic and generated under
the system temp directory.

| Part | Server | Client |
|---|---|---|
| A. Financial completion | `PFIN-D_payments_cash.sql`, `PFIN-E_refund_lines.sql` (provisional, before V1) | `src/features/finance/`, POS payment screen, shift pages, receipt, refund screen |
| B. Offline selling for ACTIVE organizations | `RECOVERY_V1_guards.sql`: offline policy, capabilities, device revocation, sync-time check | `src/recovery/offlineCapability.ts`, recovery gate, write-ahead, request layer, banner |
| C. Upgrades after V1 | `RECOVERY_V1_guards.sql`: owner keys, owner authorizations, `apply_authorized_migration` | none (owner tooling: `tools/recovery-v1/owner/owner-sim.mjs`, simulation only) |

Owner decisions that are still open are listed in section 5. No default in this document is an owner decision; each default
is the conservative choice and is labelled as such.

## 1. Part A: financial completion

### 1.1 What could not change

086 pins the MD5 of every business function body (`complete_sale`, `close_shift`, `create_refund_void_request`,
`approve_refund_request`, …) and 087's executor list is fixed. Everything below is therefore **additive**: new tables,
triggers, and new RPC names. No pinned body, signature, request hash or reply changes.

### 1.2 Split and mixed payments (PFIN-D)

- `sale_payments`: one row per method per sale, `seq` 1–10, methods `CASH`, `BANK_TRANSFER`, `MOBILE_WALLET`, `CARD`,
  `OTHER`. Each row has an applied amount, a tendered amount, a reference of at most 120 characters, and the sha256 of the
  canonical payment list. Only cash may be tendered above its amount (the change). Rows are immutable.
- Every existing sale is backfilled with one single-payment row; the file asserts that every sale's payments add up to its total.
- `fin_complete_sale_split(route, key, args, payments, actor, ctx)` is a SECURITY INVOKER wrapper. It validates the list,
  checks that the sale's own (hashed) `p_payment_method` / `p_paid_mmk` say exactly what the list says, sets a
  transaction-local setting and calls the **same** `complete_sale` on the route the server needs (085 direct, 086
  `op_execute`, 087 `op_execute_v87`). An AFTER INSERT trigger on `sales` writes the rows in the sale's own transaction.
- A replay of the key with a **different** split is refused (`FIN_PAYMENTS_MISMATCH`); the same split replays the original sale.
  The check runs **before** anything executes, from the server's own rows (`sale_payments.op_key`), never from the reply
  (086 withholds a reply from another actor and after a purge). A key already committed as a single-payment sale is
  never turned into a split.
- Client: the payment screen offers a split only when `fin_capabilities()` says the server has it. The request layer sends
  the split beside the sale's arguments, never inside them. A server without PFIN-D answers "function missing": the client
  reports `FIN_SPLIT_UNSUPPORTED` (a contract failure). Nothing is converted to a single payment and the queued sale keeps its key.

### 1.3 Cash movements and shift close (PFIN-D)

- `cash_movements`: kinds `FLOAT_IN`, `PAY_IN`, `PAY_OUT`, `DEPOSIT_OUT`, `CORRECTION_IN`, `CORRECTION_OUT`, `REVERSAL`.
  Each row records a direction, an amount, a reason of 3–300 characters, the actor, the approver, the business date
  (Asia/Yangon) and, for a reversal, the movement it reverses (UNIQUE: a movement is reversed at most once, always in full).
  Rows are immutable; a mistake is corrected only by a reversal. Every movement also writes an `audit_logs` row.
- `fin_record_cash_movement` is keyed (`idem_begin`). It refuses taking out more cash than the drawer is expected to hold.
- **P-8 default (owner decision pending):** every outflow, correction and reversal needs `shift:manage_all`, and the
  approver recorded is the acting manager (a single person). A cashier with `shift:manage_own` may record `FLOAT_IN` / `PAY_IN` on their own shift.
- `fin_shift_cash(shift)` is the authoritative cash: opening + the CASH part of non-void sales − cash refunds + movements
  in − movements out. Refunds use the explicit cash payouts (PFIN-E) when recorded, otherwise the legacy rule (a refund of a
  CASH sale is paid in cash). Attribution stays on the sale's shift (P-3).
- `fin_close_shift` closes with that figure. A legacy `close_shift` (pinned body) whose expected cash would differ is
  refused by a trigger (`FIN_CLOSE_SHIFT_UPGRADE_REQUIRED`); nothing is changed. For a single-payment sale the legacy rule
  is reproduced exactly, so a released till's normal close is never refused. For a split sale, a refund without
  recorded payouts counts as cash only up to the cash that sale took.
- **Key kind.** `fin_record_cash_movement` and `fin_close_shift` are not on 086's executor list, and 086's `idem_begin`
  runs a UUIDv7 key only inside `op_execute`. The client therefore sends them a random v4 key (`DIRECT_KEYED_RPCS`): the
  085 ledger rule, which 086 keeps and never prunes. Every other RPC keeps its v7 key.
- Client: cash movements are **online only** (a keyed, persisted online operation, scoped to the shift). The shift pages
  show the server's figures; when the server cannot answer they show "unavailable" and no local estimate. An online close
  on a PFIN-D server uses `fin_close_shift`. On a PFIN-D server the till does **not** close a shift offline (it cannot
  know other tills' split payments and movements); on an older server the existing queued `close_shift` is kept.

### 1.4 Refund lines and partial refunds (PFIN-E)

- A refund item may carry `lines: [{saleItemId, qtyUnits, amountMmk, restock}]` and `payouts: [{method, amountMmk}]`. The
  pinned request and approval store items verbatim, so these fields are part of the request hash.
- Triggers check every line-bearing item, both when the request is created (a request that could never be approved is
  refused at once instead of blocking the sale's refunds) and again at approval under the sale's row lock. Earlier
  refunds are read from the approved requests themselves, so refunds approved before PFIN-E and refunds from released
  tills count: a legacy item against the single line of its product, and as paid back by the sale's legacy method:
  - the line belongs to the sale and to the item's product;
  - lines add up to the item;
  - cumulative approved quantity and net amount per sale line stay within the line (net of every discount, PFIN-B `fin_sale_line_net`);
  - cumulative payouts per method stay within what the sale was paid with that method (cash: the applied amount, never the change).
- At approval it records immutable `refund_lines`: sale line, product, quantity, amount, restocked or not, the cost from the
  sale's own snapshot (NULL when unknown, never estimated), sale and refund business dates, and the approver. It also
  records `refund_payouts`. Column-level grants keep `cost_mmk` from `authenticated`.
- **Restock.** The pinned approval always restocks with `RETURN_IN`. A no-restock line gets an explicit compensating
  `RETURN_NO_RESTOCK` movement, so both paths are separately visible in the stock ledger.
- A legacy item (no `lines`) gets one unattributed `refund_lines` row (`sale_item_id` NULL); no line is fabricated.
- Payouts are all-or-none within a request and recorded as one row per method for the whole request (the items'
  payouts added up).
- After approving a request with a no-restock line, the till reads the server's stock again (the pinned approval's reply
  is built before the compensating movement).
- Client: when the server records refund lines, the refund screen adds a "not back to stock" choice per line. For a split
  sale it also asks how the money goes back (no default method is assumed). A sale the server does not have yet keeps the legacy items.
- **PFIN-C stays held** (P-2, P-6). It caps legacy items; PFIN-E caps line-bearing items; both can coexist.

## 2. Part B: offline selling under V1

### 2.1 Protocol

1. **Issue (connected, ACTIVE).** `recovery_v1_offline_capability(org, shop, device)` returns a capability document:
   protocol, id, organization, shop, device, cashier, offline epoch, policy scope and status, issued-at, expires-at,
   sync deadline, maximum operations, maximum value (MMK) and allowed operations (sales only). The server stores the exact
   document with an HMAC under a server key that never leaves the database. It refuses when:
   - the organization is not ACTIVE (status and any adopted 087 hold included);
   - the device is revoked;
   - the policy is not owner-approved and test defaults were not enabled at install;
   - more than 30 capabilities were issued to the cashier in the last hour.
2. **Record (unreachable).** The gate reaches the recovery-aware server, which cannot answer (network, timeout,
   Tailscale, 5xx, device offline). For an eligible sale the till reserves one operation and its value under the capability
   before anything is saved: a device sequence number, persisted. The sale is then staged **locally**:
   - it is pending, with a placeholder receipt number;
   - it is queued with its idempotency key, its 087 epoch and the capability reference;
   - it is never shown as accepted by the server.
3. **Sync.** Every attempt carries `x-orvix-offline: {capabilityId, deviceSeq}`. The ledger guard runs `offline_problem` on
   the operation's ledger row and refuses with PT503 when any of these hold:
   - the stored document no longer matches its MAC or its row (`offline_capability_integrity`);
   - the capability is unknown, or bound to another organization or cashier;
   - the sale's shop is not the capability's shop (Script 2, D1);
   - the device is revoked;
   - the organization's offline epoch changed (it left ACTIVE while the till was offline, `offline_capability_stale_epoch`);
   - the sync deadline has passed;
   - the cumulative count or value is exceeded;
   - the device sequence is reused;
   - the operation is not allowed.

   The refusal carries the reason in brackets (`[offline_…]`). The till holds the sale **for an owner's review**
   (`RECOVERY_V1_OFFLINE_HELD`): pending with its key and capability reference, never deleted, never re-keyed, never
   resent automatically. A capability row is locked while one of its operations is checked, so concurrent syncs
   cannot exceed its limits.

### 2.1a Prerequisite in the real app (Script 2 finding)

A V1 server accepts financial writes from a till only with **independent device authorization**
(`requireRecoveryV1Write` → `enrolledDevice`), which needs an independent trust source injected from outside the
recovering server (`configureIndependentTrust`). The shipped app configures none (deliberately: no trust on first use),
so against a V1 server a real till refuses every financial write, online or offline, and never requests an offline
capability. Everything in this section therefore applies only once independent device-trust custody exists
(infrastructure-blocked; Script 2 Electron test S2-E4/E5).

### 2.2 Till rules (`offlineCapability.ts`)

- The server is the verifier. The till cannot check the MAC; a tampered local copy can only make the till record more
  local sales, which the server then holds.
- The till never requests a capability while offline, and never extends or renews one locally. A failed request keeps the
  existing capability with its own expiry; a reply that arrives after a withdrawal never revives it.
- A reservation (device sequence, count, value) is one IndexedDB read-write transaction, so two windows never share a
  sequence number or overspend the limit.
- Expiry is judged on the server's clock as the till last knew it (its own clock corrected by the offset seen at
  issuance), so a till running slow does not sell past the expiry. The server checks the sync deadline, not the expiry.
- Offline selling needs the server's last answer to have been ACTIVE.
- The banner shows while the device is offline and whenever sales recorded under the capability still wait for the
  server; such a sale is announced as "recorded on this till only", never as a recorded sale.
- It stops at:
  - the expiry;
  - the count or the value;
  - another cashier;
  - a withdrawal;
  - a clock that runs backwards. A persisted high-water mark with 2 minutes' tolerance means offline selling stops until
    the server is reached; the mark is re-anchored to the server's time when a capability is issued.
- A server answer that the organization is not ACTIVE, or that the device is revoked, withdraws every local capability for that organization at once.
- **087 interaction.** Every V1 server also has 087, whose v87.x safeguard forbids new offline financial operations. The
  capability replaces that rule **for the authorized operation only**. The till must still hold an epoch and must not be in
  recovery mode. Every other offline financial operation stays refused.
- **Legacy servers (085, 086, 087 without V1)** are unchanged: a till that never identified the V1 protocol keeps the 085
  offline rules. A failed request never downgrades a V1 till to legacy rules.

### 2.3 Limits and policy

- `offline_policy` holds one row per scope (`*` or an organization). Its fields are lifetime, maximum operations, maximum value and sync grace.
- The installed default is **DEFAULT_UNAPPROVED** and is used only when the install passed
  `-v recovery_v1_offline_defaults=allow-unapproved-test-defaults`. Its values are 2 hours, 30 operations, 1,000,000 MMK and a 7-day grace.
  These are **test values, not an owner decision**; the banner says so.
- Production limits come only from `set_offline_policy` with an owner-signed `offline-policy` authorization (`OWNER_APPROVED`).

## 3. Part C: upgrades after V1

### 3.1 Owner authorization

- The owner's RSA public key (at least 2048 bits, e = 65537) is given at install (`-v recovery_v1_owner_public_key`). The
  private key never touches the server, this repository or CI.
- An authorization is a JSON document signed exactly as sent (RSASSA-PKCS1-v1_5, SHA-256). It carries:
  - protocol `orvix-owner-authorization-v1`;
  - purpose, key id and a single-use nonce;
  - the target: database name, PostgreSQL system identifier and V1 install time;
  - issued-at and expires-at, at most 7 days apart.
- The server verifies the signature in plain PL/pgSQL with exact numeric arithmetic (no extension), then the target, the
  window and the nonce (replays are refused). It accepts the authorization only from a superuser runner session.
- Purposes: `migration`, `offline-policy`, `enroll-owner-key`.
  - Key rotation is authorized by an existing key, which may retire itself in the same step.
  - A retired key authorizes nothing.

### 3.2 `apply_authorized_migration(auth, sig, sql)`

The steps run in order, in one transaction:
1. **Serialize.** An advisory lock serializes migrations; a concurrent attempt waits, then fails its predecessor check.
2. **Refuse up front.** It refuses when the recovery integrity check reports a problem.
3. **Verify the authorization.** The authorization must:
   - verify;
   - name the exact SQL (sha256);
   - name the current **chain head** as its predecessor (genesis is bound to this exact V1 install);
   - name a migration id not applied before;
   - list only permitted DDL command tags. Event triggers, extensions, roles, default privileges, dropping tables,
     schemas or triggers, and altering triggers are never permitted.
4. **Run the SQL.** The SQL runs inside an authorized-transaction context. V1's DDL guard checks every command against the
   allowed list and every new public table against the declared new tables.
5. **Guard new tables.** Each new table must be a plain table with `org_id text NOT NULL` and row-level security. It is then
   guarded automatically: write and truncate triggers are added and registered. 087's registry is re-registered when present.
6. **Validate and extend the chain.** Post-validation runs; pins and entry points are updated; the chain is extended with
   the migration id, SQL sha256 and authorization sha256.
- **An authorized migration is meant to add, and the server checks the effects it can see.** Around the SQL, queries
  written into the function's own body compare, before and after:
  - V1's catalog (functions, relations and privileges, columns, defaults, constraints, triggers, policies, rules) and its registry data;
  - the evidence counts, extensions, event triggers, roles and memberships, per-database and per-role settings;
  - the triggers, policies, rules and functions that already existed in `public`, the functions of `pg_catalog`, `auth`,
    `recovery` and `recovery_guard`, and (when adopted) the full 087 fingerprint.

  Any difference, event triggers left off, or a changed session role rolls the whole migration back
  (`RECOVERY_V1_MIGRATION_SCOPE`). The per-command allow-list (`allowedCommands`) is advisory: the effect checks above are the enforcement.
- **Residual limits (documented; not enforceable inside the database):** the SQL runs in the superuser runner's session.
  - Effects outside this transaction (`dblink`, `COPY ... TO PROGRAM`, files) cannot be rolled back.
  - Some properties of existing public tables are not compared: RLS flags, ACLs, columns, CHECK constraints, standalone
    indexes and view rules.
  - SQL written to subvert PostgreSQL itself is not stopped: it could switch event triggers off and replace
    `pg_catalog` functions the checks rely on, or rewrite and restore the context row.

  The owner's review of the exact SQL, which the signature binds, is the control for all of these. V1 itself remains
  tamper-evident afterwards: its catalog pin quarantines on the next write.
- **V1's own catalog is pinned** (functions, relations and their privileges, triggers, policies, rules in
  `recovery_v1`). Outside a migration any change is refused by the DDL guard; with event triggers switched off
  (PostgreSQL 17) it quarantines every organization at the next guarded write. No table may inherit from a guarded table.
- **Interruption** (connection loss, crash, statement timeout) rolls back the whole migration. The server log records the
  last step reached (`RAISE LOG 'RECOVERY_V1_MIGRATION <id> step …'`). The authorization's nonce is consumed only when
  the migration commits, so the SAME authorization can be retried after an interruption (Script 2, a17); repair is
  forward only.
- A compromised server can run SQL as a superuser anyway; what it cannot do is produce an authorization that verifies, so
  an applied-migration chain entry without a valid signed authorization is detectable.
- Rollback attacks: an old authorization fails three checks: the nonce, the predecessor (the chain has moved on), and the target (restore to another cluster).

### 3.3 Simulation tooling

`tools/recovery-v1/owner/owner-sim.mjs` generates synthetic keys and signs authorizations, for testing only:

```
node tools/recovery-v1/owner/owner-sim.mjs keygen /private/tmp/<dir> <keyId>
node tools/recovery-v1/owner/owner-sim.mjs authorize <pem> <keyId> migration target.json payload.json
```

It writes keys only under the system temp directory.

## 4. Tests

| Suite | What it proves |
|---|---|
| `tools/recovery-v1/db/fin-completion-smoke.sql` (38 checks, `--financial`) | split validation and routes; mismatch on replay; backfill; cash movements: P-8 default, reasons, cash-out cap, reversal once; authoritative expected cash; `fin_close_shift`; legacy close refused only when wrong; refund lines (caps per line and per method, restock / no restock, cost privacy, legacy items unattributed); cross-tenant refusals |
| `tools/recovery-v1/db/offline-smoke.sql` (27 checks) | issuance refusals (not ACTIVE, revoked, policy, rate); sync acceptance; each refusal code; copied or edited capability rows; duplicate resend; exposure limits |
| `tools/recovery-v1/db/step4_suite.py` | offline policy authorization; authorized migrations (checksum, order, target, expiry, replay, command scope, new-table rules, interruption with its log step, concurrency, non-superuser); key rotation and retirement |
| `src/stores/data/finStep4.test.ts` | split routing on 085 / 086 / 087; unsupported server; lost reply resent with the same split; mismatch; v4 keys for the direct-keyed RPCs; offline header; shift close and cash movements |
| `src/recovery/offlineCapability.test.ts` | issuance, sequence, exhaustion, expiry, clock rollback, other cashier, withdrawal, no offline renewal, foreign capability ignored |
| `src/recovery/offlineSelling.test.ts` | network loss / Tailscale / timeout / offline device; restart while offline; reconnect sends once with the header; server refusals hold the sale; restriction while offline; the 087 + V1 path through `op_execute_v87` |

## 5. Open owner decisions (none invented here)

| Id | Decision | Default in the code until decided |
|---|---|---|
| P-1 … P-7 | as recorded in `supabase/migrations-provisional/README.md` (P-2 and P-6 keep PFIN-C held) | unchanged |
| P-8 | who may record cash outflows, corrections and reversals; whether a second person must approve | `shift:manage_all`, one person |
| OFF-1 | offline lifetime, count, value and sync grace for production | none: only the unapproved test defaults, which need an explicit install flag |
| OFF-2 | which devices may sell offline; who revokes; what happens to held offline sales (accept, void, write off) | revocation by an ADMIN; held sales wait for review |
| KEY-1 | owner key custody (hardware token / offline machine), backup, rotation schedule, who holds the second key | none enrolled; a key must be given at install |
| MIG-1 | who prepares, reviews and signs post-V1 migrations; maximum validity | at most 7 days, enforced |
| RET-1 | retention of offline usage, capabilities and authorization evidence | kept indefinitely (immutable) |
| REF-1 | the payout method of a refund of a split sale | asked every time; no default |
| ACT-1 | production activation of PFIN-D/PFIN-E/V1 and the minimum till build | not activated |
| GATE-1 | whether `fin_close_shift` / `fin_record_cash_movement` may run outside 087's executor gate (they carry the epoch header check only; the pinned executor list cannot include them) | allowed; listed as a known gap |
| CLONE-1 | how authorizations are kept from being replayed on a physical copy or point-in-time restore of the database (same name, system identifier and install row) | short validity windows only; tracked outside the database |
| EXP-1 | combined offline exposure per user, device or organization (each capability has its own limits; a till that omits the header is treated as online) | per-capability limits only; capabilities do not stop a malicious till |
