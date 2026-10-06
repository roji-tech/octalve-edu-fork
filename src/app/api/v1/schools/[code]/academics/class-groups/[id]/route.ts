import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, academicFailure, isPlausibleId, nameField, notFound, writeLimited } from "@/lib/academics/http";
import { getClassGroup, updateClassGroup } from "@/lib/academics/classes";

// GET   /api/v1/schools/[code]/academics/class-groups/[id]  — the group with its live arms.
// PATCH /api/v1/schools/[code]/academics/class-groups/[id]  { name?, sortOrder? } — ADMIN only. The campus is fixed at creation.
type Ctx = { params: Promise<{ code: string; id: string }> };
const patchBody = z
  .strictObject({ name: nameField.optional(), sortOrder: z.number().int().optional() })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give a name, an order, or both.");

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("class");
    const result = await getClassGroup(auth.tenant, id);
    return result.ok ? ok({ classGroup: result.group }) : academicFailure(result.reason, result.detail, "class");
  },
  { tenant: true, roles: READ_ROLES },
);

export const PATCH = withAuth(
  validate({ body: patchBody }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("class");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await updateClassGroup(auth.tenant, auth.userId, id, body);
    return result.ok ? ok({ classGroup: result.group, changed: result.changed }) : academicFailure(result.reason, result.detail, "class");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
