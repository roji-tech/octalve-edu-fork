import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { archiveSubject } from "@/lib/academics/classes";

// POST /api/v1/schools/[code]/academics/subjects/[id]/archive — ADMIN only; refused (409 SUBJECT_IN_USE) while a live class still studies it.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("subject");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await archiveSubject(auth.tenant, auth.userId, id);
    return result.ok ? ok({ subject: result.subject, changed: result.changed }) : academicFailure(result.reason, result.detail, "subject");
  },
  { tenant: true, roles: WRITE_ROLES },
);
