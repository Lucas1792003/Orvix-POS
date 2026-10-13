-- dr-drill-consistency.sql — read-only transaction-consistency checks after a restore.
-- Output: <check>|<value>. Every line whose check does not start with "info:" must be 0.
-- Sources: emergency-recovery-runbook.md §7 (q1-q5), e2e/helpers/saleLedger.ts (key ledger,
-- one operation -> one sale, unique receipts), tools/selfhost-migration/sql/post_restore_checks.sql
-- (orphans), plus a generic check of EVERY foreign key in public/auth/storage.
\set ON_ERROR_STOP 1
SET timezone = 'UTC';

-- runbook §7
SELECT 'q1 sales without a committed complete_sale key (last 3 days)', count(*) FROM public.sales s
 WHERE s.created_at > now() - interval '3 days'
   AND NOT EXISTS (SELECT 1 FROM public.idempotency_keys k WHERE k.rpc = 'complete_sale' AND k.response->'sale'->>'id' = s.id::text);
SELECT 'q2 committed complete_sale keys without their sale', count(*) FROM public.idempotency_keys k
 WHERE k.rpc = 'complete_sale' AND k.response IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.id::text = k.response->'sale'->>'id');
SELECT 'q3 same client operation applied twice (groups)', count(*) FROM (
  SELECT 1 FROM public.sales GROUP BY cashier_id, shift_id, created_at HAVING count(*) > 1) x;
SELECT 'q4 duplicate receipt numbers per shop (groups)', count(*) FROM (
  SELECT 1 FROM public.sales GROUP BY shop_id, receipt_no HAVING count(*) > 1) x;
SELECT 'q5 negative stock rows', count(*) FROM public.inventory WHERE qty_base_units < 0;

-- saleLedger.ts key ledger, all time
SELECT 'ledger: sales claimed by more than one key', count(*) FROM (
  SELECT k.response->'sale'->>'id' FROM public.idempotency_keys k
   WHERE k.rpc = 'complete_sale' AND k.response->'sale'->>'id' IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'info: sales (all time)', count(*) FROM public.sales;
SELECT 'info: complete_sale keys with a response', count(*) FROM public.idempotency_keys WHERE rpc = 'complete_sale' AND response IS NOT NULL;
SELECT 'info: sales without a key (all time; pre-062 hosted-era sales have none)', count(*) FROM public.sales s
 WHERE NOT EXISTS (SELECT 1 FROM public.idempotency_keys k WHERE k.rpc = 'complete_sale' AND k.response->'sale'->>'id' = s.id::text);
SELECT 'sale_items without their sale', count(*) FROM public.sale_items si LEFT JOIN public.sales s ON s.id = si.sale_id WHERE s.id IS NULL;

-- post_restore_checks.sql orphan block
SELECT 'orphans: users.auth_id -> auth.users', count(*) FROM public.users u LEFT JOIN auth.users au ON au.id::text = u.auth_id::text
 WHERE u.auth_id IS NOT NULL AND au.id IS NULL;
SELECT 'orphans: auth.identities -> auth.users', count(*) FROM auth.identities i LEFT JOIN auth.users au ON au.id = i.user_id WHERE au.id IS NULL;
SELECT 'orphans: auth.sessions -> auth.users', count(*) FROM auth.sessions s LEFT JOIN auth.users au ON au.id = s.user_id WHERE au.id IS NULL;
SELECT 'orphans: auth.mfa_factors -> auth.users', count(*) FROM auth.mfa_factors f LEFT JOIN auth.users au ON au.id = f.user_id WHERE au.id IS NULL;

-- every foreign key (MATCH SIMPLE: rows with a NULL in the key are exempt): violating rows
SELECT 'info: foreign keys checked', count(*) FROM pg_constraint
 WHERE contype = 'f' AND connamespace IN ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace);
SELECT 'foreign keys not validated', count(*) FROM pg_constraint
 WHERE contype = 'f' AND NOT convalidated AND connamespace IN ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace);
SELECT format('SELECT %L, count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
         'fk ' || con.conrelid::regclass || ' ' || con.conname,
         con.conrelid::regclass,
         (SELECT string_agg(format('c.%I IS NOT NULL', a.attname), ' AND ')
            FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k),
         con.confrelid::regclass,
         (SELECT string_agg(format('p.%I = c.%I', pa.attname, ca.attname), ' AND ')
            FROM unnest(con.conkey, con.confkey) AS u(ck, fk)
            JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = u.ck
            JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = u.fk))
  FROM pg_constraint con
 WHERE con.contype = 'f' AND con.connamespace IN ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace)
 ORDER BY 1
\gexec
