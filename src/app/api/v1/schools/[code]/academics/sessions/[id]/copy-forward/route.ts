import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, isPlausibleId, isoDateField, nameField, notFound, writeLimited } from "@/lib/academics/http";
import { copyForward } from "@/lib/academics/sessions";

// POST /api/v1/schools/[code]/academics/sessions/[id]/copy-forward  { startDate, label?, dryRun? } — ADMIN only.
// Creates the NEXT session from this one: dates shifted by the whole-year difference to `startDate`, periods copied (none current), PLANNED.
// Idempotent: a second run is refused (409 ALREADY_COPIED). `dryRun: true` returns the plan and its conflicts and writes NOTHING.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ startDate: isoDateField, label: nameField.optional(), dryRun: z.boolean().default(false) });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await copyForward(auth.tenant, auth.userId, id, input);
    return result.ok
      ? ok({ plan: result.plan, session: result.created }, {}, result.created ? 201 : 200)
      : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
