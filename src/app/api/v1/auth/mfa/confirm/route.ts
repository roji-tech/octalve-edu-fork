import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt, refundAttempt } from "@/lib/auth/rate-limit";
import { revokeOtherSessions } from "@/lib/auth/session";
import { auditPersonEvent } from "@/lib/auth/audit";
import { MfaUnavailableError, mfaConfigured } from "@/lib/auth/mfa/secret-box";
import { confirmEnrolment } from "@/lib/auth/mfa/service";
import { normaliseTotpCode } from "@/lib/auth/mfa/totp";
import { mfaEnabledEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/mfa/confirm  { code }                                               (plan §0.5.D)
// Step 2 of turning two-step verification on: the person types the code their authenticator now shows.
// Success makes the credential ACTIVE, issues the ten recovery codes (returned here, once, never readable
// again), signs the person out of every OTHER device (an attacker's session from before the factor existed
// must not survive it) and sends a notice.
const USER_LIMIT = 5; // wrong codes per account per 5 minutes; a success is refunded

const schema = z.object({ code: z.string().min(1).max(64) });

export const POST = withAuth(async (req, auth) => {
  if (!mfaConfigured()) return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");

  const key = `mfa:confirm:${auth.userId}`;
  if (!(await reserveAttempt(key, USER_LIMIT))) {
    return fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success || normaliseTotpCode(parsed.data.code) === null) {
    await refundAttempt(key); // a typo is not a guess
    return fail("Enter the 6-digit code from your authenticator app.", 400, "VALIDATION");
  }

  let result: Awaited<ReturnType<typeof confirmEnrolment>>;
  try {
    result = await confirmEnrolment(auth.userId, parsed.data.code);
  } catch (error) {
    if (error instanceof MfaUnavailableError) {
      console.error("[mfa/confirm]", error.message);
      return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");
    }
    throw error;
  }
  if (!result.ok) {
    if (result.reason === "not-enrolling") {
      await refundAttempt(key);
      return fail("Start setting up two-step verification first.", 409, "NOT_ENROLLING");
    }
    return fail("That code isn't right. Check it and try again.", 400, "INVALID_CODE");
  }
  await refundAttempt(key);
  await revokeOtherSessions(auth.userId, auth.sessionId);

  after(async () => {
    try {
      await auditPersonEvent(auth.userId, "MFA_ENABLED");
      const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { email: true } });
      if (user?.email) await sendEmailQuietly(mfaEnabledEmail(user.email));
    } catch (error) {
      console.error("[mfa/confirm] follow-up failed:", error instanceof Error ? error.message : error);
    }
  });
  return noStore(ok({ enabled: true, recoveryCodes: result.recoveryCodes }));
});
