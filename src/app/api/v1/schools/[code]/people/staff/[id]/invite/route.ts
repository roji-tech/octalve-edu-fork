import { after } from "next/server";
import { fail, ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { mailInvitation } from "@/lib/invitations/deliver";
import { createInvitation } from "@/lib/invitations/service";
import { WRITE_ROLES, isPlausibleId, notFound, peopleFailure } from "@/lib/people/http";
import { staffInviteDetails } from "@/lib/people/staff";

// POST /api/v1/schools/[code]/people/staff/[id]/invite — ADMIN only. Invites the record's email address to sign in, as the role its category signs in as, on its
// campus; accepting the (hashed, single-use, seven-day) link creates the membership AND links this record to it in one transaction (plan 1.2, decision P5).
// Same limits as the Users page's invitations; the mail is sent AFTER the response.
type Ctx = { params: Promise<{ code: string; id: string }> };
const CREATES_PER_WINDOW = 30; // per administrator per school per 5 minutes (shared with the Users page: the same bucket)
const PER_ADDRESS = 3; // per school per address per 5 minutes

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("staff member");
    const { tenant } = auth;
    const details = await staffInviteDetails(tenant, id);
    if (!details.ok) return peopleFailure(details.reason, details.detail, "staff member");
    if (!(await reserveAttempt(`invite:create:${tenant.tenantId}:${auth.userId}`, CREATES_PER_WINDOW))) {
      return fail("Too many invitations. Please try again in a few minutes.", 429, "RATE_LIMITED");
    }
    if (!(await reserveAttempt(`invite:to:${tenant.tenantId}:${details.email}`, PER_ADDRESS))) {
      return fail("That address was invited several times just now. Please wait a few minutes.", 429, "RATE_LIMITED");
    }
    const result = await createInvitation(tenant, auth.userId, {
      email: details.email,
      role: details.role,
      campusId: details.campusId,
      staffRecordId: id,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "ALREADY_MEMBER":
          return fail(
            "That address already belongs to a member of this school. Link their account to this record instead.",
            409,
            "ALREADY_MEMBER",
          );
        case "DEACTIVATED_MEMBER":
          return fail(
            "That person was deactivated in this school. Reactivate them on the Users page, then link their account.",
            409,
            "DEACTIVATED_MEMBER",
          );
        case "INVALID_CAMPUS":
          return fail("Choose one of this school's campuses.", 400, "VALIDATION");
        case "INVALID_STAFF_RECORD":
          return fail("That can't be done to it in its current state.", 409, "WRONG_STATE");
      }
    }
    after(() =>
      mailInvitation({
        to: details.email,
        token: result.token,
        schoolName: tenant.tenantName,
        role: details.role,
        inviterName: auth.user.name,
      }),
    );
    return ok({ invitation: result.invitation }, {}, 201);
  },
  { tenant: true, roles: WRITE_ROLES },
);
