import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { reopenSession } from "@/lib/academics/sessions";

// POST /api/v1/schools/[code]/academics/sessions/[id]/reopen  { reason } — ADMIN only. A CLOSED session becomes ACTIVE again, with a typed
// reason (5–300 characters, kept in the audit trail), unless another session of the same scope is active (409 SESSION_ALREADY_ACTIVE, naming it).
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ reason: z.string({ error: "Give a reason." }).max(1000) });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await reopenSession(auth.tenant, auth.userId, id, input.reason);
    return result.ok ? ok({ session: result.session }) : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
