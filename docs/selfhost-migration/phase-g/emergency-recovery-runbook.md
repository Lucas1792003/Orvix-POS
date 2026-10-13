# Emergency recovery runbook: lucashome down while the shops keep selling

**PRIVATE.** This document names the server, its paths and its procedures. It
is not part of the sanitized public branch.

Status 2026-10-13 (UTC). Written against schema 080, client 1.0.16 (branch
`feature/selfhost-supabase-migration`), lucashome stack in
`/srv/supabase/stack`. Every claim marked **TESTED** has evidence in §8. No
destructive step in this runbook was performed on lucashome while writing it:
the server-side recovery options (§5) cite earlier drills and are otherwise
unexercised here.

Related: [release compatibility + earlier emergency notes](release-compatibility.md#emergency-procedure--lucashome-fails-after-go-live) ·
[offline authorisation](../phase-d/offline-authorization.md) ·
[idempotency contract](../phase-d/idempotency-contract.md) ·
[backup README](../../../deploy/lucashome/backup/README.md) ·
[WAL archiving / PITR](../../../deploy/lucashome/backup/WAL-ARCHIVING.md) ·
[offsite enable](../../../deploy/lucashome/backup/OFFSITE-ENABLE.md) ·
[e2e results](../phase-e/e2e-results.md).

---

## 0. One-page summary

| Time since the server stopped answering | Tills | Who | Action |
|---|---|---|---|
| 0–15 min | keep selling; sales queue as PENDING receipts | shop staff | nothing; do not restart, sign out or reinstall |
| **15 min** | | engineer | §2 diagnose (Tailscale, host, containers) |
| **1 h** | | engineer → owner | report cause + ETA; inspect one till's queue (§4) |
| **2 h** (operational maximum before escalation) | | owner | decide: keep trading offline / restore from backup (§5.3) / prepare paper fallback |
| **8 h** | | owner + shop managers | paper receipts ready; export every till's queue (§4.3) |
| **12 h** (hard stop, enforced by the app) | **new sales refused** on each till 12 h after its last successful contact | shop managers | switch to paper; tills stay ON with their queue |
| 24 h | till signs out on next boot; queue kept | engineer | server must be back or rebuilt (§5.4) before staff sign in again |

Never (§6): point tills at hosted Supabase, publish or install a v1.0.15-based
build, downgrade a till, clear a till's app data, or restore over a database
while tills still hold unsynced sales without accepting that their replays
will execute fresh.

---

## 1. How the system behaves in an outage (what the design guarantees)

- **Offline-first tills.** A sale that cannot reach the server is written to
  the till's IndexedDB (`shwe-phala-local`, store `syncOutbox`) with its own
  idempotency key and its ring-up time, and shown as receipt `PENDING`. The
  queue survives app restarts, OS restarts and offline boots (B4, B5).
- **Exactly once on reconnect.** The till retries with the same key; the
  server's `idempotency_keys` ledger returns the stored result for a key it has
  already committed, so a lost response or a replay never makes a second sale
  (B2, B9, B10, **B13**). The consistency gate checks every sale against that
  ledger (§7).
- **Retry cadence.** A drain runs on every reconnect event and every 30 s,
  with exponential backoff per entry (1 s doubling, capped at 5 min, ±20 %
  jitter). After a long outage the first successful drain can therefore come
  up to ~5 min after the server returns, without anyone touching the till
  (B13 measured it).
- **Sales keep their time.** `p_created_at` is the ring-up time; the server
  keeps it if it is within 48 h in the past (`resolve_event_time`, 045), so
  reports and receipt numbering are by sale time, not sync time (B13).
- **Bounded offline authority** (`OFFLINE_WRITE_TRUST_MS = 12 h`,
  `OFFLINE_SESSION_TRUST_MS = 24 h`, counted from the till's last successful
  server contact): writes refused after 12 h, read-only until 24 h, then
  signed out on the next boot. The queue is never deleted by these limits
  (C1, C2).
- **What does not work while the server is down:** everything online-only
  (new staff, catalogue/price edits, purchase approvals, refund approvals,
  phone image upload, reports across tills, Realtime stock updates between
  tills). Stock shown on a till is its own last snapshot minus its own queued
  sales: two tills can sell the same last unit; the server resolves it on
  replay (the later replay is refused as a conflict, B8 shows the online
  equivalent) and the conflict appears on the Sync Conflicts page.

## 2. Diagnose (T+15 min, engineer)

From the Mac (read-only):
```sh
tailscale status | grep lucashome            # node online? last seen?
tailscale ping -c 3 lucashome
ssh -o ConnectTimeout=10 lucashome 'uptime; df -h / /srv | tail -2'
ssh lucashome 'cd /srv/supabase/stack && docker compose ps --format "{{.Service}} {{.Status}}"'
ssh lucashome '/srv/supabase/backup/bin/backup-status.sh | head -40'   # archiver, last base, last dump
curl -s -o /dev/null -w '%{http_code}\n' https://lucashome.tail8a86e4.ts.net/auth/v1/health
```
Status page: status.cyfrosec.com is a different system; the POS has no public
status page. Write every step with its UTC time into
`docs/selfhost-migration/evidence/G13/cutover-log.md` (or the incident file).

| Finding | Go to |
|---|---|
| Node offline in Tailscale, host unreachable | house power / WAN / the machine itself (owner on site); tills keep selling |
| Host up, one container unhealthy / exited | §5.1 |
| Database refuses connections, data directory intact | §5.1 (db restart), then §5.2 if it does not come up |
| Data damaged / wrong data written (bad migration, accidental delete) | §5.3 |
| Host lost (disk, theft, fire) | §5.4 (**gap: no offsite copy yet**) |
| Shops' internet down, server fine | nothing server-side; tills drain on reconnect |

## 3. Tills during the outage (shop staff, from T+0)

Tell every shop, in this order:
1. **Keep selling.** A `PENDING` receipt is a valid sale; it gets its real
   number when the till reconnects. Do not ring a sale up twice "to be sure".
2. **Do not** sign out, uninstall, reinstall, "clear app data", or install any
   update someone sends. Restarting the till is safe (the queue survives) but
   only needed if the app hangs.
3. Keep the till powered and on the same Windows account.
4. Note the time of the first PENDING receipt per till (the 12 h clock runs
   from the last *successful* contact, which is earlier).
5. Refunds/voids requested offline are queued too; approvals wait for the server.

**TESTED (B13, 2026-10-13):** API refused on two tills for 4 min while both
kept trading (6 sales including the same basket twice in a row on one till,
attempts with backoff during the outage, 0 sales landing); after the API came
back, both drained on their own; 6 keys → 6 distinct sales, stock = before −
sold, consistency gate PASS. Earlier evidence for shorter or different
outages: B1 (offline before checkout), B2 (cut after commit), B3 (prolonged
offline incl. shift close), B4 (app killed with a queue), B5 (offline boot),
B9 (gateway 503), B10 (database unavailable, simulated) — results in
[e2e-results](../phase-e/e2e-results.md).

## 4. The pending queue: never lose it

### 4.1 Rules

- A till's queue is the **only** copy of its unsynced sales. Nothing on the
  server knows about them.
- **Never downgrade a till** (v1.0.15 code deletes every queued entry on its
  first online load — release-compatibility §5, observed in Electron).
- **Never redirect a till** to another backend (hosted, a staging stack, a
  differently named rebuild): entries carry no record of the backend they were
  queued for and would be replayed there (release-compatibility §5).
- Before **any** intervention on a till (reinstall, Windows repair, moving the
  till, a new build), export its queue first (§4.3) and keep the export with
  the incident.

### 4.2 Look at the queue (no export)

- Sidebar badge on the till: "N actions waiting to sync"; offline badge.
- ADMIN on that till: **Sync Conflicts** page (`/app/admin/sync-conflicts`):
  conflicts needing action + entries still syncing.

### 4.3 Export a till's queue (manual; the app has no export button yet)

**Cold copy first** (always, before anything else; app closed):
- Windows: copy the whole folder `%APPDATA%\retails-shop\` (contains
  `IndexedDB\file__0.indexeddb.leveldb\`, `Local Storage\`, logs) to a USB
  stick / the Mac, named `<shop>-<till>-<UTC time>`.
- macOS: `~/Library/Application Support/retails-shop/`.
This copy can be put back byte-for-byte into the same path on the same or a
replacement machine with the same build, and the queue reappears.

**Readable export** (app open, signed in, any role):
1. `Ctrl+Shift+I` (macOS `Cmd+Alt+I`) or menu View → Toggle Developer Tools
   (the default Electron menu is present in the packaged build).
2. Console, paste:
   ```js
   (async () => {
     const db = await new Promise((ok, ko) => { const r = indexedDB.open("shwe-phala-local"); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
     const all = (s) => new Promise((ok) => { if (!db.objectStoreNames.contains(s)) return ok([]); const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => ok(q.result); });
     const out = { exportedAt: new Date().toISOString(), outbox: await all("syncOutbox"), syncState: await all("syncState"),
       pendingSales: (await all("sales")).filter((s) => s.pendingSync), pendingShifts: (await all("shifts")).filter((s) => s.pendingSync),
       idMap: await all("provisionalIdMap") };
     copy(JSON.stringify(out, null, 1));   // DevTools helper: puts it on the clipboard
     return `${out.outbox.length} outbox entries, ${out.pendingSales.length} pending sales copied`;
   })();
   ```
3. Paste into a text file next to the cold copy. It contains sale lines,
   amounts, shift ids and idempotency keys; no passwords or tokens (the auth
   session lives in Local Storage, which this snippet does not read).
4. DevTools → Application → IndexedDB → `shwe-phala-local` → `syncOutbox`
   shows the same rows for a visual check (status `pending` / `failed` /
   `conflict`, `attempts`, `lastError`, `idempotencyKey`).

**Proposed feature** (not built): "Export queue" on the Sync Conflicts page
that writes the JSON above through the main process (`dialog.showSaveDialog`),
plus a boot guard that refuses to run `loadData` on a build older than the
database's schema when the outbox is non-empty (release-compatibility §5,
safeguards 2–3). Until it exists, §4.3 is the procedure.

## 5. Server-side recovery options, in this order

Owner approval before each step (memory rule: confirm before prod changes).
Prefer the least invasive option that restores service.

### 5.1 Restart the failed service(s)

```sh
ssh lucashome 'cd /srv/supabase/stack && docker compose ps'
ssh lucashome 'cd /srv/supabase/stack && docker compose logs --since 30m <service> | tail -100'
ssh lucashome 'cd /srv/supabase/stack && docker compose restart <service>'   # one service
ssh lucashome 'cd /srv/supabase/stack && docker compose up -d'               # anything exited
```
No data is touched. Tills drain on their own within ~5 min (backoff cap); a
till that shows "N waiting" for longer: open the Sync Conflicts page and press
Retry, or restart the app (B4: the queue drains on boot).
Not exercised on lucashome for this runbook (no restarts allowed); the client
side of exactly this recovery is TESTED (B9/B10/B13).

### 5.2 Database will not start but the data directory is intact

Read `docker compose logs db`; disk full (`df -h /srv`) is the usual cause —
free space (old `restore-test/` temp dirs, docker images), never by deleting
anything under `volumes/db/data` or `backups/wal_archive`. Then `docker
compose up -d db`.

### 5.3 Restore from the local base backup + WAL (PITR)

When: data is damaged or wrong, the host is fine. Procedure:
[backup README §B / §B2](../../../deploy/lucashome/backup/README.md) (stop app
services, move the bad PGDATA aside — do not delete it —, restore the newest
good base, add `recovery.signal` + `restore_command` +
`recovery_target_time` = last good moment, start `db`, validate against
`counts.json` and the newest hourly dump, then start the rest).

Evidence: PITR drill `pitr-test.sh` on 2026-10-11 restored base
`20261011T235750Z` + archive to T1 in a throwaway: only pre-T1 rows, new
timeline, **9 s end to end**; weekly `restore-test.sh` restores the newest base
and dump into throwaways ([WAL-ARCHIVING §4 results](../../../deploy/lucashome/backup/WAL-ARCHIVING.md);
G4 restoration evidence). RPO ≤ `archive_timeout` (300 s) + archive time
(0.1–0.3 s measured). PITR window ≈ 14 days (base retention).

Interaction with the tills:
- Same host name, same JWT secret, same anon key → the pinned 1.0.16 builds
  reconnect without a new release.
- Sales committed **before** the restore point: their keys are in the
  restored ledger → a replay returns the stored result (no duplicate).
- Sales committed **after** the restore point but already drained (the till
  deleted them from its queue): **lost from the database**, and the till will
  not resend them. Recover them from the newest hourly logical dump if it is
  newer than the target, or re-key them from the receipts. So pick the latest
  safe `recovery_target_time`, and compare `sales` per shop/day with the last
  dump before letting tills drain.
- Sales still queued on tills: replayed after the restore and executed fresh
  (their keys are unknown to the restored ledger), which is the desired
  result. Stock is re-derived by the RPCs.
- After the restore, before opening to tills: run §7 queries.

### 5.4 Rebuild the host from offsite — **GAP: not possible today**

Offsite backups are **disabled** (`offsite: disabled`; R2 bucket not
configured; `offsite-restore-test.sh` commented out in the crontab). If the
host is lost today, the only copies are: the Mac pull tier (`MAC-TIER.md`:
**not installed** as of 2026-10-12, so in practice none), the Mac golden migration workspace (hosted export of
2026-10-11, **pre-go-live data only**), and the tills' queues. Required to
close the gap (owner): enable offsite per
[OFFSITE-ENABLE](../../../deploy/lucashome/backup/OFFSITE-ENABLE.md) (§8.2 is
the rebuild procedure: same Tailscale name — retire the dead node first so
MagicDNS hands the name over —, same TLS name, same JWT secret / anon key from
the secrets bundle), and run one offsite restore drill and record the RTO.

### 5.5 After any recovery

1. Let **one** till drain first; check §7 queries; then the rest.
2. Watch the Sync Conflicts page on each till; resolve conflicts with the shop
   (oversold last units, shifts closed meanwhile).
3. Close the incident in `docs/lucashome-selfhost/incidents.md`.

## 6. Never

| Never | Why |
|---|---|
| Point tills (or publish a build) at hosted Supabase | Hosted lacks 062–080; 1.0.16 fails closed there (30/30 RPCs `PGRST202`) and the till becomes unusable; queued sales would be parked as conflicts against the wrong backend; hosted has no data since go-live (release-compatibility §3) |
| Publish or install a v1.0.15-based build ("rollback") on tills that ran 1.0.16 | Its first online load deletes every queued entry, its own and 1.0.16's, without sending them (observed, release-compatibility §5 step 9); the auto-updater would install a published 1.0.17 on every till at next restart |
| Downgrade any till with unsynced transactions | Same deletion; Dexie opens the newer database without error, so nothing warns |
| Clear app data / reinstall a till before exporting its queue (§4.3) | The queue is the only copy |
| Restore the database without deciding what happens to sales after the restore point (§5.3) | Already-drained sales after the target are not resent by the tills |
| Edit tills' clocks or the offline windows to "buy time" | The 12 h / 24 h bounds are the revocation guarantee; extending them by hand is not supported |
| Change `UPLOAD_SIGNED_URL_EXPIRATION_TIME`, compose files or `.env` during an incident without a written change | Not needed for recovery; adds a second variable |

## 7. Verification queries after recovery (read-only)

Run as `supabase_admin` (`docker compose exec -T db psql -U supabase_admin -d
postgres -At </dev/null` with the SQL copied in). They are the server-side
half of the e2e consistency gate (`e2e/helpers/saleLedger.ts`).

```sql
-- 1. every sale has exactly one committed complete_sale key (since 062 a sale cannot be made without one)
SELECT 'sales without a key', count(*) FROM sales s
 WHERE s.created_at > now() - interval '3 days'
   AND NOT EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.rpc = 'complete_sale' AND k.response->'sale'->>'id' = s.id);
-- 2. every committed key still has its sale (a key without its sale = a lost sale, e.g. after a PITR)
SELECT 'keys without their sale', count(*) FROM idempotency_keys k
 WHERE k.rpc = 'complete_sale' AND k.response IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = k.response->'sale'->>'id');
-- 3. one client operation applied twice (same cashier, shift and ring-up time)
SELECT 'same operation twice', cashier_id, shift_id, created_at, count(*) FROM sales
 GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;
-- 4. receipt numbers unique per shop
SELECT 'duplicate receipt', shop_id, receipt_no, count(*) FROM sales GROUP BY 1, 2, 3 HAVING count(*) > 1;
-- 5. stock never negative
SELECT 'negative stock', count(*) FROM inventory WHERE qty_base_units < 0;
```
Expected: 0 / 0 / no rows / no rows / 0. Note (1) covers only the last 30
days at most: `prune_idempotency_keys()` deletes keys older than 30 days (not
scheduled on lucashome today).

## 8. Evidence (2026-10-13 run)

| What | Result | Where |
|---|---|---|
| B13 long outage, two tills, restore | API refused 240 s on both tills (navigator online; 26 + 19 refused requests); A queued 3 (same basket twice in a row), B queued 3; max 7 attempts per entry (backoff), 0 sales landed; after restore both drained **on their own in 74 s**; 6 keys → 6 distinct sales (3 + 3), stock prod1 −4 / prod2 −2, ring-up times kept (synced 55–235 s later); consistency gate PASS | `e2e/b-failures.e2e.ts` B13 (run 2026-10-13) |
| Consistency gate proof (E1–E3) | distinct identical-basket queued sales PASS; forged duplicate row and same-operation-under-new-key FAIL; reverted → PASS | `e2e/e-consistency-gate.e2e.ts`, `e2e/helpers/saleLedger.test.ts` |
| Offline windows | C1 11 h write ok / 13 h refused, queue kept; C2 23 h read ok / 25 h signed out, queue kept and drained after sign-in | `e2e/c-offline-auth.e2e.ts` |
| PITR | 2026-10-11 drill, 9 s, rows at target only | `deploy/lucashome/backup/WAL-ARCHIVING.md` |
| Offsite rebuild | **not tested — disabled** | §5.4 |
| Service restart on lucashome | not exercised (no restarts permitted during this verification) | §5.1 |
