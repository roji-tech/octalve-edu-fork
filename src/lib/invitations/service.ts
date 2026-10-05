import type { Prisma, Role } from "@prisma/client";
import { forInvitation, setTenantContext } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { maskEmail } from "@/lib/auth/mask-email";
import { INVITATION_TTL_MS, hashInvitationToken, newInvitationToken } from "./token";
import { invitationStatus, isLiveInvitation, type InvitationStatus } from "./status";

// Invitations (domain-implementation-plan.md §0.5.4, "Build design — Users and invitations").
//
//   admin side (tenant context, ADMIN only — enforced by the routes): create, resend, revoke, list
//   invitee side (NO membership yet): preview and accept, through the *invitation* context (lib/tenant/for-tenant.ts)
//
// Every write is audited IN THE SAME TRANSACTION as the change, so a row never exists without its audit entry nor the entry
// without the row — and no audit row ever carries a token, a hash or a password.

type TenantCtx = TenantAuthContext["tenant"];

const PUBLIC_SELECT = {
  id: true,
  email: true,
  role: true,
  campusId: true,
  createdAt: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  campus: { select: { name: true } },
  invitedBy: { select: { name: true } },
} satisfies Prisma.InvitationSelect;

type InvitationRow = Prisma.InvitationGetPayload<{ select: typeof PUBLIC_SELECT }>;

/// What the API returns about an invitation: never the token, never its hash.
export type PublicInvitation = {
  id: string;
  email: string;
  role: Role;
  campusId: string | null;
  campusName: string | null;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: InvitationStatus;
};

const toPublic = (row: InvitationRow, now: Date = new Date()): PublicInvitation => ({
  id: row.id,
  email: row.email,
  role: row.role,
  campusId: row.campusId,
  campusName: row.campus?.name ?? null,
  invitedByName: row.invitedBy?.name ?? null,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  status: invitationStatus(row, now),
});

// --- the administrator's side ---------------------------------------------------------------------------------------------

export type CreateInvitationResult =
  | { ok: true; invitation: PublicInvitation; token: string }
  | { ok: false; reason: "ALREADY_MEMBER" | "DEACTIVATED_MEMBER" | "INVALID_CAMPUS" };

/// Invites `input.email` to the school. One live invitation per (school, address): an earlier open one is revoked (and audited)
/// first, and a partial unique index is the guarantee under concurrency — an advisory lock on the pair serialises two administrators
/// inviting the same person at the same instant, so the loser revokes the winner's instead of failing on the index.
/// Only ever tells the administrator about THIS school: an address that is already a member (or was deactivated here) is named as
/// such; whether the address has an account anywhere else on the platform is never consulted.
export async function createInvitation(
  tenant: TenantCtx,
  actorUserId: string,
  input: { email: string; role: Role; campusId: string | null },
): Promise<CreateInvitationResult> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    // (`$executeRaw`: the lock function returns `void`, which `$queryRaw` cannot deserialise.)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invitation:${tenantId}:${input.email}`}::text))`;

    if (input.campusId) {
      // A campus of ANOTHER school is, to this one, a campus that does not exist.
      const campus = await tx.campus.findFirst({ where: { id: input.campusId, tenantId }, select: { id: true } });
      if (!campus) return { ok: false, reason: "INVALID_CAMPUS" };
    }

    const member = await tx.tenantMembership.findFirst({ where: { tenantId, user: { email: input.email } }, select: { deactivatedAt: true } });
    if (member) return { ok: false, reason: member.deactivatedAt ? "DEACTIVATED_MEMBER" : "ALREADY_MEMBER" };

    const now = new Date();
    const earlier = await tx.invitation.findMany({ where: { tenantId, email: input.email, acceptedAt: null, revokedAt: null }, select: { id: true } });
    for (const old of earlier) {
      await tx.invitation.update({ where: { id: old.id }, data: { revokedAt: now } });
      await tx.auditLog.create({
        data: { tenantId, actorUserId, action: "INVITATION_REVOKED", targetType: "Invitation", targetId: old.id, afterValue: { email: input.email }, reason: "replaced by a new invitation" },
      });
    }

    const token = newInvitationToken();
    const created = await tx.invitation.create({
      data: {
        tenantId,
        email: input.email,
        role: input.role,
        campusId: input.campusId,
        tokenHash: hashInvitationToken(token),
        invitedById: actorUserId,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      },
      select: PUBLIC_SELECT,
    });
    await tx.auditLog.create({
      data: { tenantId, actorUserId, action: "INVITATION_CREATED", targetType: "Invitation", targetId: created.id, afterValue: { email: input.email, role: input.role, campusId: input.campusId } },
    });
    return { ok: true, invitation: toPublic(created, now), token };
  });
}

