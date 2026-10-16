-- canary-1.0.16-fingerprint.sql — READ-ONLY canary fingerprint (canary-1.0.16-checklist.md §0.4 / §7.1).
-- Run it identically BEFORE the canary (snapshot) and AFTER it (verification); compare the
-- two outputs with `diff` (§7.1). Only counts and md5s leave the database: no row content,
-- no ids, no e-mails (users.id can embed an e-mail).
--
-- A row is a CANARY row when its row text contains 'CANARY' or 'CNRY-' (case-sensitive) or
-- the id of a canary entity (seeds below + their direct children). Every other row is a
-- REAL row; the real-row md5 of every public table must be identical before and after.
--
--   ls$ cd /srv/supabase/stack && docker compose exec -T db psql -X -q -At -F '|' -U supabase_admin -d postgres \
--         -v ON_ERROR_STOP=1 -v win_start=2026-10-20T02:00:00Z -v win_end=2026-10-20T06:00:00Z \
--         < canary-1.0.16-fingerprint.sql > canary-<shop>-<before|after>.txt
-- (for the BEFORE run, win_start = win_end = the snapshot time). The file is piped in; nothing is copied
-- into the stack directory.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, MDY';
SET LOCAL intervalstyle = 'postgres';
SET LOCAL extra_float_digits = 1;
SET LOCAL bytea_output = 'hex';

-- ---------------------------------------------------------------- canary id set
-- Seeds: the CANARY TEST product(s) (name AND sku tag) and the CANARY cashier(s) (name tag, role CASHIER).
-- Children: product units (unit prices reference only the unit id), shifts of canary cashiers,
-- sales in those shifts or containing a canary product, their refund/void requests, upload
-- sessions and their storage paths, the cashier's auth id.
WITH cp AS (SELECT id FROM public.products WHERE name LIKE 'CANARY TEST%' AND sku LIKE 'CNRY-%'),
     cu AS (SELECT id, auth_id FROM public.users WHERE name LIKE 'CANARY %' AND role = 'CASHIER'),
     cpu AS (SELECT id FROM public.product_units WHERE product_id IN (SELECT id FROM cp)),
     csh AS (SELECT id FROM public.shifts WHERE cashier_id IN (SELECT id FROM cu)),
     cs AS (SELECT id FROM public.sales WHERE shift_id IN (SELECT id FROM csh)
            UNION SELECT sale_id FROM public.sale_items WHERE product_id IN (SELECT id FROM cp)),
     crf AS (SELECT id FROM public.refund_void_requests WHERE sale_id IN (SELECT id FROM cs)),
     cses AS (SELECT id, storage_path FROM public.product_image_upload_sessions WHERE product_id IN (SELECT id FROM cp)),
     ids AS (SELECT id FROM cp UNION SELECT id FROM cu UNION SELECT auth_id::text FROM cu WHERE auth_id IS NOT NULL
             UNION SELECT id FROM cpu UNION SELECT id FROM csh UNION SELECT id FROM cs UNION SELECT id FROM crf
             UNION SELECT id FROM cses UNION SELECT storage_path FROM cses WHERE storage_path IS NOT NULL)
SELECT coalesce(array_agg(id ORDER BY id), '{}')::text AS canary_ids FROM ids WHERE id IS NOT NULL AND length(id) >= 8 \gset

SELECT 'meta:now', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '', '';
SELECT 'meta:schema', coalesce(max(version), '?'), '', '' FROM supabase_migrations.schema_migrations;
SELECT 'meta:canary ids', cardinality(:'canary_ids'::text[]), '', '';

-- ---------------------------------------------------------------- every public table
-- item | real rows | canary rows | md5(real rows) ; plus real rows created inside the window
SELECT format($q$
SELECT %L, count(*) FILTER (WHERE NOT c), count(*) FILTER (WHERE c),
       md5(coalesce(string_agg(r, E'\n' ORDER BY r) FILTER (WHERE NOT c), ''))
  FROM (SELECT t::text AS r,
               (strpos(t::text, 'CANARY') > 0 OR strpos(t::text, 'CNRY-') > 0
                OR EXISTS (SELECT 1 FROM unnest(%L::text[]) i WHERE strpos(t::text, i) > 0)) AS c
          FROM %I.%I t) z$q$,
  'public.' || c.relname, :'canary_ids', n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
 ORDER BY c.relname
\gexec

SELECT format($q$
SELECT %L, count(*), '', ''
  FROM %I.%I t
 WHERE (to_jsonb(t) ->> 'created_at') IS NOT NULL
   AND (to_jsonb(t) ->> 'created_at')::timestamptz >= %L::timestamptz
   AND (to_jsonb(t) ->> 'created_at')::timestamptz <  %L::timestamptz
   AND NOT (strpos(t::text, 'CANARY') > 0 OR strpos(t::text, 'CNRY-') > 0
            OR EXISTS (SELECT 1 FROM unnest(%L::text[]) i WHERE strpos(t::text, i) > 0))$q$,
  'window:real rows created in public.' || c.relname, n.nspname, c.relname, :'win_start', :'win_end', :'canary_ids')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'created_at' AND NOT a.attisdropped)
 ORDER BY c.relname
\gexec

-- real audit entries of the window by action type (sign-ins of the owner are expected here; nothing else)
SELECT 'window:real audit_logs by action_type', a.action_type, count(*), ''
  FROM public.audit_logs a
 WHERE a.created_at >= :'win_start'::timestamptz AND a.created_at < :'win_end'::timestamptz
   AND NOT (strpos(a::text, 'CANARY') > 0 OR strpos(a::text, 'CNRY-') > 0
            OR EXISTS (SELECT 1 FROM unnest(:'canary_ids'::text[]) i WHERE strpos(a::text, i) > 0))
 GROUP BY a.action_type ORDER BY a.action_type;

