import type { PeriodKind, SchoolType } from "@prisma/client";

// The pure rules of the academic calendar (plan "Build design — Phase 1.0 and 1.1", decisions 9–12 and 16). No database, no clock: everything here
// is a function of its arguments, so every boundary is unit-tested. Dates are `YYYY-MM-DD` strings (a calendar day, no time zone — the database
// columns are `DATE`); ranges are INCLUSIVE of both ends.

export type DateRange = { start: string; end: string | null };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/// True for a real calendar day (rejects 2026-02-30, 2026-13-01, "2026-1-5").
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/// `YYYY-MM-DD` of a `Date` that came from a `DATE` column (UTC midnight).
export const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
/// A `Date` at UTC midnight for a `DATE` column.
export const fromIsoDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/// Which kind of period a school has (decision 12): never taken from a client.
export function periodKindFor(schoolType: SchoolType): PeriodKind {
  switch (schoolType) {
    case "K12":
      return "TERM";
    case "HIGHER_ED":
      return "SEMESTER";
    case "VOCATIONAL":
      return "COHORT";
  }
}

export const compareDates = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/// Two inclusive ranges share at least one day. An open end (`null`) runs forever.
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  const aEndsBeforeBStarts = a.end !== null && compareDates(a.end, b.start) < 0;
  const bEndsBeforeAStarts = b.end !== null && compareDates(b.end, a.start) < 0;
  return !aEndsBeforeBStarts && !bEndsBeforeAStarts;
}

export type SessionDatesProblem = "START_INVALID" | "END_INVALID" | "END_NOT_AFTER_START";

/// A session needs two real days, the end strictly after the start (matches the database CHECK).
export function checkSessionDates(start: unknown, end: unknown): SessionDatesProblem | null {
  if (!isIsoDate(start)) return "START_INVALID";
  if (!isIsoDate(end)) return "END_INVALID";
  return compareDates(end, start) > 0 ? null : "END_NOT_AFTER_START";
}

/// The first of `others` whose days overlap `candidate` (sessions of one scope must not overlap), or null.
export function findOverlap<T extends { start: string; end: string | null }>(candidate: DateRange, others: readonly T[]): T | null {
  return others.find((other) => rangesOverlap(candidate, other)) ?? null;
}

export type PeriodProblem = "START_INVALID" | "END_INVALID" | "END_REQUIRED" | "END_NOT_AFTER_START" | "OUTSIDE_SESSION";

/// A period lies inside its session. TERM and SEMESTER need an end; a COHORT may run open-ended (then it only has to START inside the session).
export function checkPeriodDates(
  kind: PeriodKind,
  start: unknown,
  end: unknown,
  session: { start: string; end: string },
): PeriodProblem | null {
  if (!isIsoDate(start)) return "START_INVALID";
  if (end !== null && end !== undefined && !isIsoDate(end)) return "END_INVALID";
  const hasEnd = typeof end === "string";
  if (!hasEnd && kind !== "COHORT") return "END_REQUIRED";
  if (hasEnd && compareDates(end as string, start) <= 0) return "END_NOT_AFTER_START";
  if (compareDates(start, session.start) < 0 || compareDates(start, session.end) > 0) return "OUTSIDE_SESSION";
  if (hasEnd && compareDates(end as string, session.end) > 0) return "OUTSIDE_SESSION";
  return null;
}

/// TERMs and SEMESTERs of one session may not overlap each other; COHORTs may (concurrent intakes). Returns the one that collides, or null.
export function findPeriodOverlap<T extends { kind: PeriodKind; start: string; end: string | null }>(
  candidate: { kind: PeriodKind; start: string; end: string | null },
  others: readonly T[],
): T | null {
  if (candidate.kind === "COHORT") return null;
  return others.find((other) => other.kind !== "COHORT" && rangesOverlap(candidate, other)) ?? null;
}

export type SessionStatusName = "PLANNED" | "ACTIVE" | "CLOSED";
export type SessionLike = {
  id: string;
  campusId: string | null;
  status: SessionStatusName;
  archived: boolean;
  /// A scheduled close (ISO string or Date), if any. Optional so callers that never schedule one need not carry it.
  closeAt?: string | Date | null;
};

/// Closing is scheduled (plan, "closing a session takes time"): a day ahead, or a minute ahead when the administrator proves who they are.
export const CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;
export const FORCE_CLOSE_DELAY_MS = 60 * 1000;

/// The status a session really has at `now`: an ACTIVE session whose scheduled close has passed is CLOSED — whether or not anything has written
/// that down yet. Every view and every guard uses this, so a due session is read-only the instant it is due.
export function effectiveStatus(
  session: { status: SessionStatusName; closeAt?: string | Date | null },
  now: Date | number = Date.now(),
): SessionStatusName {
  if (session.status !== "ACTIVE" || !session.closeAt) return session.status;
  return new Date(session.closeAt).getTime() <= new Date(now).getTime() ? "CLOSED" : "ACTIVE";
}

/// A reason typed for a reopening: 5–300 characters once trimmed, no control characters.
export function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < 5 || text.length > 300 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

/// A campus's current session (decision 11): its own ACTIVE session if it has one, else the school-wide ACTIVE one, else none. The ONLY definition
/// any later phase may use. `campusId` null asks for the school-wide one. A session whose scheduled close has passed is not active.
export function currentSessionFor<T extends SessionLike>(
  campusId: string | null,
  sessions: readonly T[],
  now: Date | number = Date.now(),
): T | null {
  const live = sessions.filter((session) => effectiveStatus(session, now) === "ACTIVE" && !session.archived);
  const own = campusId === null ? undefined : live.find((session) => session.campusId === campusId);
  return own ?? live.find((session) => session.campusId === null) ?? null;
}

/// Adds whole years to a day, keeping the month and day; 29 February in a non-leap year becomes 28 February.
export function addYears(day: string, years: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const target = year + years;
  const lastOfMonth = new Date(Date.UTC(target, month, 0)).getUTCDate();
  return `${String(target).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(date, lastOfMonth)).padStart(2, "0")}`;
}

/// How many whole years the new session starts after the old one (copy-forward shifts every date by this).
export function wholeYearsBetween(oldStart: string, newStart: string): number {
  return Number(newStart.slice(0, 4)) - Number(oldStart.slice(0, 4));
}

/// "2026/2027" → "2027/2028" (and "2026-2027", "2026 / 2027"); anything else → null (the administrator then types the label).
export function nextSessionLabel(label: string): string | null {
  const match = /^(\d{4})(\s*[/-]\s*)(\d{4})$/.exec(label.trim());
  if (!match) return null;
  const [first, separator, second] = [Number(match[1]), match[2], Number(match[3])];
  return `${first + 1}${separator}${second + 1}`;
}

/// A trimmed, whitespace-collapsed name; empty or over `max` → null. (Labels and names are compared exactly after this.)
export function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length >= 1 && cleaned.length <= max ? cleaned : null;
}
