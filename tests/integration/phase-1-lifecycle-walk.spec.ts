import "../support/env";
import { test, expect } from "@playwright/test";
import { AttendanceStatus, InvoiceStatus, Relationship, ResultStatus, Role, StaffCategory } from "@prisma/client";
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
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { activateSession, createPeriod, createSession } from "@/lib/academics/sessions";
import { createArm, createClassGroup, createSubject, setOfferings } from "@/lib/academics/classes";
import { createScheme } from "@/lib/academics/assessment";
import { createScale, makeDefaultScale } from "@/lib/academics/grading";
import { addAssignment, createStaff, linkAccount as linkStaffAccount } from "@/lib/people/staff";
import { createStudent, enrolStudent } from "@/lib/people/students";
import { addGuardian } from "@/lib/people/guardians";
import { getArmRollCall, markArmAttendance, getStudentAttendanceHistory } from "@/lib/attendance/service";
import { getStudentReportCard, recordStudentResults, transitionResultStatuses } from "@/lib/results/service";
import { createFeeStructure, fulfillPayment, generateInvoicesForPeriod, getStudentInvoice, initializePayment } from "@/lib/finance/service";
import { mockPaystack } from "@/lib/finance/mock-paystack";
import { createTimetableSlot, queryTimetableSlots } from "@/lib/timetable/service";
import { createAnnouncement, listAnnouncements } from "@/lib/announcements/service";
import { mutateSchoolSettings } from "@/lib/school-settings/service";

let school: TestTenant;
let adminUser: TestUser;
let teacherUser: TestUser;
let studentUser: TestUser;
let parentUser: TestUser;

const tenantCtx = (role: Role = Role.ADMIN, campusId: string | null = null): TenantAuthContext["tenant"] => ({
  tenantId: trustedTenantId(school.id),
  tenantCode: school.code,
  tenantName: school.name,
  schoolType: "K12",
  role,
  campusId,
  permissions: [],
  run: <T>(fn: (tx: Tx) => Promise<T>) => forTenant(trustedTenantId(school.id)).transaction(fn),
});

