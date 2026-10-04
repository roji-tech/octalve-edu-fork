import crypto from "node:crypto";
import { prisma } from "@/lib/db";

// The "pending MFA" state between a correct password and a correct second factor
// (domain-implementation-plan.md §0.5.D). It is NOT a session: there is no cookie, and `withAuth`
// cannot see it — so a password alone can never open anything that needs a session.
//
// The token is 256 random bits, returned once in the JSON of sign-in step 1 and held in memory by the
// sign-in page; only its SHA-256 hash is stored. It lives five minutes, allows five attempts, and is
// consumed by the successful one.

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
/// One person can't pile up unbounded challenges by repeating step 1 (it needs the password each time,
/// but a correct password is refunded by the rate limiter).
const MAX_LIVE_CHALLENGES_PER_USER = 5;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/// A new challenge for `userId`; returns the plaintext token. `remember` is the "Keep me signed in"
/// choice made at step 1 — it travels with the challenge, so step 2 can't change it.
export async function createChallenge(userId: string, remember: boolean): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.mfaChallenge.deleteMany({ where: { userId, expiresAt: { lt: now } } });
    await tx.mfaChallenge.create({
      data: {
        tokenHash: hashToken(token),
        userId,
        remember,
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      },
    });
    const live = await tx.mfaChallenge.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const overflow = live.slice(MAX_LIVE_CHALLENGES_PER_USER);
    if (overflow.length > 0) {
      await tx.mfaChallenge.deleteMany({ where: { id: { in: overflow.map((c) => c.id) } } });
    }
  });
  return token;
}

/// Spends ONE attempt on the challenge, atomically (a conditional increment, so concurrent guesses
/// can't all slip under the limit), and returns whose challenge it is — or null if it is unknown,
/// expired, used up or out of attempts (callers treat all four alike). The attempt is spent BEFORE the
/// code is checked; a correct code then consumes the whole challenge.
export async function spendChallengeAttempt(
  token: string,
): Promise<{ userId: string; remember: boolean } | null> {
  const tokenHash = hashToken(token);
  const spent = await prisma.mfaChallenge.updateMany({
    where: { tokenHash, expiresAt: { gt: new Date() }, attempts: { lt: CHALLENGE_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (spent.count !== 1) return null;
  return prisma.mfaChallenge.findUnique({ where: { tokenHash }, select: { userId: true, remember: true } });
}

/// Consumes the challenge after a correct second factor. Exactly one caller gets `true` — two
/// simultaneous successes can't both turn one challenge into a session.
export async function consumeChallenge(token: string): Promise<boolean> {
  const { count } = await prisma.mfaChallenge.deleteMany({ where: { tokenHash: hashToken(token) } });
  return count === 1;
}

/// Kills every pending challenge of a person. Called when their password changes: a challenge is proof
/// of the OLD password and must not outlive it.
export async function deleteUserChallenges(userId: string): Promise<void> {
  await prisma.mfaChallenge.deleteMany({ where: { userId } });
}
