import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import {
  READ_ROLES,
  WRITE_ROLES,
  academicFailure,
  isPlausibleId,
  isoDateField,
  nameField,
  notFound,
  writeLimited,
} from "@/lib/academics/http";
import { createPeriod, listPeriods } from "@/lib/academics/sessions";

// GET  /api/v1/schools/[code]/academics/sessions/[id]/periods  — the session's terms/semesters/cohorts in order (`?archived=true` includes archived).
// POST /api/v1/schools/[code]/academics/sessions/[id]/periods  { label, startDate, endDate?, ordinal? } — ADMIN only. The KIND is derived from the
// school's type on the server and is not accepted from the body (a `kind` key is refused).
type Ctx = { params: Promise<{ code: string; id: string }> };
const query = z.object({ archived: z.enum(["true", "false"]).default("false") });
const body = z.strictObject({
  label: nameField,
  startDate: isoDateField,
  endDate: isoDateField.nullable().optional(),
  ordinal: z.number().int().optional(),
});

export const GET = withAuth(
  validate({ query }, async (_req, auth: TenantAuthContext, ctx: Ctx, { query: q }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const result = await listPeriods(auth.tenant, id, { includeArchived: q.archived === "true" });
    return result.ok ? ok({ periods: result.periods }) : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await createPeriod(auth.tenant, auth.userId, id, input);
    return result.ok ? ok({ period: result.period }, {}, 201) : academicFailure(result.reason, result.detail, "session");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
