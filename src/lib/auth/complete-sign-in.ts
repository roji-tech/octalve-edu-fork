import { after, type NextRequest, type NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { forUser } from "@/lib/tenant/for-tenant";
import { auditPersonEvent } from "@/lib/auth/audit";
import { describeUserAgent } from "@/lib/auth/user-agent";
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

  // Read through the user context: a person's own memberships are visible before any tenant is known (§0.5.2).
  const holdsAdmin = Boolean(
    await forUser(user.id).transaction((tx) =>
      tx.tenantMembership.findFirst({ where: { userId: user.id, role: Role.ADMIN, deactivatedAt: null }, select: { id: true } }),
    ),
  );
  const { token, expires, persistent } = await createSession(user.id, req.headers.get("user-agent"), {
    admin: holdsAdmin,
    remember,
  });

  // The sign-in is on the person's audit trail (one row per school): WHEN and from what KIND of device — never an IP
  // address (none is stored anywhere). Written after the response, so it costs the person nothing and its failure
  // can never fail a sign-in.
  const device = describeUserAgent(req.headers.get("user-agent"));
  after(async () => {
    try {
      await auditPersonEvent(user.id, "LOGIN_SUCCEEDED", { after: { device, remembered: remember } });
    } catch (error) {
      console.error("[sign-in] audit failed:", error instanceof Error ? error.message : error);
    }
  });

  const response = ok({ user: { id: user.id, name: user.name, email: user.email }, ...extra });
  return setSessionCookie(response, token, persistent ? expires : null);
}
