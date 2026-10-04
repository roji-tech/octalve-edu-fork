import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { base32Encode } from "./base32";
import { generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode } from "./recovery-codes";
import { decryptSecret, encryptSecret } from "./secret-box";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp";

// Two-step verification for one person (domain-implementation-plan.md §0.5.D): enrol, confirm, verify a
// second factor, replace recovery codes, turn off. Routes own the HTTP, rate limits and re-authentication;
// this owns the data — and every "use it once" rule is a conditional UPDATE whose row count decides, never a
// read followed by a write, so two simultaneous requests can't both succeed.

export type SecondFactor = { code: string } | { recoveryCode: string };

/// An active factor: confirmed. (An unconfirmed credential is an enrolment in progress and is invisible
/// to sign-in.)
export async function hasActiveMfa(userId: string): Promise<boolean> {
  const row = await prisma.mfaCredential.findFirst({
    where: { userId, confirmedAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

export async function unusedRecoveryCodeCount(userId: string): Promise<number> {
  return prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
}

export type MfaStatus = { enabled: boolean; recoveryCodesRemaining: number };

export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const enabled = await hasActiveMfa(userId);
  return { enabled, recoveryCodesRemaining: enabled ? await unusedRecoveryCodeCount(userId) : 0 };
}

/// Starts (or restarts) an enrolment: a fresh secret, stored encrypted and UNCONFIRMED, returned once as
/// the manual-entry key plus the otpauth:// URL the page turns into a QR code. Starting again replaces an
/// earlier unconfirmed secret. Returns null if a confirmed credential already exists (turn it off first).
/// Throws MfaUnavailableError without a key.
export async function beginEnrolment(
  userId: string,
  opts: { issuer: string; account: string },
): Promise<{ secret: string; otpauthUrl: string } | null> {
  const secret = generateTotpSecret();
  const secretEnc = encryptSecret(secret, userId);
  try {
    await prisma.$transaction([
      prisma.mfaCredential.deleteMany({ where: { userId, confirmedAt: null } }),
      prisma.mfaCredential.create({ data: { userId, secretEnc } }),
    ]);
  } catch (error) {
    // The unique index on userId: a CONFIRMED credential survived the delete above.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
  return { secret: base32Encode(secret), otpauthUrl: otpauthUrl({ ...opts, secret }) };
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "not-enrolling" | "invalid-code" };

/// Finishes an enrolment: the person proves they can produce a code from the secret they were shown.
/// On success the credential becomes active (recording the step the code was for, so it can't be used
/// again at sign-in) and ten recovery codes are issued — returned here, once, and never readable again.
export async function confirmEnrolment(userId: string, code: string): Promise<ConfirmResult> {
  const credential = await prisma.mfaCredential.findFirst({ where: { userId, confirmedAt: null } });
  if (!credential) return { ok: false, reason: "not-enrolling" };

  const step = verifyTotp(decryptSecret(credential.secretEnc, userId), code);
  if (step === null) return { ok: false, reason: "invalid-code" };

  const recoveryCodes = generateRecoveryCodes();
  const won = await prisma.$transaction(async (tx) => {
    // Conditional on "still unconfirmed": of two simultaneous confirms, exactly one proceeds.
    const claimed = await tx.mfaCredential.updateMany({
      where: { id: credential.id, confirmedAt: null },
      data: { confirmedAt: new Date(), lastUsedStep: step },
    });
    if (claimed.count !== 1) return false;
    await replaceRecoveryCodes(tx, userId, recoveryCodes);
    return true;
  });
  return won ? { ok: true, recoveryCodes } : { ok: false, reason: "not-enrolling" };
}

/// Checks a code from the authenticator for a person with an ACTIVE credential. A step at or below the
/// last accepted one is refused (replay), and the step is recorded with a conditional update — so two
/// simultaneous submissions of one code, one of which could pass a plain read-then-write check, cannot
/// both succeed. Throws MfaUnavailableError without a key.
export async function verifyTotpForUser(userId: string, code: string): Promise<boolean> {
  const credential = await prisma.mfaCredential.findFirst({ where: { userId, confirmedAt: { not: null } } });
  if (!credential) return false;

  const step = verifyTotp(decryptSecret(credential.secretEnc, userId), code, {
    afterStep: credential.lastUsedStep,
  });
  if (step === null) return false;

  const claimed = await prisma.mfaCredential.updateMany({
    where: { id: credential.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
    data: { lastUsedStep: step },
  });
  return claimed.count === 1;
}

/// Spends a recovery code: true exactly once per code (a conditional update on `usedAt` null).
export async function spendRecoveryCode(userId: string, code: string): Promise<boolean> {
  const normalised = normaliseRecoveryCode(code);
  if (!normalised) return false;
  const claimed = await prisma.mfaRecoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(normalised), usedAt: null },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1;
}

/// Verifies whichever second factor was given; says which one it was.
export async function verifySecondFactor(
  userId: string,
  factor: SecondFactor,
): Promise<"totp" | "recovery" | null> {
  if ("code" in factor) return (await verifyTotpForUser(userId, factor.code)) ? "totp" : null;
  return (await spendRecoveryCode(userId, factor.recoveryCode)) ? "recovery" : null;
}

type Tx = Prisma.TransactionClient;

async function replaceRecoveryCodes(tx: Tx, userId: string, codes: string[]): Promise<void> {
  await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
  await tx.mfaRecoveryCode.createMany({
    data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(normaliseRecoveryCode(code)!) })),
  });
}

/// Replaces ALL of a person's recovery codes (used or not) with a fresh set, returned once.
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await prisma.$transaction((tx) => replaceRecoveryCodes(tx, userId, codes));
  return codes;
}

/// Turns two-step verification off: the credential, every recovery code and every pending challenge.
export async function disableMfa(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.mfaChallenge.deleteMany({ where: { userId } }),
    prisma.mfaCredential.deleteMany({ where: { userId } }),
  ]);
}
