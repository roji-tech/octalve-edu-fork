import crypto from "node:crypto";

// Keys and encryption for two-step verification (domain-implementation-plan.md §0.5.D).
//
// A TOTP secret has to be READ back to check a code, so unlike a password it cannot be hashed. It is
// encrypted instead (AES-256-GCM) with a key that lives in the environment, never in the database: a
// leaked database alone yields no usable secret. Recovery codes are a different matter — they are only
// ever compared, so they are stored as keyed hashes (see recovery-codes.ts) under a second key DERIVED
// from the same root, so one root secret is never used raw for two purposes.
//
// Fail closed: with no valid key, two-step verification is simply unavailable (enrolment answers 503).
// There is deliberately no development fallback key — a baked-in default is exactly the sort of thing
// that ships to production by accident.

export const MFA_KEY_ENV = "MFA_ENCRYPTION_KEY";

/// Thrown when two-step verification cannot be used: no valid MFA_ENCRYPTION_KEY, or a stored secret that the
/// current key cannot read (the key was changed since enrolment, or the row was altered). Routes map it to 503
/// — the person can't fix it, an operator can (`pnpm mfa:reset`).
export class MfaUnavailableError extends Error {
  constructor(reason: string = `${MFA_KEY_ENV} is not set to a base64 32-byte key.`) {
    super(`Two-step verification is unavailable: ${reason}`);
    this.name = "MfaUnavailableError";
  }
}

type Env = Record<string, string | undefined>;

function rootKey(env: Env): Buffer | null {
  const raw = env[MFA_KEY_ENV]?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

/// True when a valid key is configured.
export const mfaConfigured = (env: Env = process.env): boolean => rootKey(env) !== null;

/// A purpose-specific 32-byte key derived from the root key (HKDF-SHA256).
export function deriveKey(purpose: string, env: Env = process.env): Buffer {
  const root = rootKey(env);
  if (!root) throw new MfaUnavailableError();
  return Buffer.from(crypto.hkdfSync("sha256", root, Buffer.alloc(0), `mfa/${purpose}`, 32));
}

const VERSION = "v1";
const IV_BYTES = 12; // the GCM standard

/// `v1.<iv>.<ciphertext>.<tag>` (base64url). `aad` binds the ciphertext to its owner: a row copied to a
/// different user's credential fails to decrypt instead of silently becoming that user's secret.
export function encryptSecret(plaintext: Buffer, aad: string, env: Env = process.env): string {
  const key = deriveKey("totp-secret/v1", env);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, ciphertext, tag]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/// Throws MfaUnavailableError on a malformed box, the wrong key, the wrong `aad`, or any tampering (GCM
/// authentication) — never returns wrong plaintext.
export function decryptSecret(box: string, aad: string, env: Env = process.env): Buffer {
  const [version, iv, ciphertext, tag, ...extra] = box.split(".");
  if (version !== VERSION || !iv || !ciphertext || !tag || extra.length > 0) {
    throw new MfaUnavailableError("a stored secret is malformed.");
  }
  const key = deriveKey("totp-secret/v1", env);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  } catch {
    throw new MfaUnavailableError("a stored secret could not be decrypted (wrong key, or the row was altered).");
  }
}
