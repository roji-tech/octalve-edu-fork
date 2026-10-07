import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { archivePeriod } from "@/lib/academics/sessions";

// POST /api/v1/schools/[code]/academics/periods/[id]/archive — ADMIN only, audited in the same transaction; no body.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("term");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await archivePeriod(auth.tenant, auth.userId, id);
    return result.ok ? ok({ period: result.period, changed: result.changed }) : academicFailure(result.reason, result.detail, "term");
  },
  { tenant: true, roles: WRITE_ROLES },
);
