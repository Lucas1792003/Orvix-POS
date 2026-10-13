# Phase D · Offline authorisation and outbox reliability (client design)

Status: designed 2026-10-12, implemented in the same change. Companion to
[idempotency-contract.md](./idempotency-contract.md) (server side). Fixes
defects R1–R3 and changes A2–A6, A8, A9 from
the production-dependencies audit §8 (private ops notes).

Owner decisions this design respects: the JWT lifetime stays **1 hour**
(no GoTrue change, nothing relies on a longer token); the offline
authorisation window is a **client-side** control; the server remains the
only security boundary.

## 1. Two different things: offline authorisation vs server authentication

| | Offline authorisation (local) | Server authentication |
|---|---|---|
| Question | "May this device keep *recording* activity while it cannot reach the server?" | "Is this request from a live, valid session, and may this user perform it?" |
| Decided by | the client, from a cached snapshot (`authCache`) and the time since the last successful authenticated round trip | GoTrue (JWT + refresh token) and every RPC's own `current_app_user()` / permission checks |
| Can be wrong | yes — the snapshot may be stale (user deactivated, role changed) | no — it is the source of truth |
| Consequence of being wrong | the device queues work the server will later reject; the queue entry becomes a visible conflict and the cash/stock discrepancy is handled by a manager | — |
| Purpose | UX and latency: keep the till trading through an outage without a round trip per action, and stop a device that has been cut off for too long | security |

The client gate (`assertOfflineWriteEligible`) is therefore **not** a
security control. It exists so that a till that has been disconnected for an
abnormally long time stops accumulating activity that is increasingly likely
to be rejected, and so that a revoked account's offline exposure is bounded.

## 2. The offline authorisation window

### Value: 12 hours for writes, 24 hours for read-only session
`OFFLINE_WRITE_TRUST_MS = 12 h`, `OFFLINE_SESSION_TRUST_MS = 24 h` (unchanged),
both measured from `authCache.cachedAt`, which is now the **time of the last
successful authenticated server round trip**, not the time of boot or login.

Why 12 h, not the current 2 h, and not unbounded:

- The previous 2 h was measured from boot/login and never refreshed, so a
  till booted at 08:00 could not sell offline after a 10:00 outage even
  though it had been talking to the server continuously until then (R3).
  With `cachedAt` refreshed on every successful round trip, the window is
  now "time since the connection was lost". 2 h from loss of connectivity is
  shorter than a typical ISP/power outage in the shops this runs in; a POS
  that stops selling two hours into an outage defeats the point of
  offline-first.
- 12 h covers one full trading day (open ≈ 08:00, close ≈ 20:00) with the
  connection lost at opening — the realistic worst case for a day-long
  outage — while still forcing re-validation before the next trading day.
  Shifts are the unit of accountability (`open_shift`/`close_shift`); a
  window that spans a shift but not two keeps a revoked account's possible
  unsynced activity inside what one end-of-day reconciliation can review.
- It is shorter than the 24 h read-only session window, so a device always
  stops *writing* before it stops *showing* cached data, as today.
- Exposure analysis for a deactivated/role-changed user: the server
  re-validates every replayed RPC (`current_app_user()` is active, role and
  shop checks, and `p_expected_actor_id` where declared), so the user's
  queued activity is rejected on replay and surfaces as conflicts, with the
  provisional records kept and flagged. The window bounds how much such
  activity can accumulate, not whether it is accepted.

The value is a single constant and can be tuned without touching the logic.

### What refreshes `cachedAt`
Every successful authenticated server round trip:
- a full `loadData()` (also refreshes the role/shop/org/permissions snapshot
  from the freshly loaded `users` row),
- a successful `pullDeltas()` (every 30–120 s while the app is open and
  online),
- a successful RPC reply, online or during an outbox replay,
- `restoreSession()`/`login()` as before.

Failed or network-errored calls never touch it. A device that is online and
in use therefore always has `cachedAt` within the last couple of minutes.

### What is persisted, and where
IndexedDB `authCache` (Dexie, keyed by Supabase auth id):

