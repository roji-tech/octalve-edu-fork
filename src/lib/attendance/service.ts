import { SessionStatus, Prisma } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import { isFutureDate, canEditAttendance, calculateAttendanceSummary, AttendanceStatus, type AttendanceCountSummary } from "./rules";
import type { BulkMarkAttendanceInput, AttendanceFailure } from "./http";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; failure: AttendanceFailure; detail?: Record<string, unknown> };

export type StudentRollCallEntry = {
  studentId: string;
  admissionNo: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  status: AttendanceStatus | null;
  remarks: string | null;
  markedAt: Date | null;
  markedByUserId: string | null;
};

export type RollCallResult = {
  classArm: {
    id: string;
    name: string;
    classGroup: {
      id: string;
      name: string;
      campusId: string | null;
    };
  };
  sessionId: string;
  date: string;
  students: StudentRollCallEntry[];
  summary: AttendanceCountSummary;
  canEdit: boolean;
};

/**
 * Retrieves the roll call roster for a specific class arm and date.
 */
export async function getArmRollCall(
  tx: Tx,
  tenantId: string,
  classArmId: string,
  dateStr: string,
  actorRole: string,
): Promise<ServiceResult<RollCallResult>> {
  // 1. Verify ClassArm exists in this tenant
  const classArm = await tx.classArm.findFirst({
    where: { tenantId, id: classArmId, archivedAt: null },
    include: {
      classGroup: {
        select: { id: true, name: true, campusId: true },
      },
    },
  });

  if (!classArm) {
    return { ok: false, failure: "NOT_FOUND" };
  }

  // 2. Identify the active academic session
  const activeSession = await tx.academicSession.findFirst({
    where: { tenantId, status: SessionStatus.ACTIVE, archivedAt: null },
    select: { id: true },
  });

  if (!activeSession) {
    return { ok: false, failure: "SESSION_NOT_ACTIVE" };
  }

  // 3. Fetch active enrollments in this arm for the active session
  const enrollments = await tx.studentEnrollment.findMany({
    where: {
      tenantId,
      classArmId,
      sessionId: activeSession.id,
      status: "ACTIVE",
    },
    include: {
      student: {
        select: {
          id: true,
          admissionNo: true,
          firstName: true,
          middleName: true,
          lastName: true,
          archivedAt: true,
        },
      },
    },
    orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
  });

  // Filter out any archived students
  const activeStudents = enrollments.filter((e) => e.student.archivedAt === null).map((e) => e.student);

  // 4. Fetch existing attendance records for these students on the specified date
  const date = new Date(dateStr);
  const studentIds = activeStudents.map((s) => s.id);

  const existingRecords = await tx.attendanceRecord.findMany({
    where: {
      tenantId,
      classArmId,
      date,
      studentId: { in: studentIds },
    },
  });

  const recordMap = new Map(existingRecords.map((r) => [r.studentId, r]));

  // 5. Compose the student roll call entries
  const students: StudentRollCallEntry[] = activeStudents.map((s) => {
    const record = recordMap.get(s.id);
    return {
      studentId: s.id,
      admissionNo: s.admissionNo,
      firstName: s.firstName,
      middleName: s.middleName,
      lastName: s.lastName,
      status: record?.status ?? null,
      remarks: record?.remarks ?? null,
      markedAt: record?.markedAt ?? null,
      markedByUserId: record?.markedByUserId ?? null,
    };
  });

  // Calculate summary based only on marked records
  const markedRecords = existingRecords.map((r) => ({ status: r.status }));
  const summary = calculateAttendanceSummary(markedRecords, activeStudents.length);
  const canEdit = canEditAttendance(dateStr, actorRole);

  return {
    ok: true,
    data: {
      classArm: {
        id: classArm.id,
        name: classArm.name,
        classGroup: classArm.classGroup,
      },
      sessionId: activeSession.id,
      date: dateStr,
      students,
      summary,
      canEdit,
    },
  };
}

/**
 * Idempotently records/upserts roll call attendance for students in an arm.
 */
export async function markArmAttendance(
  tx: Tx,
  tenantId: string,
  classArmId: string,
  actorUserId: string,
  actorRole: string,
  input: BulkMarkAttendanceInput,
): Promise<ServiceResult<{ count: number; summary: AttendanceCountSummary }>> {
  // 1. Boundary and authorization checks
  if (isFutureDate(input.date)) {
    return { ok: false, failure: "FUTURE_DATE_NOT_ALLOWED" };
  }

  if (!canEditAttendance(input.date, actorRole)) {
    return { ok: false, failure: "EDIT_WINDOW_EXPIRED" };
  }

  // 2. Verify ClassArm exists
  const classArm = await tx.classArm.findFirst({
    where: { tenantId, id: classArmId, archivedAt: null },
    select: { id: true },
  });

  if (!classArm) {
    return { ok: false, failure: "NOT_FOUND" };
  }

  const date = new Date(input.date);

  // 3. Upsert each attendance record
  for (const record of input.records) {
    await tx.attendanceRecord.upsert({
      where: {
        tenantId_studentId_date: {
          tenantId,
          studentId: record.studentId,
          date,
        },
      },
      create: {
        tenantId,
        studentId: record.studentId,
        classArmId,
        date,
        status: record.status,
        remarks: record.remarks ?? null,
        markedByUserId: actorUserId,
        source: input.source,
      },
      update: {
        classArmId,
        status: record.status,
        remarks: record.remarks ?? null,
        markedByUserId: actorUserId,
        source: input.source,
      },
    });
  }

  // 4. Audit Log
  await tx.auditLog.create({
    data: {
      tenantId,
      actorUserId,
      action: "ATTENDANCE_MARKED",
      targetType: "ClassArm",
      targetId: classArmId,
      afterValue: {
        date: input.date,
        recordsCount: input.records.length,
        source: input.source,
      } as Prisma.InputJsonValue,
    },
  });

  const summary = calculateAttendanceSummary(
    input.records.map((r) => ({ status: r.status })),
    input.records.length,
  );

  return {
    ok: true,
    data: {
      count: input.records.length,
      summary,
    },
  };
}

/**
 * Retrieves a single student's attendance history.
 */
export async function getStudentAttendanceHistory(
  tx: Tx,
  tenantId: string,
  studentId: string,
  limit = 60,
): Promise<
  ServiceResult<{
    student: { id: string; admissionNo: string; firstName: string; lastName: string };
    records: {
      id: string;
      date: string;
      status: AttendanceStatus;
      remarks: string | null;
      classArmName: string;
    }[];
    summary: AttendanceCountSummary;
  }>
> {
  const student = await tx.studentRecord.findFirst({
    where: { tenantId, id: studentId },
    select: { id: true, admissionNo: true, firstName: true, lastName: true },
  });

  if (!student) {
    return { ok: false, failure: "NOT_FOUND" };
  }

  const rows = await tx.attendanceRecord.findMany({
    where: { tenantId, studentId },
    orderBy: { date: "desc" },
    take: limit,
    include: {
      classArm: {
        select: { name: true },
      },
    },
  });

  const records = rows.map((r) => ({
    id: r.id,
    date: r.date.toISOString().split("T")[0],
    status: r.status,
    remarks: r.remarks,
    classArmName: r.classArm.name,
  }));

  const summary = calculateAttendanceSummary(records, records.length);

  return {
    ok: true,
    data: {
      student,
      records,
      summary,
    },
  };
}