-- ---------------------------------------------------------------- auth + storage (volatile columns removed)
-- Sign-ins move last_sign_in_at / updated_at / last_challenged_at: excluded. The canary cashier's rows are canary rows.
SELECT 'auth.users (real, stable columns)', count(*), '',
       md5(coalesce(string_agg((to_jsonb(u) - ARRAY['last_sign_in_at','updated_at','confirmation_sent_at','recovery_sent_at','email_change_sent_at','reauthentication_sent_at'])::text, E'\n' ORDER BY u.id), ''))
  FROM auth.users u WHERE NOT (u.id::text = ANY(:'canary_ids'::text[]));
SELECT 'auth.mfa_factors (real, stable columns)', count(*), '',
       md5(coalesce(string_agg((to_jsonb(f) - ARRAY['updated_at','last_challenged_at'])::text, E'\n' ORDER BY f.id), ''))
  FROM auth.mfa_factors f WHERE NOT (f.user_id::text = ANY(:'canary_ids'::text[]));
SELECT 'storage.objects (real)', count(*) FILTER (WHERE NOT c), count(*) FILTER (WHERE c),
       md5(coalesce(string_agg(r, '|' ORDER BY r) FILTER (WHERE NOT c), ''))
  FROM (SELECT (to_jsonb(o) - 'last_accessed_at')::text AS r,
               EXISTS (SELECT 1 FROM unnest(:'canary_ids'::text[]) i WHERE strpos(o.name, i) > 0) AS c
          FROM storage.objects o) z;

-- ---------------------------------------------------------------- canary assertions (all must read 0 after the canary)
WITH cp AS (SELECT id FROM public.products WHERE name LIKE 'CANARY TEST%' AND sku LIKE 'CNRY-%'),
     cu AS (SELECT id FROM public.users WHERE name LIKE 'CANARY %' AND role = 'CASHIER'),
     csh AS (SELECT id FROM public.shifts WHERE cashier_id IN (SELECT id FROM cu)),
     cs AS (SELECT id FROM public.sales WHERE shift_id IN (SELECT id FROM csh)
            UNION SELECT sale_id FROM public.sale_items WHERE product_id IN (SELECT id FROM cp))
SELECT 'assert:canary sales with a REAL product line', count(*), '', '' FROM public.sale_items
 WHERE sale_id IN (SELECT id FROM cs) AND product_id NOT IN (SELECT id FROM cp)
UNION ALL
SELECT 'assert:canary sales outside a CANARY cashier shift', count(*), '', '' FROM public.sales
 WHERE id IN (SELECT id FROM cs) AND shift_id NOT IN (SELECT id FROM csh)
UNION ALL
SELECT 'assert:canary sales not refunded/voided', count(*), '', '' FROM public.sales
 WHERE id IN (SELECT id FROM cs) AND status NOT IN ('REFUNDED', 'VOID')
UNION ALL
SELECT 'assert:stock movements of REAL products by a CANARY cashier', count(*), '', '' FROM public.inventory_movements
 WHERE created_by IN (SELECT id FROM cu) AND product_id NOT IN (SELECT id FROM cp)
UNION ALL
SELECT 'assert:CANARY cashiers still active', count(*), '', '' FROM public.users WHERE id IN (SELECT id FROM cu) AND is_active
UNION ALL
SELECT 'assert:CANARY shifts still open', count(*), '', '' FROM public.shifts WHERE id IN (SELECT id FROM csh) AND ended_at IS NULL
UNION ALL
SELECT 'assert:complete_sale keys with more than one canary sale', count(*), '', ''
  FROM (SELECT k.key FROM public.idempotency_keys k
         WHERE k.rpc = 'complete_sale' AND k.response::text LIKE ANY (SELECT '%' || id || '%' FROM cs)
         GROUP BY k.key HAVING count(*) > 1) d;

-- ---------------------------------------------------------------- canary counts (information)
WITH cp AS (SELECT id FROM public.products WHERE name LIKE 'CANARY TEST%' AND sku LIKE 'CNRY-%'),
     cu AS (SELECT id FROM public.users WHERE name LIKE 'CANARY %' AND role = 'CASHIER'),
     csh AS (SELECT id FROM public.shifts WHERE cashier_id IN (SELECT id FROM cu)),
     cs AS (SELECT id FROM public.sales WHERE shift_id IN (SELECT id FROM csh)
            UNION SELECT sale_id FROM public.sale_items WHERE product_id IN (SELECT id FROM cp))
SELECT 'canary:products', (SELECT count(*) FROM cp), '', ''
UNION ALL SELECT 'canary:cashiers', (SELECT count(*) FROM cu), '', ''
UNION ALL SELECT 'canary:shifts', (SELECT count(*) FROM csh), '', ''
UNION ALL SELECT 'canary:sales', (SELECT count(*) FROM cs), '', ''
UNION ALL SELECT 'canary:refund/void requests', (SELECT count(*) FROM public.refund_void_requests WHERE sale_id IN (SELECT id FROM cs)), '', ''
UNION ALL SELECT 'canary:stock movements', (SELECT count(*) FROM public.inventory_movements WHERE product_id IN (SELECT id FROM cp)), '', ''
UNION ALL SELECT 'canary:upload sessions', (SELECT count(*) FROM public.product_image_upload_sessions WHERE product_id IN (SELECT id FROM cp)), '', ''
UNION ALL SELECT 'canary:complete_sale idempotency keys', (SELECT count(*) FROM public.idempotency_keys k
           WHERE k.rpc = 'complete_sale' AND k.response::text LIKE ANY (SELECT '%' || id || '%' FROM cs)), '', '';
COMMIT;
