import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt, refundAttempt } from "@/lib/auth/rate-limit";
import { verifyPassword, PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { createEmailChangeToken } from "@/lib/auth/email-change";
import { auditPersonEvent } from "@/lib/auth/audit";
import {
  emailChangeConfirmEmail,
  emailChangeRequestedNotice,
  emailChangeTakenNotice,
} from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/email-change/request  { newEmail, password }                         (plan §0.5.E)
// Step 1 of changing the address on an account. The CURRENT password is re-verified (a stolen session alone must
// not be able to move an account's recovery channel), then — whatever the address is — the answer is the same:
// "we've sent a link". An authenticated person must not be able to probe which addresses have accounts, so the
// lookup, the token and the mail all happen AFTER the response, and a taken address gets a different notice
// instead of a link. The link goes to the NEW address (following it proves it is reachable); the OLD one is told.
const PASSWORD_LIMIT = 5; // password attempts per account per 5 minutes; anything but a wrong password is refunded
const REQUEST_LIMIT = 3; // VERIFIED requests per account per 5 minutes — it limits the mail we send, not guesses
const ADDRESS_LIMIT = 3; // requests per target address per 5 minutes: no mail-bombing a stranger through us

const schema = z.object({
  newEmail: z.string().trim().max(254).email().toLowerCase(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const POST = withAuth(async (req, auth) => {
  const passwordKey = `emailchange:password:${auth.userId}`;
  if (!(await reserveAttempt(passwordKey, PASSWORD_LIMIT))) {
    return fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    await refundAttempt(passwordKey);
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    await refundAttempt(passwordKey); // a typo is not a password guess
    return fail("Enter a valid email address and your current password.", 400, "VALIDATION");
  }
  const { newEmail, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { email: true, passwordHash: true } });
  if (!(await verifyPassword(password, user?.passwordHash ?? null))) {
    return fail("Your password is incorrect.", 400, "INVALID_PASSWORD");
  }
  await refundAttempt(passwordKey);
  if (user?.email === newEmail) return fail("That is already your email address.", 400, "SAME_EMAIL");

  // Counted only now: it bounds how much mail one signed-in person can cause, and must not be spent by typos
  // or wrong passwords (those have their own, tighter, guess limit above).
  if (!(await reserveAttempt(`emailchange:user:${auth.userId}`, REQUEST_LIMIT))) {
    return fail("Too many requests. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }

  const addressAllowed = await reserveAttempt(`emailchange:address:${newEmail}`, ADDRESS_LIMIT);
  after(async () => {
    try {
      if (user?.email) await sendEmailQuietly(emailChangeRequestedNotice(user.email, newEmail));
      await auditPersonEvent(auth.userId, "EMAIL_CHANGE_REQUESTED", { after: { newEmail } });
      if (!addressAllowed) return; // the same generic answer, but nothing more is sent to that address
      const existing = await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } });
      if (existing) {
        await sendEmailQuietly(emailChangeTakenNotice(newEmail));
      } else {
        const token = await createEmailChangeToken(auth.userId, newEmail);
        await sendEmailQuietly(emailChangeConfirmEmail(newEmail, token));
      }
    } catch (error) {
      console.error("[email-change/request] follow-up failed:", error instanceof Error ? error.message : error);
    }
  });
  return ok({ requested: true });
});
