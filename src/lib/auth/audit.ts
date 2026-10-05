import type { Prisma } from "@prisma/client";
import { forTenant, forUser } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";

export type AuditDetails = { before?: unknown; after?: unknown; reason?: string };

/// Records a person-level security event (password reset/changed, MFA, profile and email changes, sessions).
/// Octalve Edu's AuditLog is per school, and a person can belong to several, so one row is written for each
/// school they belong to (none if they belong to none yet). AlEemaan's has no tenant column — a divergence kept
/// on purpose. `details` is for events that changed something: what it was and what it became.
///
/// AuditLog is tenant-scoped (row-level security), so each row is written INSIDE that school's tenant context —
/// the id comes from the person's own membership rows, read through the user context, which is the proof
/// `trustedTenantId` needs.
export async function auditPersonEvent(userId: string, action: string, details: AuditDetails = {}): Promise<void> {
  const memberships = await forUser(userId).transaction((tx) =>
    tx.tenantMembership.findMany({ where: { userId, deactivatedAt: null }, select: { tenantId: true } }), // not a school they were removed from
  );
  for (const m of memberships) {
    await forTenant(trustedTenantId(m.tenantId)).transaction((tx) =>
      tx.auditLog.create({
        data: {
          tenantId: m.tenantId,
          actorUserId: userId,
          action,
          targetType: "User",
          targetId: userId,
          ...(details.before !== undefined ? { beforeValue: details.before as Prisma.InputJsonValue } : {}),
          ...(details.after !== undefined ? { afterValue: details.after as Prisma.InputJsonValue } : {}),
          ...(details.reason ? { reason: details.reason } : {}),
        },
      }),
    );
  }
}
