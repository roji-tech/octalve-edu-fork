import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

// Change email with confirmation (domain-implementation-plan.md §0.5.E). The link goes to the NEW address, so
// following it proves that address is reachable. Same discipline as the password-reset links: only a SHA-256 hash
// is stored, a link works once (a conditional update decides, so two simultaneous clicks can't both win) and for
// a short time, and a person has one live request at a time.

export const EMAIL_CHANGE_LINK_MINUTES = 60;
export const EMAIL_CHANGE_TTL_MS = EMAIL_CHANGE_LINK_MINUTES * 60 * 1000;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/// A new request for `userId` to switch to `newEmail` (already lower-cased); returns the plaintext token for the
/// link. Any earlier request of theirs — used, expired or still live — is deleted first.
export async function createEmailChangeToken(userId: string, newEmail: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url"); // 256-bit, server-generated
  await prisma.$transaction([
    prisma.emailChangeToken.deleteMany({ where: { userId } }),
    prisma.emailChangeToken.create({
      data: { tokenHash: hashToken(token), userId, newEmail, expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) },
    }),
  ]);
  return token;
}

export type EmailChange = { userId: string; oldEmail: string | null; newEmail: string };

/// Claims the link and switches the address, in ONE transaction. The claim is a conditional update (`usedAt` null
/// and not expired) whose count must be exactly 1. Because the email is the recovery channel, everything that
/// was issued for the OLD one dies with it: every session of the person, their pending password-reset links and
/// sign-in challenges, and any other email-change request. Returns null for an unknown / used / expired link —
/// and also when the new address was taken in the meantime (the unique index refuses it and the whole
/// transaction rolls back, nothing changes) — callers treat all of them alike.
export async function confirmEmailChange(token: string): Promise<EmailChange | null> {
  const tokenHash = hashToken(token);
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.emailChangeToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return null;

      const row = await tx.emailChangeToken.findUniqueOrThrow({ where: { tokenHash } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: row.userId }, select: { email: true } });
      await tx.user.update({ where: { id: row.userId }, data: { email: row.newEmail, emailVerified: now } });
      await tx.session.deleteMany({ where: { userId: row.userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId: row.userId } });
      await tx.mfaChallenge.deleteMany({ where: { userId: row.userId } });
      await tx.emailChangeToken.deleteMany({ where: { userId: row.userId, id: { not: row.id } } });
      return { userId: row.userId, oldEmail: user.email, newEmail: row.newEmail };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null; // address taken
    throw error;
  }
}
