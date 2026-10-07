import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { removeAssignment } from "@/lib/people/staff";

// POST /api/v1/schools/[code]/people/staff/[id]/assignments/[assignmentId]/remove — ADMIN only. Removes one assignment (a real delete: nothing references it yet).
type Ctx = { params: Promise<{ code: string; id: string; assignmentId: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id, assignmentId } = await ctx.params;
    if (!isPlausibleId(id) || !isPlausibleId(assignmentId)) return notFound("assignment");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await removeAssignment(auth.tenant, auth.userId, id, assignmentId);
    return result.ok ? ok({ removed: result.removed }) : peopleFailure(result.reason, result.detail, "assignment");
  },
  { tenant: true, roles: WRITE_ROLES },
);
