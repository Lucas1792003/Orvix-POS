-- Step 5 suite seed (runs BEFORE Recovery V1 is installed: V1 closes onboarding). Synthetic only.
-- org-s5a / org-s5b: one shop and one ADMIN each, for the reopening tests. org-s5b also holds a ledger row that was never
-- finished (committed with no response): an operation of UNKNOWN outcome, which no owner decision may wave through.
\set ON_ERROR_STOP on
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-4000-8000-0000000005a1', 's5a-admin@test.local'), ('a0000000-0000-4000-8000-0000000005b1', 's5b-admin@test.local');
INSERT INTO public.organizations SELECT (jsonb_populate_record(NULL::public.organizations, to_jsonb(o) || jsonb_build_object('id','org-s5a','name','Step 5 synthetic org A'))).*
  FROM public.organizations o WHERE id = 'org-test';
INSERT INTO public.organizations SELECT (jsonb_populate_record(NULL::public.organizations, to_jsonb(o) || jsonb_build_object('id','org-s5b','name','Step 5 synthetic org B'))).*
  FROM public.organizations o WHERE id = 'org-test';
INSERT INTO public.shops SELECT (jsonb_populate_record(NULL::public.shops, to_jsonb(s) || jsonb_build_object('id','shop-s5a','org_id','org-s5a','name','S5 shop A','code','S5A'))).*
  FROM public.shops s WHERE id = 'shop-b';
INSERT INTO public.shops SELECT (jsonb_populate_record(NULL::public.shops, to_jsonb(s) || jsonb_build_object('id','shop-s5b','org_id','org-s5b','name','S5 shop B','code','S5B'))).*
  FROM public.shops s WHERE id = 'shop-b';
SET ROLE service_role;   -- platform provisioning path (migration 073): only it (or an ADMIN) may create ADMIN users
INSERT INTO public.users SELECT (jsonb_populate_record(NULL::public.users, to_jsonb(u) || jsonb_build_object('id','u-s5a-admin','org_id','org-s5a',
  'auth_id','a0000000-0000-4000-8000-0000000005a1','email','s5a-admin@test.local','name','S5A admin'))).* FROM public.users u WHERE id = 'u-admin';
INSERT INTO public.users SELECT (jsonb_populate_record(NULL::public.users, to_jsonb(u) || jsonb_build_object('id','u-s5b-admin','org_id','org-s5b',
  'auth_id','a0000000-0000-4000-8000-0000000005b1','email','s5b-admin@test.local','name','S5B admin'))).* FROM public.users u WHERE id = 'u-admin';
RESET ROLE;
INSERT INTO public.idempotency_keys (key, rpc, actor_id, org_id, request_hash) VALUES ('55555555-0000-4000-8000-0000000000b1', 'complete_sale', 'u-s5b-admin', 'org-s5b', md5('s5-unfinished'));
SELECT test.check('s5 seed: org-s5a / org-s5b with a shop and an ADMIN each; org-s5b holds one unfinished ledger row',
  (SELECT count(*) = 2 FROM public.shops WHERE id IN ('shop-s5a','shop-s5b')) AND (SELECT count(*) = 2 FROM public.users WHERE id IN ('u-s5a-admin','u-s5b-admin'))
  AND EXISTS (SELECT 1 FROM public.idempotency_keys WHERE key = '55555555-0000-4000-8000-0000000000b1' AND response IS NULL));
