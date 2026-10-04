import type { NextRequest, NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/api/envelope";
import {
  SESSION_COOKIE_NAME,
  createSession,
  deleteSessionByToken,
  setSessionCookie,
} from "@/lib/auth/session";

/// The ONE place a person becomes signed in. Used by sign-in step 1 (no second factor on the account) and
/// by step 2 (`/login/mfa`, after the second factor) — so the two can't drift apart, and nothing else may
/// call createSession on the strength of a password alone.
///
/// Rotates first (a session the browser already presented is deleted before the new one exists, never left
/// valid alongside it), gives an ADMIN anywhere the shorter absolute lifetime, and honours `remember`
/// ("Keep me signed in": a persistent cookie and the long policy; otherwise a browser-session cookie and a
/// 12-hour server-side cap).
export async function completeSignIn(
  req: NextRequest,
  user: { id: string; name: string | null; email: string | null },
  remember: boolean,
  extra: Record<string, unknown> = {},
): Promise<NextResponse> {
  const presentedToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (presentedToken) await deleteSessionByToken(presentedToken);

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

  const response = ok({ user: { id: user.id, name: user.name, email: user.email }, ...extra });
  return setSessionCookie(response, token, persistent ? expires : null);
}
