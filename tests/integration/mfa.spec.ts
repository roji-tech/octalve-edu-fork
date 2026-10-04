import "../support/env";
import { TEST_MFA_KEY } from "../support/env";
import { test, expect } from "@playwright/test";
import { codeFor, createUser, db, enableMfa, rewindMfa, sha256Hex } from "../support/db";
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_MS,
  consumeChallenge,
  createChallenge,
  deleteUserChallenges,
  spendChallengeAttempt,
} from "@/lib/auth/mfa/challenge";
import {
  beginEnrolment,
  confirmEnrolment,
  disableMfa,
  getMfaStatus,
  hasActiveMfa,
  regenerateRecoveryCodes,
  spendRecoveryCode,
  verifyTotpForUser,
} from "@/lib/auth/mfa/service";
import { MfaUnavailableError, decryptSecret } from "@/lib/auth/mfa/secret-box";
import { base32Decode } from "@/lib/auth/mfa/base32";
import { createResetToken, resetPasswordWithToken } from "@/lib/auth/password-reset";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";

const ISSUER = { issuer: "Octalve Edu", account: "someone@test.example" };

test.describe("sign-in challenge (the pending-MFA state)", () => {
  test("stores only the hash; creates NO session; carries the remember choice", async () => {
    const user = await createUser();
    const token = await createChallenge(user.id, true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url

    const rows = await db.mfaChallenge.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256Hex(token));
    expect(rows[0].remember).toBe(true);
    expect(rows[0].attempts).toBe(0);
    expect(Math.abs(rows[0].expiresAt.getTime() - (Date.now() + CHALLENGE_TTL_MS))).toBeLessThan(60_000);
    expect(CHALLENGE_TTL_MS).toBe(5 * 60_000);

    const hits = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "MfaChallenge" c WHERE c::text LIKE ${"%" + token + "%"}`;
    expect(hits[0].n).toBe(0);
    // The whole point: a pending challenge is not a session.
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  test("each attempt is spent atomically, and after five the challenge is dead", async () => {
    const user = await createUser();
    const token = await createChallenge(user.id, false);
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i++) {
      expect(await spendChallengeAttempt(token)).toEqual({ userId: user.id, remember: false });
    }
    expect(await spendChallengeAttempt(token)).toBeNull();
    expect(CHALLENGE_MAX_ATTEMPTS).toBe(5);
  });

  test("twenty simultaneous guesses spend exactly five attempts, not twenty", async () => {
    const user = await createUser();
    const token = await createChallenge(user.id, false);
    const results = await Promise.all(Array.from({ length: 20 }, () => spendChallengeAttempt(token)));
    expect(results.filter(Boolean)).toHaveLength(CHALLENGE_MAX_ATTEMPTS);
  });

  test("expired, unknown and garbage tokens all give the same null", async () => {
    const user = await createUser();
    const token = await createChallenge(user.id, false);
    await db.mfaChallenge.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await spendChallengeAttempt(token)).toBeNull();
    expect(await spendChallengeAttempt("x".repeat(43))).toBeNull();
    expect(await spendChallengeAttempt("")).toBeNull();
  });

  test("single use: of simultaneous consumers exactly one wins", async () => {
    const user = await createUser();
    const token = await createChallenge(user.id, false);
    const wins = await Promise.all(Array.from({ length: 10 }, () => consumeChallenge(token)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await spendChallengeAttempt(token)).toBeNull(); // gone
  });

  test("bounded growth: a person keeps at most five live challenges, and their own dead ones are swept", async () => {
    const user = await createUser();
    const other = await createUser();
    const otherToken = await createChallenge(other.id, false);
    const tokens: string[] = [];
    for (let i = 0; i < 8; i++) tokens.push(await createChallenge(user.id, false));
    expect(await db.mfaChallenge.count({ where: { userId: user.id } })).toBe(5);
    expect(await spendChallengeAttempt(tokens[0])).toBeNull(); // the oldest were evicted
    expect(await spendChallengeAttempt(tokens[7])).not.toBeNull();
    expect(await spendChallengeAttempt(otherToken)).not.toBeNull(); // someone else's is untouched

    await db.mfaChallenge.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await createChallenge(user.id, false);
    expect(await db.mfaChallenge.count({ where: { userId: user.id } })).toBe(1);
  });

  test("deleteUserChallenges kills a person's pending challenges only", async () => {
    const a = await createUser();
    const b = await createUser();
    const ta = await createChallenge(a.id, false);
    const tb = await createChallenge(b.id, false);
    await deleteUserChallenges(a.id);
    expect(await spendChallengeAttempt(ta)).toBeNull();
    expect(await spendChallengeAttempt(tb)).not.toBeNull();
  });
});

test.describe("enrolment", () => {
  test("the secret is stored ENCRYPTED and unconfirmed — and an unconfirmed credential is not an active factor", async () => {
    const user = await createUser();
    const started = await beginEnrolment(user.id, ISSUER);
    expect(started).not.toBeNull();
    expect(started!.secret).toMatch(/^[A-Z2-7]{32}$/); // 160 bits of base32
    expect(started!.otpauthUrl).toContain(`secret=${started!.secret}`);

    const row = await db.mfaCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.confirmedAt).toBeNull();
    expect(row.secretEnc).toMatch(/^v1\./);
    expect(row.secretEnc).not.toContain(started!.secret);
    const plaintext = decryptSecret(row.secretEnc, user.id);
    expect(plaintext.equals(base32Decode(started!.secret)!)).toBe(true);
    // The secret is nowhere in the table in any readable form.
    const hits = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "MfaCredential" c WHERE c::text LIKE ${"%" + started!.secret + "%"}`;
    expect(hits[0].n).toBe(0);

    expect(await hasActiveMfa(user.id)).toBe(false);
    expect(await getMfaStatus(user.id)).toEqual({ enabled: false, recoveryCodesRemaining: 0 });
  });

  test("starting again replaces an unconfirmed secret; the old one can no longer be confirmed", async () => {
    const user = await createUser();
    const first = await beginEnrolment(user.id, ISSUER);
    const second = await beginEnrolment(user.id, ISSUER);
    expect(second!.secret).not.toBe(first!.secret);
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(1);
    const staleCode = codeFor(base32Decode(first!.secret)!);
    expect(await confirmEnrolment(user.id, staleCode)).toEqual({ ok: false, reason: "invalid-code" });
    expect((await confirmEnrolment(user.id, codeFor(base32Decode(second!.secret)!))).ok).toBe(true);
  });

  test("a wrong or malformed code does not confirm; confirming with nothing started says so", async () => {
    const user = await createUser();
    expect(await confirmEnrolment(user.id, "123456")).toEqual({ ok: false, reason: "not-enrolling" });
    const started = await beginEnrolment(user.id, ISSUER);
    const right = codeFor(base32Decode(started!.secret)!);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect(await confirmEnrolment(user.id, wrong)).toEqual({ ok: false, reason: "invalid-code" });
    expect(await confirmEnrolment(user.id, "abc")).toEqual({ ok: false, reason: "invalid-code" });
    expect(await hasActiveMfa(user.id)).toBe(false);
  });

  test("confirming activates it, issues ten recovery codes (hashed), and records the step so the code can't be replayed", async () => {
    const user = await createUser();
    const started = await beginEnrolment(user.id, ISSUER);
    const secret = base32Decode(started!.secret)!;
    const result = await confirmEnrolment(user.id, codeFor(secret));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);
    expect(await hasActiveMfa(user.id)).toBe(true);
    expect(await getMfaStatus(user.id)).toEqual({ enabled: true, recoveryCodesRemaining: 10 });

    const cred = await db.mfaCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(cred.confirmedAt).not.toBeNull();
    expect(cred.lastUsedStep).not.toBeNull();

    // No recovery code is stored in the clear.
    const rows = await db.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(10);
    for (const code of result.recoveryCodes) {
      const bare = code.replace("-", "");
      for (const row of rows) {
        expect(row.codeHash).not.toContain(bare);
        expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    // The code that confirmed it cannot also be used to sign in.
    expect(await verifyTotpForUser(user.id, codeFor(secret))).toBe(false);
    // Once it can be (time has moved on) the credential works.
    await rewindMfa(user.id);
    expect(await verifyTotpForUser(user.id, codeFor(secret))).toBe(true);
  });

  test("of simultaneous confirmations with the same code exactly one wins — and only one set of codes exists", async () => {
    const user = await createUser();
    const started = await beginEnrolment(user.id, ISSUER);
    const code = codeFor(base32Decode(started!.secret)!);
    const results = await Promise.all(Array.from({ length: 8 }, () => confirmEnrolment(user.id, code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
  });

  test("it refuses to start while a confirmed credential exists, and leaves it intact", async () => {
    const user = await createUser();
    const mfa = await enableMfa(user.id);
    expect(await beginEnrolment(user.id, ISSUER)).toBeNull();
    expect(await hasActiveMfa(user.id)).toBe(true);
    expect(await verifyTotpForUser(user.id, codeFor(mfa.secret))).toBe(true);
  });
});

test.describe("verifying a code", () => {
  test("accepts the current code once; the same code, or an older one, is replay", async () => {
    const user = await createUser();
    const { secret } = await enableMfa(user.id);
    expect(await verifyTotpForUser(user.id, codeFor(secret))).toBe(true);
    expect(await verifyTotpForUser(user.id, codeFor(secret))).toBe(false); // same code again
    expect(await verifyTotpForUser(user.id, codeFor(secret, -1))).toBe(false); // an earlier step
  });

  test("a later step is accepted after an earlier one was used", async () => {
    const user = await createUser();
    const { secret } = await enableMfa(user.id);
    await db.mfaCredential.update({ where: { userId: user.id }, data: { lastUsedStep: Math.floor(Date.now() / 30000) - 3 } });
    expect(await verifyTotpForUser(user.id, codeFor(secret))).toBe(true);
    const cred = await db.mfaCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(cred.lastUsedStep).toBeGreaterThanOrEqual(Math.floor(Date.now() / 30000) - 1);
  });

  test("ten simultaneous submissions of ONE valid code: exactly one succeeds", async () => {
    const user = await createUser();
    const { secret } = await enableMfa(user.id);
    const code = codeFor(secret);
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyTotpForUser(user.id, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("wrong codes, codes from another person's secret, and codes two steps+ out are refused", async () => {
    const a = await createUser();
    const b = await createUser();
    const ma = await enableMfa(a.id);
    const mb = await enableMfa(b.id);
    expect(await verifyTotpForUser(a.id, codeFor(mb.secret))).toBe(false);
    expect(await verifyTotpForUser(a.id, codeFor(ma.secret, 3))).toBe(false);
    expect(await verifyTotpForUser(a.id, codeFor(ma.secret, -3))).toBe(false);
    expect(await verifyTotpForUser(a.id, "12345")).toBe(false);
  });

  test("an unconfirmed credential never verifies", async () => {
    const user = await createUser();
    const started = await beginEnrolment(user.id, ISSUER);
    expect(await verifyTotpForUser(user.id, codeFor(base32Decode(started!.secret)!))).toBe(false);
  });

  test("a person with no credential, and a box that doesn't belong to them, verify false / throw — never true", async () => {
    const a = await createUser();
    const b = await createUser();
    expect(await verifyTotpForUser(a.id, "123456")).toBe(false);
    // b's encrypted secret copied onto a's row: bound to b's id, so it must not decrypt for a.
    const mb = await enableMfa(b.id);
    const row = await db.mfaCredential.findUniqueOrThrow({ where: { userId: b.id } });
    await db.mfaCredential.create({ data: { userId: a.id, secretEnc: row.secretEnc, confirmedAt: new Date() } });
    await expect(verifyTotpForUser(a.id, codeFor(mb.secret))).rejects.toBeInstanceOf(MfaUnavailableError);
  });
});

test.describe("recovery codes", () => {
  test("each works exactly once, in any of the ways a person might type it", async () => {
    const user = await createUser();
    const { recoveryCodes } = await enableMfa(user.id);
    const [a, b, c] = recoveryCodes;
    expect(await spendRecoveryCode(user.id, a)).toBe(true);
    expect(await spendRecoveryCode(user.id, a)).toBe(false); // used
    expect(await spendRecoveryCode(user.id, b.toLowerCase())).toBe(true);
    expect(await spendRecoveryCode(user.id, c.replace("-", " "))).toBe(true);
    expect(await getMfaStatus(user.id)).toEqual({ enabled: true, recoveryCodesRemaining: 7 });
  });

  test("ten simultaneous uses of ONE code: exactly one succeeds", async () => {
    const user = await createUser();
    const { recoveryCodes } = await enableMfa(user.id);
    const results = await Promise.all(Array.from({ length: 10 }, () => spendRecoveryCode(user.id, recoveryCodes[0])));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("one person's code does not work for another; garbage never does", async () => {
    const a = await createUser();
    const b = await createUser();
    const ma = await enableMfa(a.id);
    await enableMfa(b.id);
    expect(await spendRecoveryCode(b.id, ma.recoveryCodes[0])).toBe(false);
    for (const bad of ["", "ABCDE-FGHJK", "short", "!!!!!-!!!!!"]) expect(await spendRecoveryCode(a.id, bad)).toBe(false);
  });

  test("regenerating replaces ALL codes: the old ones (used or not) die, the new ones work", async () => {
    const user = await createUser();
    const { recoveryCodes: old } = await enableMfa(user.id);
    await spendRecoveryCode(user.id, old[0]);
    const fresh = await regenerateRecoveryCodes(user.id);
    expect(fresh).toHaveLength(10);
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
    expect(await getMfaStatus(user.id)).toEqual({ enabled: true, recoveryCodesRemaining: 10 });
    for (const code of old) expect(await spendRecoveryCode(user.id, code)).toBe(false);
    expect(await spendRecoveryCode(user.id, fresh[0])).toBe(true);
  });
});

test.describe("turning it off, and its neighbours", () => {
  test("disableMfa removes the credential, every recovery code and every pending challenge — for that person only", async () => {
    const user = await createUser();
    const other = await createUser();
    await enableMfa(user.id);
    await enableMfa(other.id);
    await createChallenge(user.id, false);
    await disableMfa(user.id);
    expect(await hasActiveMfa(user.id)).toBe(false);
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.mfaChallenge.count({ where: { userId: user.id } })).toBe(0);
    expect(await hasActiveMfa(other.id)).toBe(true);
    expect(await db.mfaRecoveryCode.count({ where: { userId: other.id } })).toBe(10);
  });

  test("a password RESET never switches two-step verification off — but it kills pending challenges", async () => {
    const user = await createUser();
    await enableMfa(user.id);
    const challenge = await createChallenge(user.id, false);
    await createSession(user.id);
    const token = await createResetToken(user.id);
    expect(await resetPasswordWithToken(token, await hashPassword("brand-new-pass-1"))).toEqual({ userId: user.id });

    expect(await hasActiveMfa(user.id)).toBe(true);
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await spendChallengeAttempt(challenge)).toBeNull(); // proof of the OLD password is dead
  });

  test("deleting the person deletes their second factor with them", async () => {
    const user = await createUser();
    await enableMfa(user.id);
    await createChallenge(user.id, false);
    await db.user.delete({ where: { id: user.id } });
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.mfaChallenge.count({ where: { userId: user.id } })).toBe(0);
  });
});

test.describe("fails closed without a key", () => {
  test("enrolment, verification and recovery all refuse (MfaUnavailableError) — nothing silently succeeds", async () => {
    const user = await createUser();
    const { secret, recoveryCodes } = await enableMfa(user.id);
    delete process.env.MFA_ENCRYPTION_KEY;
    try {
      await expect(beginEnrolment(user.id, ISSUER)).rejects.toBeInstanceOf(MfaUnavailableError);
      await expect(verifyTotpForUser(user.id, codeFor(secret))).rejects.toBeInstanceOf(MfaUnavailableError);
      await expect(spendRecoveryCode(user.id, recoveryCodes[0])).rejects.toBeInstanceOf(MfaUnavailableError);
      await expect(regenerateRecoveryCodes(user.id)).rejects.toBeInstanceOf(MfaUnavailableError);
    } finally {
      process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;
    }
    // And nothing was spent by the refusals.
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: { not: null } } })).toBe(0);
    expect(await verifyTotpForUser(user.id, codeFor(secret))).toBe(true);
  });

  test("a different key cannot read the stored secret (so a leaked database alone is useless)", async () => {
    const user = await createUser();
    const { secret } = await enableMfa(user.id);
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    try {
      await expect(verifyTotpForUser(user.id, codeFor(secret))).rejects.toBeInstanceOf(MfaUnavailableError);
    } finally {
      process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;
    }
  });
});
