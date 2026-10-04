import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt, refundAttempt } from "@/lib/auth/rate-limit";
import { hashPassword, verifyPassword, PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { checkNewPassword } from "@/lib/auth/password-policy";
import { revokeOtherSessions } from "@/lib/auth/session";
import { auditPersonEvent } from "@/lib/auth/audit";
import { passwordChangedEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/change-password  { currentPassword, newPassword }   (plan §0.5.C)
// A stolen session alone must not be enough to take over the account, so the CURRENT password is
// re-verified (constant time), with failures rate-limited per account. Success signs the person out of
// every OTHER device and keeps the session they are using.
const USER_LIMIT = 5; // failed current-password attempts per account; a success is refunded

const schema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().max(1024),
});

export const POST = withAuth(async (req, auth) => {
  const key = `change:user:${auth.userId}`;
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
  if (!parsed.success) return fail("Enter your current and new password.", 400, "VALIDATION");
  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { email: true, passwordHash: true },
  });
  if (!(await verifyPassword(currentPassword, user?.passwordHash ?? null))) {
    return fail("Your current password is incorrect.", 400, "INVALID_CURRENT_PASSWORD");
  }

  const problem = checkNewPassword(newPassword);
  if (problem) {
    await refundAttempt(key); // they proved who they are; a weak new password isn't an attack
    return fail(problem, 400, "VALIDATION");
  }
  if (newPassword === currentPassword) {
    await refundAttempt(key);
    return fail("Choose a password you haven't just used.", 400, "SAME_PASSWORD");
  }

  await prisma.user.update({ where: { id: auth.userId }, data: { passwordHash: await hashPassword(newPassword) } });
  await revokeOtherSessions(auth.userId, auth.sessionId);
  await refundAttempt(key);

  after(async () => {
    try {
      await auditPersonEvent(auth.userId, "PASSWORD_CHANGED");
      if (user?.email) await sendEmailQuietly(passwordChangedEmail(user.email));
    } catch (error) {
      console.error("[change-password] follow-up failed:", error instanceof Error ? error.message : error);
    }
  });
  return ok({ changed: true });
});
