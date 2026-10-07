import type { EnrollmentStatus, Prisma } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { cleanReason, currentSessionFor, effectiveStatus, fromIsoDate, toIsoDate } from "@/lib/academics/rules";
import { visibleTo as sessionsVisibleTo } from "@/lib/academics/sessions";
import { groupsVisibleTo } from "@/lib/academics/classes";
import {
  ADMISSION_RETRY_LIMIT,
  checkBirthDate,
  cleanAdmissionNo,
  cleanOptionalName,
  cleanPersonName,
  formatAdmissionNo,
} from "@/lib/people/rules";
import { auditPeople, invalid, refuse, refuseAndRollBack, rollingBack, type PeopleResult } from "@/lib/people/results";

// Students and their enrolment (plan "Build design — Phase 1.2", decisions P2–P4 and P7).
//
// Same discipline as the academic services: ONE transaction through `tenant.run`, the tenant named in every query (row-level security is the net underneath),
// an audit row in the same transaction, nothing deleted (records are ARCHIVED), and every uniqueness rule enforced twice — here under an advisory lock,
// and by a unique index. Personal data stays out of the audit trail (see `auditPeople`).

type TenantCtx = TenantAuthContext["tenant"];

export type EnrolmentView = {
  id: string;
  sessionId: string;
  sessionLabel: string;
  classArmId: string;
  armName: string;
  classGroupName: string;
  status: EnrollmentStatus;
  enrolledAt: string;
};

export type StudentView = {
  id: string;
  campusId: string | null;
  campusName: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /// `YYYY-MM-DD`.
  dateOfBirth: string;
  admissionNo: string;
  archived: boolean;
  /// The enrolment in the session the list was asked about (`sessionId`), if any; always null from calls that name no session.
  enrolment: EnrolmentView | null;
};

const ENROLMENT_INCLUDE = {
  session: { select: { label: true } },
  classArm: { select: { name: true, classGroup: { select: { name: true } } } },
} satisfies Prisma.StudentEnrollmentInclude;
type EnrolmentRow = Prisma.StudentEnrollmentGetPayload<{ include: typeof ENROLMENT_INCLUDE }>;

const toEnrolment = (row: EnrolmentRow): EnrolmentView => ({
  id: row.id,
  sessionId: row.sessionId,
  sessionLabel: row.session.label,
  classArmId: row.classArmId,
  armName: row.classArm.name,
  classGroupName: row.classArm.classGroup.name,
  status: row.status,
  enrolledAt: row.enrolledAt.toISOString(),
});

const STUDENT_INCLUDE = { campus: { select: { name: true } } } satisfies Prisma.StudentRecordInclude;
type StudentRow = Prisma.StudentRecordGetPayload<{ include: typeof STUDENT_INCLUDE }>;

export const toStudent = (row: StudentRow, enrolment: EnrolmentView | null = null): StudentView => ({
  id: row.id,
  campusId: row.campusId,
  campusName: row.campus?.name ?? null,
  firstName: row.firstName,
  middleName: row.middleName,
  lastName: row.lastName,
  dateOfBirth: toIsoDate(row.dateOfBirth),
  admissionNo: row.admissionNo,
  archived: row.archivedAt !== null,
  enrolment,
});

/// Which students this member may see (decision P2): an ADMIN every campus's; anyone else the school-wide ones and their own campus's.
export function studentsVisibleTo(tenant: TenantCtx): Prisma.StudentRecordWhereInput {
  if (tenant.role === "ADMIN") return {};
  return { OR: [{ campusId: null }, ...(tenant.campusId ? [{ campusId: tenant.campusId }] : [])] };
}

const findStudent = (tx: Tx, tenant: TenantCtx, id: string) =>
  tx.studentRecord.findFirst({ where: { id, tenantId: tenant.tenantId, ...studentsVisibleTo(tenant) }, include: STUDENT_INCLUDE });

/// Serialises every check-then-write on a school's student list (duplicates, admission numbers). One lock per school.
export async function lockStudents(tx: Tx, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`student:${tenantId}`}::text))`;
}
/// Serialises a student's own enrolment changes (and their archiving).
async function lockStudent(tx: Tx, tenantId: string, studentId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`student-enrolment:${tenantId}:${studentId}`}::text))`;
}

