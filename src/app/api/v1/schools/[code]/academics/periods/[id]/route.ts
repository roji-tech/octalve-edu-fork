import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, isoDateField, nameField, notFound, writeLimited } from "@/lib/academics/http";
import { updatePeriod } from "@/lib/academics/sessions";

// PATCH /api/v1/schools/[code]/academics/periods/[id]  { label?, startDate?, endDate?, ordinal? } — ADMIN only; the kind never changes.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z
  .strictObject({
    label: nameField.optional(),
    startDate: isoDateField.optional(),
    endDate: isoDateField.nullable().optional(),
    ordinal: z.number().int().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give a name, dates, a position, or any of them.");

export const PATCH = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("term");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await updatePeriod(auth.tenant, auth.userId, id, input);
    return result.ok ? ok({ period: result.period, changed: result.changed }) : academicFailure(result.reason, result.detail, "term");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
