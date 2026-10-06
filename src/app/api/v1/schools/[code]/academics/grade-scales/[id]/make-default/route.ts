import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { makeDefaultScale } from "@/lib/academics/grading";

// POST /api/v1/schools/[code]/academics/grade-scales/[id]/make-default — ADMIN only. The previous default stops being one in the same transaction.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scale");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await makeDefaultScale(auth.tenant, auth.userId, id);
    return result.ok ? ok({ gradeScale: result.scale, changed: result.changed }) : academicFailure(result.reason, result.detail, "scale");
  },
  { tenant: true, roles: WRITE_ROLES },
);
