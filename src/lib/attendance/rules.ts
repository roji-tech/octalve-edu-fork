import { AttendanceStatus, AttendanceSource } from "@prisma/client";

export { AttendanceStatus, AttendanceSource };

export const ATTENDANCE_STATUSES = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.ABSENT,
  AttendanceStatus.LATE,
  AttendanceStatus.EXCUSED,
] as const;

export const MAX_TEACHER_EDIT_DAYS = 7;

/**
 * Checks whether an ISO date string (YYYY-MM-DD) represents a future date relative to `now`.
 */
export function isFutureDate(dateStr: string, now = new Date()): boolean {
  const [year, month, day] = dateStr.split("-").map(Number);
  const targetDate = new Date(Date.UTC(year, month - 1, day));

  const nowDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return targetDate.getTime() > nowDate.getTime();
}

/**
 * Calculates days difference between `dateStr` and `now`.
 */
export function daysAgo(dateStr: string, now = new Date()): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const targetDate = new Date(Date.UTC(year, month - 1, day));
  const nowDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffMs = nowDate.getTime() - targetDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Evaluates whether a role is authorized to edit attendance for the given date.
 */
export function canEditAttendance(dateStr: string, userRole: string, now = new Date(), maxTeacherDays = MAX_TEACHER_EDIT_DAYS): boolean {
  if (isFutureDate(dateStr, now)) return false;
  if (userRole === "ADMIN") return true;
  if (userRole === "TEACHING_STAFF") {
    return daysAgo(dateStr, now) <= maxTeacherDays;
  }
  return false;
}

export type AttendanceCountSummary = {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  ratePercent: number;
};

/**
 * Computes aggregate statistics from a list of attendance records.
 */
export function calculateAttendanceSummary(records: { status: AttendanceStatus }[], totalEnrolled?: number): AttendanceCountSummary {
  let present = 0;
  let absent = 0;
  let late = 0;
  let excused = 0;

  for (const r of records) {
    switch (r.status) {
      case AttendanceStatus.PRESENT:
        present++;
        break;
      case AttendanceStatus.ABSENT:
        absent++;
        break;
      case AttendanceStatus.LATE:
        late++;
        break;
      case AttendanceStatus.EXCUSED:
        excused++;
        break;
    }
  }

  const effectiveTotal = totalEnrolled !== undefined ? totalEnrolled : records.length;
  // Present + Late count as attended
  const attended = present + late;
  const ratePercent = effectiveTotal > 0 ? Math.round((attended / effectiveTotal) * 100) : 0;

  return {
    total: effectiveTotal,
    present,
    absent,
    late,
    excused,
    ratePercent,
  };
}
