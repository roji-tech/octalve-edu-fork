import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ok, fail } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";

// /api/v1/schools/[code]/campuses                                                          (plan §0.5.3, B)
//   GET   a page of the campuses the caller may see (an ADMIN: all of the school's; everyone else: their own campus)
//   POST  create one — ADMIN only; the name is trimmed and checked, unique within the school, audited, rate-limited
// The first real consumers of the shared API infrastructure: tenant resolution + roles (withAuth), offset pagination,
// body validation, the tenant context, and the audit trail.

const CREATES_PER_WINDOW = 30; // per person per school per 5 minutes

const FORBIDDEN_CHARS = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u; // control characters and bidi overrides, as for names

const createSchema = z.object({
  name: z
    .string({ error: "Enter the campus name." })
    .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1, "Enter the campus name.")
        .max(100, "Use at most 100 characters.")
        .refine((value) => !FORBIDDEN_CHARS.test(value), "That name contains characters that can't be used."),
    ),
});

export const GET = withAuth(async (req, auth: TenantAuthContext) => {
  const { tenant } = auth;
  const page = parseOffsetPagination(req.nextUrl.searchParams);
  if (!page.ok) return fail("Some of the query parameters are not valid.", 400, "VALIDATION", page.issues.map((i) => ({ ...i, path: `query.${i.path}` })));

  // An ADMIN is tenant-wide; everyone else sees only their own campus (and none if they have not been assigned one).
  // The tenant is named explicitly AND the query runs in the tenant context — RLS is the net, not the plan.
  const where: Prisma.CampusWhereInput = {
    tenantId: tenant.tenantId,
    ...(tenant.role === "ADMIN" ? {} : { id: tenant.campusId ?? "none" }),
  };
  const [total, campuses] = await tenant.run((tx) =>
    Promise.all([
      tx.campus.count({ where }),
      tx.campus.findMany({ where, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }], skip: page.skip, take: page.take }),
    ]),
  );
  return ok({ campuses }, offsetMeta({ page: page.page, limit: page.limit, total }));
}, { tenant: true });

export const POST = withAuth(
  validate({ body: createSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const { tenant } = auth;
    if (!(await reserveAttempt(`campus:create:${tenant.tenantId}:${auth.userId}`, CREATES_PER_WINDOW))) {
      return fail("Too many campuses created. Please try again in a few minutes.", 429, "RATE_LIMITED");
    }
    try {
      const campus = await tenant.run(async (tx) => {
        const created = await tx.campus.create({ data: { tenantId: tenant.tenantId, name: body.name }, select: { id: true, name: true } });
        // Audited in the same transaction: a campus never exists without its audit row, nor the row without the campus.
        await tx.auditLog.create({
          data: { tenantId: tenant.tenantId, actorUserId: auth.userId, action: "CAMPUS_CREATED", targetType: "Campus", targetId: created.id, afterValue: { name: created.name } },
        });
        return created;
      });
      return ok({ campus }, {}, 201);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return fail("This school already has a campus with that name.", 409, "DUPLICATE", [{ path: "body.name", message: "This school already has a campus with that name." }]);
      }
      throw error;
    }
  }),
  { tenant: true, roles: ["ADMIN"] },
);
