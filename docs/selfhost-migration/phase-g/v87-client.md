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
  operation and before the outbox sends anything. Residual case: if **both** stores fail and the till then restarts
  **offline**, it may queue sales under its last epoch — the same as the unwitnessed tail: on reconnect the server is
  asked first, nothing is sent, and the server would never execute a stale epoch.
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

- `src/stores/data/recovery087.client.test.ts`: the client against the fake server's 087 emulation
  (`testing/fakeSupabase.ts`, `enable087()`), including every finding of the independent reviews.
- `tools/m087-client-verify/run.sh`: the real app in real Chromium (persistent profile, crash + restart) and in the real
  Electron app, against the committed 087 applied through the real runner with the real witness authority, on a
  disposable loopback stack.
