import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { getClientIp, refundAttempt, reserveAttempt } from "@/lib/auth/rate-limit";
import { hashPassword } from "@/lib/auth/password";
import { checkNewPasswordOnServer } from "@/lib/auth/pwned-password";
import { checkName } from "@/lib/auth/profile-policy";
import { getSessionFromRequest } from "@/lib/auth/session";
import { acceptInvitation, previewInvitation } from "@/lib/invitations/service";
import { isInvitationToken } from "@/lib/invitations/token";

// POST /api/v1/invitations/accept  { token, name?, password? }                             (plan §0.5.4)
// Three cases, one rule — an EXISTING account is attached only by its owner:
//   · no account for the address        → { name, password } creates it (address verified by the link), then the membership.
//                                         It does NOT sign the person in: a link in a mailbox is not a session (as for a reset).
//   · signed in as the invited account  → the membership is created; nothing else is needed.
//   · an account exists, nobody signed in → 409 SIGN_IN_REQUIRED (the password is not even looked at);
//     signed in as someone else          → 403 WRONG_ACCOUNT.
// Unknown, malformed, used, revoked and expired links are ONE 400. A refused password is explained BEFORE the link is spent, and
// the whole acceptance is one transaction (lib/invitations/service.ts): a failure leaves no user, no membership, an unspent link.
const IP_LIMIT = 10; // failures per IP; a success is refunded
const INVALID_LINK = "This invitation link is invalid or has expired. Ask your administrator to send a new one.";

const schema = z.object({
  token: z.string().max(200),
  name: z.string().max(1000).optional(), // size bounds only; the real rules are checkName / checkNewPasswordOnServer
  password: z.string().max(1024).optional(),
});

export async function POST(req: NextRequest) {
  return noStore(await handle(req));
}

async function handle(req: NextRequest) {
  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");

  const ipKey = `invite:accept:ip:${getClientIp(req)}`;
  if (!(await reserveAttempt(ipKey, IP_LIMIT))) return fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success || !isInvitationToken(parsed.data.token)) return fail(INVALID_LINK, 400, "INVALID_TOKEN");
  const { token, name, password } = parsed.data;

  const session = await getSessionFromRequest(req);
  const viewerUserId = session?.userId ?? null;

  // What does this link need? (Also the cheap pre-check: garbage never reaches the password hasher.)
  const preview = await previewInvitation(token, viewerUserId);
  if (!preview) return fail(INVALID_LINK, 400, "INVALID_TOKEN");

  let newAccount: { name: string; passwordHash: string } | undefined;
  if (!viewerUserId) {
    if (preview.accountExists) {
      await refundAttempt(ipKey); // asking to sign in is not an attack
      return fail("An account already exists for this address. Sign in to accept the invitation.", 409, "SIGN_IN_REQUIRED");
    }
    // A new account: explain a refused name or password BEFORE spending the link, so the person can fix it and retry.
    const checkedName = checkName(name ?? "");
    const details = [];
    if (!checkedName.ok) details.push({ path: "body.name", message: checkedName.message });
    const problem = password ? await checkNewPasswordOnServer(password) : "Choose a password.";
    if (problem) details.push({ path: "body.password", message: problem });
    if (details.length > 0 || !checkedName.ok) {
      await refundAttempt(ipKey); // a typo isn't an attack
      return fail("Some of the fields are not valid.", 400, "VALIDATION", details);
    }
    newAccount = { name: checkedName.name, passwordHash: await hashPassword(password!) };
  } else if (preview.viewer === "other") {
    await refundAttempt(ipKey);
    return fail("This invitation is for a different email address than the account you're signed in with. Sign out, then open the link again.", 403, "WRONG_ACCOUNT");
  }

  const result = await acceptInvitation({ token, viewerUserId, newAccount });
  if (!result.ok) {
    switch (result.reason) {
      case "SIGN_IN_REQUIRED":
        await refundAttempt(ipKey);
        return fail("An account already exists for this address. Sign in to accept the invitation.", 409, "SIGN_IN_REQUIRED");
      case "WRONG_ACCOUNT":
        await refundAttempt(ipKey);
        return fail("This invitation is for a different email address than the account you're signed in with. Sign out, then open the link again.", 403, "WRONG_ACCOUNT");
      case "ALREADY_MEMBER":
        await refundAttempt(ipKey);
        return fail("You're already a member of that school.", 409, "ALREADY_MEMBER");
      case "INPUT_REQUIRED":
        await refundAttempt(ipKey);
        return fail("Some of the fields are not valid.", 400, "VALIDATION");
      case "INVALID":
        return fail(INVALID_LINK, 400, "INVALID_TOKEN"); // a lost race for the same link
    }
  }

  await refundAttempt(ipKey);
  return ok({ accepted: true, schoolCode: result.schoolCode, newAccount: result.newAccount });
}
