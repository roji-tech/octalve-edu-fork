import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { reserveAttempt, getClientIp } from "@/lib/auth/rate-limit";
import { createResetToken } from "@/lib/auth/password-reset";
import { resetEmail } from "@/lib/email/messages";
import { sendEmailQuietly } from "@/lib/email/transport";

// POST /api/v1/auth/forgot-password  { email }   (domain-implementation-plan.md §0.5.C)
//
// Answers 200 with the SAME body whether or not the account exists, and does the lookup, the token
// insert and the email send in `after()` — i.e. after the response has gone — so neither the content
// nor the timing says whether the address is registered. Every request counts against the limits
// (each can send mail, so unlike login a "success" is not refunded): per IP, and per address, which
// stops this being used to mail-bomb someone. The per-address limit answers the same generic 200
// rather than a 429, which would reveal that the address was asked for recently.
const IP_LIMIT = 10;
const EMAIL_LIMIT = 3;

const schema = z.object({ email: z.string().trim().max(254).email().toLowerCase() });
const GENERIC = { requested: true };

export async function POST(req: NextRequest) {
  return noStore(await handle(req));
}

async function handle(req: NextRequest) {
  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");

  if (!(await reserveAttempt(`forgot:ip:${getClientIp(req)}`, IP_LIMIT))) {
    return fail("Too many requests. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return ok(GENERIC); // nothing to do — and nothing to learn from the answer
  const { email } = parsed.data;

  if (!(await reserveAttempt(`forgot:email:${email}`, EMAIL_LIMIT))) return ok(GENERIC);

  after(async () => {
    try {
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
      if (!user?.email) return;
      const token = await createResetToken(user.id);
      await sendEmailQuietly(resetEmail(user.email, token));
    } catch (error) {
      console.error("[forgot-password] failed:", error instanceof Error ? error.message : error);
    }
  });

  return ok(GENERIC);
}
