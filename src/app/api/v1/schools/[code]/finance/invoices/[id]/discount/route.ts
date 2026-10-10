import { Permission, Role } from "@prisma/client";
import { ok, fail } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { applyDiscountSchema } from "@/lib/finance/http";
import { applyInvoiceDiscount } from "@/lib/finance/service";

// POST /api/v1/schools/[code]/finance/invoices/[id]/discount
export const POST = withAuth(
  validate(
    { body: applyDiscountSchema },
    async (_req, auth: TenantAuthContext, ctx: { params: Promise<{ code: string; id: string }> }, { body }) => {
      try {
        const { id } = await ctx.params;
        const res = await applyInvoiceDiscount(
          auth.tenant.tenantId,
          id,
          {
            amount: body.amount,
            reason: body.reason,
            mode: body.mode,
          },
          auth.userId,
        );
        return ok(res, {}, 201);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to apply discount";
        return fail(message, 400);
      }
    },
  ),
  { tenant: true, roles: [Role.ADMIN], permissions: [Permission.CAN_MANAGE_FINANCE] },
);
