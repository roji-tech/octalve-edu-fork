import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure } from "@/lib/people/http";
import { linkableAccounts } from "@/lib/people/staff";

// GET /api/v1/schools/[code]/people/staff/[id]/linkable-accounts — ADMIN only. The active members of this school whose role fits the record and who have no staff record yet
// (at most 200): the choices for "Link account".
type Ctx = { params: Promise<{ code: string; id: string }> };

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("staff member");
    const result = await linkableAccounts(auth.tenant, id);
    return result.ok ? ok({ accounts: result.accounts }) : peopleFailure(result.reason, result.detail, "staff member");
  },
  { tenant: true, roles: WRITE_ROLES },
);
