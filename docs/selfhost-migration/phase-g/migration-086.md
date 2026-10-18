# Migration 086 — durable operation outcomes (G1 Stage 1)

Status: **candidate, not applied anywhere but disposable test stacks.**
Migration: `supabase/migrations/086_operation_outcomes.sql`.
Client: the recovery protocol in `src/stores/data/` (see "Client protocol").

## Why

| Finding | What went wrong at 085 |
|---|---|
| **B2** | A refused idempotent RPC (e.g. insufficient stock) rolls back its ledger row. A till whose reply was lost resends the same key later; after a restock the refused sale **executes**. |
| **C1** | An operation the till did not record (online attempt, reply lost, offline rules refused it) can still arrive late and execute: nothing on the server can say "this key must never run". |
| **S1** | 69 functions pin `search_path=public` without `pg_temp`, so temporary tables are searched first. A SQL session with the TEMP privilege can shadow `users` and run an ADMIN-only RPC as a cashier (proven on a disposable stack; not reachable through PostgREST). |

## Two kinds of keys — and why that matters

* **UUIDv7** — minted by 086 clients. On an 086 server such a key runs **only
  through `op_execute`**: `idem_begin` refuses it on every legacy direct RPC
  (`OP_EXECUTOR_REQUIRED`, nothing runs). Everything below — actor binding,
  recorded refusals, fences, the execution window, withheld replies — is
  therefore enforced for every UUIDv7 operation, whichever client sends it.
* **UUIDv4** — minted by 085, v1.0.16 and Batch 2A clients (and present in
  queues created before the upgrade). These still run through the legacy
  direct RPCs exactly as at 085 (see "Residual risks").

## What the migration does

Additive, plus two financial-safety corrections folded in before any
deployment (below). 29 of the 30 idempotent RPC bodies are **not changed**
(guarded by md5 before and after); `idem_begin`, `idem_finish` and
`pay_supplier_lump_sum` are re-created from their 085 bodies with exact,
generator-asserted edits.