// --- reading ------------------------------------------------------------------------------------------------------------------

export type StudentStatusFilter = "live" | "archived" | "all";
export type StudentFilters = {
  status: StudentStatusFilter;
  campusId?: string;
  q?: string;
  /// With `sessionId`: only students ENROLLED (active) in that arm that session — or, with `notEnrolled`, only those with no active enrolment in it.
  sessionId?: string;
  classArmId?: string;
  notEnrolled?: boolean;
};

/// The `where` of a student list. Exported so the CSV export applies exactly the same filter as the screen.
export function studentWhere(tenant: TenantCtx, filters: StudentFilters): Prisma.StudentRecordWhereInput {
  const and: Prisma.StudentRecordWhereInput[] = [studentsVisibleTo(tenant)];
  for (const token of (filters.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
    and.push({
      OR: [
        { firstName: { contains: token, mode: "insensitive" } },
        { middleName: { contains: token, mode: "insensitive" } },
        { lastName: { contains: token, mode: "insensitive" } },
        { admissionNo: { contains: token, mode: "insensitive" } },
      ],
    });
  }
  if (filters.sessionId && filters.classArmId) {
    and.push({ enrollments: { some: { sessionId: filters.sessionId, classArmId: filters.classArmId, status: "ACTIVE" } } });
  }
  if (filters.sessionId && filters.notEnrolled) {
    and.push({ enrollments: { none: { sessionId: filters.sessionId, status: "ACTIVE" } } });
  }
  return {
    tenantId: tenant.tenantId,
    AND: and,
    ...(filters.campusId ? { campusId: filters.campusId } : {}),
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
  };
}

export const STUDENT_ORDER = [
  { lastName: "asc" },
  { firstName: "asc" },
  { id: "asc" },
] satisfies Prisma.StudentRecordOrderByWithRelationInput[];

export async function listStudents(
  tenant: TenantCtx,
  filters: StudentFilters,
  page: { skip: number; take: number },
): Promise<{ students: StudentView[]; total: number }> {
  const where = studentWhere(tenant, filters);
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.studentRecord.count({ where }),
      tx.studentRecord.findMany({
        where,
        include: {
          ...STUDENT_INCLUDE,
          ...(filters.sessionId ? { enrollments: { where: { sessionId: filters.sessionId }, include: ENROLMENT_INCLUDE, take: 1 } } : {}),
        },
        orderBy: STUDENT_ORDER,
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return {
      students: rows.map((row) => {
        const enrolment = "enrollments" in row ? (row.enrollments as EnrolmentRow[])[0] : undefined;
        return toStudent(row, enrolment ? toEnrolment(enrolment) : null);
      }),
      total,
    };
  });
}

export async function getStudent(
  tenant: TenantCtx,
  id: string,
): Promise<PeopleResult<{ student: StudentView; enrolments: EnrolmentView[] }>> {
  return tenant.run(async (tx) => {
    const row = await findStudent(tx, tenant, id);
    if (!row) return refuse("NOT_FOUND");
    const enrolments = await tx.studentEnrollment.findMany({
      where: { tenantId: tenant.tenantId, studentId: id },
      include: ENROLMENT_INCLUDE,
      orderBy: [{ session: { startDate: "desc" } }, { id: "asc" }],
    });
    return { ok: true, student: toStudent(row), enrolments: enrolments.map(toEnrolment) };
  });
}

/// How many students are actively enrolled in each arm of a session (decision P7: capacity is displayed, never enforced).
export async function armOccupancy(tenant: TenantCtx, sessionId: string): Promise<PeopleResult<{ counts: Record<string, number> }>> {
  return tenant.run(async (tx) => {
    const session = await tx.academicSession.findFirst({
      where: { id: sessionId, tenantId: tenant.tenantId, ...sessionsVisibleTo(tenant) },
      select: { id: true },
    });
    if (!session) return refuse("INVALID_SESSION");
    const rows = await tx.studentEnrollment.groupBy({
      by: ["classArmId"],
      where: { tenantId: tenant.tenantId, sessionId, status: "ACTIVE", student: { archivedAt: null, ...studentsVisibleTo(tenant) } },
      _count: { _all: true },
    });
    return { ok: true, counts: Object.fromEntries(rows.map((row) => [row.classArmId, row._count._all])) };
  });
}

// --- writing: the record ------------------------------------------------------------------------------------------------------

export type StudentInput = {
  campusId?: string | null;
  firstName: unknown;
  middleName?: unknown;
  lastName: unknown;
  dateOfBirth: unknown;
  admissionNo?: unknown;
};

type CleanFields = { firstName: string; middleName: string | null; lastName: string; dateOfBirth: string };

/// The fields every student has, validated (decision P2's field rules). The first bad field is named.
export function cleanStudentFields(input: StudentInput, now: Date): { ok: true; value: CleanFields } | ReturnType<typeof invalid> {
  const firstName = cleanPersonName(input.firstName);
  if (!firstName) return invalid("firstName");
  const lastName = cleanPersonName(input.lastName);
  if (!lastName) return invalid("lastName");
  const middleName = cleanOptionalName(input.middleName);
  if (middleName === undefined) return invalid("middleName");
  if (checkBirthDate(input.dateOfBirth, now)) return invalid("dateOfBirth");
  return { ok: true, value: { firstName, middleName, lastName, dateOfBirth: input.dateOfBirth as string } };
}

const admissionTaken = async (tx: Tx, tenantId: string, admissionNo: string, exceptId?: string) =>
  Boolean(
    await tx.studentRecord.findFirst({
      where: { tenantId, admissionNo: { equals: admissionNo, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    }),
  );

/// A live student with the same name and date of birth (decision P4), or null.
export const findDuplicate = (tx: Tx, tenantId: string, fields: CleanFields, exceptId?: string) =>
  tx.studentRecord.findFirst({
    where: {
      tenantId,
      archivedAt: null,
      firstName: { equals: fields.firstName, mode: "insensitive" },
      lastName: { equals: fields.lastName, mode: "insensitive" },
      dateOfBirth: fromIsoDate(fields.dateOfBirth),
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { admissionNo: true },
  });

/// The year a generated number carries (decision P3): the start year of the campus's current session, else the calendar year.
async function admissionYear(tx: Tx, tenantId: string, campusId: string | null, now: Date): Promise<number> {
  const sessions = await tx.academicSession.findMany({
    where: { tenantId, archivedAt: null, status: "ACTIVE" },
    select: { id: true, campusId: true, status: true, closeAt: true, startDate: true },
  });
  const current = currentSessionFor(
    campusId,
    sessions.map((session) => ({ ...session, archived: false })),
    now,
  );
  return current ? current.startDate.getUTCFullYear() : now.getUTCFullYear();
}

/// Takes the next number(s) from the school's counter until one is free, or gives up after `ADMISSION_RETRY_LIMIT` (decision P3). The counter row's lock
/// serialises concurrent creates; the increment is in the caller's transaction, so a failed insert leaves no gap. Returns null when exhausted.
export async function generateAdmissionNo(tx: Tx, tenantId: string, year: number): Promise<string | null> {
  for (let attempt = 0; attempt < ADMISSION_RETRY_LIMIT; attempt++) {
    const rows = await tx.$queryRaw<{ seq: number }[]>`
      INSERT INTO "AdmissionCounter" ("tenantId", "year", "next") VALUES (${tenantId}, ${year}::int, 2)
      ON CONFLICT ("tenantId", "year") DO UPDATE SET "next" = "AdmissionCounter"."next" + 1
      RETURNING ("next" - 1)::int AS seq`;
    const candidate = formatAdmissionNo(year, rows[0].seq);
    if (!(await admissionTaken(tx, tenantId, candidate))) return candidate;
  }
  return null;
}

/// Creates one student INSIDE the caller's transaction (the import calls this per row, under one lock). Assumes `lockStudents` is held and the caller
/// is wrapped in `rollingBack` (running out of admission numbers is refused by throwing, after the counter has moved).
export async function insertStudent(
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  campusId: string | null,
  fields: CleanFields,
  typedAdmissionNo: string | null,
  now: Date,
): Promise<PeopleResult<{ row: StudentRow }>> {
  const duplicate = await findDuplicate(tx, tenantId, fields);
  if (duplicate) return refuse("POSSIBLE_DUPLICATE", { admissionNo: duplicate.admissionNo });
  let admissionNo = typedAdmissionNo;
  if (admissionNo) {
    if (await admissionTaken(tx, tenantId, admissionNo)) return refuse("ADMISSION_NUMBER_TAKEN");
  } else {
    admissionNo = await generateAdmissionNo(tx, tenantId, await admissionYear(tx, tenantId, campusId, now));
    // The search already advanced the counter; a refusal now must undo that, so it rolls the transaction back (callers wrap this in `rollingBack`).
    if (!admissionNo) return refuseAndRollBack("ADMISSION_NUMBER_EXHAUSTED");
  }
  const row = await tx.studentRecord.create({
    data: {
      tenantId,
      campusId,
      firstName: fields.firstName,
      middleName: fields.middleName,
      lastName: fields.lastName,
      dateOfBirth: fromIsoDate(fields.dateOfBirth),
      admissionNo,
    },
    include: STUDENT_INCLUDE,
  });
  await auditPeople(tx, tenantId, actorUserId, "StudentRecord", "STUDENT_CREATED", row.id, undefined, {
    admissionNo,
    campusId,
    generated: typedAdmissionNo === null,
  });
  return { ok: true, row };
}

export async function createStudent(
  tenant: TenantCtx,
  actorUserId: string,
  input: StudentInput,
  now: Date = new Date(),
): Promise<PeopleResult<{ student: StudentView }>> {
  const fields = cleanStudentFields(input, now);
  if (!fields.ok) return fields;
  let typed: string | null = null;
  if (
    input.admissionNo !== undefined &&
    input.admissionNo !== null &&
    !(typeof input.admissionNo === "string" && input.admissionNo.trim() === "")
  ) {
    typed = cleanAdmissionNo(input.admissionNo);
    if (!typed) return invalid("admissionNo");
  }
  const campusId = input.campusId ?? null;
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      if (campusId) {
        const campus = await tx.campus.findFirst({ where: { id: campusId, tenantId }, select: { id: true } });
        if (!campus) return refuse("INVALID_CAMPUS");
      }
      await lockStudents(tx, tenantId);
      const created = await insertStudent(tx, tenantId, actorUserId, campusId, fields.value, typed, now);
      if (!created.ok) return created;
      return { ok: true as const, student: toStudent(created.row) };
    }),
  );
}

export type StudentChanges = Partial<Omit<StudentInput, "campusId">>;

export async function updateStudent(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: StudentChanges,
  now: Date = new Date(),
): Promise<PeopleResult<{ student: StudentView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await findStudent(tx, tenant, id);
      if (!current) return refuse("NOT_FOUND");
      if (current.archivedAt) return refuse("ARCHIVED");
      const merged = cleanStudentFields(
        {
          firstName: input.firstName ?? current.firstName,
          middleName: input.middleName === undefined ? current.middleName : input.middleName,
          lastName: input.lastName ?? current.lastName,
          dateOfBirth: input.dateOfBirth ?? toIsoDate(current.dateOfBirth),
        },
        now,
      );
      if (!merged.ok) return merged;
      let admissionNo = current.admissionNo;
      if (input.admissionNo !== undefined) {
        const typed = cleanAdmissionNo(input.admissionNo);
        if (!typed) return invalid("admissionNo");
        admissionNo = typed;
      }
      const fields = merged.value;
      const changedFields = [
        fields.firstName !== current.firstName && "firstName",
        fields.middleName !== current.middleName && "middleName",
        fields.lastName !== current.lastName && "lastName",
        fields.dateOfBirth !== toIsoDate(current.dateOfBirth) && "dateOfBirth",
        admissionNo !== current.admissionNo && "admissionNo",
      ].filter((name): name is string => Boolean(name));
      if (changedFields.length === 0) return { ok: true as const, student: toStudent(current), changed: false };

      await lockStudents(tx, tenantId);
      if (changedFields.some((name) => name !== "admissionNo" && name !== "middleName")) {
        const duplicate = await findDuplicate(tx, tenantId, fields, id);
        if (duplicate) return refuse("POSSIBLE_DUPLICATE", { admissionNo: duplicate.admissionNo });
      }
      if (admissionNo !== current.admissionNo && (await admissionTaken(tx, tenantId, admissionNo, id)))
        return refuse("ADMISSION_NUMBER_TAKEN");
      const row = await tx.studentRecord.update({
        where: { id },
        data: {
          firstName: fields.firstName,
          middleName: fields.middleName,
          lastName: fields.lastName,
          dateOfBirth: fromIsoDate(fields.dateOfBirth),
          admissionNo,
        },
        include: STUDENT_INCLUDE,
      });
      await auditPeople(
        tx,
        tenantId,
        actorUserId,
        "StudentRecord",
        "STUDENT_UPDATED",
        id,
        { admissionNo: current.admissionNo },
        { admissionNo, changed: changedFields },
      );
      return { ok: true as const, student: toStudent(row), changed: true };
    }),
  );
}

