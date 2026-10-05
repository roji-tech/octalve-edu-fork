-- Users pages and invitations (domain-implementation-plan.md §0.5.4): a membership can be deactivated, and a person can be
-- invited to a school by a hashed, single-use, expiring link. ADDITIVE ONLY — no existing row changes meaning (every current
-- membership has deactivatedAt NULL = active). RLS for the new table ships in THIS migration, as the rule says.

-- AlterTable
ALTER TABLE "TenantMembership" ADD COLUMN     "deactivatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "campusId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT,
    "acceptedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_email_idx" ON "Invitation"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_createdAt_idx" ON "Invitation"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One LIVE invitation per (school, address): a second one cannot exist while the first is still open. The application revokes
-- the earlier one before inserting; this index is the guarantee under concurrency (two admins inviting the same person at once).
-- (A partial unique index — Prisma's schema language cannot express it, so it lives only here.)
CREATE UNIQUE INDEX "Invitation_one_live_per_address" ON "Invitation"("tenantId", "email") WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- --- row-level security (same migration as the table: the catalog guard fails the build otherwise) ----------------------------
-- A third transaction-local setting, like app.tenant_id / app.user_id: the HASH of an invitation token the caller presented. It
-- is read-only and matches exactly the one row whose secret the caller holds (see lib/tenant/for-tenant.ts, forInvitation).
CREATE FUNCTION app_invitation_hash() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.invitation_hash', true), '') $$;

ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" FORCE ROW LEVEL SECURITY;
-- Read: the school's own invitations, OR the one whose token hash the caller presented (the invitee, before any membership).
CREATE POLICY invitation_read ON "Invitation" FOR SELECT
  USING ("tenantId" = app_tenant_id() OR "tokenHash" = app_invitation_hash());
-- Writes: tenant context only. Accepting an invitation sets the tenant context from the row it found, then writes.
CREATE POLICY invitation_insert ON "Invitation" FOR INSERT
  WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY invitation_update ON "Invitation" FOR UPDATE
  USING ("tenantId" = app_tenant_id())
  WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY invitation_delete ON "Invitation" FOR DELETE
  USING ("tenantId" = app_tenant_id());

-- The runtime role's privileges on the new table come from the default privileges set in the RLS migration; granting again is
-- idempotent and covers a database whose default privileges were never set.
SELECT app_grant_runtime_privileges();