**Financial-safety corrections (after `19fe67a`; reproduced on the earlier
086, fixed and verified — `src/live/m086-sql.live.test.ts`).**
*Per-organisation ledger identity.* The ledger's primary key is
`(org_id, key)`; the organisation always comes from the session
(`op_caller` / the `users` row of `auth.uid()`), never from the caller. A key
names an operation of ONE organisation: another organisation can neither
claim (fence) it — with no arguments, empty arguments or its own rows as
arguments, every variant fails safe — nor learn that it exists (its lookup
and its execution are answered exactly as for a never-used key), and the
same key used by two organisations is two independent operations. Within an
organisation nothing changes: one key = one operation; another actor's replay
never re-executes (reply withheld), different arguments are a mismatch, and
concurrent first claims serialise on the per-(org, key) advisory lock (one
execution; the other answered from the ledger). Rows whose organisation was
never recorded (pre-074 / bootstrap) move to the reserved `!unattributed`
namespace and keep refusing their key in every organisation, as 074 refused
them. The UUIDv7 rules, rejected / abandoned tombstones and fencing are
unchanged, per organisation; UUIDv4 keys on the legacy direct path replay in
their own organisation (another organisation's use is its own operation).
*`pay_supplier_lump_sum`.* The supplier's received purchase orders in the
shop are locked (oldest first — the allocation order) BEFORE the outstanding
balance is computed, so a concurrent payment waits and then sees the paid
totals; a payment that cannot be applied in full is refused ("Payment amount
exceeds total outstanding balance", a recorded definitive refusal through the
executor) and rolls back entirely — never silently reduced.
`record_supplier_payment` (one purchase order) already checks under the row
lock and is unchanged.
*Open decision (pre-existing classification):* a lump-sum refusal
("Payment amount exceeds total outstanding balance") is a recorded, FINAL
refusal through the executor; the single-PO "can only be recorded against
received purchase orders" is a retried dependency. A lump sum entered while
its purchase-order receipt is still queued on another till is therefore
refused for good and must be re-entered (no money effect). Whether it should
be a dependency is an owner decision (not changed here).

1. **Ledger** (`idempotency_keys`): `state` (`committed` default | `rejected` | `abandoned`),
   `outcome_code`, `outcome_message`, `decided_at` (server clock at insert —
   *not* the commit time), `response_purged_at`, a state/prefix CHECK and an
   index on `decided_at`. Existing rows keep their `request_hash`; they become
   `committed` with `decided_at = created_at`. A rejected row stores
   `R:<hash>`, an abandoned row `A:`: the `idem_begin` hash comparison is
   verbatim, so a legacy direct call with such a key gets `IDEMPOTENCY_MISMATCH`
   — also after a rollback.
2. **`idem_begin` guard.** A UUIDv7 key is accepted only while `op_execute` is
   running that very key (a transaction-local setting no PostgREST request
   can set). `create_app_user` (direct-only) is exempt. v4 keys are unaffected.
3. **`op_execute(p_key, p_rpc, p_args, p_actor_id)`** — guarded executor (authenticated only).
   * Static, generated dispatch over 29 RPCs (`create_app_user` stays direct-only).
     Unknown RPC/argument names are refused; every argument is type-checked
     **before** anything runs; the key comes from `p_key` only.
   * **Bound to the operation's own actor.** `p_actor_id` is the app user who
     created the operation (client record). A different caller is refused
     before anything runs (`OP_ACTOR_MISMATCH`, nothing recorded): a queue
     drained in another user's session never executes, so it can never be
     refused for good because of who drained it. Required for UUIDv7 keys. A
     legacy v4 entry without a recorded actor still runs (as at 085), but a
     refusal of it is **never recorded** (`op_not_recorded:actor_unverified`).
     The server never trusts `p_actor_id` to grant anything: it can only
     refuse.
   * The request hash is byte-identical to each RPC's own `v_idem_hash`.
   * The `idem:<key>` advisory lock is taken at the **outer** level.
   * An existing decision is answered, never re-executed (committed → replay;
     rejected → the refusal; abandoned → abandoned; another org, another RPC
     or changed arguments → `{"outcome":"mismatch"}`, no detail, no write).
   * Otherwise the unchanged RPC runs in a savepoint. Business effects and the
     committed ledger row commit together. A refusal rolls the savepoint back
     and is recorded **only if it is on the audited allow-list** (below); every
     other failure re-raises with `HINT op_not_recorded:<class>` and records nothing.
4. **`op_status(p_key, p_rpc, p_fence, p_expected_actor_id, p_args)`** — lookup:
   a **decided** key is answered from the ledger before any lock (decisions
   are final and only visible once committed): `unavailable` for the
   caller's organisation's key used for another RPC, or a key whose
   organisation was never recorded (one fixed answer, no state, no in-flight
   signal); another organisation's key does not exist for the caller at all
   (per-organisation ledger: answered as a never-used key); otherwise
   `committed`/`rejected`/`abandoned`. For an undecided key:
   `in_flight` while an execution holds the key's lock (lookups take it
   *shared*, so they never see each other as in flight; an execution holds it
   for the RPC's duration), else `not_found` with `executable`.
   `p_fence = NULL` is a lookup, never a fence.
   **Fence** (`p_fence = true`): a key the server never saw is decided
   `abandoned` atomically, so a late copy never executes. Authority: the
   caller fencing their own operation, or ADMIN / `sync:resolve` for a user of
   their organisation, or ADMIN / `sync:resolve` for a legacy entry with **no
   recorded actor** — only when the operation's own arguments (`p_args`)
   prove, from the server's rows, that it belongs to the caller's
   organisation. Arguments that point to another organisation refuse **every**
   fence, the caller's own included (no cross-tenant squatting with a
   victim's real arguments). A UUIDv7 key more than 12 months old is never
   fenced (`reason: expired`): the server can no longer tell whether it once
   ran. A **future-dated** key can be fenced: the fence takes the key's lock
   exclusively (no execution in progress) and, once the row exists, no copy
   can ever execute it (keys more than 30 days ahead are refused by
   `op_execute` anyway).
5. **Retention.** `prune_idempotency_keys()` deletes **only** UUIDv7 rows whose
   decision and key time are both older than 13 months, and **only while** the
   executor and the `idem_begin` guard are installed — then neither path can
   run such a key (op_execute: 12-month window; idem_begin: executor only).
   Without them (e.g. after a rollback) it deletes nothing. v4, derived and
   pre-086 keys are **never** pruned. **Nothing schedules it**, and Stage 1
   keeps it that way. `op_purge_responses` (owner only, ≥ 90 days) is
   **inactive**: nothing calls or schedules it.
6. **S1 hardening.** The 68 remaining functions with `search_path=public` get
   `search_path=public, pg_temp` (configuration only).

### Which refusals are final (`op_classify_refusal`)

An explicit, audited allow-list: every `RAISE` in the 29 RPCs and the
helpers/triggers they reach (183 distinct messages at 085; the integration
suite re-checks that none is unclassified), plus named constraints.

| Class | Recorded? | What |
|---|---|---|
| `rejected` | **yes, final** | permission refusals (`You are not permitted …`), stock (`Insufficient stock …`), money (`Payment amount exceeds …`), validation, terminal status checks; 42501 only `AUTH_ID_READ_ONLY` / `AUTH_ACCOUNT_NOT_LINKABLE`; class 23 only `suppliers_unique_normalized_code_per_org`, `purchase_orders_paid_mmk_not_over_total`, `purchase_orders_paid_mmk_nonnegative`, `supplier_payments_amount_mmk_check` |
| `dependency` | no — retried | every `… not found …`, `No open shift for this cashier and shop`, `Transfer cannot be received from status …`, `Supplier payments can only be recorded against received purchase orders`, `Purchase order is not in a receivable (APPROVED) status`, `This cashier already has an open shift`, 23503, `shifts_one_open_per_cashier_shop` |
| `auth`, `actor`, `internal` | no | sign-in/identity, the 055 actor stamp, server defects (`permission denied for …`) |
| `unclassified` | no (fail closed) | **anything else**, including every other class 22, class 23 and 42501 error (a server defect never becomes a permanent refusal) |

### Authorization (UUIDv7 operations; for v4 see R1)

| Who | Inspect (`op_status`/replay) | Execute | Fence |
|---|---|---|---|
| The operation's own actor | full response / refusal | yes | yes |
| ADMIN (server-side `users.role`) | full, own org | **no** (never on someone else's behalf) | yes, own org; actor-less legacy entries only with org evidence |
| MANAGER | state only | no | no — unless explicitly granted `sync:resolve` |
| Another cashier | state only | no | no |
| Another organization | nothing — the key does not exist in its namespace (answered as a never-used key) | its own, independent operation (the RPC's own org guards apply) | only in its own namespace: never stops the key's real organisation |

## Client protocol (G1 Stage 1)

`callRpc` sends every allow-listed RPC through `op_execute` with the
operation's own actor. It falls back to the direct RPC only when `op_execute`
is missing (PGRST202, or 42883 from a stale schema cache — nothing ran); if an
086 server then answers `OP_EXECUTOR_REQUIRED`, the same attempt goes to the
executor. New operation keys are UUIDv7.

| Situation | Queue entry | Shown |
|---|---|---|
| committed (reply readable) | reconciled exactly once | normal |
| committed, reply withheld/purged | kept in doubt until a **verified full reload**, then acknowledged once; if later entries need its ids it is parked — the **only** entry later ones may pass (it is committed, so it can never change server state again; its dependants keep waiting on their refs) | "Applied on the server — confirming" / "… its user or an administrator must confirm it here" |
| rejected | `conflict` + `serverOutcome: "rejected"`, stock effect released, Retry refused | "Refused by the server — final, never resent" |
| abandoned | `conflict` + `serverOutcome: "abandoned"` | "Not applied — stopped on the server before it ran" |
| entered by another user | parked at the **head of the queue**: sent only in that user's session; later entries wait behind it (an owner can set it aside) | "Entered by another user — sent when they sign in on this till; later entries wait behind it" |
| dependency refusal | parked at the head of the queue and retried (same key); a conflict after 24 h | Retrying |
| outcome unknown, never authorised offline (`fenceRequired`) | **held** as `conflict` + `fenceRequired` (no build ever sends a conflict automatically); looked up and fenced, **never resent**; its stock decrease keeps counting (also once set aside, until the server decides it); a credential refresh never moves it back to `pending`; it counts as pending work, so the periodic drain keeps asking | "Not recorded on this till — being confirmed with the server, never resent" |
| …still undecided (in flight, unreachable, another user's, `unavailable`) | stays at the **head of the queue** — it may still run, so nothing after it may overtake it | as above |
| …on a server without 086 | held, never sent; **later entries wait behind it** until an owner sets it aside (exported first) | "NOT recorded on this till … will NOT be sent automatically" |
| …with no recorded actor | ADMIN resolves it (server checks the organisation); otherwise held for an owner to export and reconcile | "only an administrator can resolve it" |

`fenceRequired` is set when an outcome is unknown and staging under the
offline rules was refused; on restart for a write-ahead row whose eligibility
was never established (first online attempt, or nothing staged); and, once,
for queue rows written by an older build that are write-ahead, in doubt and
with nothing staged (`classifyLegacyQueue`). Queued offline rows of older
builds stay sendable (they were authorised offline). A Batch 2A
`close_shift` / `dispatch_stock_transfer` has no provisional rows: it counts
as staged when the local shift / transfer row carries the operation's own key
— the classification runs **before** the first full load at startup, which
replaces those rows with the server's. A keyless pre-Phase-D entry gets a
legacy (UUIDv4) key, never a UUIDv7 one (it has no recorded actor).

**Queue order (H2, final pass).** The first entry that is not provably
finished on the server is the head of the queue, and nothing overtakes it:
another user's entry, a dependency refusal, an entry waiting on an unresolved
ref, every undecided held entry, and every **conflict the server has not
decided** (`blocksQueue`: a legacy direct-path refusal is never recorded, so
it could still run if retried) stop the pass (`backoff`). This keeps restock →
sale, sale → close_shift, purchase order → receiving, transfer dispatch →
receive and refund/void prerequisites in order, with or without refs. The one
exception is a **committed** entry whose reply this till cannot read (it can
never change server state; dependants still wait on their refs). The 24 h
"needs a person" timer starts at the **first** dependency refusal (or the
first time an entry waits on a ref — a separate clock), not at creation. An
entry whose parent can never succeed (set aside, reconciled, refused,
stopped, or gone without its real id) becomes a blocking conflict at once,
without waiting. After the timer the entry
becomes a conflict that **keeps blocking** until a person retries it or an
owner sets it aside. A refusal the executor did not record
(`op_not_recorded:unclassified/internal/actor_unverified`) is **never final**:
the entry is parked and retried (head of queue); at the counter it is shown,
not staged. A key dated beyond the 30-day future bound (a fast till clock) is
held until real time catches up, never final.

**Shared till (payment-safety pass).** An entry that cannot be sent in this
session — it belongs to another app user and waits for them — no longer
stops the till. Later entries **proven independent** of it pass; anything
that may depend on it, or on an entry waiting behind it, waits too. The proof
(`stores/data/dependencies.ts`) describes each operation by what it touches:
its shift (a sale *uses* it, an open/close *owns* it), the products whose
stock it lowers or raises, its purchase order, transfer, sale, refund
request, supplier, payment, the records it creates offline and the ones it
references, and the user it acts on. Two sales commute (whatever their
products or shift) — the final stock is the same in either order; only which
one a server stock check would refuse can differ. A stock increase (restock,
receipt, transfer receive, refund approval) is ordered against every
decrease of that product; a close after every sale of its shift; a payment
after every purchase-order receipt; a refund after its sale; a user change
after that user's entries. Anything not modelled (table writes, unknown or
rare RPCs, a sale without items) is never proven independent.

Ids are compared canonically (final ordering pass): an id this till created
offline is compared under its **server** id once the verified mapping exists
(written when its creating entry was acknowledged), so a close made with a
shift's server id waits for that shift's sales still queued under its
offline id; an offline id with no mapping yet stands for *any* id and never
proves independence — **unless** its creating entry provably never left this
till (post-checkpoint pass): still `pending`/`failed` here, no attempt, never
stamped as sent, not in doubt, not held, queued for this backend, queued
**after** the till's last queue export (an exported entry may have been
replayed elsewhere with the recovery tool — the export time is stored
durably on the till), and not listed by any row that has been sent. Such a
record does not exist on any server yet, so it is compared as itself
(`local:<id>`): another cashier's close of a server-known shift does not
wait for sales on a shift a cashier opened offline and never sent. Once the
creating entry has been attempted (outcome unknown), the wildcard comes back.
The stored, idempotency-frozen arguments are never
rewritten. One open shift per **cashier**: an open waits for every queued
close of a shift that cashier owns (from the till's shift rows — in any
shop, whoever queued the close, a manager included); when the owner is
unknown, a queued close blocks every open. A close of a shift is ordered
against every void / refund approval (its expected cash depends on them;
whose shift an approval touches is not in its arguments). A stock adjustment
is a decrease or an increase by the sign of its quantity — with or without a
unit; an unknown sign counts as both. The other
user's entry is never sent in this session (and never fenced, unless it is a
held entry and an ADMIN asks the server). This user's own blocked entries
still stop the pass. Another user's entry is parked for 5 minutes; the park
is lifted early only when it was set while **someone else** was signed in
(`parkedWhileSignedIn`) and its creator is now signed in. A park set in the
creator's own session (the server refused it for this user) keeps its
backoff — no resend on every drain. Rows of older builds that carry their
actor only in the stamped `p_expected_actor_id` are attributed by it (a
deactivation of that user waits for them).

**Accepted limitation — the shared-till delay.** *Cause:* when cashier A's
work is waiting for A (another user's entries are never sent in B's
session), B's later entries that the model cannot prove independent wait
too — typically B's close of a shift whose cashier the till does not know,
or anything after A's open/sale on a shift whose open was already attempted
(it may now be any server shift). *What the cashier sees:* B's entry stays in
"N actions waiting to sync"; nothing is lost and nothing fails. *What the
owner can do safely:* have A sign in on that till (A's entries go in A's
session, then B's follow), or export the queue and, if A cannot return, set
A's entries aside (exported first). *Why the till never sends A's entries in
B's session:* the server runs a UUIDv7 operation only for its own creator,
and a legacy one would run as the wrong user (shift/actor checks, audit
trail); the till therefore never replays another cashier's operations.
*Set aside ≠ cancelled:* a set-aside entry keeps its key, its stock
reservation and its "outcome unknown" status; it may still have run, or still
run, until the server decides it (Confirm with server). Independence is
proven (and the delay removed) only where the till can show the record
cannot exist on the server yet (above) — tested in
`src/stores/data/postCheckpoint.test.ts` and live (X4).

**Online operations wait for what they depend on.** An online sale, close or
other offline-capable operation is never sent ahead of an unsent entry of
this till it may depend on — entries being sent right now (`syncing`)
included: it is queued behind it under the offline rules (refused if those
rules refuse it). Every online-only operation (payments, voids, refund/void
requests and approvals, purchase orders, transfers, approvals, user and
supplier changes) is refused while an unsent entry it may depend on remains,
after one drain attempt. Independent work is not held.

**Online-only money operations (payment-safety pass).** Every stored
unresolved operation is treated as possibly applied — whether or not it was
marked uncertain: a crash during its first attempt, an unreadable reply, a
record written by an older build. The record is written durably before each
request. Only the server's decision for its key (committed / rejected /
abandoned) or a success settles it: a 401, 503, timeout, network error,
unrecorded refusal or unreadable reply never turns it into "not applied".
Only the very first attempt of a brand-new operation can prove "not applied"
by its own answer — and only while it is still the latest attempt: outcomes
are monotonic (`decidedBy`: server / owner outrank the client's own
evidence), so a stale attempt never overwrites a newer attempt's outcome,
and a later attempt whose outcome is unknown re-opens a client-side "not
applied". A key mismatch on a stored operation keeps it unresolved. A replacement ("new") is allowed only after the server
shows the earlier one rejected or fenced (abandoned); committed → recorded
instead; no 086 → held for an owner's manual verification. Each operation
records the backend it was created for; one created for another backend — or
an older record with no backend — is never fenced, retried or replaced here
(a read-only Check may still settle it from a positive server answer; an
owner can mark it verified), and blocks new operations of the same kind.

**Atomic records (post-checkpoint pass).** The stored record is the only
authority — there is no in-memory "settled" note. Every change is one
IndexedDB read-check-write transaction on that record: *claiming* an attempt
(refused when the record is settled — "already settled … nothing was sent";
the attempt counter is incremented and the record marked uncertain before the
request leaves), *settling* (monotonic: client < server = owner; the client
may settle only an unresolved record and only for the latest attempt), and
*re-opening* (never over a server or owner decision). The request always
carries the claimed record's own name, arguments, key and user. A stale copy
can therefore never overwrite a newer outcome, a Retry can never resend a
payment another window or attempt already settled, and a replacement is
never sent while an earlier attempt may still commit (that attempt keeps the
record unresolved and listed). A record that cannot be read or parsed, a
storage error, or a key mismatch (also on a brand-new payment) leaves the
operation unresolved — nothing is sent on a failed read. An owner may mark
verified only an operation of their own organisation, and **Mark verified
decides it on the server first** (review-snapshot-7 M-1): on its own
backend the key is looked up and, if it never arrived, fenced — the record
then settles from the server's answer (applied / refused / abandoned); while
it is in flight or the server cannot answer, Mark verified is refused and
nothing changes. Only where no fence exists (a server without 086, another
or an unrecorded backend) does the owner's word close it ("verified
manually") — the owner must have checked the server's records. Before this,
an owner's Verify followed by the same payment entered again could leave two
payments (reproduced at `d0390a1`). Reproduced at
`d0390a1` (two payments) and fixed: `src/stores/data/paymentAtomic.test.ts`;
live X1/X2 (one `supplier_payments` row, the balance moved once).

**Deployment-blocker pass (after `9d37787`).**
*Stale schema cache.* Once a backend has answered `op_execute` / `op_status`,
the till records that durably (per backend origin, `syncState`
`executor-086-seen:<origin>`). From then on a "function not found" from it is a
stale PostgREST cache or a server being changed — never "no 086": nothing runs
on the direct path, nothing is closed manually, no replacement passes, and the
operation stays held with its key ("waiting for the server",
`OP_SCHEMA_UNAVAILABLE`). An unreadable record counts as "has 086". Only a
backend that never answered 086 to this till keeps the 085 fallback.
*Client-decided "not applied".* On a backend that has shown 086 — or whose 086
support is unknown — a first attempt's own evidence (503, not delivered, …)
never settles a payment: the LATEST attempt fences its key on the server and
settles from the answer (abandoned / refused / applied); if that fails it stays
unresolved. Only a server known to lack 086 (no fence exists) keeps the
client's evidence. *Unreadable records.* A stored operation record this build
cannot read (corrupt, or a newer format) is never dropped: it is counted
(badges, sign-in hint, updater guard), shown, exported raw (export **format
3** — older tools refuse such a file instead of dropping it), and it blocks a
new entry it could be (same or unknown operation / scope); nothing is invented
for it. The owner sets one aside only after an export (the raw record is kept,
the action audited, its outcome stays unknown). A store that cannot be read
sends nothing and shows a read error. *Own-scope view.* Any signed-in user
(e.g. a MANAGER) has "My unresolved operations" (`/app/sync/unresolved`): their
OWN operations of their organisation, Check (a read-only lookup, never a fence)
and an unchanged Retry; Mark verified, set-aside and the organisation-wide list
stay on the owner's Sync page; Check refuses another user's or organisation's
operation in the client, and the server applies its own rules. *One recovery
rule.* Startup classification, stranded-attempt recovery, Retry, Restore,
Confirm with server (owner-only, enforced in the function) and the recovery tool
use one rule for "authorised offline" (`offlineAuthorisation`); proof found is
kept as `staged`. The updater guard counts unresolved payments and unreadable
records as unsynced work.

**Exporting unresolved money operations.** A till with **no** queued entries
but an unresolved online operation can export it: the app shell shows "N
payment(s) await server confirmation — do not enter again" and the export
button; the Sync page's export is enabled; the sign-in screen shows the same
hint with an export link. Signed in, the export carries only the signed-in
organisation's operations (each with its organisation, backend, user and
key); from the sign-in screen it carries the whole till, like the queue.
`inspect` lists them and exits 4 ("NOT CLEAN"). Tested in Chromium (M6).

