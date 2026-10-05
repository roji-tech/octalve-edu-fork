import type { Role } from "@prisma/client";
import { forUser } from "@/lib/tenant/for-tenant";

export type UserMembership = {
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  campusId: string | null;
  role: Role;
};

/// The schools a person belongs to, with their role in each. Read through the USER context — the path by which a
/// person may see their own memberships before any tenant is known (§0.5.2). `Tenant` is identity data (resolved
/// by code before anything is known), so it is joined freely; a campus NAME is tenant-scoped data and is not
/// readable while listing someone's memberships across schools, so only its id is returned — the name appears
/// inside the school.
export async function getUserMemberships(userId: string): Promise<UserMembership[]> {
  const rows = await forUser(userId).transaction((tx) =>
    tx.tenantMembership.findMany({
      where: { userId, deactivatedAt: null }, // a deactivated membership is no membership
      include: { tenant: { select: { id: true, code: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  );

  return rows.map((m) => ({
    tenantId: m.tenant.id,
    tenantCode: m.tenant.code,
    tenantName: m.tenant.name,
    campusId: m.campusId,
    role: m.role,
  }));
}
