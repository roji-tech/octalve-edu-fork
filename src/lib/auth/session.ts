import crypto from "node:crypto";
import { cookies as nextCookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Hand-rolled database sessions, ported from AlEemaan's verified
// implementation and built to the fully hardened design in
// domain-implementation-plan.md §0.5.1 (two-level expiry, bounded growth).

// --- Lifetime policy -------------------------------------------------------
// Defaults, not PRD requirements (the PRD specifies none). Named constants so
// they can be tuned in exactly one place.
//
// SESSION_MAX_AGE_SECONDS is the IDLE window: it slides forward while the
// session is used. The ABSOLUTE caps never extend — a stolen session that an
// attacker keeps warm still dies — and are shorter for anyone holding an ADMIN
// membership, since that is the account worth stealing.
//
// Two modes, chosen at sign-in by the "Keep me signed in on this device" box:
//  - remembered: the policy above (30d idle, 90d absolute) and a persistent cookie;
//  - not remembered (the default): a browser-session cookie AND a hard 12-hour
//    server-side cap. The cap is the real bound — browsers that "continue where
//    you left off" restore session cookies across restarts, so "close the
//    browser" alone can't be relied on to end a session on a shared computer.
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // idle: 30 days
export const SESSION_ABSOLUTE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60; // 90 days
export const ADMIN_SESSION_ABSOLUTE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const SESSION_ONLY_MAX_AGE_SECONDS = 12 * 60 * 60; // not remembered: 12 hours
const MAX_SESSIONS_PER_USER = 10;
/// Sliding the idle expiry costs a write; do it at most once per interval per
/// session rather than on every request.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_USER_AGENT_LENGTH = 255;

// --- Cookie ----------------------------------------------------------------
// `__Host-` (not `__Secure-`) in production: it additionally forces Path=/ and
// forbids a Domain attribute, closing a sibling-subdomain cookie-planting risk
// `__Secure-` alone doesn't. `secure` is derived from APP_URL's actual scheme,
// NOT from NODE_ENV: a Solo/LAN install genuinely served over plain HTTP in
// "production" mode would otherwise get a 200 from login and no cookie ever
// set, since browsers silently refuse a Secure cookie over HTTP.
const isHttps = (process.env.APP_URL ?? "").startsWith("https://");
export const SESSION_COOKIE_NAME = isHttps
  ? "__Host-octalve.session-token"
  : "octalve.session-token";
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: isHttps,
};

export type SessionUser = { id: string; name: string | null; email: string | null };
export type ResolvedSession = { sessionId: string; userId: string; user: SessionUser };

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/// Creates a session for `userId` and returns the PLAINTEXT token, which the
/// caller sets as the cookie value — only its SHA-256 hash is ever persisted.
/// `expires` in the result is the ABSOLUTE expiry, i.e. the latest moment the
/// session (and so its cookie) can be valid; idle expiry is enforced
/// server-side, so the cookie itself never needs refreshing. `persistent` says
/// whether the cookie should carry that expiry (a remembered session) or be a
/// browser-session cookie (the default) — pass `persistent ? expires : null` to
/// `setSessionCookie`.
///
/// `remember` defaults to FALSE on purpose: a caller that forgets to say gets
/// the short, least-privilege session, never the long-lived one. The applicable
/// absolute cap is `min(mode cap, 7 days if admin)`.
export async function createSession(
  userId: string,
  userAgent?: string | null,
  opts: { admin?: boolean; remember?: boolean } = {},
): Promise<{ token: string; expires: Date; persistent: boolean }> {
  const token = crypto.randomBytes(32).toString("hex"); // 256-bit, server-generated, never client-supplied
  const tokenHash = hashToken(token);
  const persistent = opts.remember === true;

  const now = Date.now();
  const modeSeconds = persistent ? SESSION_ABSOLUTE_MAX_AGE_SECONDS : SESSION_ONLY_MAX_AGE_SECONDS;
  const absoluteSeconds = opts.admin
    ? Math.min(modeSeconds, ADMIN_SESSION_ABSOLUTE_MAX_AGE_SECONDS)
    : modeSeconds;
  const absoluteExpires = new Date(now + absoluteSeconds * 1000);
  const expires = new Date(
    Math.min(now + SESSION_MAX_AGE_SECONDS * 1000, absoluteExpires.getTime()),
  );

  await prisma.$transaction(async (tx) => {
    // Bounded growth: this user's already-dead rows are removed in the same
    // transaction (purgeExpiredSessions() handles the global sweep).
    await tx.session.deleteMany({
      where: {
        userId,
        OR: [{ expires: { lt: new Date(now) } }, { absoluteExpires: { lt: new Date(now) } }],
      },
    });

    await tx.session.create({
      data: {
        tokenHash,
        userId,
        expires,
        absoluteExpires,
        userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      },
    });

    // Per-user cap: a scripted login loop can't grow one account's rows
    // without bound. Evicts the oldest-created beyond the cap.
    const sessions = await tx.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const overflow = sessions.slice(MAX_SESSIONS_PER_USER);
    if (overflow.length > 0) {
      await tx.session.deleteMany({ where: { id: { in: overflow.map((s) => s.id) } } });
    }
  });

  return { token, expires: absoluteExpires, persistent };
}