**Replacing an unresolved operation** ("new" in the prompt, sales and online
money operations): every earlier attempt of the same operation whose outcome
nobody has established is found **whatever its queue status** — sending, in
doubt, held (`conflict` + `fenceRequired`), parked, set aside or quarantined —
and settled first, under the drain lock (waiting up to 20 s for this window's
own drain). The attempts are re-asked **by their own keys from the references
taken when the person was asked**: a queue row that disappears meanwhile (a
drain or another window committed and acknowledged it) is never read as "it
did not happen". Committed → recorded and **no** new one is created; never
arrived → fenced, then the new one proceeds; in flight, unknown, unreachable
or no 086 → blocked, original identity kept. An attempt queued for **another
backend** (quarantined, or a different origin) always blocks the replacement:
this server is never asked about it or asked to fence it — its "not found"
proves nothing about the other server. Only a server decision (committed /
rejected / abandoned) ends an attempt.

**Owner actions (audited).** Every owner action — Confirm with server, set
aside, restore — writes an `owner-action` line to the reconciliation log
(exported with the queue): who, when, the entry, and what the server said.
"Confirm with server" never fences an entry that was authorised offline (a
real queued operation): it is looked up only; only an attempt never
authorised offline is fenced when the server never saw it — the server
authorizes that (the operation's own user, or an ADMIN of its organisation).
"Set aside" is **not** "cancelled" and **not** "never executed": the entry,
its key and its stock reservation stay, and the audit line says whether its
outcome is unknown. "Set aside" keeps an undecided entry's stock decrease
(every conflict the server has not decided keeps it too). "Confirm with
server" (owner, on a held, in-doubt or set-aside entry of **this** backend)
asks the server and fences the operation if it never arrived — nothing is
resent; on an entry queued for another backend it refuses and changes
nothing. **Restore** of a set-aside entry whose outcome was unknown brings it
back held (never authorised offline → lookup + fence first) or in doubt
(authorised offline → resent only with its own key, which the server answers
from its ledger if it committed) — never blindly resent. A reconciliation as
**recreated** or **cancelled** is refused for an entry the server has not
decided (it could still run), and always for an undecided entry of another
backend; the owner confirms with the server first, exports again, then
reconciles. Only on a server without 086 (no fence exists) does a UUIDv4
entry of this backend keep the legacy records-search path.

## Deploy order

Apply 086 **before or together with** the client. 086 is fully compatible with
085 clients; a new client against an 085 server holds every `fenceRequired`
operation (and those block the desktop updater) until 086 is there.

1. Run the preflight queries read-only against production first (md5 of the
   32 bodies, SECURITY DEFINER/owner, hardened-function list, ledger columns,
   the ledger's primary key — `(key)` before 086 — and the number of ledger
   rows, and of rows with `org_id IS NULL`: those move to the `!unattributed`
   namespace and keep refusing their key).
2. Apply with `apply-migrations.sh` (`psql -U supabase_admin --single-transaction`)
   **outside** the e-mail backup window: the migration waits at most 3 s for
   the `idempotency_keys` lock and then aborts with nothing changed. Once it
   has the lock it HOLDS it (ACCESS EXCLUSIVE) until COMMIT — backfills, the
   CHECK validation, index builds, the primary-key rebuild and all function
   DDL — so every idempotent RPC waits for the whole apply. At the current
   ledger size that is seconds; measure it on the size the preflight
   reports before choosing the window. The runner
   fails closed: if psql exits non-zero it prints `APPLY FAILED`, exits 1 and
   records **no** version (before this pass a failed apply was hidden by
   `|| true` and its versions were recorded as applied). A `/tmp/mig` left in
   the container by an interrupted run is removed before the copy (and on
   every exit) — `docker compose cp` would otherwise nest the new files and run
   the stale ones — and each copied file is verified against the repo by
   sha256. A lost connection is reported as outcome unknown, and a failure
   while recording versions as "applied but not recorded"; never as done.
3. Do **not** schedule `prune_idempotency_keys` or call `op_purge_responses` in Stage 1.

## Rollback

Reviewed script: `supabase/rollbacks/086_operation_outcomes.rollback.sql`
(generated with the migration; **owner-approved use only**; never run by
`apply-migrations.sh`, which only reads `supabase/migrations/`). Functions
only: it drops every `public.op_*` function and installs `idem_begin`
WITHOUT the UUIDv7 guard — the 085 behaviour on the per-organisation ledger
((org_id, key) lookups and locks; md5 in the script's post-check). The 085
key-only body is deliberately NOT restored: once a key is used in two
organisations it would read another organisation's row. A post-check aborts
the transaction unless `idem_begin` is that body, `idem_finish` and
`pay_supplier_lump_sum` are still the corrected 086 bodies, the ledger
identity is still `(org_id, key)`, no `op_*` function is left, no function is
pinned to `search_path=public` and the kept prune is the inert 086 body.
**Keep** the per-organisation identity, the columns, constraint, indexes,
every tombstone, the 086 `prune_idempotency_keys` (inert without the
executor) and the hardened search paths. Forward recovery: re-apply 086 — its
preflight accepts the rollback's `idem_begin` and the corrected bodies
(idempotent; outcome codes kept). Tested: apply → re-apply → rollback →
re-apply on a disposable stack (`tools/m086-verify`, `rollback` part).

**Never:** restore 062's prune body (it deletes tombstones and re-opens
refused keys); re-run ANY migration 062–085 once 086 is applied — their
key-only `idem_begin` / `idem_finish` over the per-organisation ledger would
mix organisations' rows of one key (062's would hand one organisation's
stored reply to another; 063/070 would also revert the lump-sum correction
and re-pin search paths). `apply-migrations.sh` does not enforce this yet
(proposal §4): a range must never END before 086 after 086 is applied. Never
restore a pre-086
backup/PITR without re-checking every till's held operations (it loses every
rejected/abandoned decision); re-run 085 after 086 (it re-pins one function to
`search_path=public`, see R4).

