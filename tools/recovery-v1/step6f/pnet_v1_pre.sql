-- Step 6 finalization (review 3, M3), pre-V1 fixture for pnet_v1_post.py: a MOCK of pg_net's objects as Supabase exposes
-- them (schema net usable by PUBLIC; queue, responses and sequence with ALL for PUBLIC; request functions without an ACL),
-- created AFTER PNET-A (as if pg_net were re-created on a system whose lockdown was skipped). Plain PostgreSQL has no
-- pg_net; nothing here makes a request. Synthetic, disposable cluster only.
CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, method text, url text, headers jsonb, body bytea, timeout_milliseconds int);
CREATE TABLE net._http_response (id bigint, status_code int, content text);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.http_request_queue (method, url, timeout_milliseconds) VALUES ('POST', url, timeout_milliseconds) RETURNING id $$;
CREATE FUNCTION net.worker_restart() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
GRANT USAGE ON SCHEMA net TO PUBLIC;
GRANT ALL ON ALL TABLES IN SCHEMA net TO PUBLIC;
GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO PUBLIC;
SELECT test.check('pnet-v1-pre mock pg_net objects are exposed to PUBLIC before the post-V1 revoke',
  has_table_privilege('anon', 'net.http_request_queue', 'INSERT') AND has_function_privilege('anon', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE'));
