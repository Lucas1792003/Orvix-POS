-- Runs as the superuser AFTER baseline + migrations. Creates the `test`
-- schema: a results ledger, assertion helpers callable by every API role, and
-- a login helper that sets the JWT claim GUCs the way PostgREST does.
\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS test CASCADE;
CREATE SCHEMA test;
GRANT USAGE ON SCHEMA test TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA test TO postgres;

-- Hosted table-grant list (hosted-grants.txt), loaded by run.sh with \copy
-- over the host psql connection (role postgres, hence the grant).
CREATE TABLE test.expected_grants (table_name text, grantee text, privs text);
GRANT ALL ON test.expected_grants TO postgres;
GRANT SELECT ON test.expected_grants TO anon, authenticated, service_role;

CREATE TABLE test.results (
  seq     serial PRIMARY KEY,
  name    text NOT NULL,
  ok      boolean NOT NULL,
  detail  text,
  -- 'CHECK': a failure is a harness failure. 'FINDING' (Phase G, t09): an
  -- isolation gap that is EXPECTED to fail on the schema before the fix
  -- migrations (068+) and must pass after them; run.sh reports it as FINDING.
  kind    text NOT NULL DEFAULT 'CHECK'
);
GRANT INSERT, SELECT ON test.results TO anon, authenticated, service_role;
GRANT USAGE ON SEQUENCE test.results_seq_seq TO anon, authenticated, service_role;

-- Cross-file scratch variables (ids minted by one test file, used by another).
CREATE TABLE test.vars (k text PRIMARY KEY, v text);
GRANT SELECT, INSERT, UPDATE ON test.vars TO anon, authenticated, service_role;

CREATE FUNCTION test.setvar(p_k text, p_v text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO test.vars (k, v) VALUES (p_k, p_v)
  ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
$$;
CREATE FUNCTION test.var(p_k text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT v FROM test.vars WHERE k = p_k;
$$;

-- Record an assertion. SECURITY INVOKER: runs as whatever role the test set.
CREATE FUNCTION test.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO test.results (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), p_detail);
  RETURN (CASE WHEN COALESCE(p_ok, false) THEN 'PASS ' ELSE 'FAIL ' END) || p_name
         || COALESCE(' -- ' || p_detail, '');
END $$;

-- Execute p_sql (as the CURRENT role) and assert it raises an error whose
-- message contains p_expect. The failure is confined to a subtransaction so
-- the test file keeps running.
CREATE FUNCTION test.expect_error(p_name text, p_sql text, p_expect text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    RETURN test.check(p_name, position(p_expect in v_msg) > 0,
                      'got: ' || left(v_msg, 160));
  END;
  RETURN test.check(p_name, false, 'expected error containing "' || p_expect || '" but the statement succeeded');
END $$;

-- Phase G audit assertions. A false result is a FINDING (an isolation gap),
-- not a harness failure; after the fix migrations every finding must pass.
CREATE FUNCTION test.finding(p_name text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO test.results (name, ok, detail, kind) VALUES (p_name, COALESCE(p_ok, false), p_detail, 'FINDING');
  RETURN (CASE WHEN COALESCE(p_ok, false) THEN 'PASS ' ELSE 'FINDING ' END) || p_name
         || COALESCE(' -- ' || p_detail, '');
END $$;

-- A cross-org statement that MUST raise an error containing p_expect. If it
-- succeeds that is the finding; if it raises a different error the test
-- itself is wrong (harness FAIL) so the demonstration stays unambiguous.
CREATE FUNCTION test.finding_error(p_name text, p_sql text, p_expect text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF position(p_expect in v_msg) > 0 THEN
      RETURN test.finding(p_name, true);
    END IF;
    RETURN test.check(p_name, false, 'unexpected error (not "' || p_expect || '"): ' || left(v_msg, 160));
  END;
  RETURN test.finding(p_name, false, 'cross-org statement SUCCEEDED');
END $$;

-- A statement that is currently blocked by a cross-org collision (global
-- uniqueness) or a missing org dimension and must succeed after the fix.
CREATE FUNCTION test.finding_succeeds(p_name text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    RETURN test.finding(p_name, false, 'blocked: ' || left(v_msg, 160));
  END;
  RETURN test.finding(p_name, true);
END $$;

-- Run a DML statement as the current role and return the number of rows it
-- touched (RLS USING filters silently -> 0 rows for foreign-org targets).
CREATE FUNCTION test.affected(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Evaluate a scalar query given as text (so a test can reference a column
-- that only exists after a later migration without a planning error).
CREATE FUNCTION test.eval_bigint(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v bigint;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN v;
END $$;

CREATE FUNCTION test.col_exists(p_table text, p_col text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_col);
$$;

-- Simulate a PostgREST request for the given auth user: set BOTH GUC spellings
-- that auth.uid() implementations read (session-scoped so they survive across
-- statements in a psql file). Call BEFORE `SET ROLE authenticated`.
CREATE FUNCTION test.login(p_auth_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_auth_id::text, false);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_auth_id, 'role', 'authenticated')::text, false);
END $$;

CREATE FUNCTION test.logout() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', false);
  PERFORM set_config('request.jwt.claim.role', '', false);
  PERFORM set_config('request.jwt.claims', '', false);
END $$;

-- Inventory snapshot taken right after seeding; 08 proves
-- initial + sum(movements) = current for every row.
CREATE TABLE test.initial_inventory (shop_id text, product_id text, qty integer, PRIMARY KEY (shop_id, product_id));

-- 083 (G5): complete_product_image_upload_session becomes service_role-only
-- (the phone completes through the phone-upload-token Edge Function, which
-- checks the stored bytes first). m083() = 083 is applied (its COMMENT marker);
-- completer() = the role a test uses to simulate the phone's completion.
CREATE FUNCTION test.m083() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(obj_description(to_regprocedure('public.complete_product_image_upload_session(text,text,text,integer,text)'), 'pg_proc'), '') LIKE '083:%' $$;
CREATE FUNCTION test.completer() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN test.m083() THEN 'service_role' ELSE 'anon' END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO anon, authenticated, service_role;