/// A fresh link and a fresh seven days for an invitation that is still open (pending OR expired); the earlier link stops working
/// at once. `null` when there is no such open invitation in this school (accepted, revoked, someone else's, unknown: one answer).
export async function resendInvitation(tenant: TenantCtx, actorUserId: string, invitationId: string): Promise<{ invitation: PublicInvitation; token: string } | null> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const open = await tx.invitation.findFirst({ where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null }, select: { id: true, email: true } });
    if (!open) return null;
    const now = new Date();
    const token = newInvitationToken();
    const updated = await tx.invitation.update({
      where: { id: open.id },
      data: { tokenHash: hashInvitationToken(token), expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) },
      select: PUBLIC_SELECT,
    });
    await tx.auditLog.create({ data: { tenantId, actorUserId, action: "INVITATION_RESENT", targetType: "Invitation", targetId: open.id, afterValue: { email: open.email } } });
    return { invitation: toPublic(updated, now), token };
  });
}

/// Ends an open invitation. The conditional update is the gate: it changes exactly one row or the answer is "no such open invitation".
export async function revokeInvitation(tenant: TenantCtx, actorUserId: string, invitationId: string): Promise<boolean> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const target = await tx.invitation.findFirst({ where: { id: invitationId, tenantId }, select: { email: true } });
    const claimed = await tx.invitation.updateMany({ where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) return false;
    await tx.auditLog.create({ data: { tenantId, actorUserId, action: "INVITATION_REVOKED", targetType: "Invitation", targetId: invitationId, afterValue: { email: target?.email ?? null } } });
    return true;
  });
}

/// The school's open invitations (pending, and expired ones that can still be resent), newest first.
export async function listOpenInvitations(tenant: TenantCtx, page: { skip: number; take: number }): Promise<{ invitations: PublicInvitation[]; total: number }> {
  const { tenantId } = tenant;
  const where: Prisma.InvitationWhereInput = { tenantId, acceptedAt: null, revokedAt: null };
  const [total, rows] = await tenant.run((tx) =>
    Promise.all([
      tx.invitation.count({ where }),
      tx.invitation.findMany({ where, select: PUBLIC_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: page.skip, take: page.take }),
    ]),
  );
  const now = new Date();
  return { invitations: rows.map((row) => toPublic(row, now)), total };
}

// --- the invitee's side ---------------------------------------------------------------------------------------------------

/// `viewer`: nobody signed in ("none"), signed in as the invited address's own account ("invitee"), or as someone else ("other").
export type InvitationPreview = { schoolName: string; role: Role; maskedEmail: string; accountExists: boolean; viewer: "none" | "invitee" | "other" };

/// What the page shows before anyone commits: the school, the role, and whether this address already has an account (which decides
/// between "choose a password" and "sign in"). The token holder is the invitee, so this is theirs to know; the address is masked
/// anyway. `null` for unknown, used, revoked and expired alike — one answer.
export async function previewInvitation(token: string, viewerUserId: string | null = null): Promise<InvitationPreview | null> {
  const hash = hashInvitationToken(token);
  return forInvitation(hash).transaction(async (tx) => {
    const found = await tx.invitation.findUnique({ where: { tokenHash: hash } });
    if (!found || !isLiveInvitation(found)) return null;
    const school = await tx.tenant.findUnique({ where: { id: found.tenantId }, select: { name: true } });
    const account = await tx.user.findUnique({ where: { email: found.email }, select: { id: true } });
    if (!school) return null;
    const viewer = !viewerUserId ? "none" : account?.id === viewerUserId ? "invitee" : "other";
    return { schoolName: school.name, role: found.role, maskedEmail: maskEmail(found.email), accountExists: Boolean(account), viewer };
  });
}

export type AcceptInvitationInput = {
  token: string;
  /// Who is signed in right now (the session's user), or null.
  viewerUserId: string | null;
  /// Required when there is no account for the invited address; ignored otherwise. The password arrives already hashed.
  newAccount?: { name: string; passwordHash: string };
};