/// Archives a student — refused while an ACTIVE enrolment remains (withdraw first: nothing is archived silently). Conditional, so two clicks archive once.
export async function archiveStudent(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<PeopleResult<{ student: StudentView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await findStudent(tx, tenant, id);
      if (!current) return refuse("NOT_FOUND");
      if (current.archivedAt) return { ok: true as const, student: toStudent(current), changed: false };
      await lockStudent(tx, tenantId, id);
      if (await tx.studentEnrollment.findFirst({ where: { tenantId, studentId: id, status: "ACTIVE" }, select: { id: true } })) {
        return refuse("HAS_ACTIVE_ENROLMENT");
      }
      const done = await tx.studentRecord.updateMany({ where: { id, tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(tx, tenantId, actorUserId, "StudentRecord", "STUDENT_ARCHIVED", id, undefined, {
        admissionNo: current.admissionNo,
      });
      return {
        ok: true as const,
        student: toStudent(await tx.studentRecord.findUniqueOrThrow({ where: { id }, include: STUDENT_INCLUDE })),
        changed: true,
      };
    }),
  );
}

/// Puts an archived student back. A live student with the same name and birthday may have been added since (decision P4), so the check runs again.
export async function restoreStudent(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<PeopleResult<{ student: StudentView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await findStudent(tx, tenant, id);
      if (!current) return refuse("NOT_FOUND");
      if (!current.archivedAt) return { ok: true as const, student: toStudent(current), changed: false };
      await lockStudents(tx, tenantId);
      const duplicate = await findDuplicate(
        tx,
        tenantId,
        {
          firstName: current.firstName,
          middleName: current.middleName,
          lastName: current.lastName,
          dateOfBirth: toIsoDate(current.dateOfBirth),
        },
        id,
      );
      if (duplicate) return refuse("POSSIBLE_DUPLICATE", { admissionNo: duplicate.admissionNo });
      const done = await tx.studentRecord.updateMany({ where: { id, tenantId, archivedAt: { not: null } }, data: { archivedAt: null } });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(tx, tenantId, actorUserId, "StudentRecord", "STUDENT_RESTORED", id, undefined, {
        admissionNo: current.admissionNo,
      });
      return {
        ok: true as const,
        student: toStudent(await tx.studentRecord.findUniqueOrThrow({ where: { id }, include: STUDENT_INCLUDE })),
        changed: true,
      };
    }),
  );
}

