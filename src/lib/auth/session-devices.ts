import { prisma } from "@/lib/db";
import { SESSION_ONLY_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { describeUserAgent } from "@/lib/auth/user-agent";

// "Active devices" (domain-implementation-plan.md §0.5.E): a person's own sessions, so they can spot one they don't
// recognise and end it. Nothing here exposes a session TOKEN (only its row id, which is meaningless without the
// cookie), and no IP address is stored or shown — there is no column for one and none was added for this.

export type SessionSummary = {
  id: string;
  device: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  /// "Keep me signed in" was ticked at sign-in (the long policy), as opposed to the 12-hour kind.
  keptSignedIn: boolean;
};

/// The person's unexpired sessions, the current one first, then the most recently used.
export async function listSessions(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
  const now = new Date();
  const rows = await prisma.session.findMany({
    where: { userId, expires: { gt: now }, absoluteExpires: { gt: now } },
    orderBy: { lastUsedAt: "desc" },
  });
  const sessions = rows.map((row) => ({
    id: row.id,
    device: describeUserAgent(row.userAgent),
    current: row.id === currentSessionId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    keptSignedIn: row.absoluteExpires.getTime() - row.createdAt.getTime() > (SESSION_ONLY_MAX_AGE_SECONDS + 60) * 1000,
  }));
  return [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)];
}

/// Ends one of the caller's OWN sessions. false = there is no such session of theirs — whether it never existed,
/// expired, or belongs to somebody else (callers answer all three alike, so ids can't be probed).
export async function revokeOwnSession(userId: string, sessionId: string): Promise<{ device: string } | null> {
  const row = await prisma.session.findFirst({ where: { id: sessionId, userId }, select: { id: true, userAgent: true } });
  if (!row) return null;
  const { count } = await prisma.session.deleteMany({ where: { id: row.id, userId } });
  return count === 1 ? { device: describeUserAgent(row.userAgent) } : null;
}

/// Ends every session of the person except the one in use; says how many.
export async function revokeAllOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId, id: { not: keepSessionId } } });
  return count;
}