```
authId, userId, role, shopId, orgId, isActive, hasTotp,
grantedPermissions?, revokedPermissions?,   // permissions snapshot (users row)
cachedAt                                    // last successful authenticated round trip
```

No tokens are stored here. The access/refresh tokens are persisted only by
supabase-js in its own `localStorage` key, exactly as before. The
role/permissions snapshot is written **only** from a server response
(`resolveAppUser()` or the `users` table of a full load) — never from UI
input, never from the outbox, so the client cannot escalate itself.

`syncState` (new small key/value table): `needs-reauth` flag and the
cross-instance drain lease (see §5). Cleared on sign-in, never touched by
the snapshot replace.

### Which operations are permitted offline
Unchanged from docs/10-offline-desktop-known-issues.md:

- offline-capable (queued, replayed): `complete_sale`, `adjust_stock`,
  `receive_purchase_order`, `record_supplier_payment`,
  `dispatch_stock_transfer`, `receive_stock_transfer`, `open_shift`,
  `close_shift`, `create_refund_void_request` (request only), and the
  single-row table writes (categories, brands, unit types, price tiers,
  shops, users, suppliers).
- online-only: void/refund approval, PO create/approve/cancel, lump-sum and
  void supplier payments, transfer create/approve/reject/cancel, catalog
  batch writes, business profile, user admin.

No change is proposed: the offline list is the set of floor actions that
cannot wait; everything else is a desk action that can. The online-only
RPCs still get idempotency keys (and a short bounded retry with the same
key on a transient failure), so a lost response no longer duplicates them.

### What happens when the window expires
- New offline writes are refused with a clear message
  ("offline for more than 12 hours … reconnect to verify your sign-in").
  Nothing is discarded: the queue, provisional records and cached data stay.
- Read-only browsing continues until the 24 h session window.
- The first successful round trip after reconnecting refreshes `cachedAt`
  and the snapshot; writes are allowed again immediately. If the server
  rejects the session (see §4) the user must sign in; the queue is drained
  after sign-in.

## 3. Privilege escalation

- The cached role/permissions only ever come from the server. The client
  never writes role or permissions into `authCache` from local state.
- Every queued RPC carries `p_expected_actor_id` where the RPC declares it
  (stamped at enqueue time from the resolved app user), and every RPC
  re-derives the actor from the JWT via `current_app_user()` at replay. A
  queue entry made by user A cannot execute as user B, and a user whose
  role changed is re-checked with the new role.
- The idempotency key is a random UUID v4 minted client-side; the server
  binds it to the request hash and the actor, so a key cannot be reused to
  replay someone else's response (mismatch → `IDEMPOTENCY_MISMATCH`).
- The client gate is advisory: bypassing it (dev tools) only lets a device
  queue entries the server will reject.

## 4. Sessions, JWT expiry and reauthentication

Lifetimes: access token 1 h (unchanged), refresh token long-lived with
rotation. supabase-js persists both and refreshes on demand.

Before every drain pass (`ensureSessionForDrain`):
1. `supabase.auth.getSession()` — local read; supabase-js refreshes an
   expired access token here.
2. Session present and not expired → proceed (and clear `needs-reauth`).
3. Refresh failed with a **network** error (`AuthRetryableFetchError`,
   status 0/5xx) → stop the pass, keep everything `pending`, retry later.
4. Refresh failed with an **auth** error (invalid/revoked refresh token,
   4xx) or no session at all → set `needs-reauth` (persisted in
   `syncState`), keep every entry, show a banner with "Sign in again".
   supabase-js has already removed its session in this case.
5. After a successful sign-in (`onAuthStateChange` SIGNED_IN) or token
   refresh (TOKEN_REFRESHED) the flag is cleared and a drain is started.

During a pass, a 401 / `PGRST301` / "JWT expired" reply from PostgREST is
classified **transient**: the entry stays pending with backoff; the next
pass goes through step 1 again, which refreshes the token.

Offline writes are also refused while `needs-reauth` is set, since the
server has explicitly rejected this device's session.

## 5. Outbox reliability (summary of the implementation)

