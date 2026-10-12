import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  applyRecordedWrites, beginWriteRecording, deleteLocalRows, endWriteRecording, putLocalRows,
} from "./localWrites";
import type { Sale, Shift } from "../../types";

const shift = (id: string, endedAt?: string): Shift => ({
  id, shopId: "shop-1", cashierId: "user-1", startedAt: "2026-10-12T08:00:00Z", openingCashMmk: 0, endedAt,
});
const sale = (id: string): Sale => ({
  id, shopId: "shop-1", shiftId: "shift-1", receiptNo: `R-${id}`, cashierId: "user-1", status: "NORMAL",
  subtotalMmk: 1000, discountMmk: 0, cartDiscountPct: 0, totalMmk: 1000, paymentMethod: "CASH", paidMmk: 1000,
  changeMmk: 0, createdAt: "2026-10-12T08:01:00Z",
});

describe("writes that land during an in-flight full load", () => {
  it("records puts/deletes only between begin and end, and re-applies them on top of the snapshot", async () => {
    await putLocalRows({ shifts: [shift("shift-before")] }); // not recording: ignored
    const recorder = beginWriteRecording();
    const overlapping = beginWriteRecording(); // a second load in flight at the same time
    await putLocalRows({ shifts: [shift("shift-new")], sales: [sale("sale-new")] });
    await putLocalRows({ shifts: [shift("shift-old", "2026-10-12T09:00:00Z")], inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 7 }] });
    await deleteLocalRows([{ table: "sales", ids: ["sale-provisional"] }]);
    const writes = endWriteRecording(recorder);
    expect(writes.puts).toHaveLength(2);
    expect(writes.deletes).toEqual([{ table: "sales", ids: ["sale-provisional"] }]);
    // both loads saw every write made during their window
    expect(endWriteRecording(overlapping)).toEqual(writes);

    // The stale snapshot: no shift-new, shift-old still open, sale-provisional still present.
    const snapshot = {
      shifts: [shift("shift-old"), shift("shift-before")],
      sales: [sale("sale-provisional"), sale("sale-existing")],
      inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 9 }, { shopId: "shop-1", productId: "p2", qtyBaseUnits: 1 }],
      users: [{ id: "u" }],
    };
    const merged = applyRecordedWrites(snapshot, writes);
    expect(merged.shifts.map((s) => s.id)).toEqual(["shift-new", "shift-old", "shift-before"]);
    expect(merged.shifts.find((s) => s.id === "shift-old")?.endedAt).toBe("2026-10-12T09:00:00Z");
    expect(merged.sales.map((s) => s.id)).toEqual(["sale-new", "sale-existing"]);
    expect(merged.inventory).toEqual([
      { shopId: "shop-1", productId: "p1", qtyBaseUnits: 7 }, { shopId: "shop-1", productId: "p2", qtyBaseUnits: 1 },
    ]);
    expect(merged.users).toEqual([{ id: "u" }]);
    // untouched when nothing was recorded, and recording is off again
    expect(applyRecordedWrites(snapshot, { puts: [], deletes: [] })).toBe(snapshot);
    await putLocalRows({ shifts: [shift("shift-after")] });
    expect(writes.puts).toHaveLength(2);
  });
});
