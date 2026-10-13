// Unit proof for the consistency gate's duplicate-sale detection
// (saleLedger.ts). Runs under `npm test` (vitest picks up *.test.ts).
import { describe, expect, it } from "vitest";
import { instant, saleLedgerViolations, type LedgerKey, type LedgerSale } from "./saleLedger";

const sale = (id: string, receipt: number, createdAt: string, over: Partial<LedgerSale> = {}): LedgerSale => ({
  id, shop_id: "qa-shop", shift_id: "qa-shift", cashier_id: "qa-cashier", receipt_no: `QA-20261013-${String(receipt).padStart(4, "0")}`, created_at: createdAt, ...over,
});
const key = (k: string, saleId: string | null): LedgerKey => ({ key: k, rpc: "complete_sale", response: saleId ? { sale: { id: saleId, shopId: "qa-shop" } } : null });
const checks = (r: ReturnType<typeof saleLedgerViolations>) => r.violations.map((v) => v.check);

describe("saleLedgerViolations", () => {
  it("PASSES two distinct queued sales of the same basket rung up back to back (the old 2 s heuristic flagged this)", () => {
    // same shift, same total, same lines, 400 ms apart, each with its own key
    const sales = [sale("s1", 1, "2026-10-13T08:00:00.100+00:00"), sale("s2", 2, "2026-10-13T08:00:00.500+00:00")];
    const keys = [key("k1", "s1"), key("k2", "s2")];
    const clientCalls = [
      { terminal: "A", key: "k1", createdAt: "2026-10-13T08:00:00.100Z" },
      { terminal: "A", key: "k2", createdAt: "2026-10-13T08:00:00.500Z" },
      { terminal: "A", key: "k1", createdAt: "2026-10-13T08:00:00.100Z" }, // replay after a lost response: same key
    ];
    expect(saleLedgerViolations({ sales, keys, clientCalls }).violations).toEqual([]);
  });

  it("FAILS a forged second sale row for an existing operation (same client event, no key of its own)", () => {
    const sales = [sale("s1", 1, "2026-10-13T08:00:00.100+00:00"), sale("s1-copy", 2, "2026-10-13T08:00:00.100+00:00")];
    const r = saleLedgerViolations({ sales, keys: [key("k1", "s1")] });
    expect(checks(r)).toContain("sale without a committed idempotency key");
    expect(checks(r)).toContain("duplicate sale: one client operation applied more than once");
  });

  it("FAILS one UI operation sent twice under different keys (both committed) - server and terminal ledger", () => {
    const sales = [sale("s1", 1, "2026-10-13T08:00:00.100+00:00"), sale("s2", 2, "2026-10-13T08:00:00.100+00:00")];
    const keys = [key("k1", "s1"), key("k2", "s2")];
    const clientCalls = [
      { terminal: "A", key: "k1", createdAt: "2026-10-13T08:00:00.100Z" },
      { terminal: "A", key: "k2", createdAt: "2026-10-13T08:00:00.100Z" },
    ];
    const r = saleLedgerViolations({ sales, keys, clientCalls });
    expect(checks(r)).toEqual(["duplicate sale: one client operation applied more than once", "client replayed one operation under a new key"]);
  });

  it("FAILS a duplicate even when it lands much later than 2 s (a delayed replay)", () => {
    // stored created_at is the client's event time, so the server-side commit time does not matter
    const sales = [sale("s1", 1, "2026-10-13T08:00:00.100+00:00"), sale("s2", 7, "2026-10-13T08:00:00.100+00:00")];
    expect(checks(saleLedgerViolations({ sales, keys: [key("k1", "s1"), key("k2", "s2")] }))).toContain("duplicate sale: one client operation applied more than once");
  });

  it("FAILS a lost sale, a sale claimed twice, a duplicate receipt and a key reused for another operation", () => {
    const sales = [sale("s1", 1, "2026-10-13T08:00:00.100+00:00"), sale("s2", 1, "2026-10-13T08:00:01.100+00:00", { cashier_id: "qa-cashier-b" })];
    const keys = [key("k1", "s1"), key("k1b", "s1"), key("k2", "s2"), key("k3", "gone")];
    const clientCalls = [{ terminal: "B", key: "k9", createdAt: "2026-10-13T08:00:02Z" }, { terminal: "B", key: "k9", createdAt: "2026-10-13T08:00:03Z" }];
    expect(checks(saleLedgerViolations({ sales, keys, clientCalls }))).toEqual([
      "committed key without its sale (lost sale)",
      "sale claimed by several keys",
      "duplicate receipt number",
      "one key sent for different operations",
    ]);
  });

  it("keeps distinct server-stamped times distinct (µs) and equates spellings of one instant", () => {
    expect(instant("2026-10-13T08:00:00.123456+00:00")).not.toBe(instant("2026-10-13T08:00:00.123457+00:00"));
    expect(instant("2026-10-13T08:00:00.1+00:00")).toBe(instant("2026-10-13T08:00:00.100Z"));
    expect(instant("2026-10-13T10:30:00.5+02:00")).toBe(instant("2026-10-13T08:30:00.500Z"));
  });
});
