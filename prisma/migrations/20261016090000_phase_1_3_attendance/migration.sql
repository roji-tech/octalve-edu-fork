-- Phase 1.3 — Attendance and day-to-day operations: daily roll call tracking for students and class arms.
-- ADDITIVE ONLY. RLS ships here, in the same file as the table.

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('ONLINE', 'OFFLINE_SYNC');

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "classArmId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "remarks" TEXT,
    "markedByUserId" TEXT,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "AttendanceSource" NOT NULL DEFAULT 'ONLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_tenantId_studentId_date_key" ON "AttendanceRecord"("tenantId", "studentId", "date");

-- CreateIndex
CREATE INDEX "AttendanceRecord_tenantId_classArmId_date_idx" ON "AttendanceRecord"("tenantId", "classArmId", "date");

-- CreateIndex
CREATE INDEX "AttendanceRecord_tenantId_studentId_date_idx" ON "AttendanceRecord"("tenantId", "studentId", "date");

-- CreateIndex
CREATE INDEX "AttendanceRecord_tenantId_date_idx" ON "AttendanceRecord"("tenantId", "date");

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_tenantId_studentId_fkey" FOREIGN KEY ("tenantId", "studentId") REFERENCES "StudentRecord"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_tenantId_classArmId_fkey" FOREIGN KEY ("tenantId", "classArmId") REFERENCES "ClassArm"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Validation Check Constraint
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_remarks_len" CHECK ("remarks" IS NULL OR length("remarks") <= 500);

-- Row-Level Security
ALTER TABLE "AttendanceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_record_read ON "AttendanceRecord" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY attendance_record_insert ON "AttendanceRecord" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY attendance_record_update ON "AttendanceRecord" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY attendance_record_delete ON "AttendanceRecord" FOR DELETE USING ("tenantId" = app_tenant_id());

SELECT app_grant_runtime_privileges();
