// Step 6 (PFIN-F / PDISC-A) client wrappers: online only, a fresh key per action (the same key on a transient retry),
// server refusals verbatim, capability probes that never upgrade on a failed probe.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../../lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import {
  decideFinApproval, finStep6Capabilities, parseFinApproval, parseRefundPlan, parseRefundPayoutState, requestDiscountApproval,
  resetFinStep6CapabilitiesForTests,
} from "./finCompletion";
import { localDb } from "../../lib/localDb";

const approvalJson = { id: "fa-1", shopId: "shop-1", kind: "DISCOUNT", subjectId: null,
  details: { referenceSubtotalMmk: 10000, discountMmk: 600, pct: 6, needsShopAdmin: true }, reason: "Loyal customer",
  requestedBy: "user-1", requestedAt: "2026-10-22T10:00:00Z", status: "REQUESTED", decidedBy: null, decidedAt: null,
  decisionReason: null, expiresAt: null, consumedSaleId: null };

beforeEach(async () => {
  rpc.mockReset();
  resetFinStep6CapabilitiesForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("parsers", () => {
  it("reads an approval from the RPC reply (camelCase) and from the table (snake_case)", () => {
    expect(parseFinApproval(approvalJson)).toMatchObject({ id: "fa-1", kind: "DISCOUNT", status: "REQUESTED", requestedBy: "user-1" });
    expect(parseFinApproval({ id: "fa-2", shop_id: "shop-1", kind: "REFUND_ALT_PAYOUT", subject_id: "r-1", details: {}, reason: "x",
      requested_by: "user-2", requested_at: "t", status: "REJECTED", decided_by: "user-3", decision_reason: "No" }))
      .toMatchObject({ shopId: "shop-1", subjectId: "r-1", requestedBy: "user-2", decidedBy: "user-3", decisionReason: "No" });
    expect(() => parseFinApproval({ id: "x", kind: "OTHER", status: "REQUESTED" })).toThrow();
  });
  it("reads the refund plan and payout state", () => {
    expect(parseRefundPlan({ lines: [{ saleItemId: "si-1", qtyUnits: 1, defaultMmk: 3000 }], totalMmk: 3000,
      defaultPayouts: [{ method: "CASH", amountMmk: 1800 }, { method: "BANK_TRANSFER", amountMmk: 1200 }],
      methods: [{ method: "CASH", paidMmk: 1800, attributedRefundedMmk: 0, leftMmk: 1800 }], canProposeExceptions: true }))
      .toMatchObject({ totalMmk: 3000, canProposeExceptions: true, defaultPayouts: [{ method: "CASH", amountMmk: 1800 }, { method: "BANK_TRANSFER", amountMmk: 1200 }] });
    expect(parseRefundPlan({ lines: [], totalMmk: 0, defaultPayouts: null, methods: [] }).defaultPayouts).toBeNull();
    expect(parseRefundPayoutState([{ id: "rp-1", requestId: "r-1", method: "BANK_TRANSFER", amountMmk: 1200, status: "PENDING_CONFIRMATION" }])[0])
      .toMatchObject({ status: "PENDING_CONFIRMATION", reference: null });
  });
});

describe("online-only keyed writes", () => {
  it("refused before anything is sent while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(decideFinApproval("fa-1", "APPROVE", null)).rejects.toThrow(/only while this till is connected/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a fresh v4 key per action; a transient failure is retried with the SAME key", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "upstream connect error or disconnect/reset before headers. reset reason: connection failure" }, status: 503 })
      .mockResolvedValueOnce({ data: { approval: { ...approvalJson, status: "APPROVED" }, replayed: false }, error: null, status: 200 });
    const a = await decideFinApproval("fa-1", "APPROVE", null);
    expect(a.status).toBe("APPROVED");
    expect(rpc).toHaveBeenCalledTimes(2);
    const [k1, k2] = rpc.mock.calls.map((c) => (c[1] as { p_key: string }).p_key);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    rpc.mockResolvedValueOnce({ data: { approval: approvalJson, replayed: false }, error: null, status: 200 });
    await requestDiscountApproval("shop-1", 10000, 600, "Loyal customer");
    expect((rpc.mock.calls[2][1] as { p_key: string }).p_key).not.toBe(k1);
    expect(rpc.mock.calls[2][1]).toMatchObject({ p_shop_id: "shop-1", p_reference_subtotal_mmk: 10000, p_discount_mmk: 600, p_reason: "Loyal customer" });
  });
  it("a server refusal is thrown verbatim and never retried", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "FIN_APPROVAL_SELF: you cannot decide your own request; another approver must" }, status: 400 });
    await expect(decideFinApproval("fa-1", "REJECT", "No")).rejects.toThrow(/^FIN_APPROVAL_SELF/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("finStep6Capabilities (probes)", () => {
  it("a function the server runs (and refuses) is present; 'not found' is absent; a failed probe changes nothing", async () => {
    rpc.mockImplementation(async (fn: string) => fn === "fin_refund_payout_state"
      ? { data: null, error: { code: "P0001", message: "app_require_org: sale not found" }, status: 400 }
      : { data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 });
    expect(await finStep6Capabilities({ refresh: true })).toEqual({ splitRefunds: true, discountApprovals: false });
    rpc.mockImplementation(async () => ({ data: null, error: { message: "Failed to fetch" }, status: 0 }));
    expect(await finStep6Capabilities({ refresh: true })).toEqual({ splitRefunds: true, discountApprovals: false });
  });
});
