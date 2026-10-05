import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type AuditDetails = { before?: unknown; after?: unknown; reason?: string };

/// Records a person-level security event (password reset/changed, MFA, profile and email changes, sessions).
/// Octalve Edu's AuditLog is per school, and a person can belong to several, so one row is written for each
/// school they belong to (none if they belong to none yet). AlEemaan's has no tenant column — a divergence kept
/// on purpose. `details` is for events that changed something: what it was and what it became.
export async function auditPersonEvent(userId: string, action: string, details: AuditDetails = {}): Promise<void> {
  const memberships = await prisma.tenantMembership.findMany({
    where: { userId },
    select: { tenantId: true },
  });
  if (memberships.length === 0) return;
  await prisma.auditLog.createMany({
    data: memberships.map((m) => ({
      tenantId: m.tenantId,
      actorUserId: userId,
      action,
      targetType: "User",
      targetId: userId,
      ...(details.before !== undefined ? { beforeValue: details.before as Prisma.InputJsonValue } : {}),
      ...(details.after !== undefined ? { afterValue: details.after as Prisma.InputJsonValue } : {}),
      ...(details.reason ? { reason: details.reason } : {}),
    })),
  });
}