/// Deletes the session matching a plaintext token (login rotation, logout).
/// Idempotent — deleteMany doesn't throw if the row is already gone.
export async function deleteSessionByToken(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/// Deletes every session for a user, optionally keeping one (e.g. the session
/// that just changed the password). Call on password change, role change, or
/// deactivation — without it a dismissed staff member's session stays valid
/// until natural expiry. Not called anywhere yet (those flows don't exist);
/// it exists so they don't have to reinvent it.
export async function revokeUserSessions(userId: string, exceptToken?: string): Promise<void> {
  const exceptHash = exceptToken ? hashToken(exceptToken) : undefined;
  await prisma.session.deleteMany({
    where: { userId, ...(exceptHash ? { tokenHash: { not: exceptHash } } : {}) },
  });
}

/// Deletes every session of a user EXCEPT the one with this id — "sign out everywhere else" (password
/// change, enabling two-step verification): the person keeps the session they are using.
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId, id: { not: keepSessionId } } });
}

/// Deletes every expired session (idle or absolute). Returns how many.
/// Intended for a scheduled nightly job — the job runner arrives with the
/// BullMQ infrastructure; until then this is callable and verified.
export async function purgeExpiredSessions(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { OR: [{ expires: { lt: now } }, { absoluteExpires: { lt: now } }] },
  });
  return count;
}

/// Reads the session cookie from an incoming request, hashes it, and looks up
/// the (session, user) pair — null if no cookie, no matching row, or expired.
export async function getSessionFromRequest(req: NextRequest): Promise<ResolvedSession | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  return token ? resolveToken(token) : null;
}

/// Same as getSessionFromRequest, for Server Components that only have the
/// cookies() API, not a NextRequest.
export async function getSession(): Promise<ResolvedSession | null> {
  const store = await nextCookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  return token ? resolveToken(token) : null;
}

async function resolveToken(token: string): Promise<ResolvedSession | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!session) return null;

  const now = new Date();
  if (session.expires <= now || session.absoluteExpires <= now) return null;

  // Slide the idle expiry (never past the absolute cap), throttled. Best-
  // effort: a failed touch must never fail the request it rides along with —
  // e.g. the row deleted by a concurrent logout between the read and here.
  if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    const idleExpiry = new Date(
      Math.min(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000, session.absoluteExpires.getTime()),
    );
    await prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: now, expires: idleExpiry } })
      .catch(() => undefined);
  }

  return { sessionId: session.id, userId: session.userId, user: session.user };
}

/// `expires` null → a browser-session cookie (no Expires / Max-Age attribute): the
/// "not remembered" mode. The server-side cap in createSession bounds it anyway.
export function setSessionCookie(
  response: NextResponse,
  token: string,
  expires: Date | null,
): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    ...COOKIE_OPTIONS,
    ...(expires ? { expires } : {}),
  });
  return response;
}

/// Deletes the cookie with the EXACT attributes it was set with. A bare
/// `cookies.delete(name)` can silently fail to clear a `__Host-`/`__Secure-`
/// prefixed cookie in a real HTTPS deployment even though it appears to work
/// in dev against the unprefixed cookie — browsers reject a Set-Cookie that
/// clears a secure-prefixed cookie without the matching attributes. Verified
/// in a real browser over HTTPS, not just in dev (see the phase record).
export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
