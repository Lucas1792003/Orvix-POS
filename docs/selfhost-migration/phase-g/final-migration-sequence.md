# Final POS migration sequence (financial features and Recovery V1)

**Status: proposed** on branch `ws/final-migrations`, based on `b28f17d`, with the Recovery V1 commit `aba83aa` applied but not
committed. Nothing here has been applied to any real database.
- The machine-readable form is `supabase/migrations-provisional/SEQUENCE.json`, checked by `tools/migration-sequence/verify.py`.
- Numbering is in `supabase/migrations/NUMBERING.md`.

## 1. Inventory

| Item | Where | Class |
|---|---|---|
| 062–083, 085 | `supabase/migrations/` | numbered; applied in production (ledger max 085) |
| 084 validated uploads only | `supabase/migrations/` | numbered; **held** until every till runs the validated-upload client |
| 086 operation outcomes: per-organization idempotency `(org_id, key)`, `op_execute` / `op_status` | `supabase/migrations/` | numbered; implemented, not applied |
| 087 recovery hold | `supabase/migrations/` | numbered; implemented, not applied |
| 088 | `supabase/migrations/088_retired_number.sql`, plus its rollback | numbered tombstone: retired number, no-op |
| PSAFE-A: no 086 re-run after 087 | `migrations-provisional/` | provisional |
| PFIN-A report indexes; PFIN-B daily revenue/profit and shift reconciliation reports | `migrations-provisional/` | provisional |
| PCOST-A cost privacy | `migrations-provisional/` | provisional |
| PFIN-C: a refund never exceeds the net paid amount | `migrations-provisional/held/` | implemented, not applied; held as a byte-identical reviewed copy |
| Recovery V1 | `migrations-provisional/RECOVERY_V1_guards.sql` | provisional; never numbered |
| The original Recovery Migration 088 (restore and reopen) | named only in 087's comments | superseded: the design was rejected and never implemented |
| PFIN-D: split and mixed payments (`sale_payments`), cash movements in / out with reversals, authoritative shift cash, `fin_close_shift` (Step 4) | `migrations-provisional/` | provisional; local implementation only |
| PFIN-E: refund lines linked to sale lines, cumulative caps, payouts per method, separate restock / no-restock (Step 4) | `migrations-provisional/` | provisional; local implementation only |
| Price history, discount approvals, financial ledger | master plan v2 labels only | **missing**: no SQL anywhere (not in Step 4's scope) |

**Each area the brief asks about:**
- **Server-authoritative sales.** `complete_sale` comes from 072, with keys from 074 and the executor from 086. A sale has one `payment_method` and one `paid_mmk`, so split payments are **missing**.
- **Refunds and partial refunds.**
  - Request and approval come from 070, through the 086 executor.
  - The cap is per product, taken from the line total before the cart discount.
  - PFIN-C closes only the cart-discount gap, and it is held. 070's check reads only the first line of a product that appears on several lines; that gap stays until the refund line model.
  - Payout records are missing.
- **Purchase orders and supplier payments.** These are numbered: 006, 012, 018, 028, 037, 039, 040, 057 and 070, plus 086's `pay_supplier_lump_sum`. They are keyed by 074 and run through 086.
- **Inventory movements.** The business functions write them. 087 and V1 each resolve their polymorphic references.
- **Cost, profit and historical cost.**
  - The cost snapshot taken at sale time is numbered: 041, `unit_cost_mmk_snapshot`.
  - PCOST-A moves it and current costs into permission-gated tables.
  - PFIN-B computes COGS from snapshots only.
- **Shift reconciliation.** `close_shift` is numbered, and PFIN-B adds a report. Cash movements are missing.
- **Stable operation identities.** These come from 074 and 086. 087 chains the ledger, and V1 makes ledger rows immutable.
- **Tenant isolation.**
  - Row-level security, the 068 helpers and 074 caller binding apply throughout.
  - 087 and V1 each resolve every organization a row touches. V1 refuses rows that link two organizations.
- **Control database.** No dependency. Orvix Control is a separate PostgreSQL. Its POS hooks (POS numbers 100–102) are not built, and it never releases a POS recovery hold. Its documents still say "087/088"; Control is unchanged here.

## 2. Order and gates

```
085 (production) -> 086 -> PSAFE-A -> PFIN-A -> PFIN-B -> PCOST-A -> PFIN-D -> PFIN-E -> [PFIN-C, held] -> 087 -> 088 -> RECOVERY_V1
                                                                                                   -> (after V1: owner-authorized migrations only)
```

**Ordering rules:**
- **087 is required before 088 and every later number,** because the planner refuses gaps. Skipping 087 is an owner decision. The runner's held list is fixed in the script (`HELD=084` in `apply-migrations.sh`), so skipping needs a reviewed edit of that line. Otherwise the numbered chain stops at 086.
- **Recovery V1 is always last.** After it, the following are refused or unsupported:
  - every provisional step;
  - every new public table (refused by V1's DDL guard);
  - every rollback (refused by the runner).

  Forward repair is the only remedy after V1.
- **The financial roadmap lands before V1 (Step 4).** PFIN-D (split payments, cash movements) and PFIN-E (refund lines, payouts, restock) are applied before V1. PFIN-C stays held (P-2, P-6) and, if wanted, is applied before V1 as well.
- **After V1: owner-authorized migrations only (Step 4 Part C).** `recovery_v1.apply_authorized_migration` runs a schema change only with an owner-signed authorization bound to the exact SQL (sha256), the target database, the current head of the applied-migration chain, the allowed DDL commands and the new tables. New tables must carry `org_id` and row-level security and are guarded automatically. A compromised server cannot mint an authorization: it holds only the owner's public key. See `docs/recovery-v1/STEP4-DESIGN.md`.

**Forbidden orders.** Each is refused by the runner or a database guard, and flagged by `verify.py plan`.

| Order | Why |
|---|---|
| 087 after V1 | 087 disables every event trigger and is never adopted, so every organization is QUARANTINED. Its rollback would also drop V1's triggers. |
| 086 after V1 | V1 pins the idempotency stage. |
| 086 after 087 | 086's grant step takes the v87 executors away from every till. |
| PCOST-A, PFIN-C, PFIN-D or PFIN-E after V1 | Their tables or triggers would be unguarded or untested; V1's DDL guard refuses an unauthorized new table. |
| PCOST-A first applied while 087 is held | 087 refuses the cost null-out. |

```
python3 -I tools/migration-sequence/verify.py check-repo [--held-originals FILE]
python3 -I tools/migration-sequence/verify.py facts-sql          # read-only query; run it yourself, save the JSON line
python3 -I tools/migration-sequence/verify.py plan --facts F.json [--allow-held]
```

**`apply-migrations.sh` changes.** The runner snapshots `has_recovery_v1` and re-checks it under its lock. When V1 is installed it refuses:
- 086 or 087;
- every rollback;
- any other forward run without `--recovery-v1-reviewed`, a flag that is itself refused when V1 is absent.

The 088 rollback removes only 088's own ledger row, so 087 stays rollback-able before V1.

**Gates.** Each step's gates are listed in `SEQUENCE.json`. For 086 and 087 they refer to the full deployment preconditions of `migration-086.md` and `migration-087.md`.

## 3. Migration 087 and Recovery V1

### Why V1 rejected 087

| Where | What |
|---|---|
| V1 install preflight | refused any `recovery` / `recovery_guard` schema |
| V1 per-row integrity check | quarantined every organization when an 087 schema existed |
| V1 DDL guard | refused every DDL command while an 087 schema existed |
| 087's function registry | requires every `public.recovery_%` function to be owned by `recovery_owner`. V1's four public functions were not, so after any re-registration, every non-superuser DDL command and the PFIN/PCOST preflights would be refused for good. |
| 087's held row guard | refuses V1's fence sentinel insert |
| 087's rollback | drops every `zz_recovery_*` trigger (V1's included) and restores the pre-087 grants |

### The adapter

It lives in the V1 installer and is additive. Neither 087 nor any numbered migration changes.

**Adoption, in order:**
1. **Catalog-only preconditions.** Nothing of 087 is read or executed yet. Required:
   - both 087 schemas;
   - 087's DDL event trigger, enabled ALWAYS and superuser-owned;
   - superuser-owned registry functions and guard tables;
   - `recovery.continuity` as a real table owned by `recovery_owner`.

   The installer also refuses event triggers controlled by a non-superuser. When supautils is loaded, it requires `orvix_recovery_operator` in `supautils.reserved_roles`.
2. **The pinned catalog fingerprint** of every 087 object must equal the reviewed 087 (`3406f665…`). It does not depend on which superuser ran 087: the same value is proven with 087 run as `postgres` and as `supabase_admin`.
3. **Only then 087's data.** The continuity row and 087's whole DDL backstop condition must be clean, because V1 never blesses existing drift.
4. **V1 installs.** The public `recovery_v1_*` functions become SECURITY INVOKER wrappers owned by `recovery_owner`, as 087's registry requires.
   - The implementations stay SECURITY DEFINER in schema `recovery_v1`.
   - `authenticated` gets USAGE on that schema and EXECUTE on those four implementations only.
   - Names, signatures and replies are unchanged.
5. **087's snapshot is re-registered.** The fingerprint is asserted again, still equal to the pin. The pinned value and a full fingerprint (adding raw permissions) are recorded.
6. **Last, V1 pins its own state.** It records:
   - its four entry points;
   - the identity of both DDL event triggers: oid, function, no tags, and catalog row version;
   - the row versions of every recovery row trigger, V1's and 087's;
   - the public tables that existed at install.

**What the fingerprint covers:**
- **Functions:** every function in schemas `recovery` and `recovery_guard`, and every public 087 function, with security, volatility, strictness, leakproof, parallel, cost, settings, owner and body.
- **Relations:** every relation in the 087 schemas and the canary, with kind, owner, row security, columns, defaults, constraints, indexes, policies, rules and triggers.
- **Other objects:** the types and schema owners; 087's triggers on public tables (full definition); the event trigger; the attributes of the 087 roles.
- **Privileges:** the effective privileges of PUBLIC, anon, authenticated and service_role.

**After adoption:**
- **Both guards apply.** A write needs an ACTIVE V1 organization **and** an open 087 server (valid lease, organization not held). Status reports RESTRICTED when 087 would refuse, evaluating the lease inline; no 087 function runs inside V1.
- **Fencing.** V1's `fence_key` refuses under 087 and records an audit row. 087's own fence path is also refused while V1 restricts the organization, because its abandoned ledger row needs an ACTIVE organization. **Nothing can be fenced while V1 is installed.** That fails closed.
- **087 is fixed for good.** On every DDL command, V1's guard compares both 087 fingerprints and its own entry points. It refuses:
  - any 087 change, the rollback included;
  - any change to an entry point;
  - any public table that did not exist at install, however it appears (`CREATE`, `SET SCHEMA`, a foreign-schema import).

  V1 has no uninstall, so no reviewed release or extension of an 087 hold can ever be added after adoption. **This is an owner decision.**
- **Runtime fail-closed.** The per-row integrity check quarantines every organization when any of these holds:
  - a pinned event trigger row is no longer the installed row: disabled, re-enabled, recreated, retagged or replaced (any `ALTER/DROP/CREATE EVENT TRIGGER` window);
  - a recovery row trigger was replaced, disabled or dropped, including while event triggers were switched off (`SET event_triggers = off` on PostgreSQL 17 and later);
  - the adopted 087's schemas are replaced or removed;
  - 087 is present but was not adopted (applied after V1).
- **Limits (infrastructure trust):**
  - **Superuser tampering that leaves the pinned rows untouched is not detected at runtime:** a direct `UPDATE recovery_v1.org_state`; `ALTER ROLE`; single-user mode; editing catalogs.
  - **With event triggers switched off**, replacing the body of a V1 or 087 internal function (for example `recovery_v1.guard_write`) changes no pinned row. The 087 functions are caught at the next DDL command by the fingerprint check, but V1's internal functions are not fingerprinted.
  - **A public table created while event triggers are switched off** takes unguarded writes until the next DDL command with event triggers on, which then refuses. A changed attribute of an 087 role (`ALTER ROLE`) is likewise seen only at the next DDL command.
  - **Restores and upgrades quarantine:** a major-version upgrade or a dump and restore recreates the event triggers, so V1 quarantines afterwards. That is fail-closed and needs a forward-repair decision.

**Accidental 087 after V1 (forward repair).** Every organization stays QUARANTINED. Do **not** roll back 087: it would drop V1's triggers, and V1 and the runner both refuse it. Repair means restoring the backup taken before 087, which is an owner decision.

## 4. Offline-first and authorization

| Server | Status request fails (network, timeout, 5xx) | Session refused (401, `PGRST301-303`, `RECOVERY_V1_CALLER_REQUIRED`) | Offline |
|---|---|---|---|
| Never identified as V1 (085/086/087) | 085 rules: the sale is saved and queued with its key | 085 rules: the outbox refreshes and retries with the same key | 085 rules |
| Identified as V1 | hold, reason `communication` | one session refresh and one re-ask. Then a hold, reason `authorization`, and the sync status asks for a new sign-in. An auth server that cannot be reached or answers 5xx counts as `communication`. | hold, reason `communication` |

- **Holds keep the operation.** Every hold keeps a queued operation pending, with its original key and in-doubt flag, and retries it automatically. Nothing is discarded or re-keyed.
- **Integrity stops for a person.** An `integrity` block (contradictory evidence or a malformed answer) waits for owner review instead of retrying silently.
- **New operations are refused before anything is saved or sent.**

**Offline selling under V1 (Step 4 Part B).** While connected and ACTIVE, a till receives a server-issued offline capability, bound to the organization, shop, device, cashier, offline epoch, allowed operations (sales only), an expiry, a count and a value limit. When the recovery-aware server cannot be reached, a sale may be recorded **locally** under it; it is queued with its key and the capability reference and sent with the `x-orvix-offline` header. At sync the server re-checks the capability (MAC, device, current state and epoch, cumulative exposure, device sequence); anything doubtful is refused with a hold code and kept for review, never accepted as verified. The till never renews or extends a capability offline and stops at its expiry, its limits, or a backwards clock. The limits installed by default are **test limits** (`DEFAULT_UNAPPROVED`); production limits need an owner-signed offline-policy authorization. Details: `docs/recovery-v1/STEP4-DESIGN.md`.

### Minimum client

| Step | Minimum build |
|---|---|
| 086 | any keyed build (074 or later) |
| 087, PFIN-C, PCOST-A | a v87.x build: `b28f17d` or later. RC3 (`a722aa3`) lacks the net-paid refund math. |
| PFIN-D | a build of this tree before any split payment or cash movement is used. Older tills keep selling single payments; their close is refused (nothing changed) once their shift has a split payment, a movement or a refund payout. |
| Recovery V1 | a build of this tree. Earlier builds hold the database's refusals with their keys, but keep selling offline until they are refused. |

- **1.0.15 (published)** is pinned to hosted Supabase at build time and sends no idempotency keys. It never reaches the self-hosted server.
- **Builds since RC1** (frozen, locally built) send the same 1.0.16 header. This tree adds the `recovery-v1` capability to X-Client-Info, so a V1-ready till is now distinguishable. Its version label is an owner release decision; 1.0.17 is recommended.
- **Forced updates:** none is added. 1.0.15's own updater installs on quit without a guard (see `release-1.0.16.md`).

## 5. Rollback and forward repair

| Step | Rollback |
|---|---|
| 086 | `supabase/rollbacks/086_*.rollback.sql` through the runner; never after 087 or V1 |
| 087 | its rollback through the runner (keeps evidence), after rolling back 088 first; refused while V1 is installed |
| 088 | `supabase/rollbacks/088_retired_number.rollback.sql` (only its ledger row) |
| PSAFE-A, PFIN-A, PFIN-B | `*.rollback.sql` (drop objects only); PFIN-B's refuses while PFIN-C exists. Not supported after V1. |
| PCOST-A | its rollback copies every value back (asserted) before dropping. Not supported after V1. |
| PFIN-C | its rollback (triggers and function; no data). Not supported after V1. |
| PFIN-D | its rollback refuses while PFIN-E exists, once any split payment or cash movement exists, and after V1 |
| PFIN-E | its rollback refuses once any refund line exists, and after V1 |
| Recovery V1 | **none.** It is install-once and preserves evidence. Repair is forward only, or a restore of the backup taken before the install (an owner decision). |

## 6. Tests

| Suite | Command |
|---|---|
| Private-cluster database matrix | `python3 -I tools/recovery-v1/db/db-smoke.py --stage 85\|86 [--financial [--with-pfin-c]] [--with-087 [--m087-runner postgres\|supabase_admin]] [--hold-084]` |
| Financial harness | `supabase/tests/fin/run.sh`, and `FIN_WITH_HELD=1 supabase/tests/fin/run.sh` |
| Planner | `python3 -I deploy/lucashome/tests/migration-plan-test.py` |
| Sequence verifier | `python3 -I tools/migration-sequence/verify-test.py` |
| Client | `npx vitest run` (Step 4: `src/stores/data/finStep4.test.ts`, `src/recovery/offlineCapability.test.ts`, `src/recovery/offlineSelling.test.ts`) |
| Step 4 database suites | run by the matrix: `fin-completion-smoke.sql` (with `--financial`), `offline-smoke.sql`, `step4_suite.py` (offline policy, authorized migrations, key rotation) |
| Pin on the Supabase PostgreSQL 17 image through the real runner | see the final report |
