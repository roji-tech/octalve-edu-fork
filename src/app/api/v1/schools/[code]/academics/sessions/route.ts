import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, academicFailure, idField, isoDateField, nameField, writeLimited } from "@/lib/academics/http";
import { createSession, listSessions } from "@/lib/academics/sessions";

// GET  /api/v1/schools/[code]/academics/sessions   — the school's academic sessions, newest first (plan "Build design — Phase 1.0 and 1.1", decisions 7, 9, 17).
// POST /api/v1/schools/[code]/academics/sessions   { campusId?, label, startDate, endDate } — ADMIN only; PLANNED until activated.
// Reads: ADMIN, TEACHING_STAFF, NON_TEACHING_STAFF — staff see school-wide sessions and their own campus's only. `status` defaults to "live" (not archived).
const query = z.object({
  status: z.enum(["live", "planned", "active", "closed", "archived", "all"]).default("live"),
  campusId: idField.optional(),
});
const createBody = z.strictObject({
  campusId: idField.nullable().optional(),
  label: nameField,
  startDate: isoDateField,
  endDate: isoDateField,
});

export const GET = withAuth(
  validate({ query }, async (req, auth: TenantAuthContext, _ctx: unknown, { query: filters }) => {
    const page = parseOffsetPagination(req.nextUrl.searchParams);
    if (!page.ok) {
      return fail(
        "Some of the query parameters are not valid.",
        400,
        "VALIDATION",
        page.issues.map((i) => ({ ...i, path: `query.${i.path}` })),
      );
    }
    const { sessions, total } = await listSessions(auth.tenant, filters, page);
    return ok({ sessions }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body: createBody }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await createSession(auth.tenant, auth.userId, body);
    return result.ok ? ok({ session: result.session }, {}, 201) : academicFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
