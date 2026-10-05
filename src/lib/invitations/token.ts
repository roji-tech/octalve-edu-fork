import crypto from "node:crypto";

// Invitation links (domain-implementation-plan.md §0.5.4). The token is 256 random bits, travels in the URL FRAGMENT (never in a
// server log or a Referer — see components/auth/useFragmentToken.ts) and only its SHA-256 hash is ever stored or put in a database
// context: a leaked database, backup or log yields no usable link.

export const INVITATION_TTL_DAYS = 7;
export const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/// 32 random bytes as base64url: always exactly 43 characters.
export const newInvitationToken = (): string => crypto.randomBytes(32).toString("base64url");

export const hashInvitationToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

/// Cheap shape check, so garbage never reaches the database (and a wrong-length value is refused the same way as a wrong one).
export const isInvitationToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
