-- Phase 1.2 — people and enrolment: staff records, students, guardians, enrolment (plan "Build design — Phase 1.2", reconciliations 1–6, decisions P2–P8).
-- ADDITIVE ONLY (seven new tables and one nullable column on "Invitation"). RLS ships here, in the same file as the tables. Records are ARCHIVED, never deleted:
-- no DELETE policy, except on StaffSubjectAssignment (nothing references an assignment yet).

-- CreateEnum
CREATE TYPE "StaffCategory" AS ENUM ('TEACHING', 'NON_TEACHING');

-- CreateEnum
CREATE TYPE "Relationship" AS ENUM ('MOTHER', 'FATHER', 'GUARDIAN', 'OTHER');

-- CreateEnum
CREATE TYPE "GuardianLinkStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'PROMOTED', 'REPEATED', 'WITHDRAWN', 'TRANSFERRED', 'ALUMNI');

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "staffRecordId" TEXT;

-- CreateTable
CREATE TABLE "StaffRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campusId" TEXT,
    "userId" TEXT,
    "category" "StaffCategory" NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffSubjectAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "staffRecordId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classArmId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffSubjectAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campusId" TEXT,
    "userId" TEXT,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "admissionNo" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionCounter" (
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AdmissionCounter_pkey" PRIMARY KEY ("tenantId","year")
);

-- CreateTable
CREATE TABLE "GuardianRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardianRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardianLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "relationship" "Relationship" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "status" "GuardianLinkStatus" NOT NULL DEFAULT 'APPROVED',
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "GuardianLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentEnrollment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "classArmId" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffRecord_tenantId_idx" ON "StaffRecord"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffRecord_tenantId_id_key" ON "StaffRecord"("tenantId", "id");

-- CreateIndex
CREATE INDEX "StaffSubjectAssignment_tenantId_idx" ON "StaffSubjectAssignment"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffSubjectAssignment_staffRecordId_subjectId_classArmId_key" ON "StaffSubjectAssignment"("staffRecordId", "subjectId", "classArmId");

-- CreateIndex
CREATE INDEX "StudentRecord_tenantId_idx" ON "StudentRecord"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentRecord_tenantId_id_key" ON "StudentRecord"("tenantId", "id");

-- CreateIndex
CREATE INDEX "GuardianRecord_tenantId_idx" ON "GuardianRecord"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianRecord_tenantId_id_key" ON "GuardianRecord"("tenantId", "id");

