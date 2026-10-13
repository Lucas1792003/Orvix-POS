# QA cleanup manifest — PROPOSED, NOT EXECUTED (2026-10-13)

Private. Built read-only from the self-hosted database at schema 081 (`scratchpad/qa-manifest.sql`). Nothing below has been run. Execution needs explicit owner approval, a fresh verified base backup + LSN on the day, and the guarded transaction in §4 (it aborts unless every count matches exactly).

Scope approved for **proposal** by the owner: (1) the two stock adjustments labelled "Testing", (2) expired disposable two-factor codes, (3) expired, unreferenced upload sessions. **Kept pending review:** the three other stock adjustments, the 7 unlinked login accounts, the cashier and manager accounts, all 81 audit entries, all business data.

## 1. Stock adjustments labelled "Testing" — 2 rows (`public.inventory_movements`)
| id | created (UTC) | product | qty | before → after | reason | audit refs | stock now |
|---|---|---|---|---|---|---|---|
| `move-fe7fb6c321414d119cbb39425b5b7201` | 2026-06-10 09:01 | sunday coffee | +32 | 0 → 32 | Testing | 0 | 0 |
| `move-57b5faf8d4344018a9649c8c2ff124d1` | 2026-06-10 10:02 | sunday coffee | +90 | 0 → 90 | Testing | 0 | 0 |

Dependencies: no foreign key points at `inventory_movements`; no trigger on the table; no audit entry references either id; `reference_id` empty. Removing them does not change `inventory` (already 0 for that product; movements are history, not the balance). The three "Manual adjustment" rows (`move-de1473dd…`, `move-cbff9b99…`, `move-9aff3d3d…`) are **kept**.

## 2. Expired two-factor email codes — 15 rows (`public.admin_login_codes`)
All created 2026-06-14 15:03 … 2026-06-15 04:57 UTC, each expired 10 minutes later (only a hash of the code is stored). Dependencies: no foreign key points at the table; its own FK to `auth.users` is ON DELETE CASCADE in the other direction, so removing codes does not touch accounts; no trigger. The admin-2fa function only reads unexpired, unconsumed codes.

## 3. Expired, unreferenced upload sessions — 21 rows (`public.product_image_upload_sessions`)
Criteria (all must hold): status ≠ COMPLETED, `expires_at` in the past, **no storage object at `storage_path`**, no product `image_url` ending in that path, no audit entry referencing the id. 19 CANCELED + 1 EXPIRED + 1 PENDING.

| id | status | created | had product |
|---|---|---|---|
| `pimg-d691ae6ec9e34a3abc4b194dff63dfee` | CANCELED | 2026-06-10 | no |
| `pimg-37c78c008d984af58aa912541abd3b14` | CANCELED | 2026-06-10 | no |
| `pimg-0ffe8573dde846e2978e9dcfef89dee6` | CANCELED | 2026-06-15 | no |
| `pimg-3ffb094f68884f7ea14896b2d1d4eddf` | CANCELED | 2026-06-15 | no |
| `pimg-aa861c572efe404a8399ca558713b140` | CANCELED | 2026-06-15 | no |
| `pimg-ad169734f89d4fd39a73406d960c9e8d` | CANCELED | 2026-06-15 | no |
| `pimg-745f9d7e2bdd45359e67e4fc1c2838b3` | CANCELED | 2026-06-15 | no |
| `pimg-a66429cdbcf14b31a5a0ba2522fefcfc` | CANCELED | 2026-06-15 | no |
| `pimg-c811d14226e844bfa906b75ae1adfeee` | CANCELED | 2026-06-21 | no |
| `pimg-5843f8704f2047628f88fe62f3b1da86` | CANCELED | 2026-06-22 | no |
| `pimg-746f17413e734941b157bcb280d13c55` | CANCELED | 2026-06-25 | no |
| `pimg-ef6a8b373a7b4076bd1d5109fe8272ba` | CANCELED | 2026-06-27 | no |
| `pimg-bf20dc69b6b543f1a13bc6f2148c696d` | CANCELED | 2026-06-30 | no |
| `pimg-3920fc173147443abc1c04472070f115` | EXPIRED | 2026-06-30 | no |
| `pimg-cfd45d102aa84c2a979c0827a8ea8b9a` | CANCELED | 2026-07-02 | no |
| `pimg-ef7b7d1666884d7292c0b56846cde1b3` | CANCELED | 2026-07-03 | yes |
| `pimg-0976807e8d094d0286f2947de07dca5d` | CANCELED | 2026-08-16 | no |
| `pimg-bf8d834ffbc54a82b7be67f89b1f2526` | CANCELED | 2026-08-16 | no |
| `pimg-fdbcf07c191e46b99db185d91742116f` | CANCELED | 2026-08-17 | no |
| `pimg-ba1b4e3f4cc740c69719e25512b890f0` | CANCELED | 2026-08-17 | yes |
| `pimg-876d7c3dc3984a25ab2c4426f04e7666` | PENDING | 2026-08-17 | yes |

**Kept (referenced):** `pimg-8be2942382e54cb8ba3cdc3c34b7d4e4` (CANCELED, 2026-06-13) — a storage object still exists at its `temp/` path; migration 078 authorizes legacy `temp/` objects through their session row, so deleting the session would orphan that object's authorization. All 556 COMPLETED sessions are kept (history behind the product images).

Dependencies: no foreign key points at the table; no trigger; outgoing FKs (shop, product, creator) are unaffected by deleting session rows.

