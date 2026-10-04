import "../support/env";
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { createUser, db, sha256Hex } from "../support/db";
import { createSession } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createResetToken, isLiveResetToken, resetPasswordWithToken, RESET_TOKEN_TTL_MS } from "@/lib/auth/password-reset";

test.describe("createResetToken", () => {
  test("only the SHA-256 hash is stored — the plaintext is nowhere in the database", async () => {
    const user = await createUser();
    const token = await createResetToken(user.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    const rows = await db.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256Hex(token));
    const hits = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "PasswordResetToken" t WHERE t::text LIKE ${"%" + token + "%"}`;
    expect(hits[0].n).toBe(0);
  });

  test("expires in 30 minutes", async () => {
    const user = await createUser();
    await createResetToken(user.id);
    const row = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(Math.abs(row.expiresAt.getTime() - (Date.now() + RESET_TOKEN_TTL_MS))).toBeLessThan(60_000);
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60_000);
  });

  test("one live link per person: asking again kills the earlier one; other people's are untouched", async () => {
    const a = await createUser();
    const b = await createUser();
    const first = await createResetToken(a.id);
    const bToken = await createResetToken(b.id);
    const second = await createResetToken(a.id);
    expect(await isLiveResetToken(first)).toBe(false);
    expect(await isLiveResetToken(second)).toBe(true);
    expect(await isLiveResetToken(bToken)).toBe(true);
    expect(await db.passwordResetToken.count({ where: { userId: a.id } })).toBe(1);
  });
});

test.describe("resetPasswordWithToken", () => {
  test("sets the new password, deletes ALL the person's sessions and spares everyone else's", async () => {
    const user = await createUser();
    const other = await createUser();
    await createSession(user.id);
    await createSession(user.id);
    const bystander = await createSession(other.id);
    const token = await createResetToken(user.id);

    const result = await resetPasswordWithToken(token, await hashPassword("brand-new-pass-1"));
    expect(result).toEqual({ userId: user.id });
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("brand-new-pass-1", row.passwordHash)).toBe(true);
    expect(await verifyPassword(user.password, row.passwordHash)).toBe(false);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.session.count({ where: { tokenHash: sha256Hex(bystander.token) } })).toBe(1);
  });

  test("single use: the same link a second time is refused and changes nothing", async () => {
    const user = await createUser();
    const token = await createResetToken(user.id);
    expect(await resetPasswordWithToken(token, await hashPassword("first-pass-111"))).not.toBeNull();
    expect(await resetPasswordWithToken(token, await hashPassword("second-pass-222"))).toBeNull();
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("first-pass-111", row.passwordHash)).toBe(true);
  });

  test("an expired link is refused", async () => {
    const user = await createUser();
    const token = await createResetToken(user.id);
    await db.passwordResetToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await isLiveResetToken(token)).toBe(false);
    expect(await resetPasswordWithToken(token, await hashPassword("whatever-123"))).toBeNull();
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(user.password, row.passwordHash)).toBe(true); // unchanged
  });

  test("unknown and malformed tokens are refused", async () => {
    for (const token of ["", "x", crypto.randomBytes(32).toString("base64url"), "' OR '1'='1", "a".repeat(5000)]) {
      expect(await resetPasswordWithToken(token, "irrelevant"), token.slice(0, 20)).toBeNull();
    }
  });

  test("20 simultaneous attempts with one link: exactly ONE wins", async () => {
    const user = await createUser();
    const token = await createResetToken(user.id);
    const hashes = await Promise.all(Array.from({ length: 20 }, (_, i) => hashPassword(`racer-pass-${i}-x`)));
    const results = await Promise.all(hashes.map((h) => resetPasswordWithToken(token, h)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(hashes).toContain(row.passwordHash); // and the winner's password is the one that stuck
  });

  test("deleting the person deletes their links (cascade)", async () => {
    const user = await createUser();
    const token = await createResetToken(user.id);
    await db.user.delete({ where: { id: user.id } });
    expect(await isLiveResetToken(token)).toBe(false);
  });
});