// --- writing: enrolment (decision P7) -----------------------------------------------------------------------------------------

/// A session or class may be used for a student when it is school-wide or belongs to the student's own campus; a student with no campus fits only the school-wide ones.
const scopeFits = (studentCampusId: string | null, scopeCampusId: string | null) =>
  scopeCampusId === null || scopeCampusId === studentCampusId;

/// The session an enrolment goes into: visible to the caller, fitting the student, not archived, and not CLOSED (effective status, so a close that is due counts).
async function sessionForEnrolment(tx: Tx, tenant: TenantCtx, studentCampusId: string | null, sessionId: string, now: Date) {
  const session = await tx.academicSession.findFirst({
    where: { id: sessionId, tenantId: tenant.tenantId, ...sessionsVisibleTo(tenant) },
    select: { id: true, campusId: true, status: true, closeAt: true, archivedAt: true },
  });
  if (!session || !scopeFits(studentCampusId, session.campusId)) return refuse("INVALID_SESSION");
  if (session.archivedAt || effectiveStatus(session, now) === "CLOSED") return refuse("SESSION_CLOSED");
  return { ok: true as const, session };
}

/// The arm an enrolment goes into: live, its class group live and fitting the student and visible to the caller.
async function armForEnrolment(tx: Tx, tenant: TenantCtx, studentCampusId: string | null, classArmId: string) {
  const arm = await tx.classArm.findFirst({
    where: { id: classArmId, tenantId: tenant.tenantId, archivedAt: null, classGroup: { archivedAt: null, ...groupsVisibleTo(tenant) } },
    select: { id: true, name: true, classGroup: { select: { name: true, campusId: true } } },
  });
  if (!arm || !scopeFits(studentCampusId, arm.classGroup.campusId)) return refuse("INVALID_ARM");
  return { ok: true as const, arm };
}

