import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { isPlausibleId, notFound } from "@/lib/academics/http";
import { READ_ROLES, WRITE_ROLES, isoDateField, bulkMarkAttendanceSchema, attendanceFailure } from "@/lib/attendance/http";
import { getArmRollCall, markArmAttendance } from "@/lib/attendance/service";

type Ctx = { params: Promise<{ code: string; id: string }> };

const querySchema = z.object({
  date: isoDateField.optional(),
});

// GET /api/v1/schools/[code]/academics/arms/[id]/attendance?date=YYYY-MM-DD
export const GET = withAuth(
  validate({ query: querySchema }, async (_req, auth: TenantAuthContext, ctx: Ctx, { query }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("arm");

    const dateStr = query.date ?? new Date().toISOString().split("T")[0];
    const role = auth.tenant.role;

    const result = await auth.tenant.run((tx) => getArmRollCall(tx, auth.tenant.tenantId, id, dateStr, role));

    if (!result.ok) {
      return attendanceFailure(result.failure);
    }

    return ok(result.data);
  }),
  { tenant: true, roles: READ_ROLES },
);

// POST /api/v1/schools/[code]/academics/arms/[id]/attendance
// Body: { date: "YYYY-MM-DD", records: [{ studentId, status, remarks? }], source?: "ONLINE" | "OFFLINE_SYNC" }
export const POST = withAuth(
  validate({ body: bulkMarkAttendanceSchema }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("arm");

    const role = auth.tenant.role;

    const result = await auth.tenant.run((tx) => markArmAttendance(tx, auth.tenant.tenantId, id, auth.userId, role, input));

    if (!result.ok) {
      return attendanceFailure(result.failure);
    }

    return ok(result.data);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
