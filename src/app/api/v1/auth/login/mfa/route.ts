import { after, type NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { fail, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { reserveAttempt, refundAttempt, getClientIp } from "@/lib/auth/rate-limit";
import { completeSignIn } from "@/lib/auth/complete-sign-in";
import { auditPersonEvent } from "@/lib/auth/audit";
import { consumeChallenge, spendChallengeAttempt } from "@/lib/auth/mfa/challenge";
import { parseSecondFactor } from "@/lib/auth/mfa/factor";
import { MfaUnavailableError, mfaConfigured } from "@/lib/auth/mfa/secret-box";
import { unusedRecoveryCodeCount, verifySecondFactor } from "@/lib/auth/mfa/service";
import { recoveryCodeUsedEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/login/mfa  { challenge, code }  or  { challenge, recoveryCode }      (plan §0.5.D)
// Sign-in step 2: redeems the challenge step 1 handed out. Only here — after a correct second factor —
// does a session come into existence, with the "Keep me signed in" choice made at step 1 (carried inside
// the challenge, so it cannot be changed now).
//
// Three limits stack, because six digits are guessable by volume and each closes a gap the others leave:
//  - per challenge: 5 attempts, then it is dead (spent atomically, BEFORE the code is checked);
//  - per account: 10 failures / 5 minutes across ALL challenges — the real bound for someone who knows the
//    password and can mint challenges at will; hard, not soft, because that someone already holds the password;
//  - per IP: 30 failures / 5 minutes, loose for the same carrier-NAT / school-egress reason as sign-in.
// A correct code is refunded; a malformed one (not 6 digits / not a recovery code) is a typo, not a guess.
const MFA_IP_LIMIT = 30;
const MFA_ACCOUNT_LIMIT = 10;

const RATE_LIMITED_MESSAGE = "Too many attempts. Please try again in a few minutes.";
const EXPIRED_MESSAGE = "Your sign-in has expired. Enter your password again.";
const INVALID_CODE_MESSAGE = "That code isn't right. Check it and try again.";

const schema = z.object({
  challenge: z.string().min(1).max(200),
  code: z.string().max(64).optional(),
  recoveryCode: z.string().max(64).optional(),
});

async function handleMfaLogin(req: NextRequest): Promise<NextResponse> {
  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");
  if (!mfaConfigured()) return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");

  const ipKey = `mfa:ip:${getClientIp(req)}`;
  if (!(await reserveAttempt(ipKey, MFA_IP_LIMIT))) return fail(RATE_LIMITED_MESSAGE, 429, "RATE_LIMITED");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    await refundAttempt(ipKey);
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(body);
  const factor = parsed.success ? parseSecondFactor(parsed.data) : null;
  if (!parsed.success || !factor) {
    await refundAttempt(ipKey); // a typo is not a guess
    return fail("Enter the code from your authenticator app, or one of your recovery codes.", 400, "VALIDATION");
  }
  const { challenge } = parsed.data;

  // Unknown, expired, used up and out-of-attempts all look the same.
  const pending = await spendChallengeAttempt(challenge);
  if (!pending) return fail(EXPIRED_MESSAGE, 401, "INVALID_CHALLENGE");

  const accountKey = `mfa:account:${pending.userId}`;
  if (!(await reserveAttempt(accountKey, MFA_ACCOUNT_LIMIT))) {
    return fail(RATE_LIMITED_MESSAGE, 429, "RATE_LIMITED");
  }

  let used: "totp" | "recovery" | null;
  try {
    used = await verifySecondFactor(pending.userId, factor);
  } catch (error) {
    if (error instanceof MfaUnavailableError) {
      console.error("[login/mfa]", error.message);
      return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");
    }
    throw error;
  }
  if (!used) return fail(INVALID_CODE_MESSAGE, 401, "INVALID_CODE");

  // Exactly one request turns a challenge into a session.
  if (!(await consumeChallenge(challenge))) return fail(EXPIRED_MESSAGE, 401, "INVALID_CHALLENGE");
  await refundAttempt(ipKey);
  await refundAttempt(accountKey);

  const user = await prisma.user.findUnique({
    where: { id: pending.userId },
    select: { id: true, name: true, email: true },
  });
  if (!user) return fail(EXPIRED_MESSAGE, 401, "INVALID_CHALLENGE");

  const extra: Record<string, unknown> = {};
  if (used === "recovery") {
    // The page warns when the supply is low; the person is told by email that a code was spent.
    const remaining = await unusedRecoveryCodeCount(user.id);
    extra.recoveryCodesRemaining = remaining;
    after(async () => {
      try {
        await auditPersonEvent(user.id, "MFA_RECOVERY_CODE_USED");
        if (user.email) await sendEmailQuietly(recoveryCodeUsedEmail(user.email, remaining));
      } catch (error) {
        console.error("[login/mfa] follow-up failed:", error instanceof Error ? error.message : error);
      }
    });
  }
  return completeSignIn(req, user, pending.remember, extra);
}

export async function POST(req: NextRequest) {
  // Every path — success, failure, rate-limited — is uncacheable.
  return noStore(await handleMfaLogin(req));
}
