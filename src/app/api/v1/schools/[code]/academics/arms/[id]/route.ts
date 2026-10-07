import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, nameField, notFound, writeLimited } from "@/lib/academics/http";
import { updateArm } from "@/lib/academics/classes";

// PATCH /api/v1/schools/[code]/academics/arms/[id]  { name?, capacity? } — ADMIN only; `capacity: null` clears the limit.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z
  .strictObject({ name: nameField.optional(), capacity: z.number().int().nullable().optional() })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give a name, a capacity, or both.");

export const PATCH = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("arm");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await updateArm(auth.tenant, auth.userId, id, input);
    return result.ok ? ok({ arm: result.arm, changed: result.changed }) : academicFailure(result.reason, result.detail, "arm");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
