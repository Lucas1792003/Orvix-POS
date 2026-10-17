import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeAll } from "vitest";

// ----------------------------------------------------------------------
// Batch 2A evidence on REAL PostgREST (v14.17) — the throwaway
// security-audit stack (tools/security-audit/run.sh --stack-only). Proves
// what the fakes cannot: that every catalogue write returns its affected
// ids, that a write matching no row is visible (not a silent 204), and that
// a duplicate primary key is told apart from a duplicate name. Skipped
// unless DISPOSABLE_PG_URL/DISPOSABLE_PG_KEY are set; refuses any host
// other than loopback: it can never touch lucashome.
// ----------------------------------------------------------------------

const URL_ = process.env.DISPOSABLE_PG_URL ?? "";
const KEY = process.env.DISPOSABLE_PG_KEY ?? "";
const enabled = URL_ !== "" && KEY !== "";
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(URL_);
if (enabled && !loopback) throw new Error("tableWrite.disposable.test: DISPOSABLE_PG_URL must be a loopback address");

vi.mock("../../lib/supabase", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.DISPOSABLE_PG_URL || "http://127.0.0.1:9";
  const key = process.env.DISPOSABLE_PG_KEY || "unset";
  return { supabase: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) };
});

import { supabase } from "../../lib/supabase";
import { isPrimaryKeyDuplicate, runTableWrite } from "./tableWrite";
import { callRpc } from "./idempotentRpc";

const run = Date.now().toString(36);
const id = `zz-b2a-${run}`;
let orgId = "";

describe.skipIf(!enabled)("Batch 2A table writes on real PostgREST (disposable stack)", () => {
  beforeAll(async () => {
    const { data, error } = await supabase.from("organizations").select("id").limit(1);
    expect(error).toBeNull();
    orgId = (data?.[0] as { id: string } | undefined)?.id ?? "";
    if (!orgId) {
      orgId = `zz-b2a-org-${run}`;
      const ins = await supabase.from("organizations").insert({ id: orgId, name: `B2A ${run}` });
      expect(ins.error).toBeNull();
    }
  });

  it("insert returns exactly the target row's id", async () => {
    const res = await runTableWrite("unit_types", "insert", { id, name: `B2A ${run}`, org_id: orgId }, id);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([{ id }]);
  });

  it("re-sending the same insert is a duplicate PRIMARY KEY (already applied)", async () => {
    const res = await runTableWrite("unit_types", "insert", { id, name: `B2A ${run}`, org_id: orgId }, id);
    expect(res.error?.code).toBe("23505");
    expect(isPrimaryKeyDuplicate("unit_types", res.error)).toBe(true);
  });

  it("a new row with a duplicate NAME is a real conflict, never treated as applied", async () => {
    const other = `${id}-2`;
    const res = await runTableWrite("unit_types", "insert", { id: other, name: `B2A ${run}`, org_id: orgId }, other);
    expect(res.error?.code).toBe("23505");
    expect(isPrimaryKeyDuplicate("unit_types", res.error)).toBe(false);
  });

  it("update of the row returns its id; update of a missing row is ZERO_ROWS, not a silent success", async () => {
    const ok = await runTableWrite("unit_types", "update", { description: "b2a" }, id);
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual([{ id }]);
    const missing = await runTableWrite("unit_types", "update", { description: "b2a" }, `${id}-missing`);
    expect(missing.error?.code).toBe("ZERO_ROWS");
    expect(missing.error?.failure.retryable).toBe(false);
  });

  it("delete of a missing row is ZERO_ROWS; delete of the row returns its id", async () => {
    const missing = await runTableWrite("unit_types", "delete", undefined, `${id}-missing`);
    expect(missing.error?.code).toBe("ZERO_ROWS");
    const ok = await runTableWrite("unit_types", "delete", undefined, id);
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual([{ id }]);
  });

  it("an RPC the server does not have is WAITING_BACKEND (held), not a refusal", async () => {
    const res = await callRpc("zz_b2a_no_such_function", { p_idempotency_key: `k-${run}` });
    expect(res.error?.failure.klass).toBe("WAITING_BACKEND");
    expect(res.error?.failure.hold).toBe("backend-version");
  });
});
