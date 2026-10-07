import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited, textField } from "@/lib/people/http";
import { withdrawEnrolment } from "@/lib/people/students";

// POST /api/v1/schools/[code]/people/students/[id]/enrolments/[enrolmentId]/withdraw  { reason } — ADMIN only. The reason (5–300 characters) goes into the audit entry.
type Ctx = { params: Promise<{ code: string; id: string; enrolmentId: string }> };
const body = z.strictObject({ reason: textField });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id, enrolmentId } = await ctx.params;
    if (!isPlausibleId(id) || !isPlausibleId(enrolmentId)) return notFound("enrolment");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await withdrawEnrolment(auth.tenant, auth.userId, id, enrolmentId, input);
    return result.ok ? ok({ enrolment: result.enrolment }) : peopleFailure(result.reason, result.detail, "enrolment");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
