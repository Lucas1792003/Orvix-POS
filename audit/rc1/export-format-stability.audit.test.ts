// RC1 (b777345) release-readiness audit, step 1(a): the queue-export file
// format is version-stable. Characterization tests only (no product code).
//   * a file written by the pre-1.0.16 export code (3c00aeb, format v1 without
//     backendOrigin/quarantineReason) is read by RC1;
//   * a frozen RC1-written file (fixtures/golden-rc1.spqx, fixed salt/iv)
//     keeps decrypting with whatever format.ts the repo has: if a later
//     change breaks old files, this fails.
// Regenerate the golden file only on purpose: AUDIT_REGEN_GOLDEN=1.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as rc1 from "../../src/lib/queueExport/format";
import * as old from "./fixtures/format.3c00aeb";
import { replayExport } from "../../tools/queue-recovery/replay";

const GOLDEN = join(__dirname, "fixtures", "golden-rc1.spqx");
const PASS = "canary-golden-passphrase";

function entry(over: Record<string, unknown> = {}) {
  return {
    seq: 1, opId: "outbox-a", idempotencyKey: "11111111-1111-4111-8111-111111111111", kind: "rpc", opType: "complete_sale",
    table: null, tableOp: null, rowId: null,
    payload: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_idempotency_key: "11111111-1111-4111-8111-111111111111", p_items: [{ productId: "p", qty: 1 }] },
    refs: [], provisional: [{ table: "sales", ids: ["sale-prov-1"] }], shopId: "shop-1",
    createdAt: "2026-10-16T01:00:00.000Z", ringUpAt: null, status: "pending", attempts: 0,
    lastErrorClass: null, lastError: null, nextAttemptAt: null, ...over,
  };
}

function payload(entries: unknown[]) {
  return {
    format: "shwephala-queue-export", formatVersion: 1, appVersion: "1.0.16", exportedAt: "2026-10-16T02:00:00.000Z",
    tillId: "till-audit", backendHost: "127.0.0.1:54321",
    session: { userId: "u", orgId: "o", shopId: "shop-1", role: "OWNER" },
    entries, provisionalIdMap: [], redactedFields: 0,
  };
}

describe("queue export format stability (RC1 audit 1a)", () => {
  it("RC1 decrypts a file written by the pre-1.0.16 export code (3c00aeb)", async () => {
    const env = await old.encryptQueueExport(payload([entry()]) as never, PASS, { iterations: 100_000 });
    const back = await rc1.decryptQueueExport(JSON.stringify(env), PASS);
    expect(back.entries[0]).toMatchObject({ opId: "outbox-a", status: "pending", backendOrigin: null, quarantineReason: null });
    expect(back.entries[0].payload).toEqual(entry().payload);
  });

  it("a frozen RC1 file (quarantined + pending entries) still decrypts and is replayable (dry run)", async () => {
    if (process.env.AUDIT_REGEN_GOLDEN === "1" || !existsSync(GOLDEN)) {
      const p = payload([
        entry({ status: "quarantined", backendOrigin: null, quarantineReason: "Queued by an older app version (before 1.0.16)" }),
        entry({ seq: 2, opId: "outbox-b", idempotencyKey: "22222222-2222-4222-8222-222222222222",
          payload: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_idempotency_key: "22222222-2222-4222-8222-222222222222" },
          backendOrigin: "http://127.0.0.1:54321", quarantineReason: null }),
      ]);
      const env = await rc1.encryptQueueExport(p as never, PASS, {
        iterations: 100_000, salt: new Uint8Array(16).fill(7), iv: new Uint8Array(12).fill(9),
      });
      writeFileSync(GOLDEN, JSON.stringify(env, null, 1));
    }
    const back = await rc1.decryptQueueExport(readFileSync(GOLDEN, "utf8"), PASS);
    expect(back.entries.map((e) => [e.opId, e.status])).toEqual([["outbox-a", "quarantined"], ["outbox-b", "pending"]]);
    const noNet = (async () => { throw new Error("dry run must not send"); }) as unknown as typeof fetch;
    const report = await replayExport(back, {
      target: "http://127.0.0.1:54321", anonKey: null, accessToken: "x", dryRun: true, includeQuarantined: true, fetchImpl: noNet,
    });
    expect(report.ops.map((o) => o.outcome)).toEqual(["planned", "planned"]);
    // without the explicit owner flag the quarantined entry is skipped, never dropped silently
    const report2 = await replayExport(back, { target: "http://127.0.0.1:54321", anonKey: null, accessToken: "x", dryRun: true, fetchImpl: noNet });
    expect(report2.ops.map((o) => o.outcome)).toEqual(["skipped-quarantined", "planned"]);
  });
});
