import { after } from "next/server";
import { fail, ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { invitationEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";
import { resendInvitation } from "@/lib/invitations/service";
import { INVITATION_TTL_DAYS } from "@/lib/invitations/token";
import { isPlausibleId, notFound } from "@/lib/members/http";
import { ROLE_LABELS } from "@/lib/roles";

// POST /api/v1/schools/[code]/invitations/[id]/resend                                      (plan §0.5.4)
// A fresh link and a fresh seven days for an OPEN invitation (pending or expired) — the earlier link stops working at once.
// ADMIN only, audited, limited per invitation and per address.
const PER_INVITATION = 3;
const MAIL_PER_ADDRESS = 5;
type Ctx = { params: Promise<{ code: string; id: string }> };

export const POST = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { tenant } = auth;
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("open invitation");
    if (!(await reserveAttempt(`invite:resend:${tenant.tenantId}:${id}`, PER_INVITATION))) {
      return fail("That invitation was resent several times just now. Please wait a few minutes.", 429, "RATE_LIMITED");
    }
    const result = await resendInvitation(tenant, auth.userId, id);
    if (!result) return notFound("open invitation");
    const { invitation, token } = result;

    after(async () => {
      try {
        if (!(await reserveAttempt(`invite:mail:${invitation.email}`, MAIL_PER_ADDRESS))) return;
        await sendEmailQuietly(
          invitationEmail({ to: invitation.email, token, schoolName: tenant.tenantName, roleLabel: ROLE_LABELS[invitation.role], inviterName: auth.user.name, days: INVITATION_TTL_DAYS }),
        );
      } catch (error) {
        console.error("[invitations] mail failed:", error instanceof Error ? error.message : error);
      }
    });
    return ok({ invitation });
  },
  { tenant: true, roles: ["ADMIN"] },
);
