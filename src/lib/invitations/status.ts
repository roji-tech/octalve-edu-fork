// What state an invitation is in, derived — never stored — from its three timestamps. Pure and client-safe: the API and the Users
// page both use it, so what an administrator is told can't drift from what the accept route enforces.

export type InvitationTimes = { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date };
export type InvitationStatus = "accepted" | "revoked" | "expired" | "pending";

export function invitationStatus(times: InvitationTimes, now: Date = new Date()): InvitationStatus {
  if (times.acceptedAt) return "accepted";
  if (times.revokedAt) return "revoked";
  return times.expiresAt.getTime() > now.getTime() ? "pending" : "expired";
}

/// Can the link still be used? (Exactly the accept route's rule — the same three tests, in the same order of precedence.)
export const isLiveInvitation = (times: InvitationTimes, now: Date = new Date()): boolean => invitationStatus(times, now) === "pending";
