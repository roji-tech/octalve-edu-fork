import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { archiveClassGroup } from "@/lib/academics/classes";

// POST /api/v1/schools/[code]/academics/class-groups/[id]/archive — ADMIN only; refused (409 HAS_ACTIVE_ARMS) while the class still has live arms.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("class");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await archiveClassGroup(auth.tenant, auth.userId, id);
    return result.ok ? ok({ classGroup: result.group, changed: result.changed }) : academicFailure(result.reason, result.detail, "class");
  },
  { tenant: true, roles: WRITE_ROLES },
);
