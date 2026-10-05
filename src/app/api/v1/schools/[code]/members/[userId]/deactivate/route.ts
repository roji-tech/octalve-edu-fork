import { fail, ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { isPlausibleId, memberFailure, notFound } from "@/lib/members/http";
import { deactivateMember } from "@/lib/members/service";

// POST /api/v1/schools/[code]/members/[userId]/deactivate                                   (plan §0.5.4)
// ADMIN only, audited, idempotent (doing it twice is a quiet success). Nobody does this to themselves, and the school's last
// active administrator cannot be deactivated. Access ends on the person's NEXT request — the role is read from the membership
// every time, so there is no session to revoke.
const PER_WINDOW = 60;
type Ctx = { params: Promise<{ code: string; userId: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { userId } = await ctx.params;
    if (!isPlausibleId(userId)) return notFound("member");
    if (!(await reserveAttempt(`member:deactivate:${auth.tenant.tenantId}:${auth.userId}`, PER_WINDOW))) {
      return fail("Too many changes. Please try again in a few minutes.", 429, "RATE_LIMITED");
    }
    const result = await deactivateMember(auth.tenant, auth.userId, userId);
    return result.ok ? ok({ member: result.member, changed: result.changed }) : memberFailure(result.reason);
  },
  { tenant: true, roles: ["ADMIN"] },
);
