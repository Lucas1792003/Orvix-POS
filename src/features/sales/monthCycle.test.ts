import { describe, expect, it } from "vitest";
import { formatMonthLabel, getMonthBounds, inCurrentMonth } from "./monthCycle";
import { getLocalDateValue } from "./dailySalesReport";

// The Sales page month and the daily CSV day follow business days in
// Asia/Yangon (ORV-069), whatever zone the device or test machine is in.

describe("getMonthBounds (business month)", () => {
  it("starts and ends the month at Yangon midnight", () => {
    const bounds = getMonthBounds(new Date("2026-10-19T05:00:00Z"));
    expect(new Date(bounds.thisStart).toISOString()).toBe("2026-09-30T17:30:00.000Z");
    expect(new Date(bounds.nextStart).toISOString()).toBe("2026-10-31T17:30:00.000Z");
  });

  it("is already next month in Yangon before it is in UTC", () => {
    // 2026-10-31T18:00Z = 2026-11-01 00:30 Yangon.
    const bounds = getMonthBounds(new Date("2026-10-31T18:00:00Z"));
    expect(new Date(bounds.thisStart).toISOString()).toBe("2026-10-31T17:30:00.000Z");
    expect(formatMonthLabel(bounds)).toBe("November 2026");
  });

  it("rolls over the year", () => {
    const bounds = getMonthBounds(new Date("2026-12-15T00:00:00Z"));
    expect(new Date(bounds.nextStart).toISOString()).toBe("2026-12-31T17:30:00.000Z");
  });

  it("keeps a sale from 01:00 Yangon on the 1st in the new month", () => {
    const bounds = getMonthBounds(new Date("2026-10-19T05:00:00Z"));
    expect(inCurrentMonth("2026-09-30T19:30:00Z", bounds)).toBe(true); // Oct 1, 02:00 Yangon
    expect(inCurrentMonth("2026-09-30T17:29:59Z", bounds)).toBe(false); // Sep 30, 23:59 Yangon
  });

  it("names the month in the business zone", () => {
    expect(formatMonthLabel(getMonthBounds(new Date("2026-06-10T00:00:00Z")))).toBe("June 2026");
  });
});

describe("getLocalDateValue (daily report day)", () => {
  it("is the Yangon business day, not the UTC date", () => {
    expect(getLocalDateValue("2026-10-18T23:00:00Z")).toBe("2026-10-19");
    expect(getLocalDateValue("2026-10-18T17:29:00Z")).toBe("2026-10-18");
  });

  it("matches no day for an unparseable timestamp", () => {
    expect(getLocalDateValue("nope")).toBe("");
  });
});
