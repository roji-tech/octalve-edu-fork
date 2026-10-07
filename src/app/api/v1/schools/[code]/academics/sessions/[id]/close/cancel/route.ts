import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { cancelClose } from "@/lib/academics/sessions";

// POST /api/v1/schools/[code]/academics/sessions/[id]/close/cancel — ADMIN only. Takes back a scheduled close while it is still in the future.
// Idempotent when nothing is scheduled; a close that has already taken effect is 409 WRONG_STATE (use reopen).
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  validate({ body: z.strictObject({}) }, async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await cancelClose(auth.tenant, auth.userId, id);
    return result.ok ? ok({ session: result.session, changed: result.changed }) : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
