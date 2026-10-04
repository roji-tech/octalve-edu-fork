import "../support/env";
import { TEST_MFA_KEY } from "../support/env";
import { test, expect } from "@playwright/test";
import { MfaUnavailableError, decryptSecret, deriveKey, encryptSecret, mfaConfigured } from "@/lib/auth/mfa/secret-box";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  normaliseRecoveryCode,
} from "@/lib/auth/mfa/recovery-codes";

const env = (key?: string) => ({ MFA_ENCRYPTION_KEY: key });
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

test.describe("secret encryption (AES-256-GCM)", () => {
  const secret = Buffer.from("a very secret authenticator key");

  test("round-trips, and the stored form contains no plaintext", () => {
    const box = encryptSecret(secret, "user-1", env(TEST_MFA_KEY));
    expect(box).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(box).not.toContain(secret.toString("base64url"));
    expect(Buffer.from(box).includes(secret)).toBe(false);
    expect(decryptSecret(box, "user-1", env(TEST_MFA_KEY)).equals(secret)).toBe(true);
  });

  test("a fresh IV every time: the same secret never encrypts to the same box", () => {
    const boxes = new Set(Array.from({ length: 200 }, () => encryptSecret(secret, "user-1", env(TEST_MFA_KEY))));
    expect(boxes.size).toBe(200);
  });

  test("tampering with any part is detected (GCM authentication)", () => {
    const [version, iv, ciphertext, tag] = encryptSecret(secret, "user-1", env(TEST_MFA_KEY)).split(".");
    const flip = (part: string) => {
      const bytes = Buffer.from(part, "base64url");
      bytes[0] ^= 1;
      return bytes.toString("base64url");
    };
    for (const tampered of [
      [version, flip(iv), ciphertext, tag],
      [version, iv, flip(ciphertext), tag],
      [version, iv, ciphertext, flip(tag)],
    ]) {
      expect(() => decryptSecret(tampered.join("."), "user-1", env(TEST_MFA_KEY))).toThrow(MfaUnavailableError);
    }
  });

  test("bound to its owner: a box moved to another user's row does not decrypt", () => {
    const box = encryptSecret(secret, "user-1", env(TEST_MFA_KEY));
    expect(() => decryptSecret(box, "user-2", env(TEST_MFA_KEY))).toThrow(MfaUnavailableError);
  });

  test("the wrong key, and malformed boxes, do not decrypt", () => {
    const box = encryptSecret(secret, "user-1", env(TEST_MFA_KEY));
    expect(() => decryptSecret(box, "user-1", env(OTHER_KEY))).toThrow(MfaUnavailableError);
    for (const bad of ["", "v1", "v2.a.b.c", "v1.a.b", "v1.a.b.c.d", box.replace(/^v1/, "v0")]) {
      expect(() => decryptSecret(bad, "user-1", env(TEST_MFA_KEY))).toThrow(MfaUnavailableError);
    }
  });

  test("fails closed without a valid key: missing, empty, or not 32 bytes", () => {
    for (const key of [undefined, "", "   ", "c2hvcnQ=", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")]) {
      expect(mfaConfigured(env(key))).toBe(false);
      expect(() => encryptSecret(secret, "u", env(key))).toThrow(MfaUnavailableError);
      expect(() => deriveKey("anything", env(key))).toThrow(MfaUnavailableError);
    }
    expect(mfaConfigured(env(TEST_MFA_KEY))).toBe(true);
  });

  test("the encryption key and the recovery-code key are different keys derived from one root", () => {
    const a = deriveKey("totp-secret/v1", env(TEST_MFA_KEY));
    const b = deriveKey("recovery-code/v1", env(TEST_MFA_KEY));
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(Buffer.from(TEST_MFA_KEY, "base64"))).toBe(false); // the root is never used raw
  });
});

test.describe("recovery codes", () => {
  test("format: XXXXX-XXXXX from the unambiguous alphabet", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateRecoveryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
  });

  test("a set is ten distinct codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  test("uses all 32 symbols roughly evenly (50 random bits a code, no modulo bias)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      for (const char of generateRecoveryCode().replace("-", "")) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const mean = (4000 * 10) / 32; // 1250
    for (const n of counts.values()) expect(Math.abs(n - mean)).toBeLessThan(mean * 0.2);
  });

  test("normalising: case, spaces and the hyphen don't matter; O reads as 0 and I/L as 1", () => {
    expect(normaliseRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normaliseRecoveryCode(" ABCDE FGHJK ")).toBe("ABCDEFGHJK");
    expect(normaliseRecoveryCode("ABCDEFGHJK")).toBe("ABCDEFGHJK");
    expect(normaliseRecoveryCode("O0O0O-IlIlI")).toBe("0000011111");
    expect(normaliseRecoveryCode("ABCDE-FGHJ")).toBeNull(); // too short
    expect(normaliseRecoveryCode("ABCDE-FGHJKM")).toBeNull(); // too long
    expect(normaliseRecoveryCode("ABCDE-FGHJU")).toBeNull(); // U is not in the alphabet
    expect(normaliseRecoveryCode("ABCDE-FGHJ!")).toBeNull();
  });

  test("stored as a keyed hash: stable for one key, different under another, never the code itself", () => {
    const code = "ABCDEFGHJK";
    const a = hashRecoveryCode(code, env(TEST_MFA_KEY));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(hashRecoveryCode(code, env(TEST_MFA_KEY)));
    expect(a).not.toBe(hashRecoveryCode(code, env(OTHER_KEY)));
    expect(a).not.toBe(hashRecoveryCode("ABCDEFGHJM", env(TEST_MFA_KEY)));
    expect(a).not.toContain(code);
    expect(() => hashRecoveryCode(code, env(undefined))).toThrow(MfaUnavailableError);
  });
});
