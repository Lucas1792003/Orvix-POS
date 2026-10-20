import { describe, expect, it } from "vitest";
import { rangedSalesBounds } from "./useRangedSales";

// The profit report's server query used `${start}T00:00:00` …
// `${end}T23:59:59.999` with no offset — compared in the server's UTC
// session zone, so 00:00–06:30 Yangon sales fell on the previous day
// (ORV-069). The bounds are now the UTC instants of Yangon midnight.

describe("rangedSalesBounds", () => {
  it("covers Yangon business days inclusively, as UTC instants", () => {
    expect(rangedSalesBounds("2026-10-01", "2026-10-19")).toEqual({
      from: "2026-09-30T17:30:00.000Z",
      to: "2026-10-19T17:29:59.999999Z",
    });
  });

  it("includes an early-morning sale on the first day and excludes the next day's first instant", () => {
    const { from, to } = rangedSalesBounds("2026-10-19", "2026-10-19");
    const earlyMorning = "2026-10-18T18:00:00.000Z"; // 00:30 Yangon on the 19th
    const nextDay = "2026-10-19T17:30:00.000Z"; // 00:00 Yangon on the 20th
    expect(earlyMorning >= from && earlyMorning <= to).toBe(true);
    expect(nextDay <= to).toBe(false);
  });

  it("carries explicit Z offsets (no server-zone interpretation)", () => {
    const { from, to } = rangedSalesBounds("2026-12-31", "2027-01-01");
    expect(from.endsWith("Z")).toBe(true);
    expect(to.endsWith("Z")).toBe(true);
    expect(to).toBe("2027-01-01T17:29:59.999999Z");
  });
});

describe("rangedSalesBounds — microsecond timestamps", () => {
  it("keeps a sale stamped in the last millisecond of the day (Postgres keeps microseconds)", () => {
    const { to } = rangedSalesBounds("2026-10-19", "2026-10-19");
    // Lexical order equals time order for same-format UTC ISO strings.
    expect("2026-10-19T17:29:59.999400Z" <= to).toBe(true);
    expect("2026-10-19T17:30:00.000000Z" <= to).toBe(false);
  });
});
