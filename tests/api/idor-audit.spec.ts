import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import {
  AnnouncementStatus,
  AttendanceStatus,
  EnrollmentStatus,
  InvoiceStatus,
  PeriodKind,
  Relationship,
  ResultStatus,
  Role,
  SessionStatus,
  StaffCategory,
} from "@prisma/client";
import {
  addMembership,
  createTenant,
  createUser,
  db,
  removeCreatedTenants,
  seedInstance,
  type TestTenant,
  type TestUser,
} from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

const SAAS = { baseUrl: SAAS_URL };

let schoolA: TestTenant;
let schoolB: TestTenant;
let adminA: TestUser;
let adminB: TestUser;
let cookieB: string;

// Entities created in school A
let sessionA: { id: string };
let periodA: { id: string };
let groupA: { id: string };
let armA: { id: string };
let subjectA: { id: string };
let schemeA: { id: string };
let scaleA: { id: string };
let studentA: { id: string };
let staffA: { id: string };
let guardianA: { id: string };
let invoiceA: { id: string };
let slotA: { id: string };
let announcementA: { id: string };

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  schoolA = await createTenant({ name: "Alpha IDOR Guard Academy" });
  schoolB = await createTenant({ name: "Beta IDOR Audit Academy" });

  adminA = await createUser();
  adminB = await createUser();
  await addMembership(adminA.id, schoolA.id, Role.ADMIN);
  await addMembership(adminB.id, schoolB.id, Role.ADMIN);
  cookieB = await cookieFor(adminB);

  // 1. Academics in School A
  sessionA = await db.academicSession.create({
    data: {
      tenantId: schoolA.id,
      label: "2026/2027 Session A",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2027-07-31"),
      status: SessionStatus.ACTIVE,
    },
  });

  periodA = await db.academicPeriod.create({
    data: {
      tenantId: schoolA.id,
      sessionId: sessionA.id,
      kind: PeriodKind.TERM,
      ordinal: 1,
      label: "First Term A",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-12-15"),
      isCurrent: true,
    },
  });

  groupA = await db.classGroup.create({
    data: {
      tenantId: schoolA.id,
      name: "Year 10 A",
      sortOrder: 10,
    },
  });

  armA = await db.classArm.create({
    data: {
      tenantId: schoolA.id,
      classGroupId: groupA.id,
      name: "Diamond",
    },
  });

  subjectA = await db.subject.create({
    data: {
      tenantId: schoolA.id,
      name: "Pure Mathematics A",
      code: "MTHA",
    },
  });

  schemeA = await db.assessmentScheme.create({
    data: {
      tenantId: schoolA.id,
      name: "Standard 70-30 Scheme A",
      examMax: 70,
    },
  });
  await db.assessmentComponent.create({
    data: {
      tenantId: schoolA.id,
      schemeId: schemeA.id,
      name: "Continuous Assessment",
      maxScore: 30,
      sortOrder: 1,
    },
  });

  scaleA = await db.gradeScale.create({
    data: {
      tenantId: schoolA.id,
      name: "WAEC 9-Point Scale A",
      isDefault: true,
    },
  });
  await db.gradeBand.create({
    data: {
      tenantId: schoolA.id,
      scaleId: scaleA.id,
      minScore: 0,
      maxScore: 100,
      letter: "A",
      remark: "Pass",
      sortOrder: 0,
    },
  });

  // 2. People in School A
  studentA = await db.studentRecord.create({
    data: {
      tenantId: schoolA.id,
      firstName: "Amina",
      lastName: "Danjuma",
      admissionNo: "ADM-ALPHA-001",
      dateOfBirth: new Date("2010-05-15"),
    },
  });

  staffA = await db.staffRecord.create({
    data: {
      tenantId: schoolA.id,
      firstName: "Ibrahim",
      lastName: "Suleiman",
      category: StaffCategory.TEACHING,
    },
  });

  guardianA = await db.guardianRecord.create({
    data: {
      tenantId: schoolA.id,
      firstName: "Fatima",
      lastName: "Danjuma",
      email: "fatima.danjuma.alpha@example.com",
      phone: "+2348011112233",
    },
  });

  await db.guardianLink.create({
    data: {
      tenantId: schoolA.id,
      studentId: studentA.id,
      guardianId: guardianA.id,
      relationship: Relationship.MOTHER,
      isPrimary: true,
    },
  });

  await db.studentEnrollment.create({
    data: {
      tenantId: schoolA.id,
      studentId: studentA.id,
      sessionId: sessionA.id,
      classArmId: armA.id,
      status: EnrollmentStatus.ACTIVE,
    },
  });

  await db.staffSubjectAssignment.create({
    data: {
      tenantId: schoolA.id,
      staffRecordId: staffA.id,
      subjectId: subjectA.id,
      classArmId: armA.id,
    },
  });

  // Attendance in School A
  await db.attendanceRecord.create({
    data: {
      tenantId: schoolA.id,
      studentId: studentA.id,
      classArmId: armA.id,
      date: new Date("2026-10-10"),
      status: AttendanceStatus.PRESENT,
      markedByUserId: adminA.id,
    },
  });

  // Results in School A
  await db.result.create({
    data: {
      tenantId: schoolA.id,
      studentId: studentA.id,
      periodId: periodA.id,
      subjectId: subjectA.id,
      score: 85,
      maxScore: 100,
      status: ResultStatus.DRAFT,
    },
  });

  // Finance in School A
  const feeA = await db.feeStructure.create({
    data: {
      tenantId: schoolA.id,
      periodId: periodA.id,
      classGroupId: groupA.id,
      name: "Alpha Tuition Term 1",
      amount: 150000,
    },
  });

  invoiceA = await db.invoice.create({
    data: {
      tenantId: schoolA.id,
      studentId: studentA.id,
      periodId: periodA.id,
      invoiceNo: "INV-ALPHA-1001",
      totalAmount: 150000,
      amountPaid: 0,
      status: InvoiceStatus.UNPAID,
      dueDate: new Date("2026-11-01"),
      lineItems: [{ name: feeA.name, amount: 150000, feeStructureId: feeA.id }],
    },
  });

  // Timetable in School A
  slotA = await db.timetableSlot.create({
    data: {
      tenantId: schoolA.id,
      classArmId: armA.id,
      subjectId: subjectA.id,
      staffRecordId: staffA.id,
      dayOfWeek: 1,
      startTime: "09:00",
      endTime: "10:00",
      room: "Lab 1",
    },
  });

  // Announcement in School A
  announcementA = await db.announcement.create({
    data: {
      tenantId: schoolA.id,
      authorUserId: adminA.id,
      title: "Confidential Alpha Notice",
      body: "Alpha proprietary information",
      status: AnnouncementStatus.PUBLISHED,
    },
  });
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("IDOR Protection: Admin of School B querying School A entities via School B routes", () => {
  test("GET /people/students/[id] -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/students/${studentA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("PATCH /people/students/[id] -> 404 (does not mutate School A student)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/students/${studentA.id}`, {
      ...SAAS,
      method: "PATCH",
      cookie: cookieB,
      body: { firstName: "HackedName" },
    });
    expect(res.status).toBe(404);

    // Verify DB untampered
    const dbStudent = await db.studentRecord.findUniqueOrThrow({ where: { id: studentA.id } });
    expect(dbStudent.firstName).toBe("Amina");
  });

  test("POST /people/students/[id]/archive -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/students/${studentA.id}/archive`, {
      ...SAAS,
      method: "POST",
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("GET /people/students/[id]/report-card -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/students/${studentA.id}/report-card?periodId=${periodA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("GET /people/students/[id]/guardians -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/students/${studentA.id}/guardians`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("GET /people/staff/[id] -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/staff/${staffA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("PATCH /people/staff/[id] -> 404 (does not mutate School A staff)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/staff/${staffA.id}`, {
      ...SAAS,
      method: "PATCH",
      cookie: cookieB,
      body: { lastName: "TamperedLastName" },
    });
    expect(res.status).toBe(404);

    const dbStaff = await db.staffRecord.findUniqueOrThrow({ where: { id: staffA.id } });
    expect(dbStaff.lastName).toBe("Suleiman");
  });

  test("GET /people/guardians/[id] -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/people/guardians/${guardianA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("GET /academics/sessions/[id] -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/academics/sessions/${sessionA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("GET /academics/class-groups/[id] -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/academics/class-groups/${groupA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("PATCH /academics/subjects/[id] -> 404 (does not mutate School A subject)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/academics/subjects/${subjectA.id}`, {
      ...SAAS,
      method: "PATCH",
      cookie: cookieB,
      body: { name: "Compromised Subject" },
    });
    expect(res.status).toBe(404);

    const dbSubject = await db.subject.findUniqueOrThrow({ where: { id: subjectA.id } });
    expect(dbSubject.name).toBe("Pure Mathematics A");
  });

  test("GET /academics/assessment-schemes/[id] -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/academics/assessment-schemes/${schemeA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("GET /academics/grade-scales/[id] -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/academics/grade-scales/${scaleA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("GET /finance/invoices/[id] -> 404 (does not disclose School A billing)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/finance/invoices/${invoiceA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("POST /finance/invoices/[id]/manual-payment -> 404 (cannot credit School A invoice)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/finance/invoices/${invoiceA.id}/manual-payment`, {
      ...SAAS,
      method: "POST",
      cookie: cookieB,
      body: {
        amount: 50000,
        notes: "Unauthorized attempt",
      },
    });
    expect(res.status).toBe(404);

    const dbInv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceA.id } });
    expect(dbInv.status).toBe(InvoiceStatus.UNPAID);
  });

  test("POST /finance/invoices/[id]/discount -> 404", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/finance/invoices/${invoiceA.id}/discount`, {
      ...SAAS,
      method: "POST",
      cookie: cookieB,
      body: {
        amount: 10000,
        reason: "Unauthorized attempt",
      },
    });
    expect(res.status).toBe(404);
  });

  test("PATCH /timetable/[id] -> 404 (cannot alter School A timetable)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/timetable/${slotA.id}`, {
      ...SAAS,
      method: "PATCH",
      cookie: cookieB,
      body: { room: "Hacked Room" },
    });
    expect(res.status).toBe(404);

    const dbSlot = await db.timetableSlot.findUniqueOrThrow({ where: { id: slotA.id } });
    expect(dbSlot.room).toBe("Lab 1");
  });

  test("DELETE /timetable/[id] -> 404 (cannot delete School A timetable slot)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/timetable/${slotA.id}`, {
      ...SAAS,
      method: "DELETE",
      cookie: cookieB,
    });
    expect(res.status).toBe(404);

    const exists = await db.timetableSlot.findUnique({ where: { id: slotA.id } });
    expect(exists).not.toBeNull();
  });

  test("GET /announcements/[id] -> 404 (cannot view confidential School A notice)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/announcements/${announcementA.id}`, {
      ...SAAS,
      cookie: cookieB,
    });
    expect(res.status).toBe(404);
  });

  test("PATCH /announcements/[id] -> 404 (cannot deface School A notice)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/announcements/${announcementA.id}`, {
      ...SAAS,
      method: "PATCH",
      cookie: cookieB,
      body: { title: "Defaced Notice" },
    });
    expect(res.status).toBe(404);

    const dbAnn = await db.announcement.findUniqueOrThrow({ where: { id: announcementA.id } });
    expect(dbAnn.title).toBe("Confidential Alpha Notice");
  });

  test("DELETE /announcements/[id] -> 404 (cannot delete School A notice)", async () => {
    const res = await api(`/api/v1/schools/${schoolB.code}/announcements/${announcementA.id}`, {
      ...SAAS,
      method: "DELETE",
      cookie: cookieB,
    });
    expect(res.status).toBe(404);

    const exists = await db.announcement.findUnique({ where: { id: announcementA.id } });
    expect(exists).not.toBeNull();
  });
});
