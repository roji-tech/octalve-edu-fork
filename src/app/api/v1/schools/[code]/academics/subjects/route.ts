import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, academicFailure, nameField, writeLimited } from "@/lib/academics/http";
import { createSubject, listSubjects } from "@/lib/academics/classes";

// GET  /api/v1/schools/[code]/academics/subjects   — the school's subjects by name; `q` searches name or code (`%` and `_` are text).
// POST /api/v1/schools/[code]/academics/subjects   { name, code? } — ADMIN only. Subjects belong to the school, not a campus.
const query = z.object({
  status: z.enum(["live", "archived", "all"]).default("live"),
  q: z
    .string()
    .trim()
    .max(64, "Search for at most 64 characters.")
    .optional()
    .transform((value) => value || undefined),
});
const createBody = z.strictObject({ name: nameField, code: z.string().max(40).nullable().optional() });

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
    const { subjects, total } = await listSubjects(auth.tenant, filters, page);
    return ok({ subjects }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body: createBody }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await createSubject(auth.tenant, auth.userId, body);
    return result.ok ? ok({ subject: result.subject }, {}, 201) : academicFailure(result.reason, result.detail, "subject");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
