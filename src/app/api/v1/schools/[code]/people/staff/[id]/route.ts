import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited, textField } from "@/lib/people/http";
import { getStaff, updateStaff } from "@/lib/people/staff";

// GET   /api/v1/schools/[code]/people/staff/[id]  — the record, its sign-in state and what it teaches.
// PATCH /api/v1/schools/[code]/people/staff/[id]  { category?, firstName?, lastName?, phone?, email? } — ADMIN only. phone/email null clears it. The campus is fixed at
//        creation; the category is fixed while the record has a sign-in account.
type Ctx = { params: Promise<{ code: string; id: string }> };
const patchBody = z
  .strictObject({
    category: z.string().max(20).optional(),
    firstName: textField.optional(),
    lastName: textField.optional(),
    phone: textField.nullable().optional(),
    email: textField.nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give at least one thing to change.");

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("staff member");
    const result = await getStaff(auth.tenant, id);
    return result.ok
      ? ok({ staff: result.staff, assignments: result.assignments })
      : peopleFailure(result.reason, result.detail, "staff member");
  },
  { tenant: true, roles: READ_ROLES },
);

export const PATCH = withAuth(
  validate({ body: patchBody }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("staff member");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await updateStaff(auth.tenant, auth.userId, id, body);
    return result.ok ? ok({ staff: result.staff, changed: result.changed }) : peopleFailure(result.reason, result.detail, "staff member");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
