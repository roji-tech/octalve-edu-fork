import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { archiveStudent } from "@/lib/people/students";

// POST /api/v1/schools/[code]/people/students/[id]/archive — ADMIN only. Idempotent: doing it twice answers 200 with changed: false.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("student");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await archiveStudent(auth.tenant, auth.userId, id);
    return result.ok ? ok({ student: result.student, changed: result.changed }) : peopleFailure(result.reason, result.detail);
  },
  { tenant: true, roles: WRITE_ROLES },
);