export type AcceptInvitationResult =
  | { ok: true; userId: string; schoolCode: string; newAccount: boolean; reactivated: boolean }
  /// INVALID: unknown, used, revoked or expired — one answer. SIGN_IN_REQUIRED: the address has an account and nobody is signed in.
  /// WRONG_ACCOUNT: signed in as someone else. ALREADY_MEMBER: nothing to do (the link is NOT spent). INPUT_REQUIRED: a new account
  /// needs a name and a password.
  | { ok: false; reason: "INVALID" | "SIGN_IN_REQUIRED" | "WRONG_ACCOUNT" | "ALREADY_MEMBER" | "INPUT_REQUIRED" };

class Abort extends Error {
  constructor(readonly reason: Extract<AcceptInvitationResult, { ok: false }>["reason"]) {
    super(reason);
  }
}

/// Accepts the invitation in ONE transaction: read it by the token's hash, set the TENANT context from the row found (the secret's
/// hash named the tenant — nothing in the request does), claim it with a conditional update, create or find the account, create or
/// reactivate the membership, audit. Any failure rolls back ALL of it: a refused password or a lost race leaves no user, no
/// membership and an unspent link.
///
/// The rule that matters: an EXISTING account is attached only by its owner — the person signed in as that account. An administrator
/// can never attach a stranger's account, and a token holder who is signed in as someone else is refused.
export async function acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
  const hash = hashInvitationToken(input.token);
  try {
    return await forInvitation(hash).transaction(async (tx): Promise<AcceptInvitationResult> => {
      const now = new Date();
      const found = await tx.invitation.findUnique({ where: { tokenHash: hash } });
      if (!found || !isLiveInvitation(found, now)) throw new Abort("INVALID");

      const account = await tx.user.findUnique({ where: { email: found.email }, select: { id: true } });
      if (input.viewerUserId) {
        if (!account || account.id !== input.viewerUserId) throw new Abort("WRONG_ACCOUNT");
      } else if (account) {
        throw new Abort("SIGN_IN_REQUIRED");
      } else if (!input.newAccount) {
        throw new Abort("INPUT_REQUIRED");
      }

      // From here the tenant is the one the invitation row names. Everything below is a tenant-context write.
      await setTenantContext(tx, trustedTenantId(found.tenantId));

      const existing = account
        ? await tx.tenantMembership.findUnique({ where: { userId_tenantId: { userId: account.id, tenantId: found.tenantId } }, select: { id: true, deactivatedAt: true } })
        : null;
      if (existing && !existing.deactivatedAt) throw new Abort("ALREADY_MEMBER");

      // Single use: the conditional update must change exactly one row, so two simultaneous accepts produce one membership.
      const claimed = await tx.invitation.updateMany({
        where: { id: found.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) throw new Abort("INVALID");

      let userId: string;
      if (account) {
        userId = account.id;
      } else {
        try {
          const created = await tx.user.create({
            data: { email: found.email, name: input.newAccount!.name, passwordHash: input.newAccount!.passwordHash, emailVerified: now },
            select: { id: true },
          });
          userId = created.id;
        } catch (error) {
          // An account for this address appeared since the check above: the right path is now "sign in", not "choose a password".
          if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") throw new Abort("SIGN_IN_REQUIRED");
          throw error;
        }
      }

      if (existing) {
        await tx.tenantMembership.update({ where: { id: existing.id }, data: { role: found.role, campusId: found.campusId, deactivatedAt: null } });
      } else {
        await tx.tenantMembership.create({ data: { userId, tenantId: found.tenantId, role: found.role, campusId: found.campusId } });
      }
      await tx.invitation.update({ where: { id: found.id }, data: { acceptedById: userId } });
      await tx.auditLog.create({
        data: {
          tenantId: found.tenantId,
          actorUserId: userId,
          action: "INVITATION_ACCEPTED",
          targetType: "Invitation",
          targetId: found.id,
          afterValue: { role: found.role, campusId: found.campusId, newAccount: !account, reactivated: Boolean(existing) },
        },
      });

      const school = await tx.tenant.findUniqueOrThrow({ where: { id: found.tenantId }, select: { code: true } });
      return { ok: true, userId, schoolCode: school.code, newAccount: !account, reactivated: Boolean(existing) };
    });
  } catch (error) {
    if (error instanceof Abort) return { ok: false, reason: error.reason };
    throw error;
  }
}
