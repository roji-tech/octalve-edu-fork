import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { reserveAttempt, refundAttempt, getClientIp } from "@/lib/auth/rate-limit";
import { hashPassword } from "@/lib/auth/password";
import { checkNewPasswordOnServer } from "@/lib/auth/pwned-password";
import { isLiveResetToken, resetPasswordWithToken } from "@/lib/auth/password-reset";
import { auditPersonEvent } from "@/lib/auth/audit";
import { clearSessionCookie } from "@/lib/auth/session";
import { passwordChangedEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/reset-password  { token, password }   (domain-implementation-plan.md §0.5.C)
// Unknown, expired and already-used links all get the same 400. Success does NOT sign anyone in — they
// sign in with the new password (and, once 0.5.D exists, their second factor: a reset never bypasses MFA).
const IP_LIMIT = 10; // failures per IP; a success is refunded
const INVALID_LINK = "This link is invalid or has expired. Request a new one.";

const schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().max(1024), // size bound only; the real rule is checkNewPassword
});

export async function POST(req: NextRequest) {
  return noStore(await handle(req));
}

async function handle(req: NextRequest) {
  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");

  const ipKey = `reset:ip:${getClientIp(req)}`;
  if (!(await reserveAttempt(ipKey, IP_LIMIT))) {
    return fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail(INVALID_LINK, 400, "INVALID_TOKEN");
  const { token, password } = parsed.data;

  // Tell them about a weak password BEFORE spending the link, so they can fix it and retry.
  const problem = await checkNewPasswordOnServer(password);
  if (problem) {
    await refundAttempt(ipKey); // a typo isn't an attack
    return fail(problem, 400, "VALIDATION");
  }

  if (!(await isLiveResetToken(token))) return fail(INVALID_LINK, 400, "INVALID_TOKEN");

  const result = await resetPasswordWithToken(token, await hashPassword(password));
  if (!result) return fail(INVALID_LINK, 400, "INVALID_TOKEN"); // lost a race for the same link

  await refundAttempt(ipKey);
  after(async () => {
    try {
      await auditPersonEvent(result.userId, "PASSWORD_RESET");
      const user = await prisma.user.findUnique({ where: { id: result.userId }, select: { email: true } });
      if (user?.email) await sendEmailQuietly(passwordChangedEmail(user.email));
    } catch (error) {
      console.error("[reset-password] follow-up failed:", error instanceof Error ? error.message : error);
    }
  });

  return clearSessionCookie(ok({ reset: true })); // any cookie the browser still holds is for a deleted session
}