const enrolmentRow = (tx: Tx, id: string) => tx.studentEnrollment.findUniqueOrThrow({ where: { id }, include: ENROLMENT_INCLUDE });

/// Enrols a student INSIDE the caller's transaction (the CSV import calls this per row). Assumes the student was read through the caller's visibility and is
/// live. Same rules as `enrolStudent`; callers wrap in `rollingBack` (a lost race is refused by throwing).
export async function enrolWithin(
  tx: Tx,
  tenant: TenantCtx,
  actorUserId: string,
  student: { id: string; campusId: string | null },
  input: { sessionId: string; classArmId: string },
  now: Date,
): Promise<PeopleResult<{ enrolment: EnrolmentView; reenrolled: boolean }>> {
  const { tenantId } = tenant;
  const studentId = student.id;
  const session = await sessionForEnrolment(tx, tenant, student.campusId, input.sessionId, now);
  if (!session.ok) return session;
  const arm = await armForEnrolment(tx, tenant, student.campusId, input.classArmId);
  if (!arm.ok) return arm;
  await lockStudent(tx, tenantId, studentId);
  const existing = await tx.studentEnrollment.findFirst({
    where: { tenantId, studentId, sessionId: input.sessionId },
    include: ENROLMENT_INCLUDE,
  });
  if (existing && existing.status !== "WITHDRAWN") {
    return refuse("ALREADY_ENROLLED", {
      classArmId: existing.classArmId,
      armName: existing.classArm.name,
      className: existing.classArm.classGroup.name,
    });
  }
  if (existing) {
    // A withdrawn student coming back into the same session: the row (one per student per session) is reactivated, not duplicated.
    const done = await tx.studentEnrollment.updateMany({
      where: { id: existing.id, tenantId, status: "WITHDRAWN" },
      data: { status: "ACTIVE", classArmId: arm.arm.id },
    });
    if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
    await auditPeople(
      tx,
      tenantId,
      actorUserId,
      "StudentEnrollment",
      "ENROLMENT_REACTIVATED",
      existing.id,
      { status: "WITHDRAWN", classArmId: existing.classArmId },
      { status: "ACTIVE", classArmId: arm.arm.id, studentId, sessionId: input.sessionId },
    );
    return { ok: true as const, enrolment: toEnrolment(await enrolmentRow(tx, existing.id)), reenrolled: true };
  }
  const created = await tx.studentEnrollment.create({
    data: { tenantId, studentId, sessionId: input.sessionId, classArmId: arm.arm.id },
    include: ENROLMENT_INCLUDE,
  });
  await auditPeople(tx, tenantId, actorUserId, "StudentEnrollment", "ENROLMENT_CREATED", created.id, undefined, {
    studentId,
    sessionId: input.sessionId,
    classArmId: arm.arm.id,
  });
  return { ok: true as const, enrolment: toEnrolment(created), reenrolled: false };
}

