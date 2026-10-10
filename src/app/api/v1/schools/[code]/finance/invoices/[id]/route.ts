import { Role } from "@prisma/client";
import { ok, fail } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { getStudentInvoice } from "@/lib/finance/service";

// GET /api/v1/schools/[code]/finance/invoices/[id]
export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: { params: Promise<{ code: string; id: string }> }) => {
    try {
      const { id } = await ctx.params;
      const invoice = await getStudentInvoice(auth.tenant.tenantId, id, {
        userId: auth.userId,
        roles: [auth.tenant.role],
        permissions: [...auth.tenant.permissions],
      });
      return ok({ invoice });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invoice not found";
      const status = message.includes("IDOR") || message.includes("Unauthorized") ? 403 : 404;
      return fail(message, status);
    }
  },
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF, Role.PARENT, Role.STUDENT],
  },
);
