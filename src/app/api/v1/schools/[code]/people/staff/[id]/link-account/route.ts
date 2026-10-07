import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, idField, isPlausibleId, notFound, peopleFailure, peopleWriteLimited } from "@/lib/people/http";
import { linkAccount } from "@/lib/people/staff";

// POST /api/v1/schools/[code]/people/staff/[id]/link-account  { userId } — ADMIN only. Links the record to an active member of THIS school whose role fits its category.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ userId: idField });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("staff member");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await linkAccount(auth.tenant, auth.userId, id, input);
    return result.ok ? ok({ staff: result.staff }) : peopleFailure(result.reason, result.detail, "staff member");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
