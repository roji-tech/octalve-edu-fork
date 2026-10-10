import "../support/env";
import { test, expect } from "@playwright/test";
import { createTenant, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";

let school: TestTenant;

test.beforeAll(async () => {
  await seedInstance();
  school = await createTenant({ name: "Index Performance Benchmark Academy" });
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

interface ExplainRow {
  "QUERY PLAN": string;
}

async function explainQuery(tx: Tx, query: string): Promise<string> {
  const rows = await tx.$queryRawUnsafe<ExplainRow[]>(`EXPLAIN ${query}`);
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

test.describe("PostgreSQL EXPLAIN Index Performance & Sanity Verification", () => {
  test("1. AttendanceRecord: Queries by (tenantId, classArmId, date) and (tenantId, studentId) use compound indexes", async () => {
    const tenantId = trustedTenantId(school.id);

    await forTenant(tenantId).transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off;");

      // 1a. Arm Roll-Call query: (tenantId, classArmId, date)
      const rollCallPlan = await explainQuery(
        tx,
        `SELECT * FROM "AttendanceRecord"
         WHERE "tenantId" = '${tenantId}'
           AND "classArmId" = 'test_arm_cuid'
           AND "date" = '2026-10-10'::date;`,
      );
      expect(rollCallPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(rollCallPlan).not.toContain('Seq Scan on "AttendanceRecord"');
      expect(rollCallPlan).toMatch(/AttendanceRecord_tenantId_/);

      // 1b. Student attendance history query: (tenantId, studentId, date)
      const historyPlan = await explainQuery(
        tx,
        `SELECT * FROM "AttendanceRecord"
         WHERE "tenantId" = '${tenantId}'
           AND "studentId" = 'test_student_cuid';`,
      );
      expect(historyPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(historyPlan).not.toContain('Seq Scan on "AttendanceRecord"');
      expect(historyPlan).toMatch(/AttendanceRecord_tenantId_/);
    });
  });

  test("2. Result: Queries by (tenantId, periodId), (tenantId, studentId, periodId), and (tenantId, subjectId, periodId) utilize indexes", async () => {
    const tenantId = trustedTenantId(school.id);

    await forTenant(tenantId).transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off;");

      // 2a. Period results: (tenantId, periodId)
      const periodPlan = await explainQuery(
        tx,
        `SELECT * FROM "Result"
         WHERE "tenantId" = '${tenantId}'
           AND "periodId" = 'test_period_cuid';`,
      );
      expect(periodPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(periodPlan).not.toContain('Seq Scan on "Result"');
      expect(periodPlan).toMatch(/Result_tenantId_/);

      // 2b. Student report card: (tenantId, studentId, periodId)
      const studentPlan = await explainQuery(
        tx,
        `SELECT * FROM "Result"
         WHERE "tenantId" = '${tenantId}'
           AND "studentId" = 'test_student_cuid'
           AND "periodId" = 'test_period_cuid';`,
      );
      expect(studentPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(studentPlan).not.toContain('Seq Scan on "Result"');
      expect(studentPlan).toMatch(/Result_tenantId_/);

      // 2c. Subject results: (tenantId, subjectId, periodId)
      const subjectPlan = await explainQuery(
        tx,
        `SELECT * FROM "Result"
         WHERE "tenantId" = '${tenantId}'
           AND "subjectId" = 'test_subject_cuid'
           AND "periodId" = 'test_period_cuid';`,
      );
      expect(subjectPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(subjectPlan).not.toContain('Seq Scan on "Result"');
      expect(subjectPlan).toMatch(/Result_tenantId_/);
    });
  });

  test("3. Invoice: Queries by (tenantId, status), (tenantId, periodId), and (tenantId, studentId) utilize indexes", async () => {
    const tenantId = trustedTenantId(school.id);

    await forTenant(tenantId).transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off;");

      // 3a. Invoices by status: (tenantId, status)
      const statusPlan = await explainQuery(
        tx,
        `SELECT * FROM "Invoice"
         WHERE "tenantId" = '${tenantId}'
           AND "status" = 'UNPAID';`,
      );
      expect(statusPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(statusPlan).not.toContain('Seq Scan on "Invoice"');
      expect(statusPlan).toMatch(/Invoice_tenantId_/);

      // 3b. Invoices by period: (tenantId, periodId)
      const periodPlan = await explainQuery(
        tx,
        `SELECT * FROM "Invoice"
         WHERE "tenantId" = '${tenantId}'
           AND "periodId" = 'test_period_cuid';`,
      );
      expect(periodPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(periodPlan).not.toContain('Seq Scan on "Invoice"');
      expect(periodPlan).toMatch(/Invoice_tenantId_/);

      // 3c. Invoices by student: (tenantId, studentId)
      const studentPlan = await explainQuery(
        tx,
        `SELECT * FROM "Invoice"
         WHERE "tenantId" = '${tenantId}'
           AND "studentId" = 'test_student_cuid';`,
      );
      expect(studentPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(studentPlan).not.toContain('Seq Scan on "Invoice"');
      expect(studentPlan).toMatch(/Invoice_tenantId_/);
    });
  });

  test("4. TimetableSlot: Queries by (tenantId, classArmId), (tenantId, staffRecordId), and (tenantId, dayOfWeek) utilize indexes", async () => {
    const tenantId = trustedTenantId(school.id);

    await forTenant(tenantId).transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off;");

      // 4a. Timetable by arm: (tenantId, classArmId)
      const armPlan = await explainQuery(
        tx,
        `SELECT * FROM "TimetableSlot"
         WHERE "tenantId" = '${tenantId}'
           AND "classArmId" = 'test_arm_cuid';`,
      );
      expect(armPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(armPlan).not.toContain('Seq Scan on "TimetableSlot"');
      expect(armPlan).toMatch(/TimetableSlot_tenantId_/);

      // 4b. Timetable by teacher: (tenantId, staffRecordId)
      const teacherPlan = await explainQuery(
        tx,
        `SELECT * FROM "TimetableSlot"
         WHERE "tenantId" = '${tenantId}'
           AND "staffRecordId" = 'test_staff_cuid';`,
      );
      expect(teacherPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(teacherPlan).not.toContain('Seq Scan on "TimetableSlot"');
      expect(teacherPlan).toMatch(/TimetableSlot_tenantId_/);

      // 4c. Timetable by day: (tenantId, dayOfWeek)
      const dayPlan = await explainQuery(
        tx,
        `SELECT * FROM "TimetableSlot"
         WHERE "tenantId" = '${tenantId}'
           AND "dayOfWeek" = 1;`,
      );
      expect(dayPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(dayPlan).not.toContain('Seq Scan on "TimetableSlot"');
      expect(dayPlan).toMatch(/TimetableSlot_tenantId_/);
    });
  });

  test("5. SettingsChangeAudit & StudentEnrollment: Queries utilize compound indexes", async () => {
    const tenantId = trustedTenantId(school.id);

    await forTenant(tenantId).transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off;");

      // 5a. Settings audit ordered by createdAt: (tenantId, createdAt)
      const auditPlan = await explainQuery(
        tx,
        `SELECT * FROM "SettingsChangeAudit"
         WHERE "tenantId" = '${tenantId}'
         ORDER BY "createdAt" DESC;`,
      );
      expect(auditPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(auditPlan).not.toContain('Seq Scan on "SettingsChangeAudit"');
      expect(auditPlan).toMatch(/SettingsChangeAudit_tenantId_/);

      // 5b. Enrollment unique lookup: (tenantId, studentId, sessionId)
      const enrollPlan = await explainQuery(
        tx,
        `SELECT * FROM "StudentEnrollment"
         WHERE "tenantId" = '${tenantId}'
           AND "studentId" = 'test_student_cuid'
           AND "sessionId" = 'test_session_cuid';`,
      );
      expect(enrollPlan).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(enrollPlan).not.toContain('Seq Scan on "StudentEnrollment"');
      expect(enrollPlan).toMatch(/StudentEnrollment_tenantId_/);
    });
  });
});
