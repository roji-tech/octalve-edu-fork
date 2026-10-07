import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import {
  READ_ROLES,
  WRITE_ROLES,
  academicFailure,
  componentsField,
  isPlausibleId,
  markField,
  nameField,
  notFound,
  writeLimited,
} from "@/lib/academics/http";
import { getScheme, updateScheme } from "@/lib/academics/assessment";

// GET   /api/v1/schools/[code]/academics/assessment-schemes/[id]  — the scheme, its components, and its canonical snapshot (JSON + SHA-256).
// PATCH /api/v1/schools/[code]/academics/assessment-schemes/[id]  { name?, totalMax?, examMax?, components? } — ADMIN only, and only while NOTHING
// uses the scheme yet; once a result does it is LOCKED (409 LOCKED) and a change is a new version. The scope (class) is fixed at creation.
type Ctx = { params: Promise<{ code: string; id: string }> };
const patchBody = z
  .strictObject({
    name: nameField.optional(),
    totalMax: markField.optional(),
    examMax: markField.optional(),
    components: componentsField.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give something to change.");

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scheme");
    const result = await getScheme(auth.tenant, id);
    return result.ok
      ? ok({ assessmentScheme: result.scheme, snapshot: result.snapshot })
      : academicFailure(result.reason, result.detail, "scheme");
  },
  { tenant: true, roles: READ_ROLES },
);

export const PATCH = withAuth(
  validate({ body: patchBody }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scheme");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await updateScheme(auth.tenant, auth.userId, id, body);
    return result.ok
      ? ok({ assessmentScheme: result.scheme, changed: result.changed })
      : academicFailure(result.reason, result.detail, "scheme");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
