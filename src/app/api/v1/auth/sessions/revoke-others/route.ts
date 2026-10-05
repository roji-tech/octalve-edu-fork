import { after } from "next/server";
import { ok, fail } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { auditPersonEvent } from "@/lib/auth/audit";
import { revokeAllOtherSessions } from "@/lib/auth/session-devices";

// POST /api/v1/auth/sessions/revoke-others                                               (plan §0.5.E)
// "Sign out of every other device": ends all of the caller's sessions except the one in use. It can only ever
// REDUCE access (and the person can always sign in again), so it needs no password.
const LIMIT = 10; // per account per 5 minutes

export const POST = withAuth(async (_req, auth) => {
  if (!(await reserveAttempt(`sessions:revoke-others:${auth.userId}`, LIMIT))) {
    return fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }
  const count = await revokeAllOtherSessions(auth.userId, auth.sessionId);
  if (count > 0) {
    after(async () => {
      try {
        await auditPersonEvent(auth.userId, "SESSIONS_REVOKED", { after: { count } });
      } catch (error) {
        console.error("[sessions/revoke-others] audit failed:", error instanceof Error ? error.message : error);
      }
    });
  }
  return ok({ revoked: count });
});