test.beforeAll(async () => {
  await seedInstance();
  school = await createTenant({ name: "Crescent Horizon Model College" });

  adminUser = await createUser({ name: "Principal Fatima" });
  teacherUser = await createUser({ name: "Mr. Babatunde" });
  studentUser = await createUser({ name: "Chinedu Eze" });
  parentUser = await createUser({ name: "Mrs. Ngozi Eze" });

  await addMembership(adminUser.id, school.id, Role.ADMIN);
  await addMembership(teacherUser.id, school.id, Role.TEACHING_STAFF);
  await addMembership(studentUser.id, school.id, Role.STUDENT);
  await addMembership(parentUser.id, school.id, Role.PARENT);
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe.serial("Phase 1 Complete Operational Lifecycle Walk", () => {
  let sessionId: string;
  let periodId: string;
  let classGroupId: string;
  let classArmId: string;
  let subjectId: string;
  let scaleId: string;
  let staffRecordId: string;
  let studentRecordId: string;
  let invoiceId: string;

  test("Step 1: Admin establishes academic session, term period, and activates session", async () => {
    const admin = tenantCtx(Role.ADMIN);

    const sessionRes = await createSession(admin, adminUser.id, {
      label: "2026/2027 Academic Session",
      startDate: "2026-09-01",
      endDate: "2027-07-20",
    });
    expect(sessionRes.ok).toBe(true);
    if (!sessionRes.ok) return;
    sessionId = sessionRes.session.id;

    const periodRes = await createPeriod(admin, adminUser.id, sessionId, {
      label: "First Term 2026",
      startDate: "2026-09-01",
      endDate: "2026-12-18",
    });
    expect(periodRes.ok).toBe(true);
    if (!periodRes.ok) return;
    periodId = periodRes.period.id;

    const activateRes = await activateSession(admin, adminUser.id, sessionId, { closeCurrent: true });
    expect(activateRes.ok).toBe(true);
  });

  test("Step 2: Admin configures class structure, subjects, assessment schemes, and grade scales", async () => {
    const admin = tenantCtx(Role.ADMIN);

    // Class group & arm
    const groupRes = await createClassGroup(admin, adminUser.id, { name: "Senior Secondary 1", sortOrder: 10 });
    expect(groupRes.ok).toBe(true);
    if (!groupRes.ok) return;
    classGroupId = groupRes.group.id;

    const armRes = await createArm(admin, adminUser.id, classGroupId, { name: "Gold", capacity: 40 });
    expect(armRes.ok).toBe(true);
    if (!armRes.ok) return;
    classArmId = armRes.arm.id;

    // Subject
    const subjectRes = await createSubject(admin, adminUser.id, { name: "English Language", code: "ENG101" });
    expect(subjectRes.ok).toBe(true);
    if (!subjectRes.ok) return;
    subjectId = subjectRes.subject.id;

    // Class Group studies Subject
    const offerRes = await setOfferings(admin, adminUser.id, classGroupId, [subjectId]);
    expect(offerRes.ok).toBe(true);

    // Assessment Scheme: 40% CA + 60% Exam = 100
    const schemeRes = await createScheme(admin, adminUser.id, {
      name: "Standard 40-60 Scheme",
      examMax: 60,
      components: [
        { name: "Continuous Assessment 1", maxScore: 20 },
        { name: "Continuous Assessment 2", maxScore: 20 },
      ],
    });
    expect(schemeRes.ok).toBe(true);
    if (!schemeRes.ok) return;
    expect(schemeRes.scheme.id).toBeDefined();

    // Grade Scale: WAEC A1 to F9 (ordered ascending score)
    const scaleRes = await createScale(admin, adminUser.id, {
      name: "WAEC Standard Scale",
      bands: [
        { letter: "F9", min: 0, max: 45, remark: "Fail" },
        { letter: "P7", min: 45, max: 60, remark: "Pass" },
        { letter: "C4", min: 60, max: 70, remark: "Credit" },
        { letter: "B2", min: 70, max: 75, remark: "Very Good" },
        { letter: "A1", min: 75, max: 100, remark: "Distinction" },
      ],
    });
    expect(scaleRes.ok).toBe(true);
    if (!scaleRes.ok) return;
    scaleId = scaleRes.scale.id;

    const defRes = await makeDefaultScale(admin, adminUser.id, scaleId);
    expect(defRes.ok).toBe(true);
  });

  test("Step 3: Admin sets up staff, links teacher user account, and assigns teaching responsibility", async () => {
    const admin = tenantCtx(Role.ADMIN);

    const staffRes = await createStaff(admin, adminUser.id, {
      firstName: "Babatunde",
      lastName: "Olawale",
      category: StaffCategory.TEACHING,
      email: teacherUser.email,
    });
    expect(staffRes.ok).toBe(true);
    if (!staffRes.ok) return;
    staffRecordId = staffRes.staff.id;

    // Link teacher account
    const linkRes = await linkStaffAccount(admin, adminUser.id, staffRecordId, { userId: teacherUser.id });
    expect(linkRes.ok).toBe(true);

    // Assign subject & arm
    const assignRes = await addAssignment(admin, adminUser.id, staffRecordId, {
      subjectId,
      classArmId,
    });
    expect(assignRes.ok).toBe(true);
  });

  test("Step 4: Admin enrols student into arm, creates guardian, and establishes primary link", async () => {
    const admin = tenantCtx(Role.ADMIN);

    const studentRes = await createStudent(admin, adminUser.id, {
      firstName: "Chinedu",
      lastName: "Eze",
      admissionNo: "ADM-2026-0042",
      dateOfBirth: "2010-06-15",
    });
    expect(studentRes.ok).toBe(true);
    if (!studentRes.ok) return;
    studentRecordId = studentRes.student.id;

    // Link student user account for self-service portal
    await db.studentRecord.update({
      where: { id: studentRecordId },
      data: { userId: studentUser.id },
    });

    // Enrol into active session & class arm
    const enrolRes = await enrolStudent(admin, adminUser.id, studentRecordId, { sessionId, classArmId });
    if (!enrolRes.ok) {
      console.error("enrolStudent failed:", enrolRes);
    }
    expect(enrolRes.ok).toBe(true);

    // Add guardian and link in one call
    const guardianLinkRes = await addGuardian(admin, adminUser.id, studentRecordId, {
      firstName: "Ngozi",
      lastName: "Eze",
      email: parentUser.email,
      phone: "+2348031234567",
      relationship: Relationship.MOTHER,
      isPrimary: true,
    });
    expect(guardianLinkRes.ok).toBe(true);
    if (!guardianLinkRes.ok) return;

    // Link guardian user account
    await db.guardianRecord.update({
      where: { id: guardianLinkRes.link.guardian.id },
      data: { userId: parentUser.id },
    });
  });

  test("Step 5: Teacher logs in and conducts daily roll-call attendance for class arm", async () => {
    const admin = tenantCtx(Role.ADMIN);
    const today = "2026-10-10";

    // Teacher retrieves roll call roster
    const rollCall = await admin.run((tx) => getArmRollCall(tx, school.id, classArmId, today, "TEACHING_STAFF"));
    expect(rollCall.ok).toBe(true);
    if (!rollCall.ok) return;
    expect(rollCall.data.students).toHaveLength(1);
    expect(rollCall.data.students[0].studentId).toBe(studentRecordId);

    // Teacher marks attendance as PRESENT
    const markRes = await admin.run((tx) =>
      markArmAttendance(tx, school.id, classArmId, teacherUser.id, "TEACHING_STAFF", {
        date: today,
        source: "ONLINE",
        records: [{ studentId: studentRecordId, status: AttendanceStatus.PRESENT }],
      }),
    );
    expect(markRes.ok).toBe(true);
    if (!markRes.ok) return;
    expect(markRes.data.summary.present).toBe(1);

    // Verify student attendance history reflects 100% presence
    const history = await admin.run((tx) => getStudentAttendanceHistory(tx, school.id, studentRecordId));
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.data.records).toHaveLength(1);
    expect(history.data.records[0].status).toBe(AttendanceStatus.PRESENT);
    expect(history.data.summary.present).toBe(1);
  });

  test("Step 6: Teacher records component assessment marks and Admin approves & publishes results", async () => {
    const admin = tenantCtx(Role.ADMIN);

    // Teacher records marks: CA (36/40) + Exam (52/60) = 88 (A1)
    const recordRes = await admin.run((tx) =>
      recordStudentResults(tx, school.id, teacherUser.id, {
        periodId,
        subjectId,
        results: [
          {
            studentId: studentRecordId,
            score: 88,
            maxScore: 100,
            components: [
              { name: "Continuous Assessment 1", score: 18, maxScore: 20 },
              { name: "Continuous Assessment 2", score: 18, maxScore: 20 },
              { name: "Final Examination", score: 52, maxScore: 60 },
            ],
          },
        ],
      }),
    );
    expect(recordRes.ok).toBe(true);
    if (!recordRes.ok) return;
    const resultId = recordRes.data.saved[0];

    // Admin transitions DRAFT -> SUBMITTED
    const submitRes = await admin.run((tx) =>
      transitionResultStatuses(tx, school.id, adminUser.id, "ADMIN", [], {
        resultIds: [resultId],
        toStatus: ResultStatus.SUBMITTED,
      }),
    );
    expect(submitRes.ok).toBe(true);

    // Admin transitions SUBMITTED -> APPROVED
    const approveRes = await admin.run((tx) =>
      transitionResultStatuses(tx, school.id, adminUser.id, "ADMIN", ["CAN_APPROVE_RESULTS"], {
        resultIds: [resultId],
        toStatus: ResultStatus.APPROVED,
      }),
    );
    expect(approveRes.ok).toBe(true);

    // Admin transitions APPROVED -> PUBLISHED
    const publishRes = await admin.run((tx) =>
      transitionResultStatuses(tx, school.id, adminUser.id, "ADMIN", ["CAN_APPROVE_RESULTS"], {
        resultIds: [resultId],
        toStatus: ResultStatus.PUBLISHED,
      }),
    );
    expect(publishRes.ok).toBe(true);

    // Verify audit logs were written
    const audits = await db.resultAudit.findMany({ where: { tenantId: school.id, resultId } });
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  test("Step 7: Student and Parent access official term report card", async () => {
    const student = tenantCtx(Role.STUDENT);

    // Student views own report card
    const studentReport = await student.run((tx) =>
      getStudentReportCard(tx, school.id, studentRecordId, periodId, "STUDENT", studentUser.id),
    );
    expect(studentReport.ok).toBe(true);
    if (!studentReport.ok || !studentReport.data) return;
    expect(studentReport.data.subjects).toHaveLength(1);
    expect(Number(studentReport.data.subjects[0].score)).toBe(88);
    expect(studentReport.data.subjects[0].gradeLetter).toBe("A1");
    expect(studentReport.data.summary.totalScore).toBe(88);

    // Parent views child's report card
    const parent = tenantCtx(Role.PARENT);
    const parentReport = await parent.run((tx) => getStudentReportCard(tx, school.id, studentRecordId, periodId, "PARENT", parentUser.id));
    expect(parentReport.ok).toBe(true);
  });

  test("Step 8: Admin creates fee structure, generates invoice, and parent completes payment", async () => {
    const tenantId = trustedTenantId(school.id);

    // Admin creates tuition fee structure
    const fee = await createFeeStructure(
      tenantId,
      {
        name: "Term 1 Senior Tuition",
        amount: 85000,
        periodId,
        classGroupId,
      },
      adminUser.id,
    );
    expect(fee.id).toBeDefined();

    // Admin batch generates invoices for the period
    const batchRes = await generateInvoicesForPeriod(tenantId, school.code, periodId, { actorUserId: adminUser.id });
    expect(batchRes.created).toBe(1);

    // Verify student invoice was generated
    const studentInvoice = await db.invoice.findFirstOrThrow({
      where: { tenantId: school.id, studentId: studentRecordId, periodId },
    });
    expect(studentInvoice.status).toBe(InvoiceStatus.UNPAID);
    expect(Number(studentInvoice.totalAmount)).toBe(85000);
    invoiceId = studentInvoice.id;

    // Parent retrieves own student invoice
    const parentInvoice = await getStudentInvoice(tenantId, invoiceId, {
      userId: parentUser.id,
      roles: [Role.PARENT],
      permissions: [],
    });
    expect(parentInvoice.id).toBe(invoiceId);

    // Initialize Paystack payment
    const initRes = await initializePayment(tenantId, invoiceId, parentUser.email, 85000);
    expect(initRes.reference).toBeDefined();

    // Simulate payment completion in mock gateway
    mockPaystack.simulatePaymentCompletion(initRes.reference, "success", 85000 * 100);

    // Fulfill payment (simulating Paystack webhook or checkout verification)
    const fulfillRes = await fulfillPayment(initRes.reference, { tenantIdOverride: tenantId });
    expect(fulfillRes.success).toBe(true);

    // Verify invoice status in DB is PAID with balance 0
    const paidInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(paidInvoice.status).toBe(InvoiceStatus.PAID);
    expect(Number(paidInvoice.amountPaid)).toBe(85000);
  });

  test("Step 9: Admin schedules timetable slots and broadcasts announcements", async () => {
    // Timetable slot for English Language
    const slotRes = await createTimetableSlot(school.id, {
      classArmId,
      subjectId,
      staffRecordId,
      dayOfWeek: 1, // Monday
      startTime: "08:00",
      endTime: "09:00",
      room: "Room 101",
    });
    expect(slotRes.ok).toBe(true);

    // Query arm timetable slots
    const slots = await queryTimetableSlots(school.id, { classArmId });
    expect(slots.slots).toHaveLength(1);
    expect(slots.slots[0].startTime).toBe("08:00");

    // Publish Announcement targeted to Students and Parents
    const noticeRes = await createAnnouncement(school.id, adminUser.id, {
      title: "Welcome to Academic Session 2026/2027",
      body: "Orientation begins next Monday. All fee payments must be finalized.",
      targetRoles: [Role.STUDENT, Role.PARENT],
      status: "PUBLISHED",
      isPinned: false,
      classArmId,
    });
    expect(noticeRes.ok).toBe(true);

    // Student fetches announcement feed
    const studentFeed = await listAnnouncements(
      school.id,
      {
        role: Role.STUDENT,
        classArmId,
        userId: studentUser.id,
      },
      { page: 1, pageSize: 25 },
    );
    expect(studentFeed.items.some((a) => a.title.includes("Welcome") && a.body.includes("Orientation"))).toBe(true);
  });

  test("Step 10: Admin reconfigures school workflow toggle with step-up verification", async () => {
    // Admin toggles resultApprovalRequired with step-up verification timestamp
    const mutateRes = await mutateSchoolSettings(school.id, adminUser.id, { resultApprovalRequired: false }, new Date());

    expect(mutateRes.settings.resultApprovalRequired).toBe(false);
    expect(mutateRes.deltas).toHaveLength(1);
    expect(mutateRes.deltas[0].isWeakeningSecurity).toBe(true);

    // Verify immutable SettingsChangeAudit record
    const auditRecord = await db.settingsChangeAudit.findFirstOrThrow({
      where: {
        tenantId: school.id,
        actorUserId: adminUser.id,
        field: "resultApprovalRequired",
      },
    });
    expect(auditRecord.fromValue).toBe("true");
    expect(auditRecord.toValue).toBe("false");
    expect(auditRecord.stepUpVerifiedAt).toBeDefined();
  });
});
