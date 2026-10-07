import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, nameField, notFound, writeLimited } from "@/lib/academics/http";
import { createArm } from "@/lib/academics/classes";

// POST /api/v1/schools/[code]/academics/class-groups/[id]/arms  { name, capacity? } — ADMIN only. (Arms are read with their class group.)
// capacity: a whole number 1–1000, or omitted/null for "no limit" (display only for now).
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ name: nameField, capacity: z.number().int().nullable().optional() });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("class");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await createArm(auth.tenant, auth.userId, id, input);
    return result.ok ? ok({ arm: result.arm }, {}, 201) : academicFailure(result.reason, result.detail, "class");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
