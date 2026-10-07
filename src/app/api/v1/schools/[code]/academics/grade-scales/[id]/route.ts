import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import {
  READ_ROLES,
  WRITE_ROLES,
  academicFailure,
  bandsField,
  isPlausibleId,
  nameField,
  notFound,
  writeLimited,
} from "@/lib/academics/http";
import { getScale, updateScale } from "@/lib/academics/grading";

// GET   /api/v1/schools/[code]/academics/grade-scales/[id]  — the scale with its bands.
// PATCH /api/v1/schools/[code]/academics/grade-scales/[id]  { name?, bands? } — ADMIN only, and only while NOTHING uses the scale yet (409 LOCKED after;
// make a new version). `bands` replaces the whole list.
type Ctx = { params: Promise<{ code: string; id: string }> };
const patchBody = z
  .strictObject({ name: nameField.optional(), bands: bandsField.optional() })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Give a name, the bands, or both.");

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scale");
    const result = await getScale(auth.tenant, id);
    return result.ok ? ok({ gradeScale: result.scale }) : academicFailure(result.reason, result.detail, "scale");
  },
  { tenant: true, roles: READ_ROLES },
);

export const PATCH = withAuth(
  validate({ body: patchBody }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scale");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await updateScale(auth.tenant, auth.userId, id, body);
    return result.ok ? ok({ gradeScale: result.scale, changed: result.changed }) : academicFailure(result.reason, result.detail, "scale");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
