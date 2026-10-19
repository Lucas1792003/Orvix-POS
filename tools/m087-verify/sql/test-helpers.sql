-- TEST ONLY — created by tools/m087-verify in the DISPOSABLE stack, never part of migration 087.
-- zz_test_release_org stands in for what 088 will do (release a hold WITHOUT changing the epoch), so the tests can prove that
-- nothing created before or during a hold becomes executable afterwards. zz_test_witness forges a correctly signed till witness
-- (needs the server key) to test the committed hold. Both are superuser-only; the 087 rollback drops every function in schema recovery.
CREATE FUNCTION recovery.zz_test_release_org(p_org text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM recovery.owner_only();
  UPDATE recovery.org_state SET held = false WHERE org_id = p_org;
END $$;
CREATE FUNCTION recovery.zz_test_witness(p_org text, p_n bigint, p_h text, p_epoch_no int) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b jsonb := jsonb_build_object('org', p_org, 'epoch_no', p_epoch_no, 'n', p_n, 'h', p_h);
BEGIN
  PERFORM recovery.owner_only();
  RETURN b || jsonb_build_object('mac', recovery.mac(b, 'witness'));
END $$;
REVOKE ALL ON FUNCTION recovery.zz_test_release_org(text), recovery.zz_test_witness(text, bigint, text, int) FROM PUBLIC;
