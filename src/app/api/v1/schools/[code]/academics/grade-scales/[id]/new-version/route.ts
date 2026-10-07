import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, academicFailure, bandsField, isPlausibleId, nameField, notFound, writeLimited } from "@/lib/academics/http";
import { newScaleVersion } from "@/lib/academics/grading";

// POST /api/v1/schools/[code]/academics/grade-scales/[id]/new-version  { name?, bands? } — ADMIN only.
// For a LOCKED scale: copies it as version + 1 with the given changes, archives the old one and hands over the default flag. 409 NOT_LOCKED for an
// unlocked one (edit it in place). An empty body copies it unchanged.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ name: nameField.optional(), bands: bandsField.optional() });

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: changes }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scale");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await newScaleVersion(auth.tenant, auth.userId, id, changes);
    return result.ok ? ok({ gradeScale: result.scale }, {}, 201) : academicFailure(result.reason, result.detail, "scale");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
