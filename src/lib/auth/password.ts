import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { PASSWORD_MAX_BYTES, passwordByteLength } from "@/lib/auth/password-policy";

// The size limits live in password-policy.ts (client-safe); re-exported so
// server code keeps a single import for "everything about passwords".
export { PASSWORD_MAX_LENGTH, PASSWORD_MAX_BYTES } from "@/lib/auth/password-policy";

export const BCRYPT_COST = 12;

// A real bcrypt hash of an unguessed, never-used value, generated once at
// module load (boot) at the real production cost factor. It makes every
// login-failure path run bcrypt.compare exactly once whether or not a user
// matched — closing a timing side-channel where a missing-user response that
// skips bcrypt is measurably faster than a wrong-password response, even when
// both return the identical error. A malformed placeholder (not a real
// bcrypt hash) would make compare return instantly and defeat the fix, so
// this is a genuine hash, never a hardcoded string.
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), BCRYPT_COST);

/// Callers validate first (Zod schemas turn an over-long password into a normal
/// 400 the user can act on); this is the backstop that guarantees no code path
/// can ever store a hash of a silently-truncated password.
export function hashPassword(password: string): Promise<string> {
  if (passwordByteLength(password) > PASSWORD_MAX_BYTES) {
    return Promise.reject(new RangeError(`Password exceeds ${PASSWORD_MAX_BYTES} bytes; bcrypt would silently truncate it.`));
  }
  return bcrypt.hash(password, BCRYPT_COST);
}

/// Always runs bcrypt.compare — against DUMMY_HASH when `hash` is null (no
/// such user, or an invited-but-not-yet-activated account with no
/// passwordHash) — so every branch costs the same.
export function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH);
}
