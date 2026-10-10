import { Permission, Role } from "@prisma/client";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { createAnnouncementSchema, queryAnnouncementsSchema, announcementFailure } from "@/lib/announcements/http";
import { listAnnouncements, createAnnouncement } from "@/lib/announcements/service";

// GET /api/v1/schools/[code]/announcements
export const GET = withAuth(
  validate({ query: queryAnnouncementsSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { query }) => {
    const viewer = {
      userId: auth.userId,
      role: auth.tenant.role,
      campusId: auth.tenant.campusId,
    };

    const result = await listAnnouncements(auth.tenant.tenantId, viewer, query);
    return ok(result);
  }),
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF, Role.STUDENT, Role.PARENT],
  },
);

// POST /api/v1/schools/[code]/announcements
export const POST = withAuth(
  validate({ body: createAnnouncementSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const result = await createAnnouncement(auth.tenant.tenantId, auth.userId, body);
    if (!result.ok) {
      return announcementFailure(result.failure, result.detail);
    }
    return ok(result.data, {}, 201);
  }),
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF],
    permissions: [Permission.CAN_PUBLISH_CONTENT],
  },
);
