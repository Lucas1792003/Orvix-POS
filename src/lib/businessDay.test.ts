import { describe, expect, it } from "vitest";
import {
  BUSINESS_TIME_ZONE,
  addDays,
  businessDayKey,
  businessDayRangeUtc,
  businessDayStart,
  businessToday,
  dayKeyToDisplayDate,
  isDayKey,
  isWithinBusinessDays,
  monthStartKey,
  nextMonthStartKey,
} from "./businessDay";

// Every case uses explicit UTC instants, so the result does not depend on
// the time zone of the machine running the tests.

describe("businessDayKey (Asia/Yangon, UTC+06:30)", () => {
  it("is the business zone", () => {
    expect(BUSINESS_TIME_ZONE).toBe("Asia/Yangon");
  });

  it("puts 00:00–06:29 Yangon on the Yangon date, not the earlier UTC date (ORV-069)", () => {
    // 2026-10-18T17:30Z = 2026-10-19 00:00 Yangon
    expect(businessDayKey("2026-10-18T17:30:00.000Z")).toBe("2026-10-19");
    // 2026-10-18T23:59Z = 2026-10-19 06:29 Yangon; its UTC date is the 18th
    expect("2026-10-18T23:59:00.000Z".slice(0, 10)).toBe("2026-10-18");
    expect(businessDayKey("2026-10-18T23:59:00.000Z")).toBe("2026-10-19");
  });

  it("keeps the last minute before Yangon midnight on the previous day", () => {
    expect(businessDayKey("2026-10-18T17:29:59.999Z")).toBe("2026-10-18");
  });

  it("accepts server timestamps with an offset", () => {
    expect(businessDayKey("2026-10-19T00:15:00+00:00")).toBe("2026-10-19");
    expect(businessDayKey("2026-10-18T20:00:00+00:00")).toBe("2026-10-19");
  });

  it("accepts Date and epoch ms", () => {
    const ms = Date.parse("2026-10-18T17:30:00Z");
    expect(businessDayKey(ms)).toBe("2026-10-19");
    expect(businessDayKey(new Date(ms))).toBe("2026-10-19");
  });

  it("returns null for unparseable input", () => {
    expect(businessDayKey("not-a-date")).toBeNull();
    expect(businessDayKey(Number.NaN)).toBeNull();
  });

  it("supports another zone explicitly", () => {
    expect(businessDayKey("2026-10-18T23:59:00Z", "UTC")).toBe("2026-10-18");
  });
});

describe("businessDayStart / businessDayRangeUtc", () => {
  it("begins a Yangon day at 17:30 UTC the day before", () => {
    expect(businessDayStart("2026-10-19").toISOString()).toBe("2026-10-18T17:30:00.000Z");
  });

  it("round-trips with businessDayKey at the boundary", () => {
    const start = businessDayStart("2026-03-01");
    expect(businessDayKey(start)).toBe("2026-03-01");
    expect(businessDayKey(start.getTime() - 1)).toBe("2026-02-28");
  });

  it("builds a half-open UTC interval for inclusive business days", () => {
    expect(businessDayRangeUtc("2026-10-01", "2026-10-19")).toEqual({
      from: "2026-09-30T17:30:00.000Z",
      toExclusive: "2026-10-19T17:30:00.000Z",
    });
  });

  it("handles a single day and a year boundary", () => {
    expect(businessDayRangeUtc("2026-12-31", "2026-12-31")).toEqual({
      from: "2026-12-30T17:30:00.000Z",
      toExclusive: "2026-12-31T17:30:00.000Z",
    });
  });

  it("rejects malformed and impossible day keys", () => {
    expect(() => businessDayStart("2026-2-1")).toThrow(RangeError);
    expect(() => businessDayStart("2026-02-31")).toThrow(RangeError);
  });

  it("finds local midnight in a zone with daylight saving", () => {
    // New York, first day of DST (2026-03-08): midnight is still EST (-05:00).
    expect(businessDayStart("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    // The day after, midnight is EDT (-04:00).
    expect(businessDayStart("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("day-key arithmetic", () => {
  it("adds and subtracts days across months and years", () => {
    expect(addDays("2026-10-19", -7)).toBe("2026-10-12");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("finds month starts", () => {
    expect(monthStartKey("2026-10-19")).toBe("2026-10-01");
    expect(nextMonthStartKey("2026-10-19")).toBe("2026-11-01");
    expect(nextMonthStartKey("2026-12-05")).toBe("2027-01-01");
  });

  it("validates keys", () => {
    expect(isDayKey("2026-10-19")).toBe(true);
    expect(isDayKey("2026-13-01")).toBe(false);
    expect(isDayKey("20261019")).toBe(false);
  });
});

describe("businessToday / isWithinBusinessDays", () => {
  it("uses the business zone for 'today'", () => {
    // 01:00 Yangon on the 19th — still the 18th in UTC.
    expect(businessToday(new Date("2026-10-18T18:30:00Z"))).toBe("2026-10-19");
  });

  it("filters an instant by inclusive business days", () => {
    const earlyMorning = "2026-10-18T19:00:00Z"; // 01:30 Yangon on the 19th
    expect(isWithinBusinessDays(earlyMorning, "2026-10-19", "2026-10-19")).toBe(true);
    expect(isWithinBusinessDays(earlyMorning, "2026-10-01", "2026-10-18")).toBe(false);
    expect(isWithinBusinessDays(earlyMorning, "", undefined)).toBe(true);
    expect(isWithinBusinessDays("garbage", "", "")).toBe(false);
  });
});

describe("dayKeyToDisplayDate", () => {
  it("is the same calendar date on this device", () => {
    const d = dayKeyToDisplayDate("2026-10-19");
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 19]);
  });
});
