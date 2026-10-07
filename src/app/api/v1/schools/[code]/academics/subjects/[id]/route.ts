import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, nameField, notFound, writeLimited } from "@/lib/academics/http";
import { updateSubject } from "@/lib/academics/classes";

// PATCH /api/v1/schools/[code]/academics/subjects/[id]  { name?, code? } — ADMIN only; `code: null` clears it.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z
  .strictObject({ name: nameField.optional(), code: z.string().max(40).nullable().optional() })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give a name, a code, or both.");

export const PATCH = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("subject");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await updateSubject(auth.tenant, auth.userId, id, input);
    return result.ok ? ok({ subject: result.subject, changed: result.changed }) : academicFailure(result.reason, result.detail, "subject");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
