# v87 client — recovery compatibility with migration 087

Status: **candidate — implemented 2026-10-19 on branch `g1/batch-2a` (uncommitted, not built), verified only against
disposable test stacks.** Nothing is applied to `lucashome`; 087 itself is committed as `e170794`. The server side is
`supabase/migrations/087_recovery_hold.sql`; its contract is `migration-087.md` ("Client contract", "Refusal contract",
"API"). This page says what the till does.

## What the till keeps (durable, per backend + organisation)

Dexie `syncState`, keys `r87:*`. It is never cleared by a snapshot load, a sign-out or a reconnect.

| Key | Holds |
|---|---|
| `r87:capability:<origin>` | whether this backend has 087 (`present` once seen, for good; `absent` re-asked every 10 min) |
| `r87:till:<origin>:<org>` | the till credential (id, secret) from `recovery_register_till`; shown once, stored only here |
| `r87:epoch:<origin>:<org>:<till>` | the epoch and epoch_no `recovery_epoch` returned, the shop, the latest witness, earlier epochs |
| `r87:mode:<origin>:<org>` | the recovery mode, the server's code, since when, when the server last verified the till |
| `r87:upload:<origin>:<org>:<till>` | the journal upload plan of the current incident (exact chunk payloads) |
| `localStorage` `r87:block:<origin>:<org>` | backup record of a blocking state (survives a lost IndexedDB write; removed only by a server-issued epoch) |

The till secret is stored in plain text on the device, as 087 intends: the till is the credential. Every
`r87:*` row is archived, never deleted, when it is replaced (re-registration, owner-confirmed rollback).

## Rules

- **The epoch** is only ever the value `recovery_epoch` returned. Every new financial operation (sale, refund/void
  request, shift, stock adjustment, receipt, transfer, payment, purchase order, catalogue write) is stamped with it
  **once, at creation** (`op_epoch` in `p_ctx`, `x-orvix-epoch` on table writes). A queued operation keeps its epoch for
  good; nothing re-stamps, re-keys or guesses one.
- **New operations are refused before anything is saved or sent** (online and offline) unless the backend has no 087,
  or the till holds a verified epoch and is in mode `normal`.
- **Recovery mode** is entered from the server's refusals (HTTP 429 `PT429` codes, the committed `{outcome:'held'}`
  reply) and from the till's own evidence (`WITNESS_BEHIND`: the server is behind what the till already received from
  it). It is left **only** by a successful `recovery_epoch` — never by reconnecting, restarting or signing in again.
- **Nothing is replayed, fenced or replaced automatically** while the till is in recovery mode. Fences go through
  `op_status_v87` with the operation's own epoch, only in mode `normal`.
- **A recovery refusal is never a network failure**: a refused online sale is not turned into an offline sale.

| Server code | Till mode | Shown as |
|---|---|---|
| `RECOVERY_HOLD`, `CONTINUITY_ROLLBACK` (`{outcome:'held'}`) | `hold` | Recovery hold active |
| `LEASE_INVALID`, `IDENTITY_CHANGED`, `NO_CONTINUITY`, `WITNESS_INVALID`, `API_GUARD` (087 seen), client `WITNESS_BEHIND` | `uncertain` | Server continuity uncertain |
| `TILL_UNKNOWN` | `till-unregistered` | Till reconciliation required |
| `TILL_NOT_RECONCILED` | `not-reconciled` | Till reconciliation required |
| `PRE_EPOCH_OPERATION`, `CLIENT_UPGRADE_REQUIRED` (one operation) | — | Operation awaiting owner review |
| `ORG_UNRESOLVED` (one operation) | — | retried later |
| `recovery_epoch` succeeds | `normal` | Safe to resume (after a blocked state) |

## Offline financial operations (v87.x, 2026-10-19)

A v87 till could not mark an offline sale as provisional: it showed "Sale recorded" and a receipt although the server had
not seen the sale and, after a recovery, might never execute it. So on a backend that **has 087 — or whose 087 status is
not established** (never asked, unreadable state, any recovery mode) — the till creates a NEW financial operation only
while it can reach the server and the server has issued it its epoch **within the last 2 minutes in this process**, for
this backend, organisation and till (monotonic clock; else it asks `recovery_epoch` first; unreachable or refused = not
recorded). Any request that does not reach the server, or whose reply is lost, ends that authorisation: the next operation
asks the server again. A "no 087" answer older than 30 minutes (`ABSENT_OFFLINE_TRUST_MS`) counts as not established
(087 may have been installed since). Never offline, never queued:

| Path | Before v87.x | v87.x on an 087 server |
|---|---|---|
| Sale, shift open/close, stock adjustment, PO receipt, supplier payment, transfer dispatch/receipt, refund/void request (write-ahead) while offline | staged + queued, shown as recorded | refused, nothing saved |
| ... depending on an entry still queued (e.g. a shift opened offline) | staged + queued | refused |
| ... that would queue behind unsent entries | queued behind them | refused |
| ... sent but definitely not delivered (connection refused) | turned into an offline sale | attempt discarded, "not recorded" |
| ... sent, reply lost / "Failed to fetch" (outcome unknown) | staged locally (stock, cart cleared), resent automatically, "pending" | HELD for confirmation: not staged, not applied locally, never resent; the queue asks the server with the same key (op_status) and fences it if the server never saw it |
| Table writes (categories, brands, unit types, price tiers, shops, users, suppliers) offline / not delivered | queued for later | refused, not saved |
| ... reply lost (outcome unknown) | queued for later | not queued; "Not confirmed — may or may not have been saved … check before entering it again" |
| Online-only operations (approvals, lump sums, POs, payments, voids, ...) | refused offline | refused offline (unchanged) |
| A restart, reload or second window with a valid epoch on disk, offline | allowed (the v87 limit below) | refused: only an authorisation in THIS process counts |

