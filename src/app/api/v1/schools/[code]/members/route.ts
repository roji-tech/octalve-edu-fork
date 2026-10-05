import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { campusIdField, roleField } from "@/lib/members/http";
import { listMembers } from "@/lib/members/service";

// GET /api/v1/schools/[code]/members                                                       (plan §0.5.4)
// The school's people — ADMIN only. Offset-paged (the shared helpers: strict, never clamped) and filtered by role, campus, status
// (default: active) and a search over name and address. A person is returned as { userId, name, email, role, campus, status,
// joinedAt } and nothing else of their account.
const query = z.object({
  role: roleField.optional(),
  campusId: campusIdField.optional(),
  status: z.enum(["active", "deactivated", "all"]).default("active"),
  q: z
    .string()
    .trim()
    .max(64, "Search for at most 64 characters.")
    .optional()
    .transform((value) => value || undefined),
});

export const GET = withAuth(
  validate({ query }, async (req, auth: TenantAuthContext, _ctx: unknown, { query: filters }) => {
    const page = parseOffsetPagination(req.nextUrl.searchParams);
    if (!page.ok) return fail("Some of the query parameters are not valid.", 400, "VALIDATION", page.issues.map((i) => ({ ...i, path: `query.${i.path}` })));
    const { members, total } = await listMembers(auth.tenant, filters, page);
    return ok({ members }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: ["ADMIN"] },
);
