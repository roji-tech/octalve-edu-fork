import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { restoreStudent } from "@/lib/people/students";

// POST /api/v1/schools/[code]/people/students/[id]/restore — ADMIN only. Idempotent: doing it twice answers 200 with changed: false.
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("student");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    let allowDuplicate = false;
    const text = await _req.text().catch(() => "");
    if (text.trim()) {
      try {
        const json = JSON.parse(text);
        allowDuplicate = Boolean(json?.allowDuplicate);
      } catch {
        // empty or non-JSON body keeps default false
      }
    }
    const result = await restoreStudent(auth.tenant, auth.userId, id, allowDuplicate);
    return result.ok ? ok({ student: result.student, changed: result.changed }) : peopleFailure(result.reason, result.detail);
  },
  { tenant: true, roles: WRITE_ROLES },
);
