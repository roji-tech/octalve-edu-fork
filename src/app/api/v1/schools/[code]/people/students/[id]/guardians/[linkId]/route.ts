import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { updateLink } from "@/lib/people/guardians";

// PATCH /api/v1/schools/[code]/people/students/[id]/guardians/[linkId]  { relationship?, isPrimary? } — ADMIN only. Making a link primary demotes the current primary in the same transaction.
type Ctx = { params: Promise<{ code: string; id: string; linkId: string }> };
const body = z
  .strictObject({ relationship: z.string().max(20).optional(), isPrimary: z.boolean().optional() })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give a relationship, a primary flag, or both.");

export const PATCH = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id, linkId } = await ctx.params;
    if (!isPlausibleId(id) || !isPlausibleId(linkId)) return notFound("guardian");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await updateLink(auth.tenant, auth.userId, id, linkId, input);
    return result.ok ? ok({ guardian: result.link, changed: result.changed }) : peopleFailure(result.reason, result.detail, "guardian");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
