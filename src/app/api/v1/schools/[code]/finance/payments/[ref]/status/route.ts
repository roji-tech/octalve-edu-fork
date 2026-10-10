import { Role } from "@prisma/client";
import { ok, fail } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { fulfillPayment } from "@/lib/finance/service";

// GET /api/v1/schools/[code]/finance/payments/[ref]/status
export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: { params: Promise<{ code: string; ref: string }> }) => {
    try {
      const { ref } = await ctx.params;
      const result = await fulfillPayment(ref, {
        tenantIdOverride: auth.tenant.tenantId,
      });
      return ok(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Payment verification failed";
      return fail(message, 400);
    }
  },
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF, Role.PARENT, Role.STUDENT],
  },
);
