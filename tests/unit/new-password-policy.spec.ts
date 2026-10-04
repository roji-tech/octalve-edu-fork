import "../support/env";
import { test, expect } from "@playwright/test";
import { checkNewPassword } from "@/lib/auth/password-policy";

// The one rule for choosing a new password (setup, reset and change all use it).
test.describe("checkNewPassword", () => {
  test("accepts a normal password", () => {
    expect(checkNewPassword("correct-horse-9")).toBeNull();
    expect(checkNewPassword("abcdefg1")).toBeNull(); // exactly 8
  });

  test("each rule, with a sentence the person can act on", () => {
    expect(checkNewPassword("abc123")).toMatch(/at least 8 characters/);
    expect(checkNewPassword("a1".repeat(65))).toMatch(/at most 128 characters/);
    expect(checkNewPassword("12345678")).toMatch(/at least one letter/);
    expect(checkNewPassword("abcdefgh")).toMatch(/at least one number/);
  });

  test("bytes, not characters: 72 bytes pass, 73 are refused (never silently truncated by bcrypt)", () => {
    expect(checkNewPassword("a1" + "x".repeat(70))).toBeNull(); // 72
    expect(checkNewPassword("a1" + "x".repeat(71))).toMatch(/72 bytes/); // 73
    expect(checkNewPassword("a1" + "😀".repeat(18))).toMatch(/72 bytes/); // 38 characters, 74 bytes
  });
});
