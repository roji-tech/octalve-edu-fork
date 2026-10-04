import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt, refundAttempt } from "@/lib/auth/rate-limit";
import { verifyPassword, PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { mfaConfigured } from "@/lib/auth/mfa/secret-box";
import { beginEnrolment } from "@/lib/auth/mfa/service";
import { brand } from "@/lib/brand";

// POST /api/v1/auth/mfa/enroll  { password }                                            (plan §0.5.D)
// Step 1 of turning two-step verification on: returns a fresh secret (as the manual-entry key and the
// otpauth:// URL the page draws as a QR code IN THE BROWSER — the secret never goes to a third party).
// It is stored encrypted and UNCONFIRMED: it protects nothing until POST /mfa/confirm proves the person
// can produce a code from it. A stolen session alone must not be able to start this, so the PASSWORD is
// re-verified (constant time), with failures limited per account.
const USER_LIMIT = 5; // wrong passwords per account per 5 minutes; a success is refunded

const schema = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

export const POST = withAuth(async (req, auth) => {
  if (!mfaConfigured()) return fail("Two-step verification is unavailable right now.", 503, "MFA_UNAVAILABLE");

  const key = `mfa:enroll:${auth.userId}`;
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
  if (!parsed.success) return fail("Enter your password.", 400, "VALIDATION");

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { email: true, name: true, passwordHash: true },
  });
  if (!(await verifyPassword(parsed.data.password, user?.passwordHash ?? null))) {
    return fail("Your password is incorrect.", 400, "INVALID_PASSWORD");
  }
  await refundAttempt(key);

  const started = await beginEnrolment(auth.userId, {
    issuer: brand.name,
    account: user?.email ?? user?.name ?? auth.userId,
  });
  if (!started) return fail("Two-step verification is already on. Turn it off first to set it up again.", 409, "ALREADY_ENABLED");
  return noStore(ok(started));
});
