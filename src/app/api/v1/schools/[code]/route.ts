import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";

// GET /api/v1/schools/[code]                                                              (plan §0.5.2)
// The school the URL names, as the CALLER sees it: which role they hold there and which campuses that role may
// see. Every route under /api/v1/schools/[code]/… is `withAuth(…, { tenant: true })`: the code is resolved and the
// caller's own membership verified before the handler runs, and the data is read through the tenant context.
//
// Belt and braces, on purpose: the query names the tenant explicitly AND runs inside the tenant context. Row-level
// security is the net under the code, not a reason to write unscoped queries.
export const GET = withAuth(async (_req, auth: TenantAuthContext) => {
  const { tenant } = auth;
  const campuses = await tenant.run((tx) =>
    tx.campus.findMany({
      where: {
        tenantId: tenant.tenantId,
        // An ADMIN is tenant-wide (campusId is bookkeeping for them); everyone else is scoped to their own campus,
        // and a non-admin with no campus assigned sees none.
        ...(tenant.role === "ADMIN" ? {} : { id: tenant.campusId ?? "none" }),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );

  return ok({
    school: { code: tenant.tenantCode, name: tenant.tenantName },
    role: tenant.role,
    campusId: tenant.campusId,
    campuses,
  });
}, { tenant: true });
