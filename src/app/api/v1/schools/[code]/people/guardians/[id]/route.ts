import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited, textField } from "@/lib/people/http";
import { getGuardian, updateGuardian } from "@/lib/people/guardians";

// GET   /api/v1/schools/[code]/people/guardians/[id]  — the guardian and the students they are linked to (only those the caller may see).
// PATCH /api/v1/schools/[code]/people/guardians/[id]  { firstName?, lastName?, phone?, email? } — ADMIN only. phone/email null clears it.
type Ctx = { params: Promise<{ code: string; id: string }> };
const patchBody = z
  .strictObject({
    firstName: textField.optional(),
    lastName: textField.optional(),
    phone: textField.nullable().optional(),
    email: textField.nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give at least one thing to change.");

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("guardian");
    const result = await getGuardian(auth.tenant, id);
    return result.ok
      ? ok({ guardian: result.guardian, students: result.students })
      : peopleFailure(result.reason, result.detail, "guardian");
  },
  { tenant: true, roles: READ_ROLES },
);

export const PATCH = withAuth(
  validate({ body: patchBody }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("guardian");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await updateGuardian(auth.tenant, auth.userId, id, body);
    return result.ok ? ok({ guardian: result.guardian, changed: result.changed }) : peopleFailure(result.reason, result.detail, "guardian");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
