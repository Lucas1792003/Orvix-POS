# Phase F · Export pending transactions + queue recovery tool

Status 2026-10-13 (UTC): implemented on a private branch (`feature/queue-export`,
from `feature/selfhost-supabase-migration`), not released, no schema change.
Replaces the DevTools console snippet of the
[emergency runbook §4.3](../phase-g/emergency-recovery-runbook.md#43-export-a-tills-queue).

| Piece | Where |
|---|---|
| Format, encryption, validation (shared by app and tool) | `src/lib/queueExport/format.ts` |
| Read-only collection from the till's IndexedDB | `src/lib/queueExport/collect.ts` |
| Export orchestration (secret check, encrypt, save) | `src/lib/queueExport/exportQueue.ts`, `src/lib/tillId.ts` |
| Dialog + entry points | `src/components/sync/ExportQueueDialog.tsx`, `AppLayout.tsx`, `SyncConflictsPage.tsx`, `LoginPage.tsx` |
| Narrow save IPC (main process writes) | `electron/main.cjs` (`queue-export:save`), `electron/preload.cjs` (`saveQueueExport`) |
| Strings (English + Myanmar) | `src/i18n/translations.ts` section `queueExport` |
| Recovery tool | `tools/queue-recovery/cli.ts`, `tools/queue-recovery/replay.ts` |
| Disposable restore drill | `tools/queue-recovery/disposable/run.sh` |
| Tests | `src/lib/queueExport/*.test.ts`, `tools/queue-recovery/replay.test.ts`, `e2e/f-queue-export.e2e.ts` |

## 1. What staff see, and who can use it

| Entry point | Shown when | Who |
|---|---|---|
| **Export pending** pill in the bottom-right badge stack (next to "N actions waiting to sync") | the queue holds anything (pending or conflict) | **every signed-in role**, online or offline, including the read-only window (12–24 h offline) |
| **Export pending transactions** button on Sync Conflicts | the page lists entries | ADMIN (the page's existing permission) |
| "This till still holds N transactions … **Export them (encrypted)**" on the login page | the queue is non-empty | anyone at the till, **signed out** |

The dialog shows counts only (total, per status), asks for a passphrase twice
(≥ 10 characters, not stored anywhere), encrypts, and opens the native save
dialog (default folder: Documents; default name
`pending-queue-<till id>-<YYYYMMDD-HHMMSS>Z.spqx`). Afterwards it shows the
path and says that nothing was removed. In the browser terminal (no Electron)
the same encrypted file is offered as a download.

**Access decision.** No manager PIN exists in the app and adding one is out of
scope, so the choice was between "signed-in only" and "also signed out":

- Signed in (any role): the normal path. The outage case is a cashier on an
  offline till, so it must not need the network, an ADMIN, or a page the role
  cannot open.
- Signed out: kept, deliberately. After 24 h without server contact the till
  signs out on the next boot and **cannot sign in again until the server is
  back**; that is exactly when the queue most needs to leave the machine.
  The export reveals nothing a person at the unlocked Windows session cannot
  already read: the queue sits unencrypted in the app profile (cold copy,
  runbook §4.3) and the packaged build has DevTools. The file itself is
  encrypted with the passphrase the operator types, and it never contains
  credentials (§3). The export is read-only, so it cannot be abused to change
  or drop anything.

## 2. File format (version 1)

One UTF-8 JSON object (`.spqx`):

```jsonc
{
  "format": "shwephala-queue-export",
  "formatVersion": 1,
  "encrypted": true,
  "header": {                         // clear, counts only
    "appVersion": "1.0.16", "exportedAt": "2026-10-13T06:25:58.768Z", "tillId": "till-eecc3f5a83",
    "summary": { "total": 4, "byStatus": { "pending": 4 }, "byOpType": { "open_shift": 1, "complete_sale": 3 } }
  },
  "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<16 bytes, base64>" },
  "cipher": { "name": "AES-GCM", "keyBits": 256, "tagBits": 128, "iv": "<12 bytes, base64>" },
  "ciphertext": "<base64>"
}
```

- Key = PBKDF2-HMAC-SHA-256(passphrase, salt, 600 000) → AES-256-GCM key
  (WebCrypto in the renderer; WebCrypto in Node for the tool).
- Additional authenticated data = canonical JSON (keys sorted) of
  `{format, formatVersion, encrypted, header, kdf, cipher}`. Any edit to the
  clear part or the ciphertext fails decryption exactly like a wrong
  passphrase. Readers refuse `iterations < 100 000` and newer format versions,
  and check that the clear summary equals the summary of the decrypted entries.
- The main process writes only a string that parses as this envelope with a
  ciphertext and no `entries`/`payload` key at the top level, to the path the
  user picked, mode `0600`, via a temp file + rename.

Decrypted payload (validated with a zod schema on both sides):

| Field | Content |
|---|---|
| `format`, `formatVersion`, `appVersion`, `exportedAt`, `tillId` | as named; `tillId` is a random per-profile id in `localStorage` (`pos-till-id`) |
| `backendHost` | host[:port] the build talks to (never a key) |
| `session` | `userId`, `orgId`, `shopId`, `role` of the signed-in app user (nulls when signed out) |
| `entries[]` | per outbox row, in queue order: `seq`, `opId` (outbox `localId`), `idempotencyKey`, `kind` (`rpc`/`table_write`), `opType` (RPC name or `<table>.<op>`), `table`, `tableOp`, `rowId`, `payload` (RPC args incl. `p_idempotency_key`, or the table row), `refs`, `provisional`, `shopId`, `createdAt` (queued), `ringUpAt` (`p_created_at`), `status`, `attempts`, `lastErrorClass` (`transient`/`permanent`), `lastError` (≤ 500 chars), `nextAttemptAt` |
| `provisionalIdMap[]` | provisional id → server id for parents that already synced (resolves `refs`) |
| `redactedFields` | how many credential-looking keys the serializer blanked (0 in practice) |
| `journal[]` | W8 Phase 0, **owner (ADMIN) exports of their organisation only** (empty in staff and sign-in-screen exports): the till's operation journal (`syncState` `opj:` records) — every financial operation with its key, request and the server's reply, acknowledged ones included, without the `fingerprint` field; credentials blanked as above. Evidence for a reconciliation, never replayed by the tool |
| `vanished[]` | W8 Phase 0, owner exports only: rows a full load no longer returned although the till had loaded them from the server (continuity evidence), of this organisation |

All statuses are exported (`pending`, `syncing`, `failed`, `conflict`), i.e.
everything the server does not have yet.

## 3. Threat model

| Concern | Control |
|---|---|
| Export changes the queue (drops, reorders, marks synced) | Collection is one Dexie transaction in mode `"r"` over `syncOutbox` + `provisionalIdMap` (Dexie rejects writes inside it); rows are copied field by field into new objects; the drain lock is not taken; nothing calls the outbox API. Tested: raw `syncOutbox`/`provisionalIdMap`/`syncState`/`authCache` contents byte-identical before/after (unit + e2e), drain afterwards sends the same keys in the same order. The only write anywhere is the till id in `localStorage`, once per profile. |
| Credentials in the file | (1) allowlist serializer — only the outbox fields above (plus, in an owner's export, the `opj:` journal / `opjv:` evidence records of `syncState`); the auth session (localStorage), `authCache` and the rest of `syncState` are not read; (2) any key matching access/refresh/provider/id token, password, passphrase, secret, totp secret/code, api/anon key, service role, jwt, authorization, bearer, cookie, session is replaced by `[REDACTED]` at any depth inside payloads (the tool never replays such an entry); (3) before encrypting, the serialized payload is searched for every credential value the renderer can see (stored session access/refresh/provider tokens, the anon key) and the export **aborts** if one occurs anywhere. Canary tests for all three. |
| A lost/stolen USB stick | AES-256-GCM with a 600k-iteration PBKDF2 key from a passphrase typed at export time and carried separately; the clear part holds counts only. Strength is bounded by the passphrase (≥ 10 characters enforced; staff are told to write it down separately). |
| Tampering with the file (e.g. edited amounts) | GCM tag over ciphertext + clear header: fails as "wrong passphrase or modified". |
| Renderer gaining file-system access | None: the preload exposes one function taking two strings; main validates the envelope, owns the dialog and the path; the sender must be the app window. |
| Replaying into the wrong backend / hosted project | The tool has **no default target** (no env fallback); `*.supabase.co` is refused at argument parsing and by the hosted guard on `fetch`; a host other than the one in the export needs `--confirm-host <host>` typed again; every request is confined to the target origin. |
| Duplicate sales from replay | The tool sends the original key and payload to the same RPC; the server's ledger (`idem_begin`, 062/074) returns the stored response for a key it has. Never mints a key; an entry without its key is not replayed. |
| Replay deletes from the till | The tool never talks to the till; the till's queue drains on its own and receives the stored results. |

Out of scope / residual: someone with the Windows session can read the
unencrypted IndexedDB anyway; the passphrase quality is the operator's; a
replay more than 48 h after ring-up records the sale at replay time
(`resolve_event_time`, 045) — the same as a late till sync.

## 4. Recovery tool

```sh
# inspect: decrypt + validate + summary (no network)
QUEUE_RECOVERY_PASSPHRASE=… npx tsx tools/queue-recovery/cli.ts inspect <file.spqx> [--json]

# plan only: nothing is sent
npx tsx tools/queue-recovery/cli.ts replay <file.spqx> --target https://<backend host> --dry-run

# replay as the user who queued the entries (password from env or hidden prompt)
QUEUE_RECOVERY_ANON_KEY=… [QUEUE_RECOVERY_SERVICE_KEY=…] \
  npx tsx tools/queue-recovery/cli.ts replay <file.spqx> --target https://<backend host> \
  --email <cashier email> --report replay-report.json
```

| Option / env | Meaning |
|---|---|
| `--target <origin>` | **required**, origin only; no default |
| `--confirm-host <host>` | required when the target is not the host the till was built for (e.g. a disposable restore stack) |
| `--dry-run` | resolve order and refs, print the plan, send nothing |
| `--include-conflicts` | also replay entries the till had parked as conflicts (default: skipped and listed) |
| `--fence-unfound` | W10 Phase 0: stop (fence) HELD entries the server has no record of. Without it they are looked up only and reported held (the run stops there): "not found" may mean the server was restored and lost them. An owner's decision only |
| `--rest-prefix` | `/rest/v1` (gateway, default) or `""` for a bare PostgREST |
| `--report <file>` | per-op JSON report (mode 0600) |
| `QUEUE_RECOVERY_PASSPHRASE` / `_PASSWORD` | else hidden prompt |
| `QUEUE_RECOVERY_ACCESS_TOKEN` | bearer token instead of `--email` |
| `QUEUE_RECOVERY_SERVICE_KEY` | optional; used **only** for read-only `GET idempotency_keys?key=eq.…` before each RPC → exact `applied` vs `already-applied`. Without it, `complete_sale` is still classified exactly (sale ids of its shift read before the call) and other RPCs report `accepted` |

Behaviour mirrors the till's drain: queue order by `seq`; `refs` resolved from
the export's id map and from earlier responses (`open_shift` → `shift.id`,
`complete_sale` → `sale.id`, `create_refund_void_request` → `request.id`); a
transient failure (network, 401, 408, 425, 429, 5xx) **stops** the run and
marks the rest `not-attempted` (re-run the same command later); a permanent
rejection (validation, permission, `IDEMPOTENCY_MISMATCH`) is reported and
the run continues; entries depending on a failed one are
`blocked-unresolved-ref`. Outcomes: `applied`, `already-applied`, `accepted`,
`rejected`, `skipped-conflict`, `skipped-redacted`, `blocked-unresolved-ref`,
`not-attempted`, `planned`. Exit 0 = everything replayable succeeded; 2 =
usage/target refused; 3 = not an export / wrong passphrase / tampered; 4 =
something was rejected, blocked or not attempted. Secrets are never printed;
keys are shown as 8-character prefixes (full keys in the report).

Replay as the user who queued the entries: offline-eligible RPCs carry
`p_expected_actor_id` (055) and the ledger is bound to the caller's org (074),
so another user's replay is refused rather than misattributed.

## 5. Test evidence (2026-10-13)

| Test | Result |
|---|---|
| `npx tsc -b`, `npx tsc -p e2e/tsconfig.json`, `npx tsc -p tools/queue-recovery/tsconfig.json` | clean |
| `npm test` (no LIVE env) | **807 passed**, 49 skipped (baseline 774 + 33 new: format 13, collect/export 8, tool 12) |
| `npm run build:electron` (backend env in the process only) | builds |
| Unit: secrets | canaries in the stored session (access/refresh), in queued args (`access_token`, nested `password`, `totp_secret`), and the anon key: absent from the file and from the decrypted payload; a live token pasted into a free-text arg aborts the export with nothing written |
| Unit: crypto | round trip; 600k PBKDF2 / AES-256-GCM / random salt+IV; wrong passphrase; flipped ciphertext byte, edited summary, edited till id, edited iteration count → `decrypt-failed`; iterations below 100k / newer version / non-export refused |
| Unit: queue untouched | raw `syncOutbox`+`provisionalIdMap`+`syncState`+`authCache` identical after two exports and after a cancelled save; drain afterwards sends exactly the exported keys in exported order and resolves the offline shift |
| Unit: ordering | export ordered by `seq` when insertion order, `createdAt` and `localId` disagree |
| Unit: tool | seq order + original keys + refs from responses; second replay all `already-applied`, no new rows; probe mode; transient stop + clean resume; rejection continues and blocks dependants; `IDEMPOTENCY_MISMATCH` rejected not retried; conflicts/redacted/keyless skipped; dry run sends nothing; target rules; origin confinement |
| **E2E F1** (Electron, QA org on the self-hosted stack) | offline: shift opened offline + 3 sales (refs to the provisional shift); app restarted offline; badge → dialog (short passphrase refused) → main-process save in 120 ms; file 0600, envelope as §2, clear part counts only, wrong passphrase rejected; decrypted 4 entries = outbox (seq, key, status), session user/org, backend host; no token / anon key / password / TOTP; outbox+idMap+syncState byte-identical; 0 network requests; 0 sales on the server — PASS |
| **E2E F2** | CLI refused: no `--target` (2), `*.supabase.co` (2), other host without `--confirm-host` (2), wrong passphrase (3); dry run 4 planned / 0 keys; replay #1: 4 applied in seq order (open_shift → real shift, 3 sales on it, ring-up times kept), sales 0→3, stock −2/−1; replay #2: 4 already-applied, 0 new rows; till queue untouched; B13-style outage (API refused 45 s, till online, 110 refused requests, entries kept pending); restore → the till drained the same 4 keys on its own in 8 s and received the stored results (sales still 3, keys 4, no PENDING left); replay #3: 4 already-applied; consistency gate (`saleLedger`) PASS; 0 hosted requests — PASS (spec 1.4 min) |
| **Disposable restore drill** (`tools/queue-recovery/disposable/run.sh` on the F1 export: `phf-qx-db` supabase/postgres 17.6.1.136 + baseline + migrations 062–080, `phf-qx-rest` PostgREST v14.17, both 127.0.0.1, QA tenant re-seeded from the live seeds) | refusals 2/2; dry run 4 planned, 0 keys; replay #1 4 applied (+3 sales, 4 keys); replay #2 4 already-applied, same result ids, 0 new rows; replay #3 without ledger access: 3 sales already-applied; runbook §7 queries all 0, SALE_OUT = items, inventory = seed + movements; ring-up times kept — **0 failures**; containers and network removed |
| `npm run e2e:cleanup` after each e2e run | CLEAN; storage.objects 574 (575 files on disk incl. `.gitkeep`) |
| Regression `e2e/b-failures.e2e.ts` (B1–B13, badge area changed) | 14/14 passed (8.6 min), then cleanup CLEAN, 575 files on disk |

## 6. Run it

```sh
# e2e (environment as in e2e/README.md; one suite at a time, then cleanup)
npx playwright test e2e/f-queue-export.e2e.ts
npm run e2e:cleanup
# disposable restore drill for an export (QA exports only)
BASELINE_SQL=<scrubbed baseline dump> QUEUE_RECOVERY_PASSPHRASE=… \
  bash tools/queue-recovery/disposable/run.sh e2e/.results/queue-export/f1-export.spqx
```
Set `E2E_QX_PASSPHRASE` for the e2e run to reuse the same passphrase for the drill.

## 7. Open issues

- The disposable drill replaces `auth.uid()` in its throwaway database with the
  definition current stacks ship (the `supabase/postgres` test image reads
  only the legacy `request.jwt.claim.sub`); it does not run GoTrue, so it
  replays with a locally minted token (`QUEUE_RECOVERY_ACCESS_TOKEN`). The
  password sign-in path of the tool is exercised by e2e F2 instead.
- `applied` vs `already-applied` with ledger access is decided by a read just
  before the call: if the till syncs the same key in that instant, the tool
  reports `applied` for an operation the till applied. Correctness (one sale)
  is unaffected.
- Table writes (`categories.insert` …) are last-write-wins and carry no
  idempotency key; a replay of an `update` after a newer edit on the server
  overwrites it, exactly as a late till sync would.
- No "Export" when the app cannot boot at all (renderer crash): the cold copy
  of the profile folder (runbook §4.3) stays the fallback.
- Not released: needs the normal release checklist
  (`next-phase/release-checklist.md`) before any till gets it.
