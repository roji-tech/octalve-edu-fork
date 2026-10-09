import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import {
  Role,
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

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let teacher: TestUser;
let parent: TestUser;
let outsider: TestUser;
const cookie: Record<string, string> = {};

let sessionA: { id: string };
let classGroupA: { id: string };
let armA: { id: string; name: string };
let student1: { id: string; admissionNo: string };
let student2: { id: string; admissionNo: string };

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School" });
  b = await createTenant({ name: "Beta School" });

  admin = await createUser();
  teacher = await createUser();
  parent = await createUser();
  outsider = await createUser();

  await addMembership(admin.id, a.id, Role.ADMIN);
  await addMembership(teacher.id, a.id, Role.TEACHING_STAFF);
  await addMembership(parent.id, a.id, Role.PARENT);
  await addMembership(outsider.id, b.id, Role.ADMIN);

  cookie.admin = await cookieFor(admin);
  cookie.teacher = await cookieFor(teacher);
  cookie.parent = await cookieFor(parent);
  cookie.outsider = await cookieFor(outsider);

  // Setup academic structure and session in School A
  sessionA = await db.academicSession.create({
    data: {
      tenantId: a.id,
      label: "2026/2027",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2027-07-20"),
      status: "ACTIVE",
    },
  });

  classGroupA = await db.classGroup.create({
    data: {
      tenantId: a.id,
      name: "JSS 1",
      sortOrder: 1,
    },
  });

  armA = await db.classArm.create({
    data: {
      tenantId: a.id,
      classGroupId: classGroupA.id,
      name: "A",
    },
  });

  // Create two students and enroll them in armA
  student1 = await db.studentRecord.create({
    data: {
      tenantId: a.id,
      firstName: "Fatima",
      lastName: "Bello",
      dateOfBirth: new Date("2014-04-10"),
      admissionNo: "2026/0001",
    },
  });

  student2 = await db.studentRecord.create({
    data: {
      tenantId: a.id,
      firstName: "Ibrahim",
      lastName: "Musa",
      dateOfBirth: new Date("2014-06-15"),
      admissionNo: "2026/0002",
    },
  });

  await db.studentEnrollment.createMany({
    data: [
      {
        tenantId: a.id,
        sessionId: sessionA.id,
        classArmId: armA.id,
        studentId: student1.id,
        status: "ACTIVE",
      },
      {
        tenantId: a.id,
        sessionId: sessionA.id,
        classArmId: armA.id,
        studentId: student2.id,
        status: "ACTIVE",
      },
    ],
  });
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
const armAttendanceRoute = (armId: string, code = a.code) => `/api/v1/schools/${code}/academics/arms/${armId}/attendance`;
const studentAttendanceRoute = (studentId: string, code = a.code) => `/api/v1/schools/${code}/people/students/${studentId}/attendance`;

test.describe("Phase 1.3: Attendance API", () => {
  test("GET roll-call requires authentication and staff role", async () => {
    // Unauthenticated
    const unauth = await api(armAttendanceRoute(armA.id), { ...SAAS });
    expect(unauth.status).toBe(401);

    // Parent forbidden
    const parentRes = await api(armAttendanceRoute(armA.id), as("parent"));
    expect(parentRes.status).toBe(403);

    // Cross-school outsider forbidden
    const crossRes = await api(armAttendanceRoute(armA.id), as("outsider"));
    expect(crossRes.status).toBe(403);
  });

  test("GET roll-call returns enrolled students with unmarked status", async () => {
    const today = new Date().toISOString().split("T")[0];
    const res = await api(`${armAttendanceRoute(armA.id)}?date=${today}`, as("teacher"));
    expect(res.status).toBe(200);

    const data = res.json.data;
    expect(data.classArm.name).toBe("A");
    expect(data.students).toHaveLength(2);
    expect(data.students[0].admissionNo).toBe("2026/0001");
    expect(data.students[0].status).toBeNull();
    expect(data.summary.total).toBe(2);
    expect(data.summary.present).toBe(0);
    expect(data.canEdit).toBe(true);
  });

  test("POST attendance refuses future dates", async () => {
    const futureDate = "2029-12-01";
    const res = await api(armAttendanceRoute(armA.id), {
      ...as("teacher"),
      method: "POST",
      body: {
        date: futureDate,
        records: [{ studentId: student1.id, status: "PRESENT" }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("FUTURE_DATE_NOT_ALLOWED");
  });

  test("POST attendance bulk-marks and idempotently updates records", async () => {
    const today = new Date().toISOString().split("T")[0];

    // 1. Initial mark: student1 PRESENT, student2 ABSENT
    const markRes = await api(armAttendanceRoute(armA.id), {
      ...as("teacher"),
      method: "POST",
      body: {
        date: today,
        records: [
          { studentId: student1.id, status: "PRESENT" },
          { studentId: student2.id, status: "ABSENT", remarks: "Fever" },
        ],
      },
    });

    expect(markRes.status).toBe(200);
    expect(markRes.json.data.count).toBe(2);
    expect(markRes.json.data.summary.present).toBe(1);
    expect(markRes.json.data.summary.absent).toBe(1);
    expect(markRes.json.data.summary.ratePercent).toBe(50);

    // Verify GET reflects the updated roll call
    const rollCall = await api(`${armAttendanceRoute(armA.id)}?date=${today}`, as("admin"));
    expect(rollCall.status).toBe(200);
    const students = rollCall.json.data.students;
    const s1 = students.find((s: { studentId: string }) => s.studentId === student1.id);
    const s2 = students.find((s: { studentId: string }) => s.studentId === student2.id);
    expect(s1.status).toBe("PRESENT");
    expect(s2.status).toBe("ABSENT");
    expect(s2.remarks).toBe("Fever");

    // 2. Idempotent re-mark: change student2 to LATE
    const reMarkRes = await api(armAttendanceRoute(armA.id), {
      ...as("teacher"),
      method: "POST",
      body: {
        date: today,
        records: [
          { studentId: student1.id, status: "PRESENT" },
          { studentId: student2.id, status: "LATE", remarks: "Arrived at 9am" },
        ],
      },
    });

    expect(reMarkRes.status).toBe(200);
    expect(reMarkRes.json.data.summary.present).toBe(1);
    expect(reMarkRes.json.data.summary.late).toBe(1);
    expect(reMarkRes.json.data.summary.absent).toBe(0);
    expect(reMarkRes.json.data.summary.ratePercent).toBe(100);

    // Verify AuditLog exists and has zero PII
    const audit = await db.auditLog.findFirst({
      where: {
        tenantId: a.id,
        targetType: "ClassArm",
        targetId: armA.id,
        action: "ATTENDANCE_MARKED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeDefined();
    const after = audit!.afterValue as Record<string, unknown>;
    expect(after.date).toBe(today);
    expect(after.recordsCount).toBe(2);
    expect(JSON.stringify(after)).not.toContain("Fatima");
    expect(JSON.stringify(after)).not.toContain("Ibrahim");
  });

  test("GET student attendance history returns individual records and summary", async () => {
    const res = await api(studentAttendanceRoute(student1.id), as("teacher"));
    expect(res.status).toBe(200);

    const data = res.json.data;
    expect(data.student.admissionNo).toBe("2026/0001");
    expect(data.records.length).toBeGreaterThanOrEqual(1);
    expect(data.records[0].status).toBe("PRESENT");
    expect(data.summary.present).toBeGreaterThanOrEqual(1);
  });

  test("enforces 7-day edit window for teachers, while admin can override", async () => {
    // 10 days ago
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const dateStr = tenDaysAgo.toISOString().split("T")[0];

    // Teacher attempt -> 403 EDIT_WINDOW_EXPIRED
    const teacherRes = await api(armAttendanceRoute(armA.id), {
      ...as("teacher"),
      method: "POST",
      body: {
        date: dateStr,
        records: [{ studentId: student1.id, status: "PRESENT" }],
      },
    });
    expect(teacherRes.status).toBe(403);
    expect(teacherRes.json.error.code).toBe("EDIT_WINDOW_EXPIRED");

    // Admin attempt on historical date -> 200 OK
    const adminRes = await api(armAttendanceRoute(armA.id), {
      ...as("admin"),
      method: "POST",
      body: {
        date: dateStr,
        records: [{ studentId: student1.id, status: "EXCUSED", remarks: "Doctor note" }],
      },
    });
    expect(adminRes.status).toBe(200);
    expect(adminRes.json.data.count).toBe(1);
  });
});
