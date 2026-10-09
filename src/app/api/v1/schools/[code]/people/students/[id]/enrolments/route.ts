import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, idField, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { enrolStudent } from "@/lib/people/students";

// POST /api/v1/schools/[code]/people/students/[id]/enrolments  { sessionId, classArmId } — ADMIN only. One enrolment per student per session; a withdrawn one is reactivated.
// (The history is read with GET …/students/[id].)
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ sessionId: idField, classArmId: idField });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("student");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await enrolStudent(auth.tenant, auth.userId, id, input);
    return result.ok
      ? ok({ enrolment: result.enrolment, reenrolled: result.reenrolled }, {}, result.reenrolled ? 200 : 201)
      : peopleFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
