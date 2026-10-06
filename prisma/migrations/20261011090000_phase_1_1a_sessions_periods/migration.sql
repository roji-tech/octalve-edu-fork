-- Phase 1.1, family A — academic sessions and periods (plan "Build design — Phase 1.0 and 1.1", decisions 9, 10, 12).
-- ADDITIVE ONLY. Row-level security for both new tables ships in THIS migration. Nothing is ever deleted by a request: there is NO DELETE
-- policy on either table (rows are archived); a school's rows go only with the school (the cascade, run by the owner).

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "PeriodKind" AS ENUM ('TERM', 'SEMESTER', 'COHORT');

-- CreateTable
CREATE TABLE "AcademicSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campusId" TEXT,
    "label" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'PLANNED',
    "copiedFromId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademicPeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "PeriodKind" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcademicSession_tenantId_status_idx" ON "AcademicSession"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicSession_tenantId_id_key" ON "AcademicSession"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AcademicPeriod_tenantId_sessionId_idx" ON "AcademicPeriod"("tenantId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicPeriod_tenantId_id_key" ON "AcademicPeriod"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Campus_tenantId_id_key" ON "Campus"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AcademicSession" ADD CONSTRAINT "AcademicSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicSession" ADD CONSTRAINT "AcademicSession_tenantId_campusId_fkey" FOREIGN KEY ("tenantId", "campusId") REFERENCES "Campus"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicSession" ADD CONSTRAINT "AcademicSession_tenantId_copiedFromId_fkey" FOREIGN KEY ("tenantId", "copiedFromId") REFERENCES "AcademicSession"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicPeriod" ADD CONSTRAINT "AcademicPeriod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicPeriod" ADD CONSTRAINT "AcademicPeriod_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "AcademicSession"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- --- rules Prisma's schema language cannot express ------------------------------------------------------------------------------
ALTER TABLE "AcademicSession" ADD CONSTRAINT "AcademicSession_dates_ordered" CHECK ("endDate" > "startDate");
ALTER TABLE "AcademicSession" ADD CONSTRAINT "AcademicSession_label_not_blank" CHECK (length(btrim("label")) BETWEEN 1 AND 40);

-- A label is unique per (school, campus-scope) among LIVE sessions: an archived label can be reused. COALESCE makes "every campus" a scope of its own.
CREATE UNIQUE INDEX "AcademicSession_label_live" ON "AcademicSession"("tenantId", COALESCE("campusId", ''), "label") WHERE "archivedAt" IS NULL;
-- ONE active session per scope (decision 10): the guarantee under concurrency; the service's conditional update is the polite path to it.
CREATE UNIQUE INDEX "AcademicSession_one_active_per_scope" ON "AcademicSession"("tenantId", COALESCE("campusId", '')) WHERE "status" = 'ACTIVE' AND "archivedAt" IS NULL;
-- At most one live copy-forward per source session (decision 16): running copy-forward twice cannot duplicate.
CREATE UNIQUE INDEX "AcademicSession_one_live_copy" ON "AcademicSession"("tenantId", "copiedFromId") WHERE "copiedFromId" IS NOT NULL AND "archivedAt" IS NULL;

ALTER TABLE "AcademicPeriod" ADD CONSTRAINT "AcademicPeriod_dates_ordered" CHECK ("endDate" IS NULL OR "endDate" > "startDate");
ALTER TABLE "AcademicPeriod" ADD CONSTRAINT "AcademicPeriod_end_required_unless_cohort" CHECK ("kind" = 'COHORT' OR "endDate" IS NOT NULL);
ALTER TABLE "AcademicPeriod" ADD CONSTRAINT "AcademicPeriod_ordinal_positive" CHECK ("ordinal" >= 1);
ALTER TABLE "AcademicPeriod" ADD CONSTRAINT "AcademicPeriod_label_not_blank" CHECK (length(btrim("label")) BETWEEN 1 AND 60);
CREATE UNIQUE INDEX "AcademicPeriod_ordinal_live" ON "AcademicPeriod"("sessionId", "ordinal") WHERE "archivedAt" IS NULL;
CREATE UNIQUE INDEX "AcademicPeriod_label_live" ON "AcademicPeriod"("sessionId", "label") WHERE "archivedAt" IS NULL;
-- At most one CURRENT period per session (decision 12).
CREATE UNIQUE INDEX "AcademicPeriod_one_current" ON "AcademicPeriod"("sessionId") WHERE "isCurrent" AND "archivedAt" IS NULL;

-- --- row-level security (same migration as the tables: the catalog guard fails the build otherwise) -----------------------------
ALTER TABLE "AcademicSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AcademicSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY academic_session_read ON "AcademicSession" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY academic_session_insert ON "AcademicSession" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY academic_session_update ON "AcademicSession" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "AcademicPeriod" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AcademicPeriod" FORCE ROW LEVEL SECURITY;
CREATE POLICY academic_period_read ON "AcademicPeriod" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY academic_period_insert ON "AcademicPeriod" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY academic_period_update ON "AcademicPeriod" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

SELECT app_grant_runtime_privileges();