-- CreateIndex
CREATE INDEX "GuardianLink_tenantId_studentId_idx" ON "GuardianLink"("tenantId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianLink_studentId_guardianId_key" ON "GuardianLink"("studentId", "guardianId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_tenantId_classArmId_idx" ON "StudentEnrollment"("tenantId", "classArmId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentEnrollment_tenantId_studentId_sessionId_key" ON "StudentEnrollment"("tenantId", "studentId", "sessionId");

-- AddForeignKey
ALTER TABLE "StaffRecord" ADD CONSTRAINT "StaffRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffRecord" ADD CONSTRAINT "StaffRecord_tenantId_campusId_fkey" FOREIGN KEY ("tenantId", "campusId") REFERENCES "Campus"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffRecord" ADD CONSTRAINT "StaffRecord_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "TenantMembership"("userId", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSubjectAssignment" ADD CONSTRAINT "StaffSubjectAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSubjectAssignment" ADD CONSTRAINT "StaffSubjectAssignment_tenantId_staffRecordId_fkey" FOREIGN KEY ("tenantId", "staffRecordId") REFERENCES "StaffRecord"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSubjectAssignment" ADD CONSTRAINT "StaffSubjectAssignment_tenantId_subjectId_fkey" FOREIGN KEY ("tenantId", "subjectId") REFERENCES "Subject"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSubjectAssignment" ADD CONSTRAINT "StaffSubjectAssignment_tenantId_classArmId_fkey" FOREIGN KEY ("tenantId", "classArmId") REFERENCES "ClassArm"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_tenantId_campusId_fkey" FOREIGN KEY ("tenantId", "campusId") REFERENCES "Campus"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "TenantMembership"("userId", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionCounter" ADD CONSTRAINT "AdmissionCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianRecord" ADD CONSTRAINT "GuardianRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianRecord" ADD CONSTRAINT "GuardianRecord_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "TenantMembership"("userId", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_tenantId_studentId_fkey" FOREIGN KEY ("tenantId", "studentId") REFERENCES "StudentRecord"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_tenantId_guardianId_fkey" FOREIGN KEY ("tenantId", "guardianId") REFERENCES "GuardianRecord"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_tenantId_studentId_fkey" FOREIGN KEY ("tenantId", "studentId") REFERENCES "StudentRecord"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "AcademicSession"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_tenantId_classArmId_fkey" FOREIGN KEY ("tenantId", "classArmId") REFERENCES "ClassArm"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_staffRecordId_fkey" FOREIGN KEY ("tenantId", "staffRecordId") REFERENCES "StaffRecord"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;



-- --- rules Prisma's schema language cannot express ------------------------------------------------------------------------------
-- Names: 1–80 characters once trimmed. Phone: 7–20 characters of digits, spaces and + - ( ). Email: lower-case, one @.
ALTER TABLE "StaffRecord" ADD CONSTRAINT "StaffRecord_names_valid" CHECK (length(btrim("firstName")) BETWEEN 1 AND 80 AND length(btrim("lastName")) BETWEEN 1 AND 80);
ALTER TABLE "StaffRecord" ADD CONSTRAINT "StaffRecord_phone_shape" CHECK ("phone" IS NULL OR ("phone" ~ '^[0-9+() -]{7,20}$'));
ALTER TABLE "StaffRecord" ADD CONSTRAINT "StaffRecord_email_shape" CHECK ("email" IS NULL OR ("email" = lower("email") AND length("email") <= 254 AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'));
-- One account, one record, per school. A NULL userId (no account) is the normal case and is never constrained.
CREATE UNIQUE INDEX "StaffRecord_account_once" ON "StaffRecord"("tenantId", "userId") WHERE "userId" IS NOT NULL;
CREATE UNIQUE INDEX "StaffRecord_email_live" ON "StaffRecord"("tenantId", lower("email")) WHERE "email" IS NOT NULL AND "archivedAt" IS NULL;

ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_names_valid" CHECK (
  length(btrim("firstName")) BETWEEN 1 AND 80 AND length(btrim("lastName")) BETWEEN 1 AND 80
  AND ("middleName" IS NULL OR length(btrim("middleName")) BETWEEN 1 AND 80));
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_birth_date_floor" CHECK ("dateOfBirth" >= DATE '1900-01-01');
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_admission_no_shape" CHECK ("admissionNo" ~ '^[A-Za-z0-9][A-Za-z0-9/.-]{0,29}$');
-- An admission number is unique per school ignoring case, ARCHIVED records included: a number is never reused.
CREATE UNIQUE INDEX "StudentRecord_admission_no_key" ON "StudentRecord"("tenantId", lower("admissionNo"));
CREATE UNIQUE INDEX "StudentRecord_account_once" ON "StudentRecord"("tenantId", "userId") WHERE "userId" IS NOT NULL;

ALTER TABLE "AdmissionCounter" ADD CONSTRAINT "AdmissionCounter_range" CHECK ("year" BETWEEN 1900 AND 9999 AND "next" >= 1);

ALTER TABLE "GuardianRecord" ADD CONSTRAINT "GuardianRecord_names_valid" CHECK (length(btrim("firstName")) BETWEEN 1 AND 80 AND length(btrim("lastName")) BETWEEN 1 AND 80);
ALTER TABLE "GuardianRecord" ADD CONSTRAINT "GuardianRecord_phone_shape" CHECK ("phone" IS NULL OR ("phone" ~ '^[0-9+() -]{7,20}$'));
ALTER TABLE "GuardianRecord" ADD CONSTRAINT "GuardianRecord_email_shape" CHECK ("email" IS NULL OR ("email" = lower("email") AND length("email") <= 254 AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'));
CREATE UNIQUE INDEX "GuardianRecord_account_once" ON "GuardianRecord"("tenantId", "userId") WHERE "userId" IS NOT NULL;

-- A link is revoked exactly when it says when; a revoked link is never the primary contact; at most one live primary per student.
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_revoked_consistent" CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL));
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_revoked_not_primary" CHECK (NOT ("isPrimary" AND "status" = 'REVOKED'));
CREATE UNIQUE INDEX "GuardianLink_one_primary" ON "GuardianLink"("studentId") WHERE "isPrimary" AND "status" <> 'REVOKED';

-- --- row-level security ---------------------------------------------------------------------------------------------------------
ALTER TABLE "StaffRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_record_read ON "StaffRecord" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY staff_record_insert ON "StaffRecord" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY staff_record_update ON "StaffRecord" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "StaffSubjectAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffSubjectAssignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_subject_assignment_read ON "StaffSubjectAssignment" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY staff_subject_assignment_insert ON "StaffSubjectAssignment" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY staff_subject_assignment_delete ON "StaffSubjectAssignment" FOR DELETE USING ("tenantId" = app_tenant_id());

ALTER TABLE "StudentRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StudentRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY student_record_read ON "StudentRecord" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY student_record_insert ON "StudentRecord" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY student_record_update ON "StudentRecord" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "AdmissionCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdmissionCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_counter_read ON "AdmissionCounter" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY admission_counter_insert ON "AdmissionCounter" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY admission_counter_update ON "AdmissionCounter" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "GuardianRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuardianRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY guardian_record_read ON "GuardianRecord" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY guardian_record_insert ON "GuardianRecord" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY guardian_record_update ON "GuardianRecord" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "GuardianLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuardianLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY guardian_link_read ON "GuardianLink" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY guardian_link_insert ON "GuardianLink" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY guardian_link_update ON "GuardianLink" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "StudentEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StudentEnrollment" FORCE ROW LEVEL SECURITY;
CREATE POLICY student_enrollment_read ON "StudentEnrollment" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY student_enrollment_insert ON "StudentEnrollment" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY student_enrollment_update ON "StudentEnrollment" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

SELECT app_grant_runtime_privileges();
