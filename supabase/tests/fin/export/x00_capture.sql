-- Contract-export helper (FIN_EXPORT_DIR only): run one statement AS the given
-- user through the real API role and return its JSON reply, or the error the
-- client would receive ({error: {code, message}}). Test schema only.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION test.capture(p_auth uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF p_auth IS NULL THEN PERFORM test.logout(); ELSE PERFORM test.login(p_auth); END IF;
  BEGIN
    EXECUTE CASE WHEN p_auth IS NULL THEN 'SET LOCAL ROLE anon' ELSE 'SET LOCAL ROLE authenticated' END;
    EXECUTE p_sql INTO r;
    EXECUTE 'RESET ROLE';
    RETURN jsonb_build_object('data', r);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', jsonb_build_object('code', SQLSTATE, 'message', SQLERRM));
  END;
END $$;
