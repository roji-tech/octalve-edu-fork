import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { getClientIp, reserveAttempt } from "@/lib/auth/rate-limit";
import { getSessionFromRequest } from "@/lib/auth/session";
import { previewInvitation } from "@/lib/invitations/service";
import { isInvitationToken } from "@/lib/invitations/token";
import { ROLE_LABELS } from "@/lib/roles";

// POST /api/v1/invitations/preview  { token }                                              (plan §0.5.4)
// What the accept page shows before anyone commits: the school, the role, a MASKED address, whether that address already has an
// account (which decides "choose a password" or "sign in"), and whether the person is signed in as it. PUBLIC — the token is the
// credential — so it is CSRF-checked and limited per IP, and unknown, malformed, used, revoked and expired links are ONE 400.
const IP_LIMIT = 40;
const INVALID_LINK = "This invitation link is invalid or has expired. Ask your administrator to send a new one.";
const schema = z.object({ token: z.string().max(200) });

export async function POST(req: NextRequest) {
  return noStore(await handle(req));
}

async function handle(req: NextRequest) {
  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");
  if (!(await reserveAttempt(`invite:preview:ip:${getClientIp(req)}`, IP_LIMIT))) {
    return fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success || !isInvitationToken(parsed.data.token)) return fail(INVALID_LINK, 400, "INVALID_TOKEN");

  const session = await getSessionFromRequest(req);
  const preview = await previewInvitation(parsed.data.token, session?.userId ?? null);
  if (!preview) return fail(INVALID_LINK, 400, "INVALID_TOKEN");
  return ok({ schoolName: preview.schoolName, role: preview.role, roleLabel: ROLE_LABELS[preview.role], email: preview.maskedEmail, accountExists: preview.accountExists, viewer: preview.viewer });
}
