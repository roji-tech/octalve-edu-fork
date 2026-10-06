import type { NextRequest } from "next/server";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { deleteSessionByToken, clearSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/session";

/**
 * POST /api/v1/auth/logout
 * Deletes the Session row (matched by hash), not just the cookie — a session
 * is over when its row is gone, which is the whole point of database
 * sessions. Idempotent: logging out with no/unknown cookie still returns 200
 * and still clears the cookie, so a stale tab can always reach a clean state.
 */
export async function POST(req: NextRequest) {
  if (!validateCSRF(req)) {
    return noStore(fail("Cross-origin request blocked", 403, "CSRF"));
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) await deleteSessionByToken(token);

  // Cleared with the exact attributes it was set with (see clearSessionCookie).
  return noStore(clearSessionCookie(ok({ loggedOut: true })));
}
