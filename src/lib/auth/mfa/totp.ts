import crypto from "node:crypto";
import { base32Encode } from "./base32";
import { normaliseTotpCode } from "./codes";

export { normaliseTotpCode };

// RFC 6238 TOTP over RFC 4226 HOTP (HMAC-SHA1 — what every authenticator app implements), written here
// rather than imported: it is ~40 lines, and security code is worth owning. Checked against the RFC's own
// published test vectors in tests/unit/totp.spec.ts. (domain-implementation-plan.md §0.5.D)

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/// Accept the current step and this many either side — i.e. ±30 s of clock drift.
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20; // 160 bits, the RFC 4226 recommendation

/// A fresh 160-bit secret.
export const generateTotpSecret = (): Buffer => crypto.randomBytes(TOTP_SECRET_BYTES);

/// The 30-second step number a moment falls in.
export const stepAt = (ms: number): number => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/// RFC 4226 HOTP: the code for one counter value.
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f; // dynamic truncation
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/// The code an authenticator shows at `atMs` (`offsetSteps` shifts it by whole steps).
export function totpAt(secret: Buffer, atMs: number, offsetSteps = 0, digits: number = TOTP_DIGITS): string {
  return hotp(secret, stepAt(atMs) + offsetSteps, digits);
}

/// Checks `code` against the steps in the drift window and returns the step that matched, or null.
/// `afterStep` is the highest step already accepted for this credential: a step at or below it is
/// refused, so a code that was used (or shoulder-surfed) cannot be used again. Every candidate is
/// compared in constant time and none short-circuits.
export function verifyTotp(
  secret: Buffer,
  code: string,
  opts: { nowMs?: number; afterStep?: number | null; window?: number } = {},
): number | null {
  const normalised = normaliseTotpCode(code);
  if (!normalised) return null;
  const current = stepAt(opts.nowMs ?? Date.now());
  const window = opts.window ?? TOTP_WINDOW;
  const given = Buffer.from(normalised);

  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    const equal = crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), given);
    const fresh = opts.afterStep == null || step > opts.afterStep;
    if (equal && fresh && matched === null) matched = step;
  }
  return matched;
}

/// The `otpauth://` URL an authenticator app imports (the QR code encodes exactly this). The issuer
/// appears twice — in the label and as a parameter — because apps read one or the other.
export function otpauthUrl(opts: { issuer: string; account: string; secret: Buffer }): string {
  const issuer = encodeURIComponent(opts.issuer);
  const label = `${issuer}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(opts.secret),
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
