import { Role } from "@prisma/client";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { batchSaveTimetableSchema, timetableFailure } from "@/lib/timetable/http";
import { batchSaveTimetable } from "@/lib/timetable/service";

// POST /api/v1/schools/[code]/timetable/batch
export const POST = withAuth(
  validate({ body: batchSaveTimetableSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const result = await batchSaveTimetable(auth.tenant.tenantId, body);
    if (!result.ok) {
      return timetableFailure(result.failure, result.detail, result.clashes);
    }
    return ok(result.data, {}, 200);
  }),
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF],
  },
);