## 4. Guarded execution script (for later approval — do not run now)
```sql
BEGIN;
DO $$
DECLARE n int;
BEGIN
  -- 1. "Testing" stock adjustments
  DELETE FROM public.inventory_movements
   WHERE id IN (
    'move-fe7fb6c321414d119cbb39425b5b7201',
    'move-57b5faf8d4344018a9649c8c2ff124d1')
     AND reason = 'Testing' AND type = 'ADJUSTMENT'
     AND NOT EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.entity_id = inventory_movements.id);
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 2 THEN RAISE EXCEPTION 'movements: expected 2, got %', n; END IF;

  -- 2. expired 2FA codes
  DELETE FROM public.admin_login_codes
   WHERE id IN (
    'c77d2cb0-fe9a-4e69-9687-9243771c5491',
    '30e0a69f-c311-4b0a-a71c-2084749986e0',
    '97b91351-b379-42a9-b68c-e9c35db8a92a',
    '0fc4133c-794b-495e-82e6-e0cc4ed27a1d',
    'b3407e06-86ee-40fd-a716-0acee0caa94d',
    '74d568e1-959e-46e2-9671-d7da222b4b1c',
    '88cc969a-9bc6-4986-a803-7d36dc0cc54d',
    '965bd37c-a076-41fc-a8ef-4aca89c4492b',
    '025772c9-7418-42e3-a2b5-362424a5c74f',
    '2c735b9d-fcae-4844-b65f-a536af34b80b',
    'c310fa1e-d259-4191-8d87-3fc52c271623',
    'b3783540-3d8f-402b-9ecd-77934f492659',
    '684f1c71-a918-4bef-b7d6-f79985e83116',
    '8a2d7999-2200-431a-ae4a-bd41280aeb88',
    '8c3e9f36-c2ad-4223-b04a-1017a61ddbc9')
     AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 15 THEN RAISE EXCEPTION 'login codes: expected 15, got %', n; END IF;

  -- 3. expired, unreferenced upload sessions
  DELETE FROM public.product_image_upload_sessions s
   WHERE s.id IN (
    'pimg-d691ae6ec9e34a3abc4b194dff63dfee',
    'pimg-37c78c008d984af58aa912541abd3b14',
    'pimg-0ffe8573dde846e2978e9dcfef89dee6',
    'pimg-3ffb094f68884f7ea14896b2d1d4eddf',
    'pimg-aa861c572efe404a8399ca558713b140',
    'pimg-ad169734f89d4fd39a73406d960c9e8d',
    'pimg-745f9d7e2bdd45359e67e4fc1c2838b3',
    'pimg-a66429cdbcf14b31a5a0ba2522fefcfc',
    'pimg-c811d14226e844bfa906b75ae1adfeee',
    'pimg-5843f8704f2047628f88fe62f3b1da86',
    'pimg-746f17413e734941b157bcb280d13c55',
    'pimg-ef6a8b373a7b4076bd1d5109fe8272ba',
    'pimg-bf20dc69b6b543f1a13bc6f2148c696d',
    'pimg-3920fc173147443abc1c04472070f115',
    'pimg-cfd45d102aa84c2a979c0827a8ea8b9a',
    'pimg-ef7b7d1666884d7292c0b56846cde1b3',
    'pimg-0976807e8d094d0286f2947de07dca5d',
    'pimg-bf8d834ffbc54a82b7be67f89b1f2526',
    'pimg-fdbcf07c191e46b99db185d91742116f',
    'pimg-ba1b4e3f4cc740c69719e25512b890f0',
    'pimg-876d7c3dc3984a25ab2c4426f04e7666')
     AND s.status <> 'COMPLETED' AND s.expires_at < now()
     AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'product-images' AND o.name = s.storage_path)
     AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.image_url LIKE '%' || s.storage_path)
     AND NOT EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.entity_id = s.id);
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 21 THEN RAISE EXCEPTION 'upload sessions: expected 21, got %', n; END IF;
END $$;
-- expected after: inventory_movements 3, admin_login_codes 0, product_image_upload_sessions 557
SELECT (SELECT count(*) FROM public.inventory_movements) AS movements,
       (SELECT count(*) FROM public.admin_login_codes)   AS login_codes,
       (SELECT count(*) FROM public.product_image_upload_sessions) AS sessions;
COMMIT;   -- or ROLLBACK if any number differs
```

## 5. Procedure when approved
1. `backup-base.sh` + record LSN in `migration-checkpoints.txt`; `backup-status.sh` OK.
2. Fingerprint before (`deploy/lucashome/backup/dr-drill-fingerprint.sql`).
3. Run §4 as `postgres` inside the db container (`-v ON_ERROR_STOP=1`, single transaction).
4. Fingerprint after: only `inventory_movements`, `admin_login_codes`, `product_image_upload_sessions` may differ; storage 574/574; 17 orphans byte-identical; audit_logs unchanged (81).
5. Rollback: restore those three tables' rows from the pre-cleanup logical dump (`pg_restore --data-only -t <table>` into a scratch DB, then copy the rows back), or PITR to the recorded LSN if needed.

## 6. Dry run on a throwaway copy (2026-10-13 11:36 UTC) — live database untouched
The §4 script was run twice inside a throwaway container restored from base backup `20261013T110121Z` (`--network none`, removed afterwards; helper `scratchpad/qa-dryrun.sh` using `backup-lib.sh` tw_* functions).

| | movements | login codes | upload sessions | audit_logs | storage objects | products |
|---|---|---|---|---|---|---|
| before | 5 | 15 | 578 | 81 | 574 | 539 |
| after run 1 (committed in the throwaway) | 3 | 0 | 557 (556 COMPLETED + the 1 kept session) | 81 | 574 | 539 |
| run 2 | refused: `movements: expected 2, got 0` → transaction aborted, nothing changed | | | | | |

Throwaway container and directory removed (0 left).
