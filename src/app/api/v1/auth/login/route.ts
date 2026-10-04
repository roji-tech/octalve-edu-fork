import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import {
  reserveAttempt,
  refundAttempt,
  checkRateLimit,
  getClientIp,
} from "@/lib/auth/rate-limit";
import { verifyPassword, PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import {
  createSession,
  deleteSessionByToken,
  setSessionCookie,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";

const loginSchema = z.object({
  // 254 = the practical RFC 5321 maximum; also bounds the size of the
  // rate-limit keys built from it below.
  email: z.string().trim().max(254).email().toLowerCase(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  // "Keep me signed in on this device". A STRICT boolean, default false: anything
  // else ("true", 1, null) fails validation like any other malformed body.
  remember: z.boolean().default(false),
});

// Three layers (docs/auth-review-2026-09-29.md finding 14), each closing a gap
// the others leave open. Windows/limits count FAILED attempts only — a correct
// login is refunded, so switching devices never locks anyone out.
//  - per-IP, all accounts: stops one IP spraying one password across many
//    accounts. Deliberately much looser than the pair limit: carrier NAT and a
//    school's shared egress put many legitimate users behind one IP, and a
//    hard 5-per-IP gate would let one person's typos lock the whole school out.
//  - per-IP+email (hard): stops one attacker grinding one account.
//  - per-email across all IPs (SOFT): stops distributed credential stuffing,
//    but is only ever surfaced as a flag — never a block — so an attacker
//    can't weaponize it to lock the real user out.
const LOGIN_IP_LIMIT = 30;
const LOGIN_PAIR_LIMIT = 5;
const LOGIN_ACCOUNT_SOFT_LIMIT = 10;

const RATE_LIMITED_MESSAGE = "Too many login attempts. Please try again in a few minutes.";
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

/**
 * POST /api/v1/auth/login
 * Hand-rolled (Auth.js is not used at all — see domain-implementation-plan.md
 * §0.5.1). Guard order: CSRF → reserve rate-limit slots → parse → validate →
 * constant-time credential check → rotate + create session.
 *
 * The pending-MFA step (design in §0.5.1, built later) slots in between
 * "password verified" and "createSession": password alone must never yield a
 * real session for an MFA-enrolled account.
 */
async function handleLogin(req: NextRequest): Promise<NextResponse> {
  if (!validateCSRF(req)) {
    return fail("Cross-origin request blocked", 403, "CSRF");
  }

  // Reserved at the very start, before any slow async work, so concurrent
  // requests can't all pass a check before any of them records anything.
  const ipKey = `login:ip:${getClientIp(req)}`;
  if (!(await reserveAttempt(ipKey, LOGIN_IP_LIMIT))) {
    return fail(RATE_LIMITED_MESSAGE, 429, "RATE_LIMITED");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    // Same response as a wrong password — the validation rules themselves
    // shouldn't be probeable — and the IP reservation above stays consumed.
    return fail(INVALID_CREDENTIALS_MESSAGE, 401, "INVALID_CREDENTIALS");
  }
  const { email, password, remember } = parsed.data;

  const pairKey = `${ipKey}:${email}`;
  const accountKey = `login:account:${email}`;

  if (!(await reserveAttempt(pairKey, LOGIN_PAIR_LIMIT))) {
    return fail(RATE_LIMITED_MESSAGE, 429, "RATE_LIMITED");
  }
  const accountThrottled = !(await checkRateLimit(accountKey, LOGIN_ACCOUNT_SOFT_LIMIT));

  const user = await prisma.user.findUnique({ where: { email } });
  // Always runs bcrypt.compare (against a dummy hash if there's no user or no
  // passwordHash), so "no such account" costs the same as "wrong password".
  const valid = await verifyPassword(password, user?.passwordHash ?? null);

  if (!user?.passwordHash || !valid) {
    await reserveAttempt(accountKey, LOGIN_ACCOUNT_SOFT_LIMIT);
    // Identical body for "no such user" and "wrong password" — enumeration
    // can't tell them apart from the content or the timing.
    return fail(INVALID_CREDENTIALS_MESSAGE, 401, "INVALID_CREDENTIALS");
  }

  // Success: hand back this request's reservations so a correct login never
  // counts against the user's own future attempts.
  await refundAttempt(ipKey);
  await refundAttempt(pairKey);

  // Rotate: a session already presented is deleted before the new one exists,
  // never left valid alongside it.
  const presentedToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (presentedToken) await deleteSessionByToken(presentedToken);

  // An ADMIN anywhere gets the shorter absolute session lifetime.
  const holdsAdmin = Boolean(
    await prisma.tenantMembership.findFirst({
      where: { userId: user.id, role: Role.ADMIN },
      select: { id: true },
    }),
  );
  const { token, expires, persistent } = await createSession(user.id, req.headers.get("user-agent"), {
    admin: holdsAdmin,
    remember,
  });

  const response = ok({
    user: { id: user.id, name: user.name, email: user.email },
    accountThrottled, // surfaced so the UI can show a soft notice, never a hard block
  });
  // Not remembered → a browser-session cookie (and a 12-hour server-side cap).
  return setSessionCookie(response, token, persistent ? expires : null);
}

export async function POST(req: NextRequest) {
  // Every path — success, failure, rate-limited — is uncacheable.
  return noStore(await handleLogin(req));
}
