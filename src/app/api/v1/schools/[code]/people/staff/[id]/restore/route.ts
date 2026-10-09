import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { restoreStaff } from "@/lib/people/staff";

// POST /api/v1/schools/[code]/people/staff/[id]/restore — ADMIN only. Idempotent: twice answers 200 with changed: false.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("staff member");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await restoreStaff(auth.tenant, auth.userId, id);
    return result.ok ? ok({ staff: result.staff, changed: result.changed }) : peopleFailure(result.reason, result.detail, "staff member");
  },
  { tenant: true, roles: WRITE_ROLES },
);
