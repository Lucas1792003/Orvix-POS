# Phase E · Offline authorisation — verification against the real app

Verifies the design in
[../phase-d/offline-authorization.md](../phase-d/offline-authorization.md) in
the real Electron app against the self-hosted stack (2026-10-12, spec
`e2e/c-offline-auth.e2e.ts`, plus B6/B7 of `e2e/b-failures.e2e.ts`). The
offline clock is `authCache.cachedAt` in IndexedDB (last successful
authenticated round trip); the tests move it through `page.evaluate` and cut
the Supabase origin with request interception — the server is never
disrupted. Every result is confirmed in the database with the service role.

## 1. Results

| # | Scenario | Expected (design) | Observed | DB check |
|---|---|---|---|---|
| C1a | Offline, `cachedAt` 11 h ago, cashier rings up a sale | allowed, queued | sale queued (receipt PENDING, badge "1 action waiting to sync", provisional record flagged) | no `sales` row yet, stock unchanged |
| C1b | Offline, `cachedAt` 13 h ago, cashier rings up a second sale | refused with the documented message; nothing discarded | "Checkout failed — This device has been offline for more than 12 hours. Reconnect to the internet to verify your sign-in before recording new offline activity — anything already queued is kept and will sync." Queue still holds the one entry; PENDING record and cart kept | no new rows; stock unchanged |
| C1c | Offline, 13 h, cashier closes the shift | refused the same way | "Could not close shift — …offline for more than 12 hours…" | shift still open |
| C2a | Offline boot, `cachedAt` 23 h ago | read-only session kept | app boots from the local mirror signed in as the cashier, POS visible, badge shows the queued action | — |
| C2b | Offline boot, `cachedAt` 25 h ago | logged out | app lands on `/login`; the queued entry is still in the outbox; an offline sign-in attempt shows "Failed to fetch" and loses nothing | — |
| C2c | Reconnect and sign in | sync restored, preserved queue drained | drained within seconds; `cachedAt` refreshed to now | `sales` +1, `idempotency_keys` row present, stock −1 |
| C3 | Cashier's `users.is_active` set to false by an admin while the till is offline, then reconnect | server rejects the replay; permanent conflict, nothing lost | replay rejected with "Not authenticated"; outbox entry `conflict`/`permanent`; badge "1 sync conflict needs attention" (shown to the admin who signs in on the till); provisional sale kept locally and flagged; the till itself drops to `/login` | no `sales` row, no key row, stock unchanged; a direct replay with the cashier's own token → HTTP 400 "Not authenticated" |
| B6 | Access token tampered + expired while a sale is queued | refresh, then continue | one refresh call, new token (same `session_id`), sale sent once with the new token, no needs-reauth flag | `sales` +1, one key row |
| B7 | Refresh token revoked server-side while a sale is queued | needs-reauth banner, queue intact; sign in → drain | banner "Your sign-in has expired on the server. Sales and other actions recorded on this device are saved (1 waiting) and will sync after you sign in again." → Sign in again → drained | refresh refused HTTP 400; no sale until the re-login; then `sales` +1 |

Two gaps were found and fixed on the way (details in
[e2e-results.md §5](./e2e-results.md)): the 12-hour refusal was displayed as
the generic "Network error" (F5), and a revoked session during a full load
emptied the till instead of showing the banner (F4). Both are covered by the
rows above after the fix.

## 2. What happens if a cashier loses authorisation while offline

In plain language, for the shop owner:

1. **The till keeps working for up to 12 hours after it last talked to the
   server.** Sales, stock adjustments, shift open/close are saved on the
   device and queued. After 12 hours with no connection the till stops
   accepting *new* sales and shows "This device has been offline for more
   than 12 hours. Reconnect…"; everything already recorded stays saved. After
   24 hours it also signs the cashier out until the connection is back.
   Nothing recorded is ever thrown away by these limits.

2. **The device cannot know that an account was disabled while it was
   offline.** If an administrator deactivates a cashier (or changes their
   role) while that cashier's till has no connection, the till will still
   accept their sales until the 12-hour limit, because it trusts the last
   thing the server told it.

3. **The server is the judge.** When the connection returns, every queued
   action is sent to the server one by one, and the server checks the account
   again at that moment. A deactivated cashier's queued sales are **refused**
   ("Not authenticated"); none of them is written to the books, no stock is
   deducted, no receipt number is used. The till shows "1 sync conflict needs
   attention" and the cashier is signed out.

4. **The money and the stock still moved in the real world.** The refused
   sale is kept on the till, marked as not synced, so a manager can see what
   was sold during that window. The manager reconciles it by hand: either
   re-enters the sale under a valid account (after re-activating the cashier
   if that was a mistake — then the queued entry can simply be retried from
   the Sync Conflicts page) or writes the cash and stock difference off
   deliberately, then dismisses the entry on the Sync Conflicts page
   (Administration → Sync Conflicts, admin only).

5. **Nothing from a revoked account can sneak through later.** Replays are
   re-checked with the account's *current* state, the queued entry carries
   the original actor and an idempotency key, and the device cannot change
   its own role or permissions locally. Signing in as a different user on the
   same till does not make the old user's queued entries run as the new user:
   the server checks the actor (`p_expected_actor_id`) and shift ownership and
   refuses them the same way.

6. **If only the sign-in expired (not the account)** — for example the
   session was revoked from the admin console — the till shows a yellow
   banner "Your sign-in has expired on the server…", keeps everything queued,
   and sends it all as soon as the cashier signs in again.

## 3. Residual notes

- The 12 h / 24 h windows are client-side constants
  (`OFFLINE_WRITE_TRUST_MS`, `OFFLINE_SESSION_TRUST_MS` in `src/stores/authStore.ts`);
  the server re-validates every replay regardless of them.
- A deactivated cashier's reconnect reload no longer sees their own `users`
  row (RLS hides inactive accounts); the till therefore signs them out and the
  conflict is visible to the next admin/manager who signs in on that device.
- The conflict page is admin-only (`audit:view_global`); a manager sees the
  badge count but cannot dismiss the entry.
