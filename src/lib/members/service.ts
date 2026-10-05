import type { Prisma, Role } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";

// The school's people (domain-implementation-plan.md §0.5.4, "Members API" and "Authority rules").
//
// People are read THROUGH `tenantMembership` — the `User` table has no tenant column, so row-level security cannot protect it;
// a query that went to `user` directly could return anyone on the platform. Here the membership is the door and only a narrow
// `select` of the person's name and address goes through it.
//
// Every change is audited in the same transaction as the change.

type TenantCtx = TenantAuthContext["tenant"];

export type MemberStatus = "active" | "deactivated";
export type MemberFilters = { role?: Role; campusId?: string; status: MemberStatus | "all"; q?: string };

export type PublicMember = {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
  campusId: string | null;
  campusName: string | null;
  status: MemberStatus;
  joinedAt: Date;
};

const MEMBER_SELECT = {
  userId: true,
  role: true,
  campusId: true,
  deactivatedAt: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
  campus: { select: { name: true } },
} satisfies Prisma.TenantMembershipSelect;

type MemberRow = Prisma.TenantMembershipGetPayload<{ select: typeof MEMBER_SELECT }>;

const toPublic = (row: MemberRow): PublicMember => ({
  userId: row.userId,
  name: row.user.name,
  email: row.user.email,
  role: row.role,
  campusId: row.campusId,
  campusName: row.campus?.name ?? null,
  status: row.deactivatedAt ? "deactivated" : "active",
  joinedAt: row.createdAt,
});

/// Prisma's `contains` hands the value to `ILIKE` as it is, so `%` and `_` in what someone typed would act as patterns (a search for
/// "%" listing everyone). Backslash is Postgres' default LIKE escape: escape the three special characters and the search is text.
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export async function listMembers(tenant: TenantCtx, filters: MemberFilters, page: { skip: number; take: number }): Promise<{ members: PublicMember[]; total: number }> {
  const where: Prisma.TenantMembershipWhereInput = {
    tenantId: tenant.tenantId,
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.campusId ? { campusId: filters.campusId } : {}),
    ...(filters.status === "active" ? { deactivatedAt: null } : filters.status === "deactivated" ? { deactivatedAt: { not: null } } : {}),
    ...(filters.q
      ? { user: { OR: [{ name: { contains: escapeLike(filters.q), mode: "insensitive" as const } }, { email: { contains: escapeLike(filters.q), mode: "insensitive" as const } }] } }
      : {}),
  };
  const [total, rows] = await tenant.run((tx) =>
    Promise.all([
      tx.tenantMembership.count({ where }),
      tx.tenantMembership.findMany({
        where,
        select: MEMBER_SELECT,
        orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }, { id: "asc" }], // a stable order, so pages never overlap or skip
        skip: page.skip,
        take: page.take,
      }),
    ]),
  );
  return { members: rows.map(toPublic), total };
}

export type MemberFailure =
  /// No such member of THIS school: unknown, another school's, or not a member — one answer.
  | "NOT_FOUND"
  /// Nobody changes or deactivates themselves here ("ask another administrator"): an accidental self-lockout is worse than an extra step.
  | "SELF"
  /// The school's last active administrator cannot be demoted or deactivated: it would leave the school with nobody who can manage it.
  | "LAST_ADMIN"
  | "INVALID_CAMPUS"
  /// A deactivated member must be reactivated before anything else about them changes.
  | "DEACTIVATED";

export type MemberResult = { ok: true; member: PublicMember; changed: boolean } | { ok: false; reason: MemberFailure };

const find = (tx: Tx, tenantId: string, userId: string) =>
  tx.tenantMembership.findUnique({ where: { userId_tenantId: { userId, tenantId } }, select: { id: true, ...MEMBER_SELECT } });

