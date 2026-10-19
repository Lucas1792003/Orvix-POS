-- TEST FIXTURE for tools/m087-verify/x1 (plain PostgreSQL 17; NOT a migration). The 087 lease, identity, chain, canary,
-- authority and gate functions of supabase/migrations/087_recovery_hold.sql on a stand-in ledger (public.ledger), so the REAL
-- tools/recovery-authority/{authority,gate}.py can be exercised against pg_basebackup / WAL-archive / logical restores.
\set ON_ERROR_STOP on
CREATE ROLE recovery_owner NOLOGIN NOSUPERUSER NOINHERIT;
CREATE ROLE recovery_authority LOGIN NOSUPERUSER NOINHERIT;      -- used only by the OFF-HOST witness authority
CREATE ROLE recovery_gate LOGIN NOSUPERUSER NOINHERIT;           -- the read-only restore gate (no superuser needed)
CREATE ROLE app LOGIN NOSUPERUSER;                                -- stand-in for an application role
CREATE SCHEMA recovery AUTHORIZATION recovery_owner;
REVOKE ALL ON SCHEMA recovery FROM PUBLIC;
GRANT USAGE ON SCHEMA recovery TO recovery_authority, recovery_gate, app;
CREATE TABLE public.ledger (org_id text NOT NULL, key uuid NOT NULL, state text NOT NULL, request_hash text NOT NULL, PRIMARY KEY (org_id, key));
GRANT SELECT, INSERT ON public.ledger TO app;
GRANT SELECT ON public.ledger TO recovery_owner;

-- public-schema canary (review r32 R32-1): renewed with the lease; a reload of only the public schema restores an old/copied row
CREATE TABLE public.zz_recovery_canary (one boolean PRIMARY KEY DEFAULT true CHECK (one), seq int NOT NULL, issued_xid xid8 NOT NULL);
ALTER TABLE public.zz_recovery_canary OWNER TO recovery_owner;
ALTER TABLE public.zz_recovery_canary ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zz_recovery_canary FROM PUBLIC;
SET ROLE recovery_owner;
CREATE TABLE recovery.continuity (one boolean PRIMARY KEY DEFAULT true CHECK (one), state text NOT NULL CHECK (state IN ('open','hold')),
  sysid text NOT NULL, timeline int NOT NULL, db_oid oid NOT NULL);
CREATE TABLE recovery.org_state (org_id text PRIMARY KEY, epoch_no int NOT NULL DEFAULT 0, held boolean NOT NULL DEFAULT false, reason text);
CREATE TABLE recovery.lease (one boolean PRIMARY KEY DEFAULT true CHECK (one), valid_until timestamptz NOT NULL, issued_at timestamptz NOT NULL,
  issued_xid xid8 NOT NULL, postmaster_start timestamptz NOT NULL, authority_seq int NOT NULL, token_sha256 text NOT NULL);
