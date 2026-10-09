-- Phase 1.4 — Results, Grading, Approval State Machine & Public Verification
-- ADDITIVE ONLY. RLS and append-only grants ship in this same file.

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'PUBLISHED', 'LOCKED');

-- CreateTable
CREATE TABLE "Result" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "score" DECIMAL(6,2) NOT NULL,
    "maxScore" DECIMAL(6,2) NOT NULL DEFAULT 100,
    "status" "ResultStatus" NOT NULL DEFAULT 'DRAFT',
    "componentScores" JSONB,
    "gradeLetter" TEXT,
    "gradeRemark" TEXT,
    "enteredByStaffId" TEXT,
    "approvedByStaffId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "verificationToken" TEXT,
    "verificationHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResultAudit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "fromStatus" "ResultStatus" NOT NULL,
    "toStatus" "ResultStatus" NOT NULL,
    "fromScore" DECIMAL(6,2),
    "toScore" DECIMAL(6,2),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultAudit_pkey" PRIMARY KEY ("id")
);

-- Unique Indexes
CREATE UNIQUE INDEX "Result_tenantId_studentId_subjectId_periodId_key" ON "Result"("tenantId", "studentId", "subjectId", "periodId");
CREATE UNIQUE INDEX "Result_tenantId_id_key" ON "Result"("tenantId", "id");
CREATE UNIQUE INDEX "Result_verificationToken_key" ON "Result"("verificationToken") WHERE "verificationToken" IS NOT NULL;
CREATE UNIQUE INDEX "ResultAudit_tenantId_id_key" ON "ResultAudit"("tenantId", "id");

-- Performance Indexes
CREATE INDEX "Result_tenantId_periodId_idx" ON "Result"("tenantId", "periodId");
CREATE INDEX "Result_tenantId_studentId_periodId_idx" ON "Result"("tenantId", "studentId", "periodId");
CREATE INDEX "Result_tenantId_subjectId_periodId_idx" ON "Result"("tenantId", "subjectId", "periodId");
CREATE INDEX "ResultAudit_tenantId_resultId_idx" ON "ResultAudit"("tenantId", "resultId");
CREATE INDEX "ResultAudit_tenantId_createdAt_idx" ON "ResultAudit"("tenantId", "createdAt");

-- Foreign Keys
ALTER TABLE "Result" ADD CONSTRAINT "Result_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Result" ADD CONSTRAINT "Result_tenantId_studentId_fkey" FOREIGN KEY ("tenantId", "studentId") REFERENCES "StudentRecord"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Result" ADD CONSTRAINT "Result_tenantId_subjectId_fkey" FOREIGN KEY ("tenantId", "subjectId") REFERENCES "Subject"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Result" ADD CONSTRAINT "Result_tenantId_periodId_fkey" FOREIGN KEY ("tenantId", "periodId") REFERENCES "AcademicPeriod"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResultAudit" ADD CONSTRAINT "ResultAudit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResultAudit" ADD CONSTRAINT "ResultAudit_tenantId_resultId_fkey" FOREIGN KEY ("tenantId", "resultId") REFERENCES "Result"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Score Integrity Check Constraints
ALTER TABLE "Result" ADD CONSTRAINT "Result_score_range" CHECK ("score" >= 0 AND "score" <= "maxScore");
ALTER TABLE "Result" ADD CONSTRAINT "Result_maxScore_positive" CHECK ("maxScore" > 0);

-- Row-Level Security: Result
CREATE FUNCTION app_verification_token() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.verification_token', true), '') $$;

ALTER TABLE "Result" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Result" FORCE ROW LEVEL SECURITY;
CREATE POLICY result_read ON "Result" FOR SELECT
  USING ("tenantId" = app_tenant_id() OR ("verificationToken" = app_verification_token() AND "status" IN ('PUBLISHED', 'LOCKED')));
CREATE POLICY result_insert ON "Result" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY result_update ON "Result" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY result_delete ON "Result" FOR DELETE USING ("tenantId" = app_tenant_id());

-- Row-Level Security: ResultAudit
ALTER TABLE "ResultAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResultAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY result_audit_read ON "ResultAudit" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY result_audit_insert ON "ResultAudit" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());

-- Runtime Privileges & Append-Only Enforcement
SELECT app_grant_runtime_privileges();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."ResultAudit" FROM app_user;
  END IF;
END $$;
