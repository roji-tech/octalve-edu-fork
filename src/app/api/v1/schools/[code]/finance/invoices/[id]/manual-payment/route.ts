import { Permission, Role } from "@prisma/client";
import { ok, fail } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { recordManualPaymentSchema } from "@/lib/finance/http";
import { recordManualPayment } from "@/lib/finance/service";

// POST /api/v1/schools/[code]/finance/invoices/[id]/manual-payment
export const POST = withAuth(
  validate(
    { body: recordManualPaymentSchema },
    async (_req, auth: TenantAuthContext, ctx: { params: Promise<{ code: string; id: string }> }, { body }) => {
      try {
        const { code, id } = await ctx.params;
        const res = await recordManualPayment(
          auth.tenant.tenantId,
          code,
          id,
          {
            amount: body.amount,
            channel: body.channel,
            receiptNo: body.receiptNo,
            note: body.note,
          },
          auth.userId,
        );
        return ok(res, {}, 201);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to record manual payment";
        const isNotFound = message.includes("not found") || (err as { name?: string })?.name === "NotFoundError";
        return fail(message, isNotFound ? 404 : 400);
      }
    },
  ),
  { tenant: true, roles: [Role.ADMIN], permissions: [Permission.CAN_MANAGE_FINANCE] },
);
