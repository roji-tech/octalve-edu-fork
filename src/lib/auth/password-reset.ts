import crypto from "node:crypto";
import { prisma } from "@/lib/db";

// Single-use, short-lived password-reset tokens (domain-implementation-plan.md §0.5.C).
// Only the SHA-256 hash is stored; the plaintext exists only in the emailed link.

import { RESET_LINK_MINUTES } from "@/lib/auth/reset-constants";

export const RESET_TOKEN_TTL_MS = RESET_LINK_MINUTES * 60 * 1000;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/// A new link for `userId`. Any earlier ones (used, expired or still live) are deleted first: one live
/// link per person, and the table stays bounded without a scheduled job.
export async function createResetToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url"); // 256-bit, server-generated
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.create({
      data: { tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
    }),
  ]);
  return token;
}

/// Cheap pre-check (no bcrypt yet): is this a live, unused token? Garbage never reaches the hasher.
export async function isLiveResetToken(token: string): Promise<boolean> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  return Boolean(row && !row.usedAt && row.expiresAt > new Date());
}

/// Claims the token and sets the new password in ONE transaction. The claim is a conditional update
/// (`usedAt` null and not expired) whose count must be exactly 1 — so a token is single-use even when
/// two requests present it at the same instant. Every session of that person is deleted (whoever knew
/// the old password, or had a stolen session, is out), and their other links are dropped.
/// Returns the user id, or null for an unknown / used / expired token — callers treat all three alike.
export async function resetPasswordWithToken(
  token: string,
  newPasswordHash: string,
): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(token);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return null;

    const row = await tx.passwordResetToken.findUniqueOrThrow({ where: { tokenHash } });
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash: newPasswordHash } });
    await tx.session.deleteMany({ where: { userId: row.userId } });
    // A pending sign-in challenge is proof of the OLD password — it must not outlive it. (The second FACTOR
    // itself is untouched: a reset never switches two-step verification off.)
    await tx.mfaChallenge.deleteMany({ where: { userId: row.userId } });
    await tx.passwordResetToken.deleteMany({ where: { userId: row.userId, id: { not: row.id } } });
    return { userId: row.userId };
  });
}
