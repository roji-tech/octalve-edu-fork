-- Phase 1.0 — foundations (domain-implementation-plan.md "Build design — Phase 1.0 and 1.1", decisions 1–6).
-- ADDITIVE ONLY: every existing school becomes K12 with a settings row; every membership keeps its meaning with no extra permissions.
-- Row-level security for the new table ships in THIS migration, as the rule says.

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('PER_TERM', 'PER_SESSION');

-- CreateEnum
CREATE TYPE "RolloverMode" AS ENUM ('AUTOMATIC', 'ADMIN_CONFIRMED');

-- CreateEnum
CREATE TYPE "DiscountWorkflowMode" AS ENUM ('MANUAL_OVERRIDE', 'APPROVAL_REQUIRED');

-- CreateEnum
CREATE TYPE "FeeCostBearer" AS ENUM ('SCHOOL_ABSORBS', 'PASSED_TO_PARENT');

-- CreateEnum
CREATE TYPE "SchoolType" AS ENUM ('K12', 'HIGHER_ED', 'VOCATIONAL');

-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('CAN_APPROVE_RESULTS', 'CAN_MANAGE_FINANCE', 'CAN_PUBLISH_CONTENT', 'CAN_MANAGE_USERS');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "schoolType" "SchoolType" NOT NULL DEFAULT 'K12';

-- AlterTable
ALTER TABLE "TenantMembership" ADD COLUMN     "permissions" "Permission"[] NOT NULL DEFAULT ARRAY[]::"Permission"[];

-- CreateTable
CREATE TABLE "SchoolSettings" (
    "tenantId" TEXT NOT NULL,
    "resultApprovalRequired" BOOLEAN NOT NULL DEFAULT true,
    "rolloverMode" "RolloverMode" NOT NULL DEFAULT 'ADMIN_CONFIRMED',
    "classAutoAssignment" BOOLEAN NOT NULL DEFAULT false,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'PER_TERM',
    "feeReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "discountWorkflowMode" "DiscountWorkflowMode" NOT NULL DEFAULT 'MANUAL_OVERRIDE',
    "feeCostBearer" "FeeCostBearer" NOT NULL DEFAULT 'SCHOOL_ABSORBS',
    "multiCampusEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaRequiredForTeaching" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolSettings_pkey" PRIMARY KEY ("tenantId")
);

-- AddForeignKey
ALTER TABLE "SchoolSettings" ADD CONSTRAINT "SchoolSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- --- permissions are meaningful only on staff roles (decision 6) -----------------------------------------------------------
-- ADMIN implies every permission and stores none; a STUDENT or PARENT can never hold one. The service clears them on a role change;
-- this CHECK is the guarantee when something else writes the row.
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_permissions_staff_only"
  CHECK (permissions = ARRAY[]::"Permission"[] OR role IN ('TEACHING_STAFF', 'NON_TEACHING_STAFF'));

-- --- SchoolSettings: backfill, then the trigger that makes the row impossible to forget (decision 3) ---------------------------
-- Backfill FIRST, before row-level security exists on the table, so it works for whatever role runs the migration. Idempotent.
INSERT INTO "SchoolSettings" ("tenantId") SELECT "id" FROM "Tenant" ON CONFLICT ("tenantId") DO NOTHING;

-- Every tenant gets its settings row from the database, whichever code created the tenant (the setup wizard, a test helper, a
-- future signup, hand-run SQL). The table is under FORCE row-level security and the inserting role has no tenant context yet (the
-- wizard sets it AFTER creating the tenant), so the function sets app.tenant_id to the new tenant for this one insert and then puts
-- the caller's previous value back — a trigger must never leave its caller in a different school's context.
CREATE FUNCTION school_settings_for_new_tenant() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  previous text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', NEW."id", true);
  INSERT INTO "SchoolSettings" ("tenantId") VALUES (NEW."id") ON CONFLICT ("tenantId") DO NOTHING;
  PERFORM set_config('app.tenant_id', COALESCE(previous, ''), true);
  RETURN NEW;
END
$$;

CREATE TRIGGER tenant_creates_settings AFTER INSERT ON "Tenant"
  FOR EACH ROW EXECUTE FUNCTION school_settings_for_new_tenant();

-- --- row-level security (same migration as the table: the catalog guard fails the build otherwise) ---------------------------
ALTER TABLE "SchoolSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SchoolSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY school_settings_read ON "SchoolSettings" FOR SELECT
  USING ("tenantId" = app_tenant_id());
CREATE POLICY school_settings_insert ON "SchoolSettings" FOR INSERT
  WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY school_settings_update ON "SchoolSettings" FOR UPDATE
  USING ("tenantId" = app_tenant_id())
  WITH CHECK ("tenantId" = app_tenant_id());
-- No DELETE policy: a school's settings row goes only with the school (the cascade, run by the owner), never by a request.

SELECT app_grant_runtime_privileges();
