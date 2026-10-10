import { Permission, Role } from "@prisma/client";
import { ok, fail } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { createFeeStructureSchema, queryFeeStructuresSchema } from "@/lib/finance/http";
import { createFeeStructure, queryFeeStructures } from "@/lib/finance/service";

// GET /api/v1/schools/[code]/finance/fee-structures
export const GET = withAuth(
  validate({ query: queryFeeStructuresSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { query }) => {
    const feeStructures = await queryFeeStructures(auth.tenant.tenantId, {
      periodId: query.periodId,
      classGroupId: query.classGroupId,
    });
    return ok({ feeStructures });
  }),
  { tenant: true, roles: [Role.ADMIN, Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF], permissions: [Permission.CAN_MANAGE_FINANCE] },
);

// POST /api/v1/schools/[code]/finance/fee-structures
export const POST = withAuth(
  validate({ body: createFeeStructureSchema }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    try {
      const feeStructure = await createFeeStructure(auth.tenant.tenantId, body, auth.userId);
      return ok({ feeStructure }, {}, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create fee structure";
      return fail(message, 400);
    }
  }),
  { tenant: true, roles: [Role.ADMIN], permissions: [Permission.CAN_MANAGE_FINANCE] },
);
