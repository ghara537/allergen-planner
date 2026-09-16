import type { Day } from "./types.js";

/** Calendar arithmetic, isolated so DST and month-length bugs have one place
 *  to live and one place to be tested. All maths runs in UTC on purpose:
 *  "today" is a calendar day, not an instant. */

export function day(y: number, m: number, d: number): Day {
  return { year: y, month: m, day: d };
}

export function dayToUTC(d: Day): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

export function fromUTC(ms: number): Day {
  const dt = new Date(ms);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

export function addDays(n: number, to: Day): Day {
  return fromUTC(dayToUTC(to) + n * 86_400_000);
}

export function daysBetween(a: Day, b: Day): number {
  return Math.round((dayToUTC(b) - dayToUTC(a)) / 86_400_000);
}

export function compareDay(a: Day, b: Day): number {
  return dayToUTC(a) - dayToUTC(b);
}

export function dayEq(a: Day, b: Day): boolean { return compareDay(a, b) === 0; }

export function parseDay(s: string): Day {
  const [y, m, d] = s.split("-").map(Number);
  return { year: y!, month: m!, day: d! };
}

export function formatDay(d: Day): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** The ONE place the clock is read. The engine never calls this - callers do,
 *  and pass the result in, which is what keeps every result reproducible. */
export function todayLocal(): Day {
  const n = new Date();
  return { year: n.getFullYear(), month: n.getMonth() + 1, day: n.getDate() };
}
