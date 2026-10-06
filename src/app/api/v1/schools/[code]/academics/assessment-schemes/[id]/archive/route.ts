import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { archiveScheme } from "@/lib/academics/assessment";

// POST /api/v1/schools/[code]/academics/assessment-schemes/[id]/archive — ADMIN only. Archived schemes stay forever (results may reference them).
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scheme");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await archiveScheme(auth.tenant, auth.userId, id);
    return result.ok
      ? ok({ assessmentScheme: result.scheme, changed: result.changed })
      : academicFailure(result.reason, result.detail, "scheme");
  },
  { tenant: true, roles: WRITE_ROLES },
);
