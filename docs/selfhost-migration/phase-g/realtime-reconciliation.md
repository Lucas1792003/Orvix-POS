# Phase G · Realtime reconciliation (server-authoritative stock after a gap)

Date: 2026-10-12. Scope: frontend only. Closes Phase E observation **F7**
(`phase-e/e2e-results.md`, B11): "a Realtime-only outage is not caught up
on rejoin".

## 1. Root cause

`inventory` is published on Realtime (migration `058`) and has no
`updated_at`, so it is excluded from the cursor-based delta pull
(`stores/data/deltaSync.ts`); the `inventory-live` channel in `AppLayout`
was the only thing keeping stock fresh between full reloads. A
`postgres_changes` channel delivers nothing while its socket is down and,
when realtime-js reconnects and rejoins, **replays nothing it missed**. The
old subscription never looked at the channel's state (`subscribe()` was
called without a callback), so after any gap — socket drop, refused rejoin,
JWT refresh failure, `isOnline` toggling — a till kept showing the last
value it had seen until the *next* event for that particular row or the
next cold boot. Two registers in one shop could disagree indefinitely.

## 2. What changed

`src/stores/data/inventoryRealtime.ts` (new) owns the channel:

- `subscribe((status) => …)` tracks `SUBSCRIBED` / `CHANNEL_ERROR` /
  `TIMED_OUT` / `CLOSED`. Any non-`SUBSCRIBED` status opens a *gap*: the
  per-scope freshness set is cleared and a generation counter bumped.
- On **every** `SUBSCRIBED` — the first join included, since rows may change
  between the full load's `SELECT` and the join being acked — it runs
  `refreshInventoryFromServer()` for the current scope (the selected shop,
  or every readable row for an ADMIN with no shop selected). A refresh that
  started before a gap opened cannot mark the scope fresh (generation
  check); one refresh runs at a time.
- `refreshInventoryIfNotLive()` is called from `pullDeltas()` (the 30–120 s
  focus/interval refresh in `AppLayout`) and re-reads the rows whenever the
  channel is not live **or** the current scope has not been confirmed since
  the last gap — so staleness while the socket never comes back is bounded
  by the pull interval, not "until the next event".
- `syncInventoryScope()` runs when the selected shop changes, so an ADMIN
  switching shops after a gap gets the new shop confirmed too.
- It publishes `inventorySyncState` (`stores/syncStore.ts`):
  `subscribed` (live and confirmed), `reconnecting` (live but catch-up
  running; or down but confirmed by a refresh since the gap began; or the
  very first join still pending), `stale` (down and not confirmed since the
  gap). `AppLayout` shows a badge after 1.5 s in the non-subscribed states
  ("Live stock paused — stock may be out of date" / "Reconnecting live
  stock…"), hidden while offline (the offline badge already covers it).
  `stop()` (unmount, logout, going offline) removes the channel and
  publishes `stale`.

`refreshInventoryFromServer({ shopId })` (`slices/inventorySlice.ts`):

1. reads **server time** first (`resolve_event_time(NULL)` → `now()`,
   migration `045`, executable by `authenticated` per `064`) — everything
   committed before that instant is visible to the read that follows;
2. `SELECT * FROM inventory [WHERE shop_id = …]` (RLS applies);
3. reads the outbox *after* the select and re-applies the net
   `qty_change` of the provisional `inventory_movements` referenced by
   `pending`/`failed` entries (`stores/data/pendingStock.ts`) on top of the
   server rows, so an offline sale/adjustment stays visible until it drains.
   `syncing` entries are deliberately not counted (their effect may already
   be on the server; the drain's reconciler replaces the row from the RPC
   result within milliseconds), and `conflict` entries moved no stock;
4. **replaces** the scope's rows in the store and in the Dexie mirror (rows
   the server no longer has are removed; other shops are untouched) and
   stamps every row's watermark with the server time from step 1.

Steady-state events still go through `applyInventoryRealtimeUpdate(row,
commit_timestamp)`: an event whose `commit_timestamp` is older than the
row's watermark (the last refresh's server time, or a later event's commit
time) is dropped, so a late delivery cannot roll a refreshed row back and
two terminals' concurrent updates settle on the latest commit regardless of
delivery order. Only server timestamps are compared with server timestamps —
the client clock is never involved. `DELETE` events remove the row
(`applyInventoryRealtimeDelete`).

Drain after a refresh does not double-apply: every reconciler
(`reconcileCompleteSale`, `reconcileAdjustStock`, …) *replaces* the row with
the RPC's authoritative `inventory` value and deletes the provisional
movement, and the server's idempotency ledger (`062`/`063`) still guarantees
one execution per key; the refresh only adds deltas for entries still
queued at the moment it reads the outbox.

## 3. Tests

`src/stores/data/inventoryRealtime.test.ts` (vitest; fake supabase client
extended with `from("inventory")`, read-only RPCs and a controllable
channel — `fakeSupabase.realtime.current().emitStatus()/emitChange()`):

| Scenario | Checks |
|---|---|
| missed update during a gap | change made while `CHANNEL_ERROR` is recovered on the next `SUBSCRIBED` with no event; one select per join; no write RPC |
| two terminals, out-of-order delivery, client clock 10 min ahead of the server | commit order wins; an event older than the join refresh is ignored; a newer one is applied |
| channel stays down | `stale` → periodic refresh → `reconnecting` with fresh rows; failed refresh keeps `stale` and the old rows; rejoin → `subscribed`; no extra select when live and fresh |
| pending offline sale across a refresh | provisional deduction survives the replace; drain sends exactly one `complete_sale` (server executions = 1); the server's own event and a later refresh do not double-apply |
| pending adjustment | re-applied on top of a server row changed elsewhere; a `syncing` entry is not counted; drains once |
| replace semantics | rows the server no longer has disappear from store and mirror; other shops untouched; `shopId: null` reads everything |
| ADMIN shop switch after a gap | the newly selected shop is refreshed |
| INSERT/DELETE events; `stop()` | applied; channel removed and state `stale` |

E2E: `e2e/b-failures.e2e.ts` **B11b** — Realtime socket blocked through the
proxy, a **service-role** direct `UPDATE` of the row during the cut, badge
visible, unblock → the card shows the new value from the rejoin refresh
with no reload and no further event, badge hidden; the edit is then
reverted (live) so the ledger gate still holds. Compiles
(`npx tsc -p e2e/tsconfig.json`); **not run** here — left for the
coordinator with the live suite.

## 4. Limits

- Ordering between the refresh and an event committed *after* the server
  time was read but *before* the select completed (one round trip) is the
  same as before: the event is applied, and the next event or refresh
  settles it.
- A `syncing` outbox entry is invisible in the stock figure for the
  milliseconds until its reply reconciles (chosen over a possible
  over-count).
- The refresh is per selected shop (or everything for a shop-less ADMIN); a
  channel event for another shop still applies immediately.
