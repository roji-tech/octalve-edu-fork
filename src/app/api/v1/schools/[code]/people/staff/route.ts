import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, idField, peopleFailure, peopleWriteLimited, textField } from "@/lib/people/http";
import { createStaff, listStaff } from "@/lib/people/staff";

// GET  /api/v1/schools/[code]/people/staff   — the school's staff records, A to Z, each with its sign-in state (none / invited / linked). ?q=, ?status=live|archived|all
//        (default live), ?campusId=, ?category=TEACHING|NON_TEACHING.
// POST /api/v1/schools/[code]/people/staff   { campusId?, category, firstName, lastName, phone?, email? } — ADMIN only.
// Reads: ADMIN and staff (staff see school-wide records and their own campus's).
const query = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["live", "archived", "all"]).default("live"),
  campusId: idField.optional(),
  category: z.enum(["TEACHING", "NON_TEACHING"]).optional(),
});
const createBody = z.strictObject({
  campusId: idField.nullable().optional(),
  category: z.string({ error: "Choose teaching or non-teaching." }).max(20),
  firstName: textField,
  lastName: textField,
  phone: textField.nullable().optional(),
  email: textField.nullable().optional(),
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
    const { staff, total } = await listStaff(auth.tenant, filters, page);
    return ok({ staff }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body: createBody }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await createStaff(auth.tenant, auth.userId, body);
    return result.ok ? ok({ staff: result.staff }, {}, 201) : peopleFailure(result.reason, result.detail, "staff member");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
