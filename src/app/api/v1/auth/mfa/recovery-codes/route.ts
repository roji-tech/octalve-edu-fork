import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt, refundAttempt } from "@/lib/auth/rate-limit";
import { auditPersonEvent } from "@/lib/auth/audit";
import { MfaUnavailableError, mfaConfigured } from "@/lib/auth/mfa/secret-box";
import { hasActiveMfa, regenerateRecoveryCodes, verifyTotpForUser } from "@/lib/auth/mfa/service";
import { normaliseTotpCode } from "@/lib/auth/mfa/totp";
import { recoveryCodesReplacedEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/mfa/recovery-codes  { code }                                        (plan §0.5.D)
// Replaces ALL recovery codes (used or not) with a fresh set, returned once. Needs a current code from the
// authenticator — not a recovery code: this is how someone down to their last codes tops up, and it must
// not be possible with only the thing it replaces.
const USER_LIMIT = 5; // wrong codes per account per 5 minutes; a success is refunded

const schema = z.object({ code: z.string().min(1).max(64) });

export const POST = withAuth(async (req, auth) => {
  if (!mfaConfigured()) return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");

  const key = `mfa:recovery:${auth.userId}`;
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

  if (!(await hasActiveMfa(auth.userId))) {
    await refundAttempt(key);
    return fail("Two-step verification isn't on.", 409, "NOT_ENABLED");
  }
  try {
    if (!(await verifyTotpForUser(auth.userId, parsed.data.code))) {
      return fail("That code isn't right. Check it and try again.", 400, "INVALID_CODE");
    }
  } catch (error) {
    if (error instanceof MfaUnavailableError) {
      console.error("[mfa/recovery-codes]", error.message);
      return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");
    }
    throw error;
  }

  const recoveryCodes = await regenerateRecoveryCodes(auth.userId);
  await refundAttempt(key);

  after(async () => {
    try {
      await auditPersonEvent(auth.userId, "MFA_RECOVERY_CODES_REPLACED");
      const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { email: true } });
      if (user?.email) await sendEmailQuietly(recoveryCodesReplacedEmail(user.email));
    } catch (error) {
      console.error("[mfa/recovery-codes] follow-up failed:", error instanceof Error ? error.message : error);
    }
  });
  return noStore(ok({ recoveryCodes }));
});
