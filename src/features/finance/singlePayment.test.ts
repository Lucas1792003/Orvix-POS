import { describe, expect, it } from "vitest";
import { singlePayment } from "./payments";

// Step 6 (PFIN-F, f10): no change is ever given from a non-cash payment.
describe("singlePayment", () => {
  it("cash may be received above the total (the change)", () => {
    expect(singlePayment("CASH", 5_000, 4_200)).toEqual({ paidMmk: 5_000, changeMmk: 800, ok: true });
    expect(singlePayment("CASH", 4_000, 4_200)).toEqual({ paidMmk: 4_000, changeMmk: 0, ok: false });
  });
  it("a non-cash payment is recorded for exactly the amount due, whatever was typed", () => {
    expect(singlePayment("OTHER", 5_000, 4_200)).toEqual({ paidMmk: 4_200, changeMmk: 0, ok: true });
    expect(singlePayment("OTHER", 0, 4_200)).toEqual({ paidMmk: 4_200, changeMmk: 0, ok: true });
  });
});
