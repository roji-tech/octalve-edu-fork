import { Role, AnnouncementStatus, Prisma } from "@prisma/client";
import { forTenant } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import { prisma } from "@/lib/db";
import { isAnnouncementVisible, canManageAnnouncement, type ViewerProfile, sortAnnouncements } from "./rules";
import type { CreateAnnouncementInput, UpdateAnnouncementInput, QueryAnnouncementsInput, AnnouncementFailure } from "./http";

export type AnnouncementServiceResult<T> = { ok: true; data: T } | { ok: false; failure: AnnouncementFailure; detail?: string };

export interface AnnouncementDto {
  id: string;
  tenantId: string;
  campusId: string | null;
  campusName: string | null;
  classArmId: string | null;
  classArmName: string | null;
  title: string;
  body: string;
  targetRoles: Role[];
  status: AnnouncementStatus;
  isPinned: boolean;
  authorUserId: string;
  authorName: string | null;
  publishedAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lists announcements visible to the viewer within this tenant.
 */
export async function listAnnouncements(
  tenantId: string,
  viewer: ViewerProfile,
  query: QueryAnnouncementsInput,
): Promise<{ items: AnnouncementDto[]; total: number; page: number; pageSize: number }> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    // Admins see all announcements; others only see PUBLISHED (or own authored items)
    const whereClause: Prisma.AnnouncementWhereInput = {
      tenantId,
    };

    if (query.campusId) {
      whereClause.campusId = query.campusId;
    }
    if (query.classArmId) {
      whereClause.classArmId = query.classArmId;
    }

    if (viewer.role !== Role.ADMIN) {
      whereClause.OR = [{ status: AnnouncementStatus.PUBLISHED }, { authorUserId: viewer.userId }];
    } else if (query.status) {
      whereClause.status = query.status;
    }

    const rows = await tx.announcement.findMany({
      where: whereClause,
      include: {
        campus: { select: { id: true, name: true } },
        classArm: { select: { id: true, name: true } },
      },
      orderBy: [{ isPinned: "desc" }, { publishedAt: "desc" }],
    });

    // Apply audience and active window rules in memory
    const now = new Date();
    const visibleRows = rows.filter((r) =>
      isAnnouncementVisible(
        {
          id: r.id,
          status: r.status,
          targetRoles: r.targetRoles,
          campusId: r.campusId,
          classArmId: r.classArmId,
          authorUserId: r.authorUserId,
          isPinned: r.isPinned,
          publishedAt: r.publishedAt,
          expiresAt: r.expiresAt,
        },
        viewer,
        now,
      ),
    );

    const sorted = sortAnnouncements(visibleRows);

    // Resolve author user names for display
    const authorUserIds = [...new Set(sorted.map((r) => r.authorUserId))];
    const authors =
      authorUserIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: authorUserIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
    const authorMap = new Map(authors.map((u) => [u.id, u.name ?? u.email]));

    const total = sorted.length;
    const startIndex = (query.page - 1) * query.pageSize;
    const paginated = sorted.slice(startIndex, startIndex + query.pageSize);

    const items: AnnouncementDto[] = paginated.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      campusId: r.campusId,
      campusName: r.campus?.name ?? null,
      classArmId: r.classArmId,
      classArmName: r.classArm?.name ?? null,
      title: r.title,
      body: r.body,
      targetRoles: r.targetRoles,
      status: r.status,
      isPinned: r.isPinned,
      authorUserId: r.authorUserId,
      authorName: authorMap.get(r.authorUserId) ?? "Staff",
      publishedAt: r.publishedAt.toISOString(),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

/**
 * Gets a single announcement by ID, ensuring tenant isolation and viewer authorization.
 */
export async function getAnnouncementById(
  tenantId: string,
  id: string,
  viewer: ViewerProfile,
): Promise<AnnouncementServiceResult<AnnouncementDto>> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    const row = await tx.announcement.findFirst({
      where: { id, tenantId },
      include: {
        campus: { select: { id: true, name: true } },
        classArm: { select: { id: true, name: true } },
      },
    });

    if (!row) {
      return { ok: false, failure: "NOT_FOUND" };
    }

    if (
      !isAnnouncementVisible(
        {
          id: row.id,
          status: row.status,
          targetRoles: row.targetRoles,
          campusId: row.campusId,
          classArmId: row.classArmId,
          authorUserId: row.authorUserId,
          isPinned: row.isPinned,
          publishedAt: row.publishedAt,
          expiresAt: row.expiresAt,
        },
        viewer,
      )
    ) {
      return { ok: false, failure: "UNAUTHORIZED", detail: "You do not have access to this announcement." };
    }

    const author = await prisma.user.findUnique({
      where: { id: row.authorUserId },
      select: { name: true, email: true },
    });

    return {
      ok: true,
      data: {
        id: row.id,
        tenantId: row.tenantId,
        campusId: row.campusId,
        campusName: row.campus?.name ?? null,
        classArmId: row.classArmId,
        classArmName: row.classArm?.name ?? null,
        title: row.title,
        body: row.body,
        targetRoles: row.targetRoles,
        status: row.status,
        isPinned: row.isPinned,
        authorUserId: row.authorUserId,
        authorName: author?.name ?? author?.email ?? "Staff",
        publishedAt: row.publishedAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  });
}

/**
 * Creates a new announcement within this tenant.
 */
