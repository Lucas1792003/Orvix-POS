import { describe, expect, it } from "vitest";
import {
  KDF_ITERATIONS, MIN_KDF_ITERATIONS, QueueExportError, assertNoSecretValues, canonicalJson, decryptQueueExport,
  defaultExportFileName, encryptQueueExport, inQueueOrder, parseEnvelope, redactSecrets, summarize,
  type QueueExportEntry, type QueueExportPayload,
} from "./format";

const PASS = "correct horse battery staple";
const FAST = { iterations: MIN_KDF_ITERATIONS };

const entry = (over: Partial<QueueExportEntry>): QueueExportEntry => ({
  seq: 1, opId: "outbox-1", idempotencyKey: "11111111-1111-4111-8111-111111111111", kind: "rpc",
  opType: "complete_sale", table: null, tableOp: null, rowId: null,
  payload: { p_shop_id: "shop-1", p_idempotency_key: "11111111-1111-4111-8111-111111111111", p_items: [{ productId: "p1", qty: 1 }] },
  refs: [], provisional: [], shopId: "shop-1", createdAt: "2026-10-13T01:00:00.000Z", ringUpAt: "2026-10-13T01:00:00.000Z",
  status: "pending", attempts: 0, lastErrorClass: null, lastError: null, nextAttemptAt: null, backendOrigin: "https://pos.example.test", quarantineReason: null,
  ...over,
});

const payload = (entries: QueueExportEntry[] = [entry({})]): QueueExportPayload => ({
  format: "shwephala-queue-export", formatVersion: 1, appVersion: "1.0.16", exportedAt: "2026-10-13T02:00:00.000Z",
  tillId: "till-abc123", backendHost: "pos.example.test",
  session: { userId: "user-1", orgId: "org-1", shopId: "shop-1", role: "CASHIER" },
  entries, provisionalIdMap: [], redactedFields: 0,
});

async function flipCiphertextByte(text: string): Promise<string> {
  const env = JSON.parse(text);
  const raw = atob(env.ciphertext);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  bytes[5] ^= 0x01;
  env.ciphertext = btoa(String.fromCharCode(...bytes));
  return JSON.stringify(env);
}

describe("queue export encryption", () => {
  it("round-trips the payload exactly", async () => {
    const p = payload([entry({}), entry({ seq: 2, opId: "outbox-2", status: "failed", attempts: 3, lastErrorClass: "transient", lastError: "Failed to fetch" })]);
    const env = await encryptQueueExport(p, PASS, FAST);
    const back = await decryptQueueExport(JSON.stringify(env), PASS);
    expect(back).toEqual(p);
  });

  it("uses PBKDF2-SHA-256 with 600k iterations, AES-256-GCM, random salt/iv by default", async () => {
    const a = await encryptQueueExport(payload(), PASS);
    const b = await encryptQueueExport(payload(), PASS, FAST);
    expect(a.kdf).toMatchObject({ name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS });
    expect(KDF_ITERATIONS).toBe(600_000);
    expect(a.cipher).toMatchObject({ name: "AES-GCM", keyBits: 256, tagBits: 128 });
    expect(atob(a.kdf.salt)).toHaveLength(16);
    expect(atob(a.cipher.iv)).toHaveLength(12);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
  });

  it("keeps everything but counts out of the clear part", async () => {
    const env = await encryptQueueExport(payload(), PASS, FAST);
    const text = JSON.stringify(env);
    for (const s of ["11111111-1111-4111-8111-111111111111", "shop-1", "user-1", "org-1", "pos.example.test", "p_items", "complete_sale"]) {
      // complete_sale appears only as a count key in the summary (op type), never with its payload
      if (s === "complete_sale") continue;
      expect(text).not.toContain(s);
    }
    expect(env.header.summary).toEqual({ total: 1, byStatus: { pending: 1 }, byOpType: { complete_sale: 1 } });
    expect(Object.keys(env).sort()).toEqual(["cipher", "ciphertext", "encrypted", "format", "formatVersion", "header", "kdf"]);
  });

  it("rejects a wrong passphrase", async () => {
    const env = await encryptQueueExport(payload(), PASS, FAST);
    await expect(decryptQueueExport(env, "wrong passphrase!!")).rejects.toMatchObject({ code: "decrypt-failed" });
  });

  it("detects tampering with the ciphertext, the clear summary and the KDF parameters", async () => {
    const text = JSON.stringify(await encryptQueueExport(payload(), PASS, FAST));
    await expect(decryptQueueExport(await flipCiphertextByte(text), PASS)).rejects.toMatchObject({ code: "decrypt-failed" });

    const summaryEdit = JSON.parse(text);
    summaryEdit.header.summary.total = 0;
    summaryEdit.header.summary.byStatus = {};
    await expect(decryptQueueExport(summaryEdit, PASS)).rejects.toMatchObject({ code: "decrypt-failed" });

    const tillEdit = JSON.parse(text);
    tillEdit.header.tillId = "till-other";
    await expect(decryptQueueExport(tillEdit, PASS)).rejects.toMatchObject({ code: "decrypt-failed" });

    const kdfEdit = JSON.parse(text);
    kdfEdit.kdf.iterations = MIN_KDF_ITERATIONS + 1;
    await expect(decryptQueueExport(kdfEdit, PASS)).rejects.toMatchObject({ code: "decrypt-failed" });

    const weakKdf = JSON.parse(text);
    weakKdf.kdf.iterations = 1;
    await expect(decryptQueueExport(weakKdf, PASS)).rejects.toMatchObject({ code: "bad-format" });
  });

  it("refuses weak passphrases, non-exports and newer format versions", async () => {
    await expect(encryptQueueExport(payload(), "short")).rejects.toMatchObject({ code: "weak-passphrase" });
    expect(() => parseEnvelope("not json")).toThrow(QueueExportError);
    expect(() => parseEnvelope({ format: "something-else" })).toThrow(/Not a Shwe Pha La queue export/);
    const env = await encryptQueueExport(payload(), PASS, FAST);
    expect(() => parseEnvelope({ ...env, formatVersion: 99 })).toThrow(expect.objectContaining({ code: "unsupported-version" }));
  });

  it("validates the payload schema before encrypting", async () => {
    const bad = { ...payload(), entries: [{ ...entry({}), status: "synced" }] } as unknown as QueueExportPayload;
    await expect(encryptQueueExport(bad, PASS, FAST)).rejects.toMatchObject({ code: "bad-format" });
  });
});

