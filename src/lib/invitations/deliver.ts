import type { Role } from "@prisma/client";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { invitationEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";
import { INVITATION_TTL_DAYS } from "@/lib/invitations/token";
import { ROLE_LABELS } from "@/lib/roles";

/// How many invitation emails one ADDRESS may receive across ALL schools in a window: nobody's inbox is a target. Beyond it the invitation exists and the mail is
/// withheld (resend later). Shared by every route that invites someone, so the limit cannot be dodged by choosing a different route.
const MAIL_PER_ADDRESS = 5;

/// Sends the invitation email. Called from `after()` — never before the response, never failing the request.
export async function mailInvitation(input: {
  to: string;
  token: string;
  schoolName: string;
  role: Role;
  inviterName: string | null;
}): Promise<void> {
  try {
    if (!(await reserveAttempt(`invite:mail:${input.to}`, MAIL_PER_ADDRESS))) return;
    await sendEmailQuietly(
      invitationEmail({
        to: input.to,
        token: input.token,
        schoolName: input.schoolName,
        roleLabel: ROLE_LABELS[input.role],
        inviterName: input.inviterName,
        days: INVITATION_TTL_DAYS,
      }),
    );
  } catch (error) {
    console.error("[invitations] mail failed:", error instanceof Error ? error.message : error);
  }
}
