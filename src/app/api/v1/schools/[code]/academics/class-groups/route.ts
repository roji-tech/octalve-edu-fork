import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, academicFailure, idField, nameField, writeLimited } from "@/lib/academics/http";
import { createClassGroup, listClassGroups } from "@/lib/academics/classes";

// GET  /api/v1/schools/[code]/academics/class-groups   — class groups in progression order, each with its live arms and a subject count.
// POST /api/v1/schools/[code]/academics/class-groups   { campusId?, name, sortOrder? } — ADMIN only.
// Reads: ADMIN and staff (staff see school-wide groups and their own campus's). `status` defaults to "live" (not archived).
const query = z.object({ status: z.enum(["live", "archived", "all"]).default("live"), campusId: idField.optional() });
const createBody = z.strictObject({ campusId: idField.nullable().optional(), name: nameField, sortOrder: z.number().int().optional() });

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
    const { groups, total } = await listClassGroups(auth.tenant, filters, page);
    return ok({ classGroups: groups }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body: createBody }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await createClassGroup(auth.tenant, auth.userId, body);
    return result.ok ? ok({ classGroup: result.group }, {}, 201) : academicFailure(result.reason, result.detail, "class");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