describe("secret hygiene helpers", () => {
  it("redacts credential-looking keys at any depth and counts them", () => {
    const counter = { n: 0 };
    const out = redactSecrets({
      p_reason: "ok", access_token: "A", nested: { refresh_token: "R", list: [{ password: "P", apikey: "K" }] },
      p_idempotency_key: "keep-me", p_expected_actor_id: "keep-me-too", session: { anything: 1 },
    }, counter);
    expect(out).toEqual({
      p_reason: "ok", access_token: "[REDACTED]", nested: { refresh_token: "[REDACTED]", list: [{ password: "[REDACTED]", apikey: "[REDACTED]" }] },
      p_idempotency_key: "keep-me", p_expected_actor_id: "keep-me-too", session: "[REDACTED]",
    });
    expect(counter.n).toBe(5);
  });

  it("finds known secret values anywhere in the serialized export", () => {
    expect(() => assertNoSecretValues('{"p_reason":"eyJhbGciOi.canary.token"}', ["eyJhbGciOi.canary.token"]))
      .toThrow(expect.objectContaining({ code: "secret-detected" }));
    expect(() => assertNoSecretValues('{"a":"short"}', ["short", null, undefined])).not.toThrow();
  });
});

describe("ordering, summary and file name", () => {
  it("orders by seq; pre-seq rows first by createdAt", () => {
    const rows = [
      entry({ seq: 3, opId: "c", createdAt: "2026-10-13T00:00:00.000Z" }),
      entry({ seq: 1, opId: "a", createdAt: "2026-10-13T09:00:00.000Z" }),
      entry({ seq: null, opId: "z", createdAt: "2026-10-13T05:00:00.000Z" }),
      entry({ seq: 2, opId: "b", createdAt: "2026-10-13T09:00:00.000Z" }),
      entry({ seq: null, opId: "y", createdAt: "2026-10-13T04:00:00.000Z" }),
    ];
    expect(inQueueOrder(rows).map((r) => r.opId)).toEqual(["y", "z", "a", "b", "c"]);
  });

  it("summarizes counts only", () => {
    expect(summarize([entry({}), entry({ status: "conflict", opType: "open_shift" })])).toEqual({
      total: 2, byStatus: { pending: 1, conflict: 1 }, byOpType: { complete_sale: 1, open_shift: 1 },
    });
  });

  it("canonical JSON sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}');
  });

  it("default file name carries the till and the UTC date/time", () => {
    expect(defaultExportFileName("till-ab12cd", new Date("2026-10-13T07:05:09.123Z")))
      .toBe("pending-queue-till-ab12cd-20261013-070509Z.spqx");
    expect(defaultExportFileName("../../etc", new Date("2026-10-13T07:05:09Z"))).toBe("pending-queue-etc-20261013-070509Z.spqx");
  });
});
