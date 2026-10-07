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
import { getSession, updateSession } from "@/lib/academics/sessions";

// GET   /api/v1/schools/[code]/academics/sessions/[id]  — the session and its periods.
// PATCH /api/v1/schools/[code]/academics/sessions/[id]  { label?, startDate?, endDate? } — ADMIN only; a closed or archived session is read-only.
// The campus of a session is fixed at creation. An unknown id, another school's and another campus's all answer the same 404.
type Ctx = { params: Promise<{ code: string; id: string }> };
const patchBody = z
  .strictObject({ label: nameField.optional(), startDate: isoDateField.optional(), endDate: isoDateField.optional() })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give a name, a start date, an end date, or any of them.");

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const result = await getSession(auth.tenant, id);
    return result.ok ? ok({ session: result.session, periods: result.periods }) : academicFailure(result.reason, result.detail);
  },
  { tenant: true, roles: READ_ROLES },
);

export const PATCH = withAuth(
  validate({ body: patchBody }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("session");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await updateSession(auth.tenant, auth.userId, id, body);
    return result.ok ? ok({ session: result.session, changed: result.changed }) : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
