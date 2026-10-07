import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { restoreGuardian } from "@/lib/people/guardians";

// POST /api/v1/schools/[code]/people/guardians/[id]/restore — ADMIN only. Idempotent: twice answers 200 with changed: false.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("guardian");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await restoreGuardian(auth.tenant, auth.userId, id);
    return result.ok ? ok({ guardian: result.guardian, changed: result.changed }) : peopleFailure(result.reason, result.detail, "guardian");
  },
  { tenant: true, roles: WRITE_ROLES },
);
