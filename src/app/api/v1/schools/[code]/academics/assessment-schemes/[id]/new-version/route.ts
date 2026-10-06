import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import {
  WRITE_ROLES,
  academicFailure,
  componentsField,
  isPlausibleId,
  markField,
  nameField,
  notFound,
  writeLimited,
} from "@/lib/academics/http";
import { newSchemeVersion } from "@/lib/academics/assessment";

// POST /api/v1/schools/[code]/academics/assessment-schemes/[id]/new-version  { name?, totalMax?, examMax?, components? } — ADMIN only.
// For a LOCKED scheme (a result uses it): copies it as version + 1 with the given changes, archives the old one. 409 NOT_LOCKED for an unlocked one
// (edit it in place instead). An empty body copies it unchanged.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({
  name: nameField.optional(),
  totalMax: markField.optional(),
  examMax: markField.optional(),
  components: componentsField.optional(),
});

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: changes }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("scheme");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await newSchemeVersion(auth.tenant, auth.userId, id, changes);
    return result.ok ? ok({ assessmentScheme: result.scheme }, {}, 201) : academicFailure(result.reason, result.detail, "scheme");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
