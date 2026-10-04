import { prisma } from "@/lib/db";

/// Records a person-level security event (password reset/changed). Octalve Edu's AuditLog is per
/// school, and a person can belong to several, so one row is written for each school they belong to
/// (none if they belong to none yet). AlEemaan's has no tenant column — a divergence kept on purpose.
export async function auditPersonEvent(userId: string, action: string): Promise<void> {
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
    })),
  });
}
