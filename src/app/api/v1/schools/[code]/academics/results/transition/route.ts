import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { transitionStatusSchema, resultFailure } from "@/lib/results/http";
import { transitionResultStatuses } from "@/lib/results/service";

// POST /api/v1/schools/[code]/academics/results/transition
// Transition result status (DRAFT -> SUBMITTED, SUBMITTED -> APPROVED, APPROVED -> PUBLISHED, etc.)
export const POST = withAuth(
  validate({ body: transitionStatusSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const role = auth.tenant.role;
    const permissions = auth.tenant.permissions ?? [];

    const res = await auth.tenant.run((tx) => transitionResultStatuses(tx, auth.tenant.tenantId, auth.userId, role, permissions, body));

    if (!res.ok) {
      return resultFailure(res.failure, res.message);
    }

    return ok(res.data);
  }),
  { tenant: true, roles: ["ADMIN", "TEACHING_STAFF"] },
);
