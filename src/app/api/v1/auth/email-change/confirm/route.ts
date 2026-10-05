import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { reserveAttempt, refundAttempt, getClientIp } from "@/lib/auth/rate-limit";
import { confirmEmailChange } from "@/lib/auth/email-change";
import { auditPersonEvent } from "@/lib/auth/audit";
import { clearSessionCookie } from "@/lib/auth/session";
import { emailChangedNotice } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/email-change/confirm  { token }                                      (plan §0.5.E)
// Step 2: the link mailed to the NEW address. Public on purpose — it is opened from a mail client, signed in or
// not; possession of the link IS the proof. Unknown, expired, used and "that address was taken in the meantime"
// all get the same 400. Success switches the address, signs the person out EVERYWHERE (the email is the recovery
// channel), tells the OLD address, and does not sign anyone in.
const IP_LIMIT = 10; // failures per IP per 5 minutes; a success is refunded
const INVALID_LINK = "This link is invalid or has expired. Request the change again from your account page.";

const schema = z.object({ token: z.string().min(20).max(200) });

export async function POST(req: NextRequest) {
  return noStore(await handle(req));
}

async function handle(req: NextRequest) {
  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");

  const ipKey = `emailchange:confirm:ip:${getClientIp(req)}`;
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

  const changed = await confirmEmailChange(parsed.data.token);
  if (!changed) return fail(INVALID_LINK, 400, "INVALID_TOKEN");

  await refundAttempt(ipKey);
  after(async () => {
    try {
      await auditPersonEvent(changed.userId, "EMAIL_CHANGED", { before: { email: changed.oldEmail }, after: { email: changed.newEmail } });
      if (changed.oldEmail) await sendEmailQuietly(emailChangedNotice(changed.oldEmail, changed.newEmail));
    } catch (error) {
      console.error("[email-change/confirm] follow-up failed:", error instanceof Error ? error.message : error);
    }
  });
  return clearSessionCookie(ok({ changed: true })); // any cookie the browser still holds is for a deleted session
}
