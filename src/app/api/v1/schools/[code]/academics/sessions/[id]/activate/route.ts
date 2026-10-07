import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { passwordProofFailure, proveOwnPassword } from "@/lib/auth/reauth";
import { WRITE_ROLES, academicFailure, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { activateSession } from "@/lib/academics/sessions";

// POST /api/v1/schools/[code]/academics/sessions/[id]/activate  { closeCurrent? } — ADMIN only.
// Refused (409 SESSION_ALREADY_ACTIVE, naming it) while another session in the same scope is active — unless the caller explicitly asks to
// `closeCurrent`, which closes that one and opens this one in ONE transaction, audited as two entries — and which, because it ends a school year
// on the spot, needs the administrator's own password (plan, "closing a session takes time"). Nothing is ever closed silently.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ closeCurrent: z.boolean().default(false), password: z.string().max(PASSWORD_MAX_LENGTH).optional() });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: options }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    if (options.closeCurrent) {
      if (options.password === undefined) {
        return fail("Enter your password to confirm closing the current session.", 400, "VALIDATION", [
          { path: "body.password", message: "Enter your password to confirm." },
        ]);
      }
      const proof = await proveOwnPassword(auth.userId, options.password);
      if (proof !== "ok") return passwordProofFailure(proof);
    }
    const result = await activateSession(auth.tenant, auth.userId, id, { closeCurrent: options.closeCurrent });
    return result.ok ? ok({ session: result.session, closed: result.closed }) : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
