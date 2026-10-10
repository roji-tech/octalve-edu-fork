import { Permission, Role } from "@prisma/client";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { updateAnnouncementSchema, announcementFailure } from "@/lib/announcements/http";
import { getAnnouncementById, updateAnnouncement, deleteAnnouncement } from "@/lib/announcements/service";

type RouteCtx = { params: Promise<{ code: string; id: string }> };

// GET /api/v1/schools/[code]/announcements/[id]
export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: RouteCtx) => {
    const { id } = await ctx.params;
    const viewer = {
      userId: auth.userId,
      role: auth.tenant.role,
      campusId: auth.tenant.campusId,
    };

    const result = await getAnnouncementById(auth.tenant.tenantId, id, viewer);
    if (!result.ok) {
      return announcementFailure(result.failure, result.detail);
    }
    return ok(result.data);
  },
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF, Role.STUDENT, Role.PARENT],
  },
);

// PATCH /api/v1/schools/[code]/announcements/[id]
export const PATCH = withAuth(
  validate({ body: updateAnnouncementSchema }, async (_req, auth: TenantAuthContext, ctx: RouteCtx, { body }) => {
    const { id } = await ctx.params;
    const result = await updateAnnouncement(auth.tenant.tenantId, id, { userId: auth.userId, role: auth.tenant.role }, body);
    if (!result.ok) {
      return announcementFailure(result.failure, result.detail);
    }
    return ok(result.data);
  }),
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF],
    permissions: [Permission.CAN_PUBLISH_CONTENT],
  },
);

// DELETE /api/v1/schools/[code]/announcements/[id]
export const DELETE = withAuth(
  async (_req, auth: TenantAuthContext, ctx: RouteCtx) => {
    const { id } = await ctx.params;
    const result = await deleteAnnouncement(auth.tenant.tenantId, id, { userId: auth.userId, role: auth.tenant.role });
    if (!result.ok) {
      return announcementFailure(result.failure, result.detail);
    }
    return ok(result.data);
  },
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF],
    permissions: [Permission.CAN_PUBLISH_CONTENT],
  },
);
