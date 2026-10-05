import { ok } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { listSessions } from "@/lib/auth/session-devices";

// GET /api/v1/auth/sessions                                                              (plan §0.5.E)
// The caller's own unexpired sessions ("active devices"): never anyone else's, never a token.
export const GET = withAuth(async (_req, auth) => {
  return ok({ sessions: await listSessions(auth.userId, auth.sessionId) });
});
