// The browser-safe half of two-step verification: what a code LOOKS like and how what a person typed is
// normalised. Deliberately imports nothing from node:crypto, so the sign-in and account screens can use the
// very same rules the server does (a typo is caught before a request is made). Generating, hashing and
// verifying live beside it, server-side only.

/// What people type for an authenticator code: "123456", "123 456", "123-456". Anything else is not a
/// code — null, so callers can tell a typo (not a guess) from a wrong code.
export function normaliseTotpCode(input: string): string | null {
  const clean = input.replace(/[\s-]+/g, "");
  return /^\d{6}$/.test(clean) ? clean : null;
}

/// Crockford base32 (no I, L, O or U): 32 symbols, so five random bits a character.
export const RECOVERY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 10;

/// What a person typed, as the canonical 10 characters — or null if it cannot be a recovery code.
/// Case, spaces and the hyphen don't matter; O reads as 0 and I/L as 1 (Crockford's own rule), so the
/// printout's commonest misreadings still work.
export function normaliseRecoveryCode(input: string): string | null {
  const clean = input
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (clean.length !== RECOVERY_CODE_LENGTH) return null;
  for (const char of clean) if (!RECOVERY_CODE_ALPHABET.includes(char)) return null;
  return clean;
}