CREATE TABLE recovery.anchor_permit (postmaster_start timestamptz PRIMARY KEY, reason text NOT NULL, approved_by text NOT NULL,
  second_approver text NOT NULL CHECK (second_approver <> approved_by), at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE recovery.org_chain (org_id text PRIMARY KEY, n bigint NOT NULL, h bytea NOT NULL);
CREATE TABLE recovery.chain_log (org_id text, n bigint, h bytea NOT NULL, p text NOT NULL, PRIMARY KEY (org_id, n));
CREATE TABLE recovery.keys (name text PRIMARY KEY, k bytea NOT NULL);
CREATE TABLE recovery.install (one boolean PRIMARY KEY DEFAULT true CHECK (one), genesis_done boolean NOT NULL DEFAULT false, max_seq int NOT NULL DEFAULT 0);
INSERT INTO recovery.install DEFAULT VALUES;
-- randomness and HMAC from pg_catalog only (no extension schema another role could own)
CREATE FUNCTION recovery.random_bytes32() RETURNS bytea LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
  SELECT decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex') $$;
CREATE FUNCTION recovery.hmac_sha256(p_msg bytea, p_key bytea) RETURNS bytea LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE k bytea := p_key; ipad bytea; opad bytea; i int;
BEGIN
  IF length(k) > 64 THEN k := sha256(k); END IF;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k; opad := k;
  FOR i IN 0..63 LOOP ipad := set_byte(ipad, i, get_byte(k, i) # 54); opad := set_byte(opad, i, get_byte(k, i) # 92); END LOOP;
  RETURN sha256(opad || sha256(ipad || p_msg));
END $$;
INSERT INTO recovery.keys VALUES ('till_witness', recovery.random_bytes32());

CREATE FUNCTION recovery.refuse(p_code text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = 'PT429', MESSAGE = 'ORG_SUSPENDED: server recovery in progress [' || p_code || ']'; END $$;

-- lease is valid only if: present, unexpired, issued after THIS server start, for THIS server start, and the row is
-- the one the issuing transaction wrote (a restored / copied row carries a different xmin than its issued_xid)
CREATE FUNCTION recovery.lease_ok() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT l.valid_until > clock_timestamp()
                      AND l.issued_at > pg_postmaster_start_time()
                      AND l.postmaster_start = pg_postmaster_start_time()
                      AND (l.issued_xid::text::numeric % 4294967296) = l.xmin::text::numeric
                     FROM recovery.lease l), false) $$;

CREATE FUNCTION recovery.assert_writable(p_org text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c recovery.continuity;
BEGIN
  SELECT * INTO c FROM recovery.continuity;
  IF NOT FOUND THEN PERFORM recovery.refuse('NO_CONTINUITY'); END IF;
  IF (c.sysid, c.timeline, c.db_oid) IS DISTINCT FROM
     ((SELECT system_identifier::text FROM pg_control_system()), (SELECT timeline_id FROM pg_control_checkpoint())::int,
      (SELECT oid FROM pg_database WHERE datname = current_database())) THEN PERFORM recovery.refuse('IDENTITY_CHANGED'); END IF;
  IF NOT recovery.lease_ok() THEN PERFORM recovery.refuse('LEASE_INVALID'); END IF;
  IF c.state <> 'open' OR EXISTS (SELECT 1 FROM recovery.org_state WHERE held AND (org_id = p_org OR p_org IS NULL)) THEN
    PERFORM recovery.refuse('RECOVERY_HOLD'); END IF;
END $$;

CREATE FUNCTION recovery.guard_tg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN PERFORM recovery.assert_writable(CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END); RETURN NULL; END $$;

CREATE FUNCTION recovery.chain_tg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_n bigint; v_p text;
BEGIN
  INSERT INTO recovery.org_state (org_id) VALUES (NEW.org_id) ON CONFLICT DO NOTHING;
  INSERT INTO recovery.org_chain VALUES (NEW.org_id, 0, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea) ON CONFLICT DO NOTHING;
  SELECT n + 1 INTO v_n FROM recovery.org_chain WHERE org_id = NEW.org_id FOR UPDATE;
  -- payload is JSON (no field-separator ambiguity)
  v_p := json_build_object('org', NEW.org_id, 'n', v_n, 'key', NEW.key, 'state', NEW.state, 'rh', NEW.request_hash)::text;
  UPDATE recovery.org_chain SET n = v_n, h = sha256(h || convert_to(v_p, 'UTF8')) WHERE org_id = NEW.org_id;
  INSERT INTO recovery.chain_log SELECT NEW.org_id, v_n, h, v_p FROM recovery.org_chain WHERE org_id = NEW.org_id;
  RETURN NULL;
END $$;

-- ---- authority interface (EXECUTE granted to recovery_authority only)
CREATE FUNCTION recovery.authority_observe() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'sysid', (SELECT system_identifier::text FROM pg_control_system()), 'timeline', (SELECT timeline_id FROM pg_control_checkpoint()),
    'db_oid', (SELECT oid FROM pg_database WHERE datname = current_database()), 'postmaster_start', pg_postmaster_start_time(),
    'lsn', pg_current_wal_lsn()::text,
    'heads', coalesce((SELECT jsonb_object_agg(org_id, jsonb_build_object('n', n, 'h', encode(h, 'hex'))) FROM recovery.org_chain), '{}'),
    'orgs', coalesce((SELECT jsonb_agg(org_id ORDER BY org_id) FROM recovery.org_state), '[]'),
    'till_key_fp', (SELECT encode(sha256(k), 'hex') FROM recovery.keys WHERE name = 'till_witness'),
    'anchor_permit', EXISTS (SELECT 1 FROM recovery.anchor_permit WHERE postmaster_start = pg_postmaster_start_time()),
    'lease_seq', (SELECT authority_seq FROM recovery.lease), 'lease_token_sha256', (SELECT token_sha256 FROM recovery.lease),
    'canary_ok', coalesce((SELECT c.seq = l.authority_seq AND (c.issued_xid::text::numeric % 4294967296) = c.xmin::text::numeric
                             FROM public.zz_recovery_canary c, recovery.lease l), (SELECT count(*) = 0 FROM recovery.lease)),
    'held', coalesce((SELECT jsonb_agg(org_id ORDER BY org_id) FROM recovery.org_state WHERE held), '[]'),
    'lease_copied', coalesce((SELECT (l.issued_xid::text::numeric % 4294967296) <> l.xmin::text::numeric FROM recovery.lease l), false),
    'ledger', coalesce((SELECT jsonb_object_agg(org_id, c) FROM (SELECT org_id, count(*) c FROM public.ledger GROUP BY 1) x), '{}')) $$;

-- the gate's read-only evidence (EXECUTE granted to recovery_gate only)
CREATE FUNCTION recovery.gate_evidence() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('observe', recovery.authority_observe(),
    'chain', coalesce((SELECT jsonb_agg(jsonb_build_array(org_id, n, encode(h, 'hex'), p) ORDER BY org_id, n) FROM recovery.chain_log), '[]'),
    'till_key', (SELECT encode(k, 'hex') FROM recovery.keys WHERE name = 'till_witness')) $$;

CREATE FUNCTION recovery.authority_hash_at(p_org text, p_n bigint) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(h, 'hex') FROM recovery.chain_log WHERE org_id = p_org AND n = p_n $$;

CREATE FUNCTION recovery.authority_renew(p_seq int, p_seconds int, p_postmaster timestamptz, p_genesis boolean, p_token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE l recovery.lease; i recovery.install;
BEGIN
  IF p_seconds NOT BETWEEN 30 AND 3600 THEN RETURN 'BAD_LENGTH'; END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN 'BAD_TOKEN'; END IF;
  IF p_postmaster IS DISTINCT FROM pg_postmaster_start_time() THEN RETURN 'STALE_OBSERVATION'; END IF;
  -- never wait: a renewal that queues behind another session's lock could commit after the authority gave up on it
  SELECT * INTO i FROM recovery.install FOR UPDATE NOWAIT;
  IF p_genesis AND i.genesis_done THEN RETURN 'GENESIS_ALREADY_DONE'; END IF;     -- one genesis per install / re-baseline
  IF NOT p_genesis AND NOT i.genesis_done THEN RETURN 'NO_GENESIS'; END IF;
  IF p_seq <= i.max_seq THEN RETURN 'SEQ_NOT_INCREASING'; END IF;
  IF p_seq > i.max_seq + 100000 THEN RETURN 'SEQ_JUMP_TOO_LARGE'; END IF;            -- review r31 NEW-7
  SELECT * INTO l FROM recovery.lease;
  IF (NOT FOUND OR l.postmaster_start IS DISTINCT FROM pg_postmaster_start_time())
     AND NOT EXISTS (SELECT 1 FROM recovery.anchor_permit WHERE postmaster_start = pg_postmaster_start_time()) THEN
    RETURN 'ANCHOR_REQUIRED';
  END IF;
  INSERT INTO recovery.lease VALUES (true, clock_timestamp() + make_interval(secs => p_seconds), clock_timestamp(), pg_current_xact_id(),
    pg_postmaster_start_time(), p_seq, encode(sha256(decode(p_token, 'hex')), 'hex'))
  ON CONFLICT (one) DO UPDATE SET valid_until = EXCLUDED.valid_until, issued_at = EXCLUDED.issued_at, issued_xid = EXCLUDED.issued_xid,
    postmaster_start = EXCLUDED.postmaster_start, authority_seq = EXCLUDED.authority_seq, token_sha256 = EXCLUDED.token_sha256;
  INSERT INTO public.zz_recovery_canary VALUES (true, p_seq, pg_current_xact_id())
  ON CONFLICT (one) DO UPDATE SET seq = EXCLUDED.seq, issued_xid = EXCLUDED.issued_xid;
  IF NOT recovery.lease_ok() THEN      -- e.g. called inside a savepoint (row xmin = subtransaction xid): never report a lease that does not work
    RAISE EXCEPTION 'LEASE_NOT_EFFECTIVE' USING ERRCODE = '55000';
  END IF;
  UPDATE recovery.install SET genesis_done = true, max_seq = p_seq;
  RETURN 'RENEWED';
END $$;

CREATE FUNCTION recovery.authority_revoke() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE recovery.lease SET valid_until = clock_timestamp(), issued_xid = pg_current_xact_id() $$;   -- expired, not 'copied'

CREATE FUNCTION recovery.owner_rebaseline(p_reason text, p_a text, p_b text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN   -- after an accepted PITR / upgrade / re-apply: allows ONE new genesis; two people; the lease stays invalid until then
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RAISE EXCEPTION 'OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  IF p_a = p_b THEN RAISE EXCEPTION 'TWO_PEOPLE_REQUIRED' USING ERRCODE = '42501'; END IF;
  UPDATE recovery.install SET genesis_done = false, max_seq = 0;      -- a re-baseline starts a NEW series (old one archived by the runbook)
  DELETE FROM recovery.lease;
END $$;

CREATE FUNCTION recovery.authority_hold(p_org text, p_reason text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO recovery.org_state (org_id, held, reason) VALUES (p_org, true, p_reason)
  ON CONFLICT (org_id) DO UPDATE SET held = true, epoch_no = recovery.org_state.epoch_no + 1, reason = EXCLUDED.reason
  WHERE NOT recovery.org_state.held $$;                           -- idempotent while held (one epoch per incident)

-- ---- owner (infrastructure owner, superuser session only)
CREATE FUNCTION recovery.owner_anchor(p_reason text, p_approved_by text, p_second text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RAISE EXCEPTION 'OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  INSERT INTO recovery.anchor_permit (postmaster_start, reason, approved_by, second_approver) VALUES (pg_postmaster_start_time(), p_reason, p_approved_by, p_second);
END $$;

CREATE FUNCTION recovery.owner_seal_install() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RAISE EXCEPTION 'OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  INSERT INTO recovery.continuity VALUES (true, 'open', (SELECT system_identifier::text FROM pg_control_system()),
    (SELECT timeline_id FROM pg_control_checkpoint())::int, (SELECT oid FROM pg_database WHERE datname = current_database()));
END $$;

CREATE FUNCTION recovery.till_witness(p_org text, p_till text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH w AS (SELECT jsonb_build_object('org', p_org, 'till', p_till, 'n', c.n, 'h', encode(c.h, 'hex'), 'epoch_no', s.epoch_no) AS b
               FROM recovery.org_chain c JOIN recovery.org_state s USING (org_id) WHERE c.org_id = p_org)
  SELECT b || jsonb_build_object('mac', encode(recovery.hmac_sha256(convert_to(b::text, 'UTF8'), (SELECT k FROM recovery.keys WHERE name = 'till_witness')), 'hex')) FROM w $$;
RESET ROLE;

-- guard on the ledger: AFTER ROW, ENABLE ALWAYS (fires under session_replication_role = replica; sees the final row)
CREATE TRIGGER zz_recovery_guard AFTER INSERT OR UPDATE OR DELETE ON public.ledger FOR EACH ROW EXECUTE FUNCTION recovery.guard_tg();
CREATE CONSTRAINT TRIGGER zz_recovery_chain AFTER INSERT ON public.ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recovery.chain_tg();
ALTER TABLE public.ledger ENABLE ALWAYS TRIGGER zz_recovery_guard, ENABLE ALWAYS TRIGGER zz_recovery_chain;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA recovery FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recovery.authority_observe(), recovery.authority_hash_at(text, bigint), recovery.authority_renew(int, int, timestamptz, boolean, text),
  recovery.authority_hold(text, text), recovery.authority_revoke() TO recovery_authority;
GRANT EXECUTE ON FUNCTION recovery.gate_evidence() TO recovery_gate;
GRANT EXECUTE ON FUNCTION recovery.guard_tg(), recovery.chain_tg(), recovery.assert_writable(text) TO app;
CREATE FUNCTION public.commit_ops(p_org text, p_count int) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.ledger SELECT p_org, gen_random_uuid(), 'committed', encode(sha256(convert_to(random()::text, 'UTF8')), 'hex') FROM generate_series(1, p_count) $$;
SELECT recovery.owner_seal_install();   -- installed WITHOUT a lease: held until the owner anchors and the authority renews