/// True when `tenantId` has MORE than one active administrator — and holds a row lock on all of them for the rest of the
/// transaction. Two administrators demoting each other at the same instant would each see "the other is still an admin"
/// without the lock; with it the second waits for the first to commit, re-reads, and finds itself the last.
async function hasAnotherActiveAdmin(tx: Tx, tenantId: string): Promise<boolean> {
  const admins = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "TenantMembership" WHERE "tenantId" = ${tenantId} AND role = 'ADMIN' AND "deactivatedAt" IS NULL FOR UPDATE`;
  return admins.length > 1;
}

export async function changeMember(
  tenant: TenantCtx,
  actorUserId: string,
  targetUserId: string,
  change: { role?: Role; campusId?: string | null },
): Promise<MemberResult> {
  if (targetUserId === actorUserId) return { ok: false, reason: "SELF" };
  const { tenantId } = tenant;
  return tenant.run(async (tx): Promise<MemberResult> => {
    const current = await find(tx, tenantId, targetUserId);
    if (!current) return { ok: false, reason: "NOT_FOUND" };
    if (current.deactivatedAt) return { ok: false, reason: "DEACTIVATED" };

    if (change.campusId) {
      // A campus of ANOTHER school is, to this one, a campus that does not exist.
      const campus = await tx.campus.findFirst({ where: { id: change.campusId, tenantId }, select: { id: true } });
      if (!campus) return { ok: false, reason: "INVALID_CAMPUS" };
    }

    const roleChanged = change.role !== undefined && change.role !== current.role;
    const campusChanged = change.campusId !== undefined && change.campusId !== current.campusId;
    if (!roleChanged && !campusChanged) return { ok: true, member: toPublic(current), changed: false }; // a no-op writes nothing

    if (roleChanged && current.role === "ADMIN" && change.role !== "ADMIN" && !(await hasAnotherActiveAdmin(tx, tenantId))) {
      return { ok: false, reason: "LAST_ADMIN" };
    }

    const updated = await tx.tenantMembership.update({
      where: { id: current.id },
      data: { ...(roleChanged ? { role: change.role } : {}), ...(campusChanged ? { campusId: change.campusId } : {}) },
      select: MEMBER_SELECT,
    });
    if (roleChanged) {
      await tx.auditLog.create({
        data: { tenantId, actorUserId, action: "MEMBER_ROLE_CHANGED", targetType: "User", targetId: targetUserId, beforeValue: { role: current.role }, afterValue: { role: change.role } },
      });
    }
    if (campusChanged) {
      await tx.auditLog.create({
        data: { tenantId, actorUserId, action: "MEMBER_CAMPUS_CHANGED", targetType: "User", targetId: targetUserId, beforeValue: { campusId: current.campusId }, afterValue: { campusId: change.campusId ?? null } },
      });
    }
    return { ok: true, member: toPublic(updated), changed: true };
  });
}

/// Deactivates the person IN THIS SCHOOL: the row stays (history, and a way back) but it stops being a membership — their access
/// ends on their next request, with no session to revoke (the role is read from the membership every time).
export async function deactivateMember(tenant: TenantCtx, actorUserId: string, targetUserId: string): Promise<MemberResult> {
  if (targetUserId === actorUserId) return { ok: false, reason: "SELF" };
  const { tenantId } = tenant;
  return tenant.run(async (tx): Promise<MemberResult> => {
    const current = await find(tx, tenantId, targetUserId);
    if (!current) return { ok: false, reason: "NOT_FOUND" };
    if (current.deactivatedAt) return { ok: true, member: toPublic(current), changed: false };
    if (current.role === "ADMIN" && !(await hasAnotherActiveAdmin(tx, tenantId))) return { ok: false, reason: "LAST_ADMIN" };

    const updated = await tx.tenantMembership.update({ where: { id: current.id }, data: { deactivatedAt: new Date() }, select: MEMBER_SELECT });
    await tx.auditLog.create({
      data: { tenantId, actorUserId, action: "MEMBER_DEACTIVATED", targetType: "User", targetId: targetUserId, beforeValue: { role: current.role, campusId: current.campusId } },
    });
    return { ok: true, member: toPublic(updated), changed: true };
  });
}

export async function reactivateMember(tenant: TenantCtx, actorUserId: string, targetUserId: string): Promise<MemberResult> {
  if (targetUserId === actorUserId) return { ok: false, reason: "SELF" };
  const { tenantId } = tenant;
  return tenant.run(async (tx): Promise<MemberResult> => {
    const current = await find(tx, tenantId, targetUserId);
    if (!current) return { ok: false, reason: "NOT_FOUND" };
    if (!current.deactivatedAt) return { ok: true, member: toPublic(current), changed: false };

    const updated = await tx.tenantMembership.update({ where: { id: current.id }, data: { deactivatedAt: null }, select: MEMBER_SELECT });
    await tx.auditLog.create({
      data: { tenantId, actorUserId, action: "MEMBER_REACTIVATED", targetType: "User", targetId: targetUserId, afterValue: { role: current.role, campusId: current.campusId } },
    });
    return { ok: true, member: toPublic(updated), changed: true };
  });
}
