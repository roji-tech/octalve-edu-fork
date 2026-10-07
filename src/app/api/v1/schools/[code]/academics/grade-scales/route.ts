import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, academicFailure, bandsField, nameField, writeLimited } from "@/lib/academics/http";
import { createScale, listScales } from "@/lib/academics/grading";

// GET  /api/v1/schools/[code]/academics/grade-scales   — grade scales (score bands → letter → remark), the default first.
// POST /api/v1/schools/[code]/academics/grade-scales   { name, bands } — ADMIN only. The school's FIRST scale becomes its default automatically.
// Bands are half-open [min, max) from 0 to 100 with no gap or overlap (the top band includes 100). `status` defaults to "live".
const query = z.object({ status: z.enum(["live", "archived", "all"]).default("live") });
const createBody = z.strictObject({ name: nameField, bands: bandsField });

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
    const { scales, total } = await listScales(auth.tenant, filters, page);
    return ok({ gradeScales: scales }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body: createBody }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await createScale(auth.tenant, auth.userId, body);
    return result.ok ? ok({ gradeScale: result.scale }, {}, 201) : academicFailure(result.reason, result.detail, "scale");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
