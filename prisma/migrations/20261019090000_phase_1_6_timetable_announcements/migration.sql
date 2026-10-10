-- Phase 1.6 — Announcements & Timetable Scheduling
-- ADDITIVE ONLY. RLS and runtime privileges ship in this same file.

-- CreateEnum: AnnouncementStatus
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable: Announcement
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campusId" TEXT,
    "classArmId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetRoles" "Role"[] NOT NULL DEFAULT ARRAY[]::"Role"[],
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'PUBLISHED',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "authorUserId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TimetableSlot
CREATE TABLE "TimetableSlot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "classArmId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "staffRecordId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "periodNumber" INTEGER,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "room" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimetableSlot_pkey" PRIMARY KEY ("id")
);

-- Unique Indexes
CREATE UNIQUE INDEX "Announcement_tenantId_id_key" ON "Announcement"("tenantId", "id");
CREATE UNIQUE INDEX "TimetableSlot_tenantId_id_key" ON "TimetableSlot"("tenantId", "id");

-- Performance Indexes
CREATE INDEX "Announcement_tenantId_status_idx" ON "Announcement"("tenantId", "status");
CREATE INDEX "Announcement_tenantId_campusId_idx" ON "Announcement"("tenantId", "campusId");
CREATE INDEX "Announcement_tenantId_classArmId_idx" ON "Announcement"("tenantId", "classArmId");
CREATE INDEX "Announcement_tenantId_publishedAt_idx" ON "Announcement"("tenantId", "publishedAt");

CREATE INDEX "TimetableSlot_tenantId_classArmId_idx" ON "TimetableSlot"("tenantId", "classArmId");
CREATE INDEX "TimetableSlot_tenantId_staffRecordId_idx" ON "TimetableSlot"("tenantId", "staffRecordId");
CREATE INDEX "TimetableSlot_tenantId_dayOfWeek_idx" ON "TimetableSlot"("tenantId", "dayOfWeek");

-- Foreign Keys
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_tenantId_campusId_fkey" FOREIGN KEY ("tenantId", "campusId") REFERENCES "Campus"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_tenantId_classArmId_fkey" FOREIGN KEY ("tenantId", "classArmId") REFERENCES "ClassArm"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_tenantId_classArmId_fkey" FOREIGN KEY ("tenantId", "classArmId") REFERENCES "ClassArm"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_tenantId_subjectId_fkey" FOREIGN KEY ("tenantId", "subjectId") REFERENCES "Subject"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_tenantId_staffRecordId_fkey" FOREIGN KEY ("tenantId", "staffRecordId") REFERENCES "StaffRecord"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Validation Check Constraints
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_dayOfWeek_valid" CHECK ("dayOfWeek" >= 1 AND "dayOfWeek" <= 7);
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_time_order" CHECK ("startTime" < "endTime");

-- Row-Level Security: Announcement
ALTER TABLE "Announcement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Announcement" FORCE ROW LEVEL SECURITY;
CREATE POLICY announcement_tenant_isolation ON "Announcement" FOR ALL TO app_user
    USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

-- Row-Level Security: TimetableSlot
ALTER TABLE "TimetableSlot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TimetableSlot" FORCE ROW LEVEL SECURITY;
CREATE POLICY timetable_slot_tenant_isolation ON "TimetableSlot" FOR ALL TO app_user
    USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

-- Runtime Privileges
CREATE OR REPLACE FUNCTION public.app_grant_runtime_privileges()
  RETURNS void
  LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE NOTICE 'role app_user does not exist: runtime privileges NOT granted (create it, then run: SELECT app_grant_runtime_privileges())';
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO app_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."_prisma_migrations" FROM app_user;
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."AuditLog" FROM app_user;
  IF to_regclass('public."ResultAudit"') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."ResultAudit" FROM app_user;
  END IF;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
END
$function$;

SELECT app_grant_runtime_privileges();
