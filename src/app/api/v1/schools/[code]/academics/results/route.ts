import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { STAFF_READ_ROLES, WRITE_ROLES, recordResultsSchema, resultsQuerySchema, resultFailure } from "@/lib/results/http";
import { recordStudentResults, queryResults } from "@/lib/results/service";

// GET /api/v1/schools/[code]/academics/results
// Staff query results by period, subject, classArm, status
export const GET = withAuth(
  validate({ query: resultsQuerySchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { query }) => {
    const results = await auth.tenant.run((tx) =>
      queryResults(tx, auth.tenant.tenantId, {
        periodId: query.periodId,
        subjectId: query.subjectId,
        classArmId: query.classArmId,
        status: query.status,
      }),
    );

    return ok({ results });
  }),
  { tenant: true, roles: STAFF_READ_ROLES },
);

// POST /api/v1/schools/[code]/academics/results
// Staff records score entries
export const POST = withAuth(
  validate({ body: recordResultsSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const res = await auth.tenant.run((tx) => recordStudentResults(tx, auth.tenant.tenantId, auth.userId, body));

    if (!res.ok) {
      return resultFailure(res.failure, res.message);
    }

    return ok(res.data);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
