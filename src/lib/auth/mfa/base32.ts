// RFC 4648 base32 — the alphabet authenticator apps expect for a TOTP secret (domain-implementation-plan.md §0.5.D).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Encodes without `=` padding (what otpauth:// URLs and authenticator apps use).
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/// Decodes, tolerating the ways people copy a key: lower case, spaces, hyphens, `=` padding.
/// Returns null for any other character (never a partial result).
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s=-]+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
