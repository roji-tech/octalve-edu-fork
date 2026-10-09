import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, isPlausibleId, notFound } from "@/lib/people/http";
import { attendanceFailure } from "@/lib/attendance/http";
import { getStudentAttendanceHistory } from "@/lib/attendance/service";

type Ctx = { params: Promise<{ code: string; id: string }> };

// GET /api/v1/schools/[code]/people/students/[id]/attendance
export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("student");

    const result = await auth.tenant.run((tx) => getStudentAttendanceHistory(tx, auth.tenant.tenantId, id));

    if (!result.ok) {
      return attendanceFailure(result.failure);
    }

    return ok(result.data);
  },
  { tenant: true, roles: READ_ROLES },
);