The shared layers enforce it (`recoveryGate.ts` gate with fresh authorisation; `writeAhead.ts` run / staging;
`tableWrite.ts`; `outbox.ts` `enqueueOutbox`), not the UI. The cashier sees "Not recorded — nothing was saved. … On this
server, sales, money entries and other changes can only be made while the till is connected and the server has confirmed
it; offline entries are switched off (recovery safeguard)." The offline badge says so while offline (same predicate as the
data layer). Operations already
queued (by an earlier build) are kept with their key, epoch and arguments and sent only after a fresh authorisation;
journals and printed-receipt evidence are untouched. A backend that answered explicitly that it has no 087 keeps the
pre-087 offline rules (for 30 minutes after that answer, renewed whenever the till asks again online). Read-only offline
use is unchanged. The tests-only switches (`simulatePreV87xClientForTests`, `ageAuthorizationForTests`) are inert outside the
unit-test build.

## Operations from before an epoch (legacy and old operations)

On an 087 server, a queued operation **without** an epoch (an older build's queue, or one queued while the server had no
087) and one **refused as old** (`PRE_EPOCH_OPERATION`) are held as `awaiting-owner-review`: never sent again, never
re-keyed, never fenced, payload untouched. While such an entry may be a prerequisite of a new operation, the new one is
refused at the counter. The owner sets it aside or reconciles it (Sync page); 088 decides its outcome.

## The journal (088 evidence)

Every financial operation has a journal record (`opj:<key>`) from creation, kept after the server acknowledges it:
key, RPC, the exact request, the server's reply, the signed v87 reply (`signed`, `sig`), organisation, actor, shop,
till, backend, the epoch it was created under, the printed receipt number (written **before** printing; a print fails
closed if it cannot be written), sends, events. A duplicate acknowledgement never overwrites the first evidence; a
different second reply is recorded as a contradiction. Nothing is deleted for a quota; an operation whose record cannot
be written is not created.

## Reconciliation of a till

1. An administrator **with an authenticator app** (aal2) registers the till (Sync › Recovery, `/app/sync/recovery`).
2. A cashier or manager session on that till uploads the journal (`recovery_submit_journal`): every record within
   200 days (the restore horizon, owner decision D9) and every undecided one, in deterministic chunks of < 180 kB,
   with the till's witness and epochs. The plan is saved before sending; a retry resends identical bytes. An
   administrator session never uploads (087 forbids approving a journal one submitted, and an organisation has one ADMIN).
3. The administrator approves it (`recovery_approve_till`). Sales resume only when `recovery_epoch` issues the epoch.

A till the server no longer knows (`TILL_UNKNOWN`, e.g. 087 rolled back and re-applied) is registered again by an MFA
administrator; the old credential is archived.

## Limits

- **First start after the update:** until the till has asked its server once whether it has 087, new operations are
  refused (fail closed), also offline. A till must reach its server once after updating.
- **A storage failure while entering a recovery mode** (2026-10-19 safety gate): the blocking state is written first to
  a second, independent store (`localStorage`, `r87:block:<origin>:<org>`), then to IndexedDB; on load the backup record
  wins over a stored "normal", and only an epoch issued by the server (or the owner's witness clear / rollback
  confirmation) removes it. After **every start** an online till asks the server (`recovery_epoch`) before its first new
  operation and before the outbox sends anything. The former residual case — **both** stores fail and the till restarts
  **offline** — is closed by v87.x: offline nothing new is created on an 087 server at all.
- **`WITNESS_BEHIND`** is sticky: it is decided against the stored state (after asking the server twice) and cleared
  only by the owner (Sync › Recovery, a written statement); the till's witness is archived, never overwritten. While the
  server is AHEAD of the till in the same epoch, the till keeps its own witness: its next operation carries it and the
  server's `check_witness` compares the hash at that position (a fork makes the server commit a hold). The till's witness
  is evidence for the gate (`tools/recovery-authority/gate.py --till`). A re-applied 087 (new chain) also ends in
  `WITNESS_BEHIND` on tills that held a witness: the owner clears it after the re-apply.
- **A rollback of 087** on the server needs the owner's confirmation on each till (Sync › Recovery), checked twice with
  the server.
- **Server journal quota** (50 MB per organisation by default): a busy till's 200-day journal can exceed it; the upload
  stops with `quota_exceeded` and nothing is deleted — the owner raises the quota.
- **Storage uploads** (product images) and edge functions running as `service_role` carry no epoch (087 does not guard
  them).

## Verification

- `src/stores/data/recovery087x.offline.test.ts`: the v87.x offline safeguard (every path in the table above).
- `src/stores/data/recovery087.client.test.ts`: the client against the fake server's 087 emulation
  (`testing/fakeSupabase.ts`, `enable087()`), including every finding of the independent reviews.
- `tools/m087-client-verify/run.sh`: the real app in real Chromium (persistent profile, crash + restart) and in the real
  Electron app, against the committed 087 applied through the real runner with the real witness authority, on a
  disposable loopback stack.
