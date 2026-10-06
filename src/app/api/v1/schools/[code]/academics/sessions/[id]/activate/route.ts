import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { activateSession } from "@/lib/academics/sessions";

// POST /api/v1/schools/[code]/academics/sessions/[id]/activate  { closeCurrent? } — ADMIN only.
// Refused (409 SESSION_ALREADY_ACTIVE, naming it) while another session in the same scope is active — unless the caller explicitly asks to
// `closeCurrent`, which closes that one and opens this one in ONE transaction, audited as two entries. Nothing is ever closed silently.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ closeCurrent: z.boolean().default(false) });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: options }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await activateSession(auth.tenant, auth.userId, id, options);
    return result.ok ? ok({ session: result.session, closed: result.closed }) : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
