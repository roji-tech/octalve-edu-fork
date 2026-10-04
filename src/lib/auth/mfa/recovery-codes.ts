import crypto from "node:crypto";
import {
  RECOVERY_CODE_ALPHABET as ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH as CODE_LENGTH,
  normaliseRecoveryCode,
} from "./codes";
import { deriveKey } from "./secret-box";

export { RECOVERY_CODE_COUNT, normaliseRecoveryCode };

// Single-use recovery codes for a person who has lost their authenticator (domain-implementation-plan.md §0.5.D).
// Ten codes, `XXXXX-XXXXX`: Crockford base32 (no I, L, O or U, so nothing is misread off a printout), five
// bits a character => exactly 50 random bits a code. Shown ONCE; stored only as keyed hashes.
//
// Why a KEYED hash (HMAC-SHA256 under a key derived from MFA_ENCRYPTION_KEY) and not a plain SHA-256: a
// code has 50 bits, not 256, so a stolen table of plain hashes could be ground through offline. With the
// key kept out of the database, the table alone is useless.

export function generateRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/// A fresh set; no two codes in it are equal.
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/// The value stored in MfaRecoveryCode.codeHash (hex). Throws MfaUnavailableError without a key.
export function hashRecoveryCode(normalised: string, env: Record<string, string | undefined> = process.env): string {
  return crypto.createHmac("sha256", deriveKey("recovery-code/v1", env)).update(normalised).digest("hex");
}
