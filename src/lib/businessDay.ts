// ----------------------------------------------------------------------
// Business-day boundaries (ORV-069).
//
// A trading day runs midnight → midnight in the SHOP's time zone, not the
// device's and not UTC. Server timestamps arrive as UTC ISO strings, so
// `createdAt.slice(0, 10)` is the UTC date: a sale rung up in Yangon between
// 00:00 and 06:30 lands on the previous day. Device-local midnight is only
// right when the device happens to be set to the shop's zone.
//
// Every report/dashboard "day", "today", "this month" and date-range query
// goes through these helpers. Day keys are `YYYY-MM-DD` in the business zone.
//
// There is no per-organisation time-zone setting yet; every shop trades in
// Myanmar. When one is added, thread it through the `timeZone` parameters.
// The server still numbers receipts by UTC day (072); that is a separate,
// server-side fix.
// ----------------------------------------------------------------------

export const BUSINESS_TIME_ZONE = "Asia/Yangon";

export type DayKey = string;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedParts = (ms: number, timeZone: string): ZonedParts => {
  const out: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
};

/** Zone offset (ms, east of UTC positive) at the instant `ms`. */
const zoneOffsetMs = (ms: number, timeZone: string): number => {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
};

const toMs = (value: string | number | Date): number =>
  value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);

const pad2 = (n: number): string => String(n).padStart(2, "0");

const parseDayKey = (key: DayKey): { year: number; month: number; day: number } | null => {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Reject impossible dates (2026-02-31) instead of rolling them over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
};

/** True for a well-formed, real calendar `YYYY-MM-DD`. */
export const isDayKey = (key: string): boolean => parseDayKey(key) !== null;

/** The business day (`YYYY-MM-DD`) an instant falls on; null if unparseable. */
export const businessDayKey = (
  value: string | number | Date,
  timeZone: string = BUSINESS_TIME_ZONE,
): DayKey | null => {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return null;
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
};

/** Today's business day. */
export const businessToday = (now: Date = new Date(), timeZone: string = BUSINESS_TIME_ZONE): DayKey =>
  businessDayKey(now, timeZone) as DayKey;

/** `key` shifted by `days` calendar days (negative = earlier). */
export const addDays = (key: DayKey, days: number): DayKey => {
  const p = parseDayKey(key);
  if (!p) throw new RangeError(`Invalid day key: ${key}`);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

/** First day of the month that `key` is in. */
export const monthStartKey = (key: DayKey): DayKey => {
  const p = parseDayKey(key);
  if (!p) throw new RangeError(`Invalid day key: ${key}`);
  return `${p.year}-${pad2(p.month)}-01`;
};

/** First day of the month after the one `key` is in. */
export const nextMonthStartKey = (key: DayKey): DayKey => {
  const p = parseDayKey(key);
  if (!p) throw new RangeError(`Invalid day key: ${key}`);
  return p.month === 12 ? `${p.year + 1}-01-01` : `${p.year}-${pad2(p.month + 1)}-01`;
};

/** The UTC instant at which business day `key` begins (local 00:00). */
export const businessDayStart = (key: DayKey, timeZone: string = BUSINESS_TIME_ZONE): Date => {
  const p = parseDayKey(key);
  if (!p) throw new RangeError(`Invalid day key: ${key}`);
  const guess = Date.UTC(p.year, p.month - 1, p.day);
  // Two passes so a zone whose offset changes near midnight still lands on
  // local midnight (Asia/Yangon itself has a fixed +06:30 offset).
  let t = guess - zoneOffsetMs(guess, timeZone);
  t = guess - zoneOffsetMs(t, timeZone);
  return new Date(t);
};

/**
 * Half-open UTC interval `[from, toExclusive)` covering business days
 * `startKey` … `endKey` inclusive — for server range queries
 * (`gte(from)` + `lt(toExclusive)`), ISO strings with an explicit `Z`.
 */
export const businessDayRangeUtc = (
  startKey: DayKey,
  endKey: DayKey,
  timeZone: string = BUSINESS_TIME_ZONE,
): { from: string; toExclusive: string } => ({
  from: businessDayStart(startKey, timeZone).toISOString(),
  toExclusive: businessDayStart(addDays(endKey, 1), timeZone).toISOString(),
});

/** True if the instant falls on a business day within `[startKey, endKey]`. */
export const isWithinBusinessDays = (
  value: string | number | Date,
  startKey: DayKey | "" | undefined,
  endKey: DayKey | "" | undefined,
  timeZone: string = BUSINESS_TIME_ZONE,
): boolean => {
  const key = businessDayKey(value, timeZone);
  if (!key) return false;
  if (startKey && key < startKey) return false;
  if (endKey && key > endKey) return false;
  return true;
};

/**
 * A calendar-date `Date` for display only (local midnight of the key's
 * Y-M-D), so `toLocaleDateString` shows exactly that date on any device.
 * Never use it for comparisons with real timestamps.
 */
export const dayKeyToDisplayDate = (key: DayKey): Date => {
  const p = parseDayKey(key);
  if (!p) throw new RangeError(`Invalid day key: ${key}`);
  return new Date(p.year, p.month - 1, p.day);
};