export async function enrolStudent(
  tenant: TenantCtx,
  actorUserId: string,
  studentId: string,
  input: { sessionId: string; classArmId: string },
  now: Date = new Date(),
): Promise<PeopleResult<{ enrolment: EnrolmentView; reenrolled: boolean }>> {
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const student = await findStudent(tx, tenant, studentId);
      if (!student) return refuse("NOT_FOUND");
      if (student.archivedAt) return refuse("ARCHIVED");
      return enrolWithin(tx, tenant, actorUserId, student, input, now);
    }),
  );
}

/// Moves an ACTIVE enrolment to another arm inside the same session (an edit, audited with before/after).
export async function moveEnrolment(
  tenant: TenantCtx,
  actorUserId: string,
  studentId: string,
  enrolmentId: string,
  input: { classArmId: string },
  now: Date = new Date(),
): Promise<PeopleResult<{ enrolment: EnrolmentView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const student = await findStudent(tx, tenant, studentId);
      if (!student) return refuse("NOT_FOUND");
      const current = await tx.studentEnrollment.findFirst({ where: { id: enrolmentId, tenantId, studentId }, include: ENROLMENT_INCLUDE });
      if (!current) return refuse("NOT_FOUND");
      if (student.archivedAt) return refuse("ARCHIVED");
      if (current.status !== "ACTIVE") return refuse("WRONG_STATE");
      const session = await sessionForEnrolment(tx, tenant, student.campusId, current.sessionId, now);
      if (!session.ok) return session;
      const arm = await armForEnrolment(tx, tenant, student.campusId, input.classArmId);
      if (!arm.ok) return arm;
      if (arm.arm.id === current.classArmId) return { ok: true as const, enrolment: toEnrolment(current), changed: false };
      await lockStudent(tx, tenantId, studentId);
      const done = await tx.studentEnrollment.updateMany({
        where: { id: enrolmentId, tenantId, status: "ACTIVE" },
        data: { classArmId: arm.arm.id },
      });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(
        tx,
        tenantId,
        actorUserId,
        "StudentEnrollment",
        "ENROLMENT_MOVED",
        enrolmentId,
        { classArmId: current.classArmId },
        {
          classArmId: arm.arm.id,
          studentId,
          sessionId: current.sessionId,
        },
      );
      return { ok: true as const, enrolment: toEnrolment(await enrolmentRow(tx, enrolmentId)), changed: true };
    }),
  );
}

