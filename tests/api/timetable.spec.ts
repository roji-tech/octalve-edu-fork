import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role } from "@prisma/client";
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

let a: TestTenant;
let b: TestTenant;
let adminA: TestUser;
let teacherA: TestUser;
let studentA: TestUser;
let adminB: TestUser;

let classArmA1: { id: string };
let classArmA2: { id: string };
let subjectMath: { id: string };
let subjectEng: { id: string };
let staffTeacherA: { id: string };
let staffTeacherB: { id: string };

const cookie: Record<string, string> = {};

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, { baseUrl: SAAS_URL });
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha Timetable College" });
  b = await createTenant({ name: "Beta Independent School" });

  adminA = await createUser();
  teacherA = await createUser();
  studentA = await createUser();
  adminB = await createUser();

  await addMembership(adminA.id, a.id, Role.ADMIN);
  await addMembership(teacherA.id, a.id, Role.TEACHING_STAFF);
  await addMembership(studentA.id, a.id, Role.STUDENT);
  await addMembership(adminB.id, b.id, Role.ADMIN);

  cookie.adminA = await cookieFor(adminA);
  cookie.teacherA = await cookieFor(teacherA);
  cookie.studentA = await cookieFor(studentA);
  cookie.adminB = await cookieFor(adminB);

  // Fixtures in Tenant A
  const cg = await db.classGroup.create({
    data: { tenantId: a.id, name: "Grade 10" },
  });

  classArmA1 = await db.classArm.create({
    data: { tenantId: a.id, classGroupId: cg.id, name: "10A" },
  });

  classArmA2 = await db.classArm.create({
    data: { tenantId: a.id, classGroupId: cg.id, name: "10B" },
  });

  subjectMath = await db.subject.create({
    data: { tenantId: a.id, name: "Mathematics", code: "MATH101" },
  });

  subjectEng = await db.subject.create({
    data: { tenantId: a.id, name: "English Literature", code: "ENG101" },
  });

  staffTeacherA = await db.staffRecord.create({
    data: {
      tenantId: a.id,
      category: "TEACHING",
      firstName: "John",
      lastName: "Doe",
      userId: teacherA.id,
    },
  });

  // Second teacher
  const teacher2 = await createUser();
  await addMembership(teacher2.id, a.id, Role.TEACHING_STAFF);
  staffTeacherB = await db.staffRecord.create({
    data: {
      tenantId: a.id,
      category: "TEACHING",
      firstName: "Mary",
      lastName: "Smith",
      userId: teacher2.id,
    },
  });
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("Timetable API & Clash Engine", () => {
  let createdSlotId: string;

  test("admin can create a timetable slot", async () => {
    const res = await api(`/api/v1/schools/${a.code}/timetable`, {
      method: "POST",
      body: {
        classArmId: classArmA1.id,
        subjectId: subjectMath.id,
        staffRecordId: staffTeacherA.id,
        dayOfWeek: 1, // Monday
        startTime: "08:00",
        endTime: "09:00",
        periodNumber: 1,
        room: "Science Hall 1",
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({
      classArmId: classArmA1.id,
      subjectId: subjectMath.id,
      staffRecordId: staffTeacherA.id,
      dayOfWeek: 1,
      startTime: "08:00",
      endTime: "09:00",
      room: "Science Hall 1",
    });
    createdSlotId = res.json.data.id;
  });

  test("student cannot create a timetable slot (403)", async () => {
    const res = await api(`/api/v1/schools/${a.code}/timetable`, {
      method: "POST",
      body: {
        classArmId: classArmA1.id,
        subjectId: subjectMath.id,
        staffRecordId: staffTeacherA.id,
        dayOfWeek: 2,
        startTime: "09:00",
        endTime: "10:00",
      },
      cookie: cookie.studentA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(403);
  });

  test("rejects invalid time ordering (startTime >= endTime)", async () => {
    const res = await api(`/api/v1/schools/${a.code}/timetable`, {
      method: "POST",
      body: {
        classArmId: classArmA1.id,
        subjectId: subjectMath.id,
        staffRecordId: staffTeacherA.id,
        dayOfWeek: 2,
        startTime: "10:00",
        endTime: "09:00",
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(400);
  });

  test("clash detection: rejects teacher double-booking with HTTP 409", async () => {
    // Teacher A is already booked Monday 08:00-09:00 in 10A
    // Attempt to schedule Teacher A in 10B on Monday 08:30-09:30
    const res = await api(`/api/v1/schools/${a.code}/timetable`, {
      method: "POST",
      body: {
        classArmId: classArmA2.id,
        subjectId: subjectEng.id,
        staffRecordId: staffTeacherA.id,
        dayOfWeek: 1,
        startTime: "08:30",
        endTime: "09:30",
        room: "Hall 2",
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("TIMETABLE_CLASH");
    expect(res.json.error.message).toContain("Teacher is already scheduled");
  });

  test("clash detection: rejects class arm schedule overlap with HTTP 409", async () => {
    // Class Arm 10A is already scheduled Monday 08:00-09:00 with Teacher A
    // Attempt to schedule Class Arm 10A with Teacher B on Monday 08:15-09:15
    const res = await api(`/api/v1/schools/${a.code}/timetable`, {
      method: "POST",
      body: {
        classArmId: classArmA1.id,
        subjectId: subjectEng.id,
        staffRecordId: staffTeacherB.id,
        dayOfWeek: 1,
        startTime: "08:15",
        endTime: "09:15",
        room: "Hall 3",
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("TIMETABLE_CLASH");
    expect(res.json.error.message).toContain("Class arm is already scheduled");
  });

  test("clash detection: rejects room collision with HTTP 409", async () => {
    // "Science Hall 1" is booked Monday 08:00-09:00
    // Attempt to book "science hall 1" (case-insensitive) for 10B with Teacher B on Monday 08:00-09:00
    const res = await api(`/api/v1/schools/${a.code}/timetable`, {
      method: "POST",
      body: {
        classArmId: classArmA2.id,
        subjectId: subjectEng.id,
        staffRecordId: staffTeacherB.id,
        dayOfWeek: 1,
        startTime: "08:00",
        endTime: "09:00",
        room: "science hall 1",
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("TIMETABLE_CLASH");
    expect(res.json.error.message).toContain("is already booked");
  });

  test("permits contiguous adjacent slots without conflict", async () => {
    // Monday 09:00-10:00 immediately following 08:00-09:00
    const res = await api(`/api/v1/schools/${a.code}/timetable`, {
      method: "POST",
      body: {
        classArmId: classArmA1.id,
        subjectId: subjectEng.id,
        staffRecordId: staffTeacherA.id,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "10:00",
        room: "Science Hall 1",
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(201);
  });

  test("allows query and list of timetable slots", async () => {
    const res = await api(`/api/v1/schools/${a.code}/timetable?classArmId=${classArmA1.id}`, {
      method: "GET",
      cookie: cookie.studentA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(200);
    expect(res.json.data.slots.length).toBeGreaterThanOrEqual(2);
    expect(res.json.data.groupedByDay[1].length).toBeGreaterThanOrEqual(2);
  });

  test("batch schedule rejects internal collision within batch payload", async () => {
    const res = await api(`/api/v1/schools/${a.code}/timetable/batch`, {
      method: "POST",
      body: {
        slots: [
          {
            classArmId: classArmA1.id,
            subjectId: subjectMath.id,
            staffRecordId: staffTeacherB.id,
            dayOfWeek: 3,
            startTime: "11:00",
            endTime: "12:00",
          },
          {
            classArmId: classArmA2.id,
            subjectId: subjectEng.id,
            staffRecordId: staffTeacherB.id, // Teacher B scheduled twice simultaneously!
            dayOfWeek: 3,
            startTime: "11:30",
            endTime: "12:30",
          },
        ],
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("TIMETABLE_CLASH");
  });

  test("cross-tenant isolation: Tenant B admin cannot update or delete Tenant A slot", async () => {
    const patchRes = await api(`/api/v1/schools/${b.code}/timetable/${createdSlotId}`, {
      method: "PATCH",
      body: { startTime: "14:00", endTime: "15:00" },
      cookie: cookie.adminB,
      baseUrl: SAAS_URL,
    });
    expect(patchRes.status).toBe(404);

    const delRes = await api(`/api/v1/schools/${b.code}/timetable/${createdSlotId}`, {
      method: "DELETE",
      cookie: cookie.adminB,
      baseUrl: SAAS_URL,
    });
    expect(delRes.status).toBe(404);
  });

  test("admin can delete timetable slot", async () => {
    const delRes = await api(`/api/v1/schools/${a.code}/timetable/${createdSlotId}`, {
      method: "DELETE",
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });
    expect(delRes.status).toBe(200);
  });
});