export async function createAnnouncement(
  tenantId: string,
  authorUserId: string,
  input: CreateAnnouncementInput,
): Promise<AnnouncementServiceResult<AnnouncementDto>> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    // Validate foreign keys within tenant if specified
    if (input.campusId) {
      const campus = await tx.campus.findFirst({
        where: { id: input.campusId, tenantId },
      });
      if (!campus) {
        return { ok: false, failure: "INVALID_AUDIENCE", detail: "Specified campus does not exist." };
      }
    }

    if (input.classArmId) {
      const arm = await tx.classArm.findFirst({
        where: { id: input.classArmId, tenantId, archivedAt: null },
      });
      if (!arm) {
        return { ok: false, failure: "INVALID_AUDIENCE", detail: "Specified class arm does not exist." };
      }
    }

    const publishedAt = input.publishedAt ? new Date(input.publishedAt) : new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    if (expiresAt && expiresAt <= publishedAt) {
      return { ok: false, failure: "BAD_REQUEST", detail: "Expiry date must be after publication date." };
    }

    const created = await tx.announcement.create({
      data: {
        tenantId,
        campusId: input.campusId ?? null,
        classArmId: input.classArmId ?? null,
        title: input.title.trim(),
        body: input.body.trim(),
        targetRoles: input.targetRoles ?? [],
        status: input.status,
        isPinned: input.isPinned,
        authorUserId,
        publishedAt,
        expiresAt,
      },
      include: {
        campus: { select: { id: true, name: true } },
        classArm: { select: { id: true, name: true } },
      },
    });

    const author = await prisma.user.findUnique({
      where: { id: authorUserId },
      select: { name: true, email: true },
    });

    return {
      ok: true,
      data: {
        id: created.id,
        tenantId: created.tenantId,
        campusId: created.campusId,
        campusName: created.campus?.name ?? null,
        classArmId: created.classArmId,
        classArmName: created.classArm?.name ?? null,
        title: created.title,
        body: created.body,
        targetRoles: created.targetRoles,
        status: created.status,
        isPinned: created.isPinned,
        authorUserId: created.authorUserId,
        authorName: author?.name ?? author?.email ?? "Staff",
        publishedAt: created.publishedAt.toISOString(),
        expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
    };
  });
}

/**
 * Updates an announcement, ensuring editor is author or ADMIN.
 */
export async function updateAnnouncement(
  tenantId: string,
  id: string,
  editor: { userId: string; role: Role },
  input: UpdateAnnouncementInput,
): Promise<AnnouncementServiceResult<AnnouncementDto>> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id, tenantId },
    });

    if (!existing) {
      return { ok: false, failure: "NOT_FOUND" };
    }

    if (!canManageAnnouncement(existing, editor)) {
      return { ok: false, failure: "UNAUTHORIZED", detail: "Only the author or an admin can edit this announcement." };
    }

    // Verify foreign keys if updating
    if (input.campusId) {
      const campus = await tx.campus.findFirst({ where: { id: input.campusId, tenantId } });
      if (!campus) return { ok: false, failure: "INVALID_AUDIENCE", detail: "Specified campus does not exist." };
    }
    if (input.classArmId) {
      const arm = await tx.classArm.findFirst({ where: { id: input.classArmId, tenantId, archivedAt: null } });
      if (!arm) return { ok: false, failure: "INVALID_AUDIENCE", detail: "Specified class arm does not exist." };
    }

    const data: Prisma.AnnouncementUpdateInput = {};
    if (input.title !== undefined) data.title = input.title.trim();
    if (input.body !== undefined) data.body = input.body.trim();
    if (input.targetRoles !== undefined) data.targetRoles = input.targetRoles;
    if (input.campusId !== undefined) {
      data.campus = input.campusId ? { connect: { tenantId_id: { tenantId, id: input.campusId } } } : { disconnect: true };
    }
    if (input.classArmId !== undefined) {
      data.classArm = input.classArmId ? { connect: { tenantId_id: { tenantId, id: input.classArmId } } } : { disconnect: true };
    }
    if (input.status !== undefined) data.status = input.status;
    if (input.isPinned !== undefined) data.isPinned = input.isPinned;
    if (input.publishedAt !== undefined) data.publishedAt = new Date(input.publishedAt);
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    const updated = await tx.announcement.update({
      where: { tenantId_id: { tenantId, id } },
      data,
      include: {
        campus: { select: { id: true, name: true } },
        classArm: { select: { id: true, name: true } },
      },
    });

    const author = await prisma.user.findUnique({
      where: { id: updated.authorUserId },
      select: { name: true, email: true },
    });

    return {
      ok: true,
      data: {
        id: updated.id,
        tenantId: updated.tenantId,
        campusId: updated.campusId,
        campusName: updated.campus?.name ?? null,
        classArmId: updated.classArmId,
        classArmName: updated.classArm?.name ?? null,
        title: updated.title,
        body: updated.body,
        targetRoles: updated.targetRoles,
        status: updated.status,
        isPinned: updated.isPinned,
        authorUserId: updated.authorUserId,
        authorName: author?.name ?? author?.email ?? "Staff",
        publishedAt: updated.publishedAt.toISOString(),
        expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    };
  });
}

/**
 * Deletes an announcement, ensuring deleter is author or ADMIN.
 */
export async function deleteAnnouncement(
  tenantId: string,
  id: string,
  editor: { userId: string; role: Role },
): Promise<AnnouncementServiceResult<{ id: string; deleted: true }>> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    const existing = await tx.announcement.findFirst({
      where: { id, tenantId },
    });

    if (!existing) {
      return { ok: false, failure: "NOT_FOUND" };
    }

    if (!canManageAnnouncement(existing, editor)) {
      return { ok: false, failure: "UNAUTHORIZED", detail: "Only the author or an admin can delete this announcement." };
    }

    await tx.announcement.delete({
      where: { tenantId_id: { tenantId, id } },
    });

    return { ok: true, data: { id, deleted: true } };
  });
}
