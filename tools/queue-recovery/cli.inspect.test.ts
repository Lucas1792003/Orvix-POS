import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MIN_KDF_ITERATIONS, encryptQueueExport, type QueueExportPayload } from "../../src/lib/queueExport/format";

// ---------------------------------------------------------------------------
// Post-checkpoint pass: `inspect` never reports a file as clean while it lists
// an unresolved online-only operation (a till with ZERO queued entries and one
// supplier payment of unknown outcome): exit 4 and "NOT CLEAN".
// ---------------------------------------------------------------------------

const PASS = "correct horse battery staple";

async function inspect(p: QueueExportPayload): Promise<{ out: string; code: number }> {
  const dir = mkdtempSync(path.join(tmpdir(), "spqx-"));
  const file = path.join(dir, "q.spqx");
  writeFileSync(file, JSON.stringify(await encryptQueueExport(p, PASS, { iterations: MIN_KDF_ITERATIONS })));
  try {
    const out = execFileSync("npx", ["tsx", "tools/queue-recovery/cli.ts", "inspect", file], {
      env: { ...process.env, QUEUE_RECOVERY_PASSPHRASE: PASS }, encoding: "utf8",
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: String(err.stdout ?? ""), code: err.status ?? -1 };
  }
}

const base = (onlineOperations: QueueExportPayload["onlineOperations"]): QueueExportPayload => ({
  format: "shwephala-queue-export", formatVersion: 2, appVersion: "t", exportedAt: "2026-10-17T02:00:00.000Z",
  tillId: "till-abc123", backendHost: "pos.example.test", session: { userId: "user-1", orgId: "org-1", shopId: null, role: "MANAGER" },
  entries: [], provisionalIdMap: [], redactedFields: 0, reconciliationLog: [], onlineOperations, unreadableOnlineRecords: [],
} as QueueExportPayload);

describe("queue-recovery inspect", () => {
  it("zero entries + one unresolved supplier payment: listed with its organisation and server, NOT CLEAN, exit 4", async () => {
    const r = await inspect(base([{
      id: "op-1", name: "pay_supplier_lump_sum", idempotencyKey: "0190a000-0000-7000-8000-000000000001", userId: "user-1", orgId: "org-1",
      backendOrigin: "https://pos.example.test", createdAt: "2026-10-17T00:00:00Z", attempts: 1, uncertain: true, lastError: null, blocksReplacement: true,
    }]));
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/NOT CLEAN: 1 online-only operation has no server decision/);
    expect(r.out).toMatch(/pay_supplier_lump_sum .*key 0190a000 .*org org-1 .*server https:\/\/pos\.example\.test/);
  }, 60_000);

  it("format 3: an UNREADABLE online-operation record is listed (claims only, unverified) and the file is NOT CLEAN, exit 4", async () => {
    const r = await inspect({ ...base([]), formatVersion: 3, unreadableOnlineRecords: [{
      key: "online-op:op-bad", raw: "garbage", reason: "unparseable",
      claimed: { name: null, scope: null, orgId: null, userId: null, backendOrigin: null, version: null },
    }] } as QueueExportPayload);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/UNREADABLE ONLINE-OPERATION RECORDS \(1\)/);
    expect(r.out).toMatch(/NOT CLEAN: 1 online-operation record is unreadable/);
    expect(r.out).not.toContain("garbage");                               // raw contents stay in the encrypted file
  }, 60_000);

  it("an empty export is clean: exit 0", async () => {
    const r = await inspect(base([]));
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/NOT CLEAN/);
  }, 60_000);
});
