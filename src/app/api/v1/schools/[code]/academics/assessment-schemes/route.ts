import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import {
  READ_ROLES,
  WRITE_ROLES,
  academicFailure,
  componentsField,
  idField,
  markField,
  nameField,
  writeLimited,
} from "@/lib/academics/http";
import { createScheme, listSchemes } from "@/lib/academics/assessment";

// GET  /api/v1/schools/[code]/academics/assessment-schemes   — how marks are built (components + exam = total), newest version first per name.
// POST /api/v1/schools/[code]/academics/assessment-schemes   { classGroupId?, name, totalMax?, examMax, components } — ADMIN only.
// `classGroupId` null/omitted is the school default; one live scheme per scope. Reads: ADMIN and staff (staff see the default and the schemes of
// classes they can see). `status` defaults to "live".
const query = z.object({ status: z.enum(["live", "archived", "all"]).default("live"), classGroupId: idField.optional() });
const createBody = z.strictObject({
  classGroupId: idField.nullable().optional(),
  name: nameField,
  totalMax: markField.optional(),
  examMax: markField,
  components: componentsField,
});

export const GET = withAuth(
  validate({ query }, async (req, auth: TenantAuthContext, _ctx: unknown, { query: filters }) => {
    const page = parseOffsetPagination(req.nextUrl.searchParams);
    if (!page.ok)
      return fail(
        "Some of the query parameters are not valid.",
        400,
        "VALIDATION",
        page.issues.map((i) => ({ ...i, path: `query.${i.path}` })),
      );
    const { schemes, total } = await listSchemes(auth.tenant, filters, page);
    return ok({ assessmentSchemes: schemes }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body: createBody }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await createScheme(auth.tenant, auth.userId, body);
    return result.ok ? ok({ assessmentScheme: result.scheme }, {}, 201) : academicFailure(result.reason, result.detail, "scheme");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