**Client rollback / downgrade — do not downgrade a till whose queue is not
empty.** What protects a downgraded till: held operations are stored as
`conflict` (no older build sends a conflict automatically), and on an 086
server every UUIDv7 operation an older build sends through the legacy path is
refused by `idem_begin` (`OP_EXECUTOR_REQUIRED`, nothing runs). What an older
build does **not** respect (R2):

1. a **manual Retry** of a held entry sends it (a UUIDv4 one executes; a
   UUIDv7 one is refused on an 086 server, but **executes on an 085 server**);
2. against a server **without** 086 (or after the rollback) it resends a
   write-ahead row it finds in `syncing` — UUIDv7 keys included;
3. it ignores head-of-line holds: entries **behind** a held or another user's
   entry are sent out of order (restock → sale, sale → close_shift …), and
   another user's UUIDv4 entry is sent in the wrong session (the 055 actor
   check refuses it, but older builds do not record that refusal);
4. it does not know "Confirm with server" or the reconcile guard: an owner can
   record a held entry as recreated / cancelled while it may still run;
5. an **older recovery tool** drops the 086 export fields; held entries are
   `conflict`, so it skips them unless `--include-conflicts`, in which case it
   **replays** them (UUIDv7 refused on 086; UUIDv4 executes).

Therefore: no downgrade, and no rollback of 086, until every till's queue is
empty (or exported and reconciled by an owner with the current build).

