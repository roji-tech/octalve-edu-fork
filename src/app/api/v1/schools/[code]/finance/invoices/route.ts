import { Permission, Role } from "@prisma/client";
import { ok, fail } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { generateInvoicesSchema, queryInvoicesSchema } from "@/lib/finance/http";
import { generateInvoicesForPeriod, queryInvoices } from "@/lib/finance/service";

// GET /api/v1/schools/[code]/finance/invoices
export const GET = withAuth(
  validate({ query: queryInvoicesSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { query }) => {
    // If student, filter by student's own record
    const result = await queryInvoices(auth.tenant.tenantId, {
      periodId: query.periodId,
      studentId: query.studentId,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
    return ok(result);
  }),
  {
    tenant: true,
    roles: [Role.ADMIN, Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF, Role.PARENT, Role.STUDENT],
    permissions: [Permission.CAN_MANAGE_FINANCE],
  },
);

// POST /api/v1/schools/[code]/finance/invoices
// Batch generation of invoices for a period
export const POST = withAuth(
  validate(
    { body: generateInvoicesSchema },
    async (_req, auth: TenantAuthContext, ctx: { params: Promise<{ code: string }> }, { body }) => {
      try {
        const { code } = await ctx.params;
        const dueDate = body.dueDate ? new Date(body.dueDate) : undefined;
        const summary = await generateInvoicesForPeriod(auth.tenant.tenantId, code, body.periodId, {
          dueDate,
          actorUserId: auth.userId,
        });
        return ok(summary, {}, 201);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to generate invoices";
        return fail(message, 400);
      }
    },
  ),
  { tenant: true, roles: [Role.ADMIN], permissions: [Permission.CAN_MANAGE_FINANCE] },
);
