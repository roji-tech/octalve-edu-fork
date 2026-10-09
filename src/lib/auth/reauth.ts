import { prisma } from "@/lib/db";
import { PASSWORD_MAX_LENGTH, verifyPassword } from "@/lib/auth/password";
import { refundAttempt, reserveAttempt } from "@/lib/auth/rate-limit";
import { fail } from "@/lib/api/envelope";

// "Prove it is you" for a consequential action (plan, "closing a session takes time"): the signed-in person re-types their own password.
// Verified in constant time against their stored hash, with FAILURES rate-limited per account (a success is refunded) — a stolen session alone
// must not be enough to force-close a school year, exactly as it is not enough to change a password. The password is never logged or audited.
const FAILURES_PER_WINDOW = 5;

export type PasswordProof = "ok" | "wrong" | "limited";

export async function proveOwnPassword(userId: string, password: unknown): Promise<PasswordProof> {
  const key = `reauth:user:${userId}`;
  if (!(await reserveAttempt(key, FAILURES_PER_WINDOW))) return "limited";
  const typed = typeof password === "string" && password.length > 0 && password.length <= PASSWORD_MAX_LENGTH ? password : null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  // verifyPassword runs even when nothing usable was typed, so the time taken does not say which it was
  const matches = await verifyPassword(typed ?? "", user?.passwordHash ?? null);
  if (typed && matches) {
    await refundAttempt(key);
    return "ok";
  }
  return "wrong";
}

/// The response for a refused proof, in the shape the dialogs read (a field error on `body.password`).
export function passwordProofFailure(proof: Exclude<PasswordProof, "ok">): Response {
  return proof === "limited"
    ? fail("Too many attempts. Please try again in a few minutes.", 429, "RATE_LIMITED")
    : fail("That password isn't right.", 403, "WRONG_PASSWORD", [{ path: "body.password", message: "That password isn't right." }]);
}
