import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, idField, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { addAssignment } from "@/lib/people/staff";

// POST /api/v1/schools/[code]/people/staff/[id]/assignments  { subjectId, classArmId } — ADMIN only. "This person teaches this subject to this class." The class must study
// the subject. (The list is read with GET …/staff/[id].)
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ subjectId: idField, classArmId: idField });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("staff member");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await addAssignment(auth.tenant, auth.userId, id, input);
    return result.ok ? ok({ assignment: result.assignment }, {}, 201) : peopleFailure(result.reason, result.detail, "staff member");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
