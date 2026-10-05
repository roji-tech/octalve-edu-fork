import { after } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { auditPersonEvent } from "@/lib/auth/audit";
import { revokeOwnSession } from "@/lib/auth/session-devices";

// POST /api/v1/auth/sessions/revoke  { sessionId }                                       (plan §0.5.E)
// Ends one of the caller's OWN other sessions. The current session is refused (that is signing out), and a
// session that is not theirs answers exactly like one that doesn't exist — ids can't be probed.
const LIMIT = 30; // per account per 5 minutes

const schema = z.object({ sessionId: z.string().min(1).max(64) });

export const POST = withAuth(async (req, auth) => {
  if (!(await reserveAttempt(`sessions:revoke:${auth.userId}`, LIMIT))) {
    return fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail("That session no longer exists.", 404, "NOT_FOUND");
  const { sessionId } = parsed.data;

  if (sessionId === auth.sessionId) return fail("Use Sign out to end the session you are using.", 400, "CURRENT_SESSION");
  const revoked = await revokeOwnSession(auth.userId, sessionId);
  if (!revoked) return fail("That session no longer exists.", 404, "NOT_FOUND");

  after(async () => {
    try {
      await auditPersonEvent(auth.userId, "SESSION_REVOKED", { after: { device: revoked.device } });
    } catch (error) {
      console.error("[sessions/revoke] audit failed:", error instanceof Error ? error.message : error);
    }
  });
  return ok({ revoked: true, device: revoked.device });
});
