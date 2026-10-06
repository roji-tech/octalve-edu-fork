import "../support/env";
import { test, expect } from "@playwright/test";
import bcrypt from "bcryptjs";
import { BCRYPT_COST, PASSWORD_MAX_BYTES, hashPassword, verifyPassword } from "@/lib/auth/password";
import { passwordByteLength } from "@/lib/auth/password-policy";

test.describe("password hashing", () => {
  test("hashes with the production cost, salted, and verifies", async () => {
    const a = await hashPassword("correct-horse-battery-9");
    const b = await hashPassword("correct-horse-battery-9");
    expect(a).toMatch(new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`));
    expect(a).not.toBe(b); // per-hash salt
    expect(await verifyPassword("correct-horse-battery-9", a)).toBe(true);
    expect(await verifyPassword("correct-horse-battery-8", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  test("no hash (unknown user / invited account) verifies false but still does the work", async () => {
    const real = await hashPassword("some-password-1");
    const time = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };
    // warm-up so JIT/first-call cost doesn't skew the comparison
    await verifyPassword("x", real);
    await verifyPassword("x", null);

    const withHash: number[] = [];
    const withoutHash: number[] = [];
    for (let i = 0; i < 4; i++) {
      withHash.push(await time(() => verifyPassword("wrong", real)));
      withoutHash.push(await time(() => verifyPassword("wrong", null)));
    }
    expect(await verifyPassword("anything", null)).toBe(false);

    const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    // A skipped bcrypt would be ~1000x faster. Generous bounds avoid CI flakiness
    // while still failing loudly if the dummy comparison is ever removed.
    expect(median(withoutHash)).toBeGreaterThan(median(withHash) * 0.5);
    expect(median(withoutHash)).toBeLessThan(median(withHash) * 2);
  });
});

test.describe("bcrypt's 72-byte truncation is refused, not silently accepted", () => {
  test("documents the library behaviour this policy exists to work around", async () => {
    const seventyTwo = "a".repeat(72);
    const hash = await bcrypt.hash(seventyTwo, 4);
    expect(await bcrypt.compare(seventyTwo + "-anything-after-byte-72", hash)).toBe(true);
  });

  test("hashPassword accepts exactly 72 bytes and rejects 73", async () => {
    await expect(hashPassword("a".repeat(PASSWORD_MAX_BYTES))).resolves.toMatch(/^\$2/);
    await expect(hashPassword("a".repeat(PASSWORD_MAX_BYTES + 1))).rejects.toThrow(RangeError);
  });

  test("the limit is in BYTES: 25 emoji is 100 bytes and is rejected despite being 'short'", async () => {
    const emoji25 = "😀".repeat(25);
    expect(emoji25.length).toBeLessThan(128); // would have passed the old character cap
    expect(passwordByteLength(emoji25)).toBe(100);
    await expect(hashPassword(emoji25)).rejects.toThrow(RangeError);
    await expect(hashPassword("😀".repeat(18))).resolves.toMatch(/^\$2/); // exactly 72 bytes
  });

  test("passwordByteLength counts UTF-8 bytes", () => {
    expect(passwordByteLength("abc")).toBe(3);
    expect(passwordByteLength("é")).toBe(2);
    expect(passwordByteLength("日本語")).toBe(9);
    expect(passwordByteLength("")).toBe(0);
  });
});