/// Withdraws an ACTIVE enrolment with a typed reason (5–300 characters), which goes into the audit entry.
export async function withdrawEnrolment(
  tenant: TenantCtx,
  actorUserId: string,
  studentId: string,
  enrolmentId: string,
  input: { reason: unknown },
): Promise<PeopleResult<{ enrolment: EnrolmentView }>> {
  const reason = cleanReason(input.reason);
  if (!reason) return invalid("reason");
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const student = await findStudent(tx, tenant, studentId);
      if (!student) return refuse("NOT_FOUND");
      const current = await tx.studentEnrollment.findFirst({
        where: { id: enrolmentId, tenantId, studentId },
        select: { id: true, status: true, classArmId: true, sessionId: true },
      });
      if (!current) return refuse("NOT_FOUND");
      if (current.status !== "ACTIVE") return refuse("WRONG_STATE");
      await lockStudent(tx, tenantId, studentId);
      const done = await tx.studentEnrollment.updateMany({
        where: { id: enrolmentId, tenantId, status: "ACTIVE" },
        data: { status: "WITHDRAWN" },
      });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(
        tx,
        tenantId,
        actorUserId,
        "StudentEnrollment",
        "ENROLMENT_WITHDRAWN",
        enrolmentId,
        { status: "ACTIVE" },
        { status: "WITHDRAWN", studentId, sessionId: current.sessionId, classArmId: current.classArmId },
        reason,
      );
      return { ok: true as const, enrolment: toEnrolment(await enrolmentRow(tx, enrolmentId)) };
    }),
  );
}
