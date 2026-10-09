import { test, expect } from "@playwright/test";
import { isFutureDate, daysAgo, canEditAttendance, calculateAttendanceSummary, AttendanceStatus } from "@/lib/attendance/rules";

test.describe("Attendance Pure Rules", () => {
  const fixedNow = new Date("2026-10-15T12:00:00Z");

  test("isFutureDate accurately distinguishes past, today, and future dates", () => {
    expect(isFutureDate("2026-10-14", fixedNow)).toBe(false);
    expect(isFutureDate("2026-10-15", fixedNow)).toBe(false);
    expect(isFutureDate("2026-10-16", fixedNow)).toBe(true);
    expect(isFutureDate("2027-01-01", fixedNow)).toBe(true);
  });

  test("daysAgo computes elapsed whole days", () => {
    expect(daysAgo("2026-10-15", fixedNow)).toBe(0);
    expect(daysAgo("2026-10-14", fixedNow)).toBe(1);
    expect(daysAgo("2026-10-08", fixedNow)).toBe(7);
    expect(daysAgo("2026-10-01", fixedNow)).toBe(14);
  });

  test("canEditAttendance enforces role boundaries and edit windows", () => {
    // Future date is always rejected
    expect(canEditAttendance("2026-10-16", "ADMIN", fixedNow)).toBe(false);
    expect(canEditAttendance("2026-10-16", "TEACHING_STAFF", fixedNow)).toBe(false);

    // Today is allowed for both ADMIN and TEACHING_STAFF
    expect(canEditAttendance("2026-10-15", "ADMIN", fixedNow)).toBe(true);
    expect(canEditAttendance("2026-10-15", "TEACHING_STAFF", fixedNow)).toBe(true);

    // 5 days ago: allowed for both
    expect(canEditAttendance("2026-10-10", "ADMIN", fixedNow)).toBe(true);
    expect(canEditAttendance("2026-10-10", "TEACHING_STAFF", fixedNow)).toBe(true);

    // 7 days ago: boundary case (allowed)
    expect(canEditAttendance("2026-10-08", "TEACHING_STAFF", fixedNow, 7)).toBe(true);

    // 8 days ago: allowed for ADMIN, forbidden for TEACHING_STAFF
    expect(canEditAttendance("2026-10-07", "ADMIN", fixedNow, 7)).toBe(true);
    expect(canEditAttendance("2026-10-07", "TEACHING_STAFF", fixedNow, 7)).toBe(false);

    // Other roles forbidden
    expect(canEditAttendance("2026-10-15", "STUDENT", fixedNow)).toBe(false);
    expect(canEditAttendance("2026-10-15", "PARENT", fixedNow)).toBe(false);
    expect(canEditAttendance("2026-10-15", "NON_TEACHING_STAFF", fixedNow)).toBe(false);
  });

  test("calculateAttendanceSummary computes accurate counts and rates", () => {
    const records = [
      { status: AttendanceStatus.PRESENT },
      { status: AttendanceStatus.PRESENT },
      { status: AttendanceStatus.LATE },
      { status: AttendanceStatus.ABSENT },
      { status: AttendanceStatus.EXCUSED },
    ];

    const summary = calculateAttendanceSummary(records, 5);
    expect(summary.total).toBe(5);
    expect(summary.present).toBe(2);
    expect(summary.late).toBe(1);
    expect(summary.absent).toBe(1);
    expect(summary.excused).toBe(1);
    // (2 present + 1 late) / 5 = 60%
    expect(summary.ratePercent).toBe(60);
  });

  test("calculateAttendanceSummary handles zero records gracefully", () => {
    const summary = calculateAttendanceSummary([], 0);
    expect(summary.total).toBe(0);
    expect(summary.ratePercent).toBe(0);
  });
});
