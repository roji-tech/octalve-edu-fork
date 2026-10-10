-- Phase 1.7 — Settings UI, Step-up MFA & Audit Logging
-- ADDITIVE ONLY. RLS and append-only grants ship in this same file.

-- CreateTable
CREATE TABLE "SettingsChangeAudit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "fromValue" TEXT NOT NULL,
    "toValue" TEXT NOT NULL,
    "stepUpVerifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettingsChangeAudit_pkey" PRIMARY KEY ("id")
);

-- Unique Indexes
CREATE UNIQUE INDEX "SettingsChangeAudit_tenantId_id_key" ON "SettingsChangeAudit"("tenantId", "id");

-- Performance Indexes
CREATE INDEX "SettingsChangeAudit_tenantId_idx" ON "SettingsChangeAudit"("tenantId");
CREATE INDEX "SettingsChangeAudit_tenantId_createdAt_idx" ON "SettingsChangeAudit"("tenantId", "createdAt");

-- Foreign Keys
ALTER TABLE "SettingsChangeAudit" ADD CONSTRAINT "SettingsChangeAudit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: SettingsChangeAudit
ALTER TABLE "SettingsChangeAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SettingsChangeAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_change_audit_read ON "SettingsChangeAudit" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY settings_change_audit_insert ON "SettingsChangeAudit" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());

-- Runtime Privileges & Append-Only Enforcement
SELECT app_grant_runtime_privileges();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."SettingsChangeAudit" FROM app_user;
  END IF;
END $$;