- **Idempotency.** A UUID v4 is minted when the operation is created
  (`beginOperation()` in each slice), stored on the provisional record, on
  the outbox entry (`idempotencyKey`) and inside its `args` as
  `p_idempotency_key`; the online attempt and every replay send the same
  key. Entries created before this change get a key on upgrade (Dexie
  schema v2) and, belt-and-braces, on their first drain.
- **Classification** of a resolved `{ error }` (supabase-js resolves, it
  does not reject): transient = status 0 (fetch failure/abort), 408, 425,
  429, 5xx, 401/`PGRST301`/JWT-expired → `pending`, `attempts + 1`,
  `nextAttemptAt` with capped exponential backoff (1 s · 2ⁿ, ±20 % jitter,
  cap 5 min), no attempt cap. Everything else (validation 4xx, RLS,
  `IDEMPOTENCY_MISMATCH`, business rules) → `conflict` with the server
  message, visible on the Sync Conflicts page.
- **Timeouts.** Every RPC call gets an `AbortSignal` (30 s) and a race
  timer, so a hung connection cannot block the drain.
- **Triggers.** After `loadData`, on offline→online (full reload →
  drain), every 30 s while pending > 0, after `pullDeltas`, on
  SIGNED_IN/TOKEN_REFRESHED, and manual Retry.
- **Cross-instance safety.** `navigator.locks.request('pos-outbox-drain',
  { ifAvailable: true })` when available; otherwise a Dexie lease row
  (`ownerId`, `expiresAt`, 60 s TTL, renewed per entry).
- **Ordering.** Oldest first; entries with unresolved refs are skipped; a
  transient failure (or a head-of-line entry still in backoff) stops the
  pass so dependents never overtake; a permanent failure does not block
  later independent entries.
- **Persistence.** `persistSnapshotToLocal` clears only snapshot tables;
  `syncOutbox`, `provisionalIdMap`, `syncMeta`, `authCache`, `syncState`
  are never cleared by a load, and `loadData` awaits the persist before
  draining. Provisional *created* rows (sales, items, movements, shifts,
  refunds, supplier payments) still queued are merged back into a full
  load so they do not vanish from the UI between reload and replay.

## 6. Trade-offs

| Choice | Alternative | Why this one |
|---|---|---|
| 12 h write window from last contact | 2 h (today) / unbounded | 2 h blocks a normal outage; unbounded lets a revoked account trade indefinitely. 12 h = one trading day, bounded by shift reconciliation. |
| Keep JWT at 1 h, rely on refresh | raise `jwt_exp` to 24 h | owner decision; a long-lived access token widens the blast radius of a leaked token and does not solve the revoked-refresh-token case anyway. |
| Transient failure stops the whole pass | skip and continue | preserves dependency order (sale after its shift); a network failure affects every entry anyway. Cost: a single entry that keeps getting a 5xx holds the queue — visible on the Sync page, dismissable. |
| No attempt cap for transient errors | cap and conflict | a cap would turn a long outage into manual work for every sale; backoff is capped instead. |
| Client minted key stored in `args` | separate column only | the args are what is sent; keeping the key inside them makes the replay byte-identical and visible in the conflict view. |
| `needs-reauth` persisted | in-memory only | a restart must not silently retry with a revoked session, and the banner must survive a reload. |
| Web Locks with Dexie lease fallback | in-memory flag only | the web build can run in several tabs; the in-memory flag only covers one JS context. The lease TTL means a crashed holder frees the queue within 60 s. |
| Duplicate-key (23505) on a replayed `table_write` insert treated as success | conflict | the row id is client-minted; a duplicate on *our* insert means our earlier attempt committed. |

## 7. Known limitations

- Two terminals share no outbox; dependency between devices (a transfer
  dispatched on A and received on B offline) is still resolved only by the
  server's state checks and surfaces as a conflict on the later device.
- A permanently 5xx-ing head-of-line entry holds the queue until dismissed
  (by design, see §6).
- `hasTotp` in the snapshot is refreshed only at login/restore (needs the
  MFA endpoints).
- The Dexie lease is advisory between instances that do not share a
  `navigator.locks` implementation (two Electron windows do share it).
