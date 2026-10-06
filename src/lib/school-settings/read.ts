import type { SchoolSettings } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { VerifiedTenantId } from "@/lib/tenant/verified-tenant";

// The one internal read of a school's settings (domain-implementation-plan.md, "Build design — Phase 1.0", decision 2).
//
// Every school has exactly one row, inserted by the database when the school is (a trigger on "Tenant"), so a missing row is a
// BUG — a school created by something that bypassed the trigger, or a row deleted by hand — and it is reported as one. This function
// never invents defaults: code that silently falls back to "approval not required" or "no MFA for teachers" would be wrong in
// exactly the direction that matters. There is no write path in Phase 1.0; the settings screen (roadmap 1.7) adds it, with step-up MFA.
export async function getSchoolSettings(tx: Tx, tenantId: VerifiedTenantId): Promise<SchoolSettings> {
  const row = await tx.schoolSettings.findUnique({ where: { tenantId } });
  if (!row) throw new Error(`school ${tenantId} has no settings row — every school must (database trigger "tenant_creates_settings")`);
  return row;
}
