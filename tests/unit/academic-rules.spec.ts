import "../support/env";
import { test, expect } from "@playwright/test";
import {
  addYears,
  checkPeriodDates,
  checkSessionDates,
  cleanName,
  currentSessionFor,
  findOverlap,
  findPeriodOverlap,
  fromIsoDate,
  isIsoDate,
  nextSessionLabel,
  periodKindFor,
  rangesOverlap,
  toIsoDate,
  wholeYearsBetween,
} from "@/lib/academics/rules";

// The pure rules of the academic calendar (plan "Build design — Phase 1.0 and 1.1", decisions 9–12, 16). Every boundary is spelled out.

test.describe("dates", () => {
  test("isIsoDate accepts only real calendar days in the exact format", () => {
    for (const ok of ["2026-01-01", "2028-02-29", "2026-12-31", "0999-01-01"]) expect(isIsoDate(ok), ok).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-1-5",
      "26-01-01",
      "2026/01/01",
      "2026-01-01T00:00:00Z",
      " 2026-01-01",
      "",
      null,
      undefined,
      20260101,
      new Date(),
    ]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });

  test("a DATE column's Date round-trips through the string form", () => {
    expect(toIsoDate(fromIsoDate("2026-09-07"))).toBe("2026-09-07");
    expect(fromIsoDate("2026-09-07").toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  test("addYears keeps the month and day, and 29 February lands on 28 February in a common year", () => {
    expect(addYears("2026-09-07", 1)).toBe("2027-09-07");
    expect(addYears("2026-09-07", -1)).toBe("2025-09-07");
    expect(addYears("2028-02-29", 1)).toBe("2029-02-28");
    expect(addYears("2028-02-29", 4)).toBe("2032-02-29");
    expect(addYears("2026-12-31", 2)).toBe("2028-12-31");
    expect(addYears("2026-01-01", 0)).toBe("2026-01-01");
  });

  test("wholeYearsBetween counts calendar years of the START dates only", () => {
    expect(wholeYearsBetween("2026-09-07", "2027-09-04")).toBe(1);
    expect(wholeYearsBetween("2026-09-07", "2026-09-07")).toBe(0);
    expect(wholeYearsBetween("2026-09-07", "2028-01-01")).toBe(2);
  });
});

test.describe("period kind by school type", () => {
  test("K12 → TERM, HIGHER_ED → SEMESTER, VOCATIONAL → COHORT", () => {
    expect(periodKindFor("K12")).toBe("TERM");
    expect(periodKindFor("HIGHER_ED")).toBe("SEMESTER");
    expect(periodKindFor("VOCATIONAL")).toBe("COHORT");
  });
});

test.describe("overlap", () => {
  const r = (start: string, end: string | null) => ({ start, end });
  test("ranges are inclusive at both ends: sharing a single day IS an overlap, adjacent days are not", () => {
    expect(rangesOverlap(r("2026-01-01", "2026-03-31"), r("2026-03-31", "2026-06-30"))).toBe(true); // share 31 March
    expect(rangesOverlap(r("2026-01-01", "2026-03-31"), r("2026-04-01", "2026-06-30"))).toBe(false); // adjacent
    expect(rangesOverlap(r("2026-04-01", "2026-06-30"), r("2026-01-01", "2026-03-31"))).toBe(false); // symmetric
    expect(rangesOverlap(r("2026-01-01", "2026-12-31"), r("2026-05-01", "2026-05-02"))).toBe(true); // contained
    expect(rangesOverlap(r("2026-05-01", "2026-05-02"), r("2026-01-01", "2026-12-31"))).toBe(true);
    expect(rangesOverlap(r("2026-01-01", "2026-01-01"), r("2026-01-01", "2026-01-01"))).toBe(true); // the same single day
  });
  test("an open end runs forever", () => {
    expect(rangesOverlap(r("2026-01-01", null), r("2030-01-01", "2030-02-01"))).toBe(true);
    expect(rangesOverlap(r("2026-01-01", null), r("2025-01-01", "2025-12-31"))).toBe(false);
    expect(rangesOverlap(r("2026-01-01", null), r("2025-01-01", "2026-01-01"))).toBe(true); // ends on the day it starts
    expect(rangesOverlap(r("2026-01-01", null), r("2027-01-01", null))).toBe(true);
  });
  test("findOverlap returns the colliding one, or null", () => {
    const others = [
      { id: "a", ...r("2025-09-01", "2026-07-31") },
      { id: "b", ...r("2026-09-01", "2027-07-31") },
    ];
    expect(findOverlap(r("2026-08-01", "2026-08-31"), others)).toBeNull();
    expect(findOverlap(r("2026-07-31", "2026-09-01"), others)?.id).toBe("a"); // touches both ends: first collision
    expect(findOverlap(r("2027-07-31", "2028-01-01"), others)?.id).toBe("b");
    expect(findOverlap(r("2026-01-01", "2026-12-31"), [])).toBeNull();
  });
});

test.describe("session dates", () => {
  test("two real days, the end STRICTLY after the start", () => {
    expect(checkSessionDates("2026-09-07", "2027-07-23")).toBeNull();
    expect(checkSessionDates("2026-09-07", "2026-09-08")).toBeNull(); // one day later is enough
    expect(checkSessionDates("2026-09-07", "2026-09-07")).toBe("END_NOT_AFTER_START");
    expect(checkSessionDates("2026-09-08", "2026-09-07")).toBe("END_NOT_AFTER_START");
    expect(checkSessionDates("2026-02-30", "2027-01-01")).toBe("START_INVALID");
    expect(checkSessionDates("2026-09-07", "soon")).toBe("END_INVALID");
    expect(checkSessionDates(undefined, "2027-01-01")).toBe("START_INVALID");
  });
});

test.describe("period dates", () => {
  const session = { start: "2026-09-07", end: "2027-07-23" };
  test("a TERM or SEMESTER needs an end after its start, and lies inside the session — both ends inclusive", () => {
    for (const kind of ["TERM", "SEMESTER"] as const) {
      expect(checkPeriodDates(kind, "2026-09-07", "2026-12-18", session), kind).toBeNull();
      expect(checkPeriodDates(kind, "2026-09-07", "2027-07-23", session), "the whole session").toBeNull();
      expect(checkPeriodDates(kind, "2026-09-06", "2026-12-18", session)).toBe("OUTSIDE_SESSION"); // a day early
      expect(checkPeriodDates(kind, "2026-09-07", "2027-07-24", session)).toBe("OUTSIDE_SESSION"); // a day late
      expect(checkPeriodDates(kind, "2027-07-24", "2027-07-25", session)).toBe("OUTSIDE_SESSION");
      expect(checkPeriodDates(kind, "2026-09-07", null, session)).toBe("END_REQUIRED");
      expect(checkPeriodDates(kind, "2026-09-07", undefined, session)).toBe("END_REQUIRED");
      expect(checkPeriodDates(kind, "2026-10-01", "2026-10-01", session)).toBe("END_NOT_AFTER_START");
      expect(checkPeriodDates(kind, "2026-10-02", "2026-10-01", session)).toBe("END_NOT_AFTER_START");
      expect(checkPeriodDates(kind, "nope", "2026-10-01", session)).toBe("START_INVALID");
      expect(checkPeriodDates(kind, "2026-10-01", "2026-13-01", session)).toBe("END_INVALID");
    }
  });
  test("a COHORT may run without an end, but must START inside the session; with an end it is held to the session like any other", () => {
    expect(checkPeriodDates("COHORT", "2026-09-07", null, session)).toBeNull();
    expect(checkPeriodDates("COHORT", "2027-07-23", null, session)).toBeNull(); // starts on the last day
    expect(checkPeriodDates("COHORT", "2027-07-24", null, session)).toBe("OUTSIDE_SESSION");
    expect(checkPeriodDates("COHORT", "2026-09-06", null, session)).toBe("OUTSIDE_SESSION");
    expect(checkPeriodDates("COHORT", "2026-10-01", "2027-08-01", session)).toBe("OUTSIDE_SESSION");
  });
  test("TERMs/SEMESTERs of one session may not overlap each other; COHORTs may overlap anything", () => {
    const terms = [{ kind: "TERM" as const, start: "2026-09-07", end: "2026-12-18" }];
    expect(findPeriodOverlap({ kind: "TERM", start: "2027-01-05", end: "2027-04-02" }, terms)).toBeNull();
    expect(findPeriodOverlap({ kind: "TERM", start: "2026-12-18", end: "2027-04-02" }, terms)).not.toBeNull(); // shares 18 December
    expect(findPeriodOverlap({ kind: "COHORT", start: "2026-09-07", end: null }, terms)).toBeNull(); // a cohort never collides
    const cohorts = [{ kind: "COHORT" as const, start: "2026-09-07", end: null }];
    expect(findPeriodOverlap({ kind: "TERM", start: "2026-09-07", end: "2026-12-18" }, cohorts)).toBeNull(); // …and is never collided with
  });
});

test.describe("the current session (decision 11)", () => {
  const s = (id: string, campusId: string | null, status: "PLANNED" | "ACTIVE" | "CLOSED", archived = false) => ({
    id,
    campusId,
    status,
    archived,
  });
  test("a campus's own ACTIVE session shadows the school-wide one; another campus falls back to the school-wide", () => {
    const sessions = [s("wide", null, "ACTIVE"), s("north", "n", "ACTIVE"), s("south-planned", "s", "PLANNED")];
    expect(currentSessionFor("n", sessions)?.id).toBe("north");
    expect(currentSessionFor("s", sessions)?.id).toBe("wide"); // its own is only PLANNED
    expect(currentSessionFor("other", sessions)?.id).toBe("wide");
    expect(currentSessionFor(null, sessions)?.id).toBe("wide"); // asking for the school-wide one
  });
  test("closed and archived sessions are never current; nothing active → null; a campus-only school resolves per campus", () => {
    expect(currentSessionFor("n", [s("a", "n", "CLOSED"), s("b", "n", "ACTIVE", true)])).toBeNull();
    expect(currentSessionFor(null, [s("north", "n", "ACTIVE")])).toBeNull(); // no school-wide session, and the school-wide ask ignores campus ones
    expect(currentSessionFor("n", [s("north", "n", "ACTIVE")])?.id).toBe("north");
    expect(currentSessionFor("n", [])).toBeNull();
  });
});

test.describe("labels and names", () => {
  test("nextSessionLabel moves both years on, keeping the separator; anything else is left to the person", () => {
    expect(nextSessionLabel("2026/2027")).toBe("2027/2028");
    expect(nextSessionLabel("2026-2027")).toBe("2027-2028");
    expect(nextSessionLabel("2026 / 2027")).toBe("2027 / 2028");
    expect(nextSessionLabel(" 2026/2027 ")).toBe("2027/2028");
    expect(nextSessionLabel("2026")).toBeNull();
    expect(nextSessionLabel("Autumn 2026")).toBeNull();
    expect(nextSessionLabel("2026/27")).toBeNull();
  });
  test("cleanName trims and collapses whitespace, and refuses empty or over-long", () => {
    expect(cleanName("  2026   /  2027 ", 40)).toBe("2026 / 2027");
    expect(cleanName("a".repeat(40), 40)).toBe("a".repeat(40));
    expect(cleanName("a".repeat(41), 40)).toBeNull();
    expect(cleanName("   ", 40)).toBeNull();
    expect(cleanName("", 40)).toBeNull();
    expect(cleanName(42, 40)).toBeNull();
    expect(cleanName(null, 40)).toBeNull();
  });
});