## Emergency recovery tool (`tools/queue-recovery`)

The tool asks the **server** who is signed in (`app_user_id()`, `app_role()`)
and probes for 086 with a read-only `op_status` lookup; it never accepts an
actor id from the operator. On an 086 server a UUIDv7 operation runs only
through `op_execute` (original key and arguments, `p_actor_id` = its creator)
and only when the creator is the signed-in user; anyone else's operation is
looked up (never run, never fenced) and reported `held`. A held entry
(`fenceRequired`) is never replayed: looked up and fenced (by its creator, or
an ADMIN with the operation's own arguments as organisation evidence). An
entry the till already saw decided (`serverOutcome`) is reported, not sent.
Outcomes: `applied` / `already-applied` / `accepted`, `rejected-final`
(recorded refusal), `abandoned`, and — each one stops the run, later entries
are `not-attempted` — `in-flight`, `unavailable`, `held`, `unknown`,
`not-attempted` (transient). `OP_EXECUTOR_REQUIRED` and `op_not_recorded:*`
refusals are never final. UUIDv4 operations, and every operation on an 085
server, keep the direct 085-compatible path (on 085 a held entry is `held`:
no lookup or fence exists there). On the RPC paths (UUIDv7 and UUIDv4, 086
and 085) an entry whose recorded creator is another user is `held` (never
sent in the signed-in user's session), as is a server refusal "queued by a
different user". **Not covered:** table writes (product/category edits) carry
no creator and are replayed as the signed-in user, and an RPC entry with no
recorded creator (older builds, non-actor-stamped RPCs) is replayed in the
signed-in user's session (the server's own permission checks apply). A key
mismatch is `unknown` (the server holds a decision under that key, possibly
committed), and an inconclusive 086 probe stops the run at the first RPC
entry (table writes before it may already have been replayed).

The tool classifies an attempt as the till does: an online attempt being
sent when exported (`syncing`, or set aside while being sent) is undecided.
**Definitely not authorised offline → looked up and fenced** on its own
backend, never executed: `staged: false` with an unknown outcome; a
write-ahead row being sent with no `staged` flag on its first attempt or with
nothing staged (the till's `recoverStrandedSyncing` — the current build's own
interrupted online sale); an older build's write-ahead row in doubt with
nothing staged (`classifyLegacyQueue`). **Authorisation unknown → looked up
only** (never fenced, never sent): a Batch 2A `close_shift` /
`dispatch_stock_transfer` of that kind (its proof lives in the till's local
row, not in the file) and an entry being sent in a version-1 file.
**Definitely authorised** (staged) → replayed with its own key. A dry run
predicts the same from the file: `held` for anything the real run would not
replay (another backend without `--confirm-host`, and a UUIDv7 executor
operation of another backend even with it), and stops there. Who will be
signed in is known only to the real run (the server says): a planned entry
with a recorded creator says "only if signed in as <creator>; otherwise
held".
`inspect` exits 4 ("NOT CLEAN") while the file has an undecided entry or an
unresolved online operation. Like the drain, the run stops at a
refusal the server did not record, at an unresolvable reference and at an
entry it cannot replay (redacted) — nothing later is replayed past them.

Backend binding: lookups, fences and executor calls are made only against the
backend an entry was queued for (its recorded origin). Replaying an entry
into a different backend (a restore under a new name) needs `--confirm-host`
and is refused for any entry ever in doubt (in doubt, held, blocking). A
conflict the server never decided (`blocksQueue`, exported) stops the run like
the drain. The run never reports success while a skipped entry is undecided,
or while the file lists an unresolved online-only operation (payments, voids,
refund requests — exported for this, never replayed): exit 4, "NOT
RECOVERED".

## Residual risks (Stage 1)

* **R1 — legacy v4 keys on the direct path.** 085 / v1.0.16 / Batch 2A
  clients (and v4 entries queued before the upgrade) call RPCs directly:
  their refusals leave no row (B2 remains for them); any same-org user who
  knows a v4 key and its arguments gets the stored reply from `idem_begin`
  (before the RPC's own permission check); v4 keys have no execution window
  and are never pruned. Closed by Stage 2 (blocked while the v1.0.16 updater
  refuses to install with a non-empty queue).
* **R2 — downgrade limits** (see "Client rollback / downgrade").
* **R3 — unseen keys (narrowed).** Across organisations: closed — the ledger
  identity is `(org_id, key)`; another organisation's fence or refusal
  decides only its own namespace and its lookups learn nothing. Within ONE
  organisation the server still cannot know which user minted a
  never-delivered key: a user of the same organisation who holds it (e.g.
  from the shared till) can fence it as their own (denial of service only;
  the till re-enters it, nothing is applied twice). Keys are UUIDv7 with 74
  random bits.
* **R4 — future migrations.** A later `CREATE OR REPLACE … SET search_path TO 'public'` silently re-opens S1 for that function.
* **R5 — till clocks.** A clock more than 12 months behind (or 30 days ahead) mints keys `op_execute` refuses (`OP_KEY_OUTSIDE_WINDOW`, nothing recorded).
* **R6 — the queue keeps final entries** (as conflicts) until an owner
  reconciles them, and held entries block the desktop updater guard.
* **R7 — dependency refusals are not final.** A "not found"/status refusal
  can execute later once its prerequisite arrives (intended eventual consistency).
* **R8 — head-of-line holds.** Ordering is kept by stopping: an undecided
  held entry waits for the server, an entry waiting on a ref waits for its
  parent, and every undecided conflict of this user (on a server without 086:
  every refusal, since none is recorded there) waits for a person — a retry
  or an owner's set-aside (exported first; its stock decrease keeps counting).
  Another user's entry no longer stops the till: only work that may depend on
  it waits. The independence model is conservative (anything unmodelled
  waits) and its relaxations are documented above (two sales of a product
  commute; which of them a stock check refuses can change; an offline record
  whose creating entry provably never left the till is not a wildcard). The
  remaining shared-till delay is an accepted limitation ("Shared till").
* **R11 — export format.** New exports are **format version 2** (**3** when the till holds online-operation records it cannot read — their raw contents are in the file, and every reader of format ≤ 2 refuses it): the 086
  recovery fields (actor, held, server decision, blocking), the owner-action
  log and the unresolved online-only operations are safety-critical. Every
  older recovery tool refuses a version-2 file outright ("unsupported-version",
  verified against the ae51e69 tool) instead of reading it and silently
  dropping those fields. The current tool still reads version-1 files from
  older builds (their 086 fields read as null). Use the tool of the same
  build as the tills.
* **R9 — direct-RPC legacy path.** `create_app_user` stays direct-only (exempt
  from the UUIDv7 guard; never pruned). Direct UUIDv4 calls keep 085 semantics
  (R1). The executor marker is a transaction-local setting: PostgREST callers
  cannot set it before an RPC, but a direct SQL session with a login role
  could — database logins stay restricted to the owner.
* **R10 — not proven here:** Windows, Electron (incl. the main-process owner
  attestation used by reconcile) and Realtime were not part of the disposable
  verification.
