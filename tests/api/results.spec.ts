import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, Permission } from "@prisma/client";
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

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let approverTeacher: TestUser;
let regularTeacher: TestUser;
let parent: TestUser;
let outsider: TestUser;
const cookie: Record<string, string> = {};

let sessionA: { id: string };
let periodA: { id: string };
let classGroupA: { id: string };
let armA: { id: string };
let subjectA: { id: string };
let student1: { id: string; admissionNo: string };
let student2: { id: string; admissionNo: string };

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha Results Academy" });
  b = await createTenant({ name: "Beta Independent School" });

  admin = await createUser();
  approverTeacher = await createUser();
  regularTeacher = await createUser();
  parent = await createUser();
  outsider = await createUser();

  await addMembership(admin.id, a.id, Role.ADMIN);
  // Teacher with CAN_APPROVE_RESULTS
  await db.tenantMembership.create({
    data: {
      userId: approverTeacher.id,
      tenantId: a.id,
      role: Role.TEACHING_STAFF,
      permissions: [Permission.CAN_APPROVE_RESULTS],
    },
  });
  // Regular teacher without extra permissions
  await addMembership(regularTeacher.id, a.id, Role.TEACHING_STAFF);
  await addMembership(parent.id, a.id, Role.PARENT);
  await addMembership(outsider.id, b.id, Role.ADMIN);

  cookie.admin = await cookieFor(admin);
  cookie.approver = await cookieFor(approverTeacher);
  cookie.teacher = await cookieFor(regularTeacher);
  cookie.parent = await cookieFor(parent);
  cookie.outsider = await cookieFor(outsider);

  // Academic Structure
  sessionA = await db.academicSession.create({
    data: {
      tenantId: a.id,
      label: "2026/2027",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2027-07-20"),
      status: "ACTIVE",
    },
  });

  periodA = await db.academicPeriod.create({
    data: {
      tenantId: a.id,
      sessionId: sessionA.id,
      kind: "TERM",
      ordinal: 1,
      label: "First Term",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-12-15"),
      isCurrent: true,
    },
  });

  classGroupA = await db.classGroup.create({
    data: {
      tenantId: a.id,
      name: "Grade 10",
      sortOrder: 1,
    },
  });

  armA = await db.classArm.create({
    data: {
      tenantId: a.id,
      classGroupId: classGroupA.id,
      name: "Gold",
    },
  });

  subjectA = await db.subject.create({
    data: {
      tenantId: a.id,
      name: "Mathematics",
      code: "MTH101",
    },
  });

  // Students in School A
  student1 = await db.studentRecord.create({
    data: {
      tenantId: a.id,
      firstName: "Fatima",
      lastName: "Bello",
      dateOfBirth: new Date("2011-04-10"),
      admissionNo: "2026/0101",
    },
  });

  student2 = await db.studentRecord.create({
    data: {
      tenantId: a.id,
      firstName: "Ibrahim",
      lastName: "Musa",
      dateOfBirth: new Date("2011-06-15"),
      admissionNo: "2026/0102",
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

  // Link parent to student1 only
  const guardianRec = await db.guardianRecord.create({
    data: {
      tenantId: a.id,
      userId: parent.id,
      firstName: "Amina",
      lastName: "Bello",
    },
  });

  await db.guardianLink.create({
    data: {
      tenantId: a.id,
      studentId: student1.id,
      guardianId: guardianRec.id,
      relationship: "MOTHER",
      status: "APPROVED",
      isPrimary: true,
    },
  });
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
const resultsRoute = (code = a.code) => `/api/v1/schools/${code}/academics/results`;
const transitionRoute = (code = a.code) => `/api/v1/schools/${code}/academics/results/transition`;
const reportCardRoute = (studentId: string, code = a.code) => `/api/v1/schools/${code}/people/students/${studentId}/report-card`;

test.describe("Phase 1.4: Results, Grading, Lifecycle & Verification API", () => {
  let createdResult1Id: string;
  let createdResult2Id: string;
  let verificationToken: string;

  test("GET /results requires staff role and returns empty list initially", async () => {
    // Unauthenticated
    const unauth = await api(resultsRoute(), { ...SAAS });
    expect(unauth.status).toBe(401);

    // Parent forbidden
    const parentRes = await api(resultsRoute(), as("parent"));
    expect(parentRes.status).toBe(403);

    // Teacher allowed
    const teacherRes = await api(`${resultsRoute()}?periodId=${periodA.id}&subjectId=${subjectA.id}`, as("teacher"));
    expect(teacherRes.status).toBe(200);
    expect(teacherRes.json.data.results).toEqual([]);
  });

  test("POST /results records scores and validates component caps", async () => {
    // Score > 100 refused
    const overflowRes = await api(
      resultsRoute(),
      as("teacher", {
        method: "POST",
        body: {
          periodId: periodA.id,
          subjectId: subjectA.id,
          results: [{ studentId: student1.id, score: 105 }],
        },
      }),
    );
    expect(overflowRes.status).toBe(400);

    // Valid score entry for both students
    const validRes = await api(
      resultsRoute(),
      as("teacher", {
        method: "POST",
        body: {
          periodId: periodA.id,
          subjectId: subjectA.id,
          results: [
            {
              studentId: student1.id,
              score: 88,
              components: [
                { name: "Continuous Assessment", score: 28, maxScore: 30 },
                { name: "Examination", score: 60, maxScore: 70 },
              ],
            },
            {
              studentId: student2.id,
              score: 74,
              components: [
                { name: "Continuous Assessment", score: 24, maxScore: 30 },
                { name: "Examination", score: 50, maxScore: 70 },
              ],
            },
          ],
        },
      }),
    );
    expect(validRes.status).toBe(200);
    expect(validRes.json.data.count).toBe(2);

    // Verify stored results in DRAFT status
    const listRes = await api(`${resultsRoute()}?periodId=${periodA.id}&subjectId=${subjectA.id}`, as("teacher"));
    expect(listRes.status).toBe(200);
    const rows = listRes.json.data.results;
    expect(rows.length).toBe(2);
    expect(rows[0].status).toBe("DRAFT");
    createdResult1Id = rows[0].id;
    createdResult2Id = rows[1].id;
  });

  test("Lifecycle state machine: SUBMIT -> APPROVE -> PUBLISH workflow", async () => {
    // 1. Regular teacher submits DRAFT -> SUBMITTED
    const submitRes = await api(
      transitionRoute(),
      as("teacher", {
        method: "POST",
        body: {
          resultIds: [createdResult1Id, createdResult2Id],
          toStatus: "SUBMITTED",
        },
      }),
    );
    expect(submitRes.status).toBe(200);

    // 2. Regular teacher tries to APPROVE -> forbidden (requires CAN_APPROVE_RESULTS)
    const teacherApproveRes = await api(
      transitionRoute(),
      as("teacher", {
        method: "POST",
        body: {
          resultIds: [createdResult1Id, createdResult2Id],
          toStatus: "APPROVED",
        },
      }),
    );
    expect(teacherApproveRes.status).toBe(403);

    // 3. Approver teacher approves SUBMITTED -> APPROVED
    const approverRes = await api(
      transitionRoute(),
      as("approver", {
        method: "POST",
        body: {
          resultIds: [createdResult1Id, createdResult2Id],
          toStatus: "APPROVED",
        },
      }),
    );
    expect(approverRes.status).toBe(200);

    // 4. Approver publishes APPROVED -> PUBLISHED
    const publishRes = await api(
      transitionRoute(),
      as("approver", {
        method: "POST",
        body: {
          resultIds: [createdResult1Id, createdResult2Id],
          toStatus: "PUBLISHED",
        },
      }),
    );
    expect(publishRes.status).toBe(200);

    // Verify ResultAudit rows exist for transitions
    const audits = await db.resultAudit.findMany({
      where: { resultId: createdResult1Id },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits[audits.length - 1].toStatus).toBe("PUBLISHED");
  });

  test("Report Card: retrieves compilation, rankings, and enforces IDOR", async () => {
    // 1. Staff can view student report card
    const staffRes = await api(`${reportCardRoute(student1.id)}?periodId=${periodA.id}`, as("teacher"));
    expect(staffRes.status).toBe(200);
    const data = staffRes.json.data;
    expect(data.student.admissionNo).toBe("2026/0101");
    expect(data.summary.classRank).toBe(1); // Score 88 > 74
    expect(data.summary.promotionOutcome).toBe("PROMOTED");
    expect(data.subjects[0].status).toBe("PUBLISHED");

    verificationToken = data.subjects[0].verificationToken;
    expect(verificationToken).toBeTruthy();

    // 2. Parent can view OWN child (student1)
    const parentOwnRes = await api(`${reportCardRoute(student1.id)}?periodId=${periodA.id}`, as("parent"));
    expect(parentOwnRes.status).toBe(200);

    // 3. IDOR: Parent tries to view another child (student2) -> 403 FORBIDDEN
    const parentOtherRes = await api(`${reportCardRoute(student2.id)}?periodId=${periodA.id}`, as("parent"));
    expect(parentOtherRes.status).toBe(403);
    expect(parentOtherRes.json.error.code).toBe("FORBIDDEN");
  });

  test("Public Verification: unauthenticated token check succeeds without leaking PII", async () => {
    expect(verificationToken).toBeTruthy();

    // 1. Unauthenticated public query to /api/v1/verify/[token]
    const verifyRes = await api(`/api/v1/verify/${verificationToken}`, { ...SAAS });
    expect(verifyRes.status).toBe(200);

    const verified = verifyRes.json.data;
    expect(verified.verified).toBe(true);
    expect(verified.institution).toBe(a.name);
    expect(verified.studentAdmissionNo).toBe("2026/0101");
    // Name is masked as initials for public privacy
    expect(verified.studentInitials).toBe("F. Bello");
    expect(verified.subject).toBe("Mathematics");
    expect(verified.verificationHash).toMatch(/^[0-9a-f]{64}$/);

    // 2. Invalid or non-existent token returns 404
    const unknownRes = await api(`/api/v1/verify/00000000000000000000000000000000`, { ...SAAS });
    expect(unknownRes.status).toBe(404);
  });
});
