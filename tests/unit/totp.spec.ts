import "../support/env";
import { test, expect } from "@playwright/test";
import { base32Decode, base32Encode } from "@/lib/auth/mfa/base32";
import {
  TOTP_SECRET_BYTES,
  generateTotpSecret,
  hotp,
  normaliseTotpCode,
  otpauthUrl,
  stepAt,
  totpAt,
  verifyTotp,
} from "@/lib/auth/mfa/totp";

// The algorithm is implemented in this repo, so it is checked against the standards' own published
// vectors — not against itself.

const RFC_SECRET = Buffer.from("12345678901234567890"); // the ASCII secret RFC 4226/6238 use

test.describe("base32 (RFC 4648)", () => {
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];

  test("the RFC's vectors encode (unpadded) and decode", () => {
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded)?.toString()).toBe(plain);
    }
  });

  test("decoding tolerates lower case, spaces, hyphens and padding — and refuses anything else", () => {
    expect(base32Decode("mzxw 6ytb-oi======")?.toString()).toBe("foobar");
    expect(base32Decode("MZXW1")).toBeNull(); // 1 is not in the alphabet
    expect(base32Decode("MZXW6!")).toBeNull();
  });

  test("round-trips random bytes", () => {
    for (let i = 0; i < 200; i++) {
      const secret = generateTotpSecret();
      expect(base32Decode(base32Encode(secret))?.equals(secret)).toBe(true);
    }
  });
});

test.describe("HOTP (RFC 4226 appendix D)", () => {
  test("counters 0–9", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });
});

test.describe("TOTP (RFC 6238 appendix B, SHA-1)", () => {
  test("the published vectors (8 digits)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) expect(totpAt(RFC_SECRET, seconds * 1000, 0, 8)).toBe(code);
  });

  test("six digits are the last six of the eight (so the same secret works at both lengths)", () => {
    expect(totpAt(RFC_SECRET, 59_000)).toBe("287082");
  });

  test("a step is 30 seconds, aligned to the epoch", () => {
    expect(stepAt(0)).toBe(0);
    expect(stepAt(29_999)).toBe(0);
    expect(stepAt(30_000)).toBe(1);
    expect(stepAt(59_000)).toBe(1);
  });

  test("secrets are 160 bits and never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const secret = generateTotpSecret();
      expect(secret.length).toBe(TOTP_SECRET_BYTES);
      seen.add(secret.toString("hex"));
    }
    expect(seen.size).toBe(1000);
  });
});

test.describe("verifyTotp — the drift window and replay", () => {
  const secret = RFC_SECRET;
  const now = 1_700_000_015_000; // mid-step, so ±1 step is unambiguous
  const current = stepAt(now);
  const at = (offset: number) => hotp(secret, current + offset);

  test("accepts the current step and one either side, returning the step that matched", () => {
    expect(verifyTotp(secret, at(0), { nowMs: now })).toBe(current);
    expect(verifyTotp(secret, at(-1), { nowMs: now })).toBe(current - 1);
    expect(verifyTotp(secret, at(1), { nowMs: now })).toBe(current + 1);
  });

  test("refuses two steps out, either way (the window is exactly ±1)", () => {
    expect(verifyTotp(secret, at(-2), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, at(2), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, at(-3), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, at(3), { nowMs: now })).toBeNull();
  });

  test("a step already used (or an earlier one) is refused; a later one is not", () => {
    expect(verifyTotp(secret, at(0), { nowMs: now, afterStep: current })).toBeNull();
    expect(verifyTotp(secret, at(-1), { nowMs: now, afterStep: current })).toBeNull();
    expect(verifyTotp(secret, at(1), { nowMs: now, afterStep: current })).toBe(current + 1);
    expect(verifyTotp(secret, at(0), { nowMs: now, afterStep: current - 1 })).toBe(current);
  });

  test("a wrong code, a wrong secret and malformed input are refused", () => {
    const wrong = String((Number(at(0)) + 1) % 1_000_000).padStart(6, "0");
    expect(verifyTotp(secret, wrong, { nowMs: now })).toBeNull();
    expect(verifyTotp(generateTotpSecret(), at(0), { nowMs: now })).toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5x", "٠١٢٣٤٥"]) {
      expect(verifyTotp(secret, bad, { nowMs: now })).toBeNull();
    }
  });

  test("how people type a code: spaces and hyphens are fine", () => {
    const code = at(0);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now })).toBe(current);
    expect(verifyTotp(secret, `${code.slice(0, 3)}-${code.slice(3)}`, { nowMs: now })).toBe(current);
    expect(normaliseTotpCode(" 123 456 ")).toBe("123456");
    expect(normaliseTotpCode("12345")).toBeNull();
  });
});

test.describe("otpauth:// URL", () => {
  test("carries the secret, the issuer (twice) and the parameters apps read", () => {
    const url = otpauthUrl({ issuer: "Octalve Edu", account: "amina@school.test", secret: RFC_SECRET });
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(decodeURIComponent(parsed.pathname)).toBe("/Octalve Edu:amina@school.test");
    expect(parsed.searchParams.get("secret")).toBe(base32Encode(RFC_SECRET));
    expect(parsed.searchParams.get("issuer")).toBe("Octalve Edu");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });

  test("an account name with reserved characters cannot break out of the label", () => {
    const url = otpauthUrl({ issuer: "A&B", account: "x:y?z=1&secret=EVIL@t.test", secret: RFC_SECRET });
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll("secret")).toEqual([base32Encode(RFC_SECRET)]);
    expect(parsed.searchParams.get("issuer")).toBe("A&B");
  });
});
