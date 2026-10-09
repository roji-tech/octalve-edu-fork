import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES } from "@/lib/people/http";
import { listGuardians } from "@/lib/people/guardians";

// GET /api/v1/schools/[code]/people/guardians — the school's guardians, A to Z. ?q= (name, phone or email), ?status=live|archived|all (default live).
// Administrators see every guardian; staff see those linked to a student they may see. (Guardians are created from a student's page.)
const query = z.object({ q: z.string().max(100).optional(), status: z.enum(["live", "archived", "all"]).default("live") });

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
    const { guardians, total } = await listGuardians(auth.tenant, filters, page);
    return ok({ guardians }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);
