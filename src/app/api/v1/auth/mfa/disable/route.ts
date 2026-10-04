import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt, refundAttempt } from "@/lib/auth/rate-limit";
import { verifyPassword, PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { revokeOtherSessions } from "@/lib/auth/session";
import { auditPersonEvent } from "@/lib/auth/audit";
import { parseSecondFactor } from "@/lib/auth/mfa/factor";
import { MfaUnavailableError, mfaConfigured } from "@/lib/auth/mfa/secret-box";
import { disableMfa, hasActiveMfa, verifySecondFactor } from "@/lib/auth/mfa/service";
import { mfaDisabledEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/mfa/disable  { password, code }  or  { password, recoveryCode }      (plan §0.5.D)
// Turning the second factor OFF needs BOTH things: the password and a current second factor — otherwise a
// stolen session (or a shoulder-surfed password) could simply remove the protection. Deletes the credential
// and every recovery code, signs out every other device and sends a notice.
const USER_LIMIT = 5; // failed attempts (either check) per account per 5 minutes; a success is refunded

const schema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: z.string().max(64).optional(),
  recoveryCode: z.string().max(64).optional(),
});

export const POST = withAuth(async (req, auth) => {
  if (!mfaConfigured()) return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");

  const key = `mfa:disable:${auth.userId}`;
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
  const factor = parsed.success ? parseSecondFactor(parsed.data) : null;
  if (!parsed.success || !factor) {
    await refundAttempt(key); // a typo is not a guess
    return fail("Enter your password and a code from your authenticator app (or a recovery code).", 400, "VALIDATION");
  }

  if (!(await hasActiveMfa(auth.userId))) {
    await refundAttempt(key);
    return fail("Two-step verification isn't on.", 409, "NOT_ENABLED");
  }

  // Password first, and only then the factor: a wrong password must not burn a one-time code.
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { email: true, passwordHash: true },
  });
  if (!(await verifyPassword(parsed.data.password, user?.passwordHash ?? null))) {
    return fail("Your password is incorrect.", 400, "INVALID_PASSWORD");
  }
  let used: "totp" | "recovery" | null;
  try {
    used = await verifySecondFactor(auth.userId, factor);
  } catch (error) {
    if (error instanceof MfaUnavailableError) {
      console.error("[mfa/disable]", error.message);
      return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");
    }
    throw error;
  }
  if (!used) return fail("That code isn't right. Check it and try again.", 400, "INVALID_CODE");

  await disableMfa(auth.userId);
  await revokeOtherSessions(auth.userId, auth.sessionId);
  await refundAttempt(key);

  after(async () => {
    try {
      await auditPersonEvent(auth.userId, "MFA_DISABLED");
      if (user?.email) await sendEmailQuietly(mfaDisabledEmail(user.email));
    } catch (error) {
      console.error("[mfa/disable] follow-up failed:", error instanceof Error ? error.message : error);
    }
  });
  return noStore(ok({ enabled: false }));
});
