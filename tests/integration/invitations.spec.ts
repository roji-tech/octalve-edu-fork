import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, deactivateMembership, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { withEnv } from "../support/with-env";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import { resolveTenant } from "@/lib/tenant/resolve-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { hashPassword } from "@/lib/auth/password";
import { acceptInvitation, createInvitation, listOpenInvitations, previewInvitation, resendInvitation, revokeInvitation } from "@/lib/invitations/service";
import { hashInvitationToken, INVITATION_TTL_MS, isInvitationToken, newInvitationToken } from "@/lib/invitations/token";
import { invitationStatus } from "@/lib/invitations/status";
import { invitationEmail } from "@/lib/email/messages";

// The invitation library in-process, as `app_user` (domain-implementation-plan.md §0.5.4): the whole lifecycle against the real
// database, and the cases that matter most — an existing account attached only by its owner, a lost race, a rollback.

let a: TestTenant;
let b: TestTenant;
let admin: { id: string };

const ctx = (t: TestTenant): TenantAuthContext["tenant"] => ({
  tenantId: trustedTenantId(t.id),
  tenantCode: t.code,
  tenantName: t.name,
  role: "ADMIN",
  campusId: null,
  run: <T>(fn: (tx: Tx) => Promise<T>) => forTenant(trustedTenantId(t.id)).transaction(fn),
});
const email = (label: string) => `${label}-${crypto.randomBytes(3).toString("hex")}@invite.test`;
const strongHash = () => hashPassword("a-Strong-passphrase-2026");

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  admin = await createUser({ name: "Ada Admin" });
  await addMembership(admin.id, a.id, R.ADMIN);
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

async function invite(to: string, opts: { role?: Role; campusId?: string | null; school?: TestTenant } = {}) {
  const result = await createInvitation(ctx(opts.school ?? a), admin.id, { email: to, role: opts.role ?? R.TEACHING_STAFF, campusId: opts.campusId ?? null });
  if (!result.ok) throw new Error(`invite failed: ${result.reason}`);
  return result;
}

test.describe("the token", () => {
  test("is 256 random bits as 43 base64url characters; only the SHA-256 hash is ever stored", async () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newInvitationToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(isInvitationToken(token)).toBe(true);
    expect(hashInvitationToken("x")).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`, 42, null, undefined]) expect(isInvitationToken(bad)).toBe(false);
  });

  test("status is derived from the three timestamps, in order of precedence", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    const future = new Date(now.getTime() + 1000);
    const past = new Date(now.getTime() - 1000);
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: future }, now)).toBe("pending");
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: past }, now)).toBe("expired");
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: now }, now)).toBe("expired"); // expiry is exclusive
    expect(invitationStatus({ acceptedAt: null, revokedAt: past, expiresAt: future }, now)).toBe("revoked");
    expect(invitationStatus({ acceptedAt: past, revokedAt: past, expiresAt: past }, now)).toBe("accepted"); // accepted wins
  });

  test("the invitation email names the school and role, carries the link in the FRAGMENT, and a hostile name cannot break its header", () => {
    const message = invitationEmail({ to: "x@y.test", token: "T".repeat(43), schoolName: "Alpha\r\nBcc: evil@x.test\u2028School", roleLabel: "Teaching staff", inviterName: "Ada\nAdmin", days: 7 });
    expect(message.subject).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(message.subject).toContain("Alpha Bcc: evil@x.test School"); // flattened, not interpreted
    expect(message.text).toContain("/accept-invite#token=" + "T".repeat(43));
    expect(message.text).not.toContain("/accept-invite?token");
    expect(message.text).toContain("Teaching staff");
    expect(message.text).toContain("within 7 days");
  });
});

test.describe("creating", () => {
  test("stores the HASH, a seven-day expiry and the inviter — and the audit row carries no secret", async () => {
    const to = email("new");
    const { invitation, token } = await invite(to, { role: R.TEACHING_STAFF });
    const row = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.tokenHash).toBe(hashInvitationToken(token));
    expect(row.tokenHash).not.toContain(token);
    expect(Math.abs(row.expiresAt.getTime() - (Date.now() + INVITATION_TTL_MS))).toBeLessThan(60_000);
    expect(row).toMatchObject({ tenantId: a.id, email: to, role: "TEACHING_STAFF", invitedById: admin.id, acceptedAt: null, revokedAt: null });
    const audit = await db.auditLog.findMany({ where: { tenantId: a.id, targetId: invitation.id } });
    expect(audit.map((r) => r.action)).toEqual(["INVITATION_CREATED"]);
    expect(audit[0]).toMatchObject({ actorUserId: admin.id, afterValue: { email: to, role: "TEACHING_STAFF", campusId: null } });
    const dump = JSON.stringify(audit);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(row.tokenHash);
    expect(JSON.stringify(invitation)).not.toMatch(/tokenHash|token/i); // and neither does what the API would return
  });

  test("ONE live invitation per (school, address): a new one revokes — and audits — the earlier, whose link then fails", async () => {
    const to = email("twice");
    const first = await invite(to);
    const second = await invite(to);
    expect(first.token).not.toBe(second.token);
    const rows = await db.invitation.findMany({ where: { tenantId: a.id, email: to }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.revokedAt !== null, r.acceptedAt])).toEqual([[true, null], [false, null]]);
    expect(await previewInvitation(first.token)).toBeNull();
    expect(await previewInvitation(second.token)).toMatchObject({ schoolName: "Alpha School" });
    const revoked = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "INVITATION_REVOKED", targetId: first.invitation.id } });
    expect(revoked.reason).toMatch(/replaced/);
  });

  test("two administrators inviting the same person at the same instant: both succeed, exactly ONE link stays live (repeated, so lucky timing cannot hide a missing lock)", async () => {
    for (let round = 0; round < 6; round++) {
      const to = email(`race${round}`);
      const results = await Promise.all([createInvitation(ctx(a), admin.id, { email: to, role: R.PARENT, campusId: null }), createInvitation(ctx(a), admin.id, { email: to, role: R.STUDENT, campusId: null })]);
      expect(results.every((r) => r.ok), `round ${round}`).toBe(true);
      const live = await db.invitation.findMany({ where: { tenantId: a.id, email: to, acceptedAt: null, revokedAt: null } });
      expect(live, `round ${round}`).toHaveLength(1);
      const liveTokens = results.flatMap((r) => (r.ok ? [r.token] : []));
      const working = (await Promise.all(liveTokens.map((t) => previewInvitation(t)))).filter(Boolean);
      expect(working, `round ${round}`).toHaveLength(1);
    }
  });

  test("an address that is already a member is named as such; a deactivated one says to reactivate; nothing is created either time", async () => {
    const member = await createUser();
    await addMembership(member.id, a.id, R.TEACHING_STAFF);
    const gone = await createUser();
    await addMembership(gone.id, a.id, R.TEACHING_STAFF);
    await deactivateMembership(gone.id, a.id);
    const before = await db.invitation.count({ where: { tenantId: a.id } });
    expect(await createInvitation(ctx(a), admin.id, { email: member.email, role: R.PARENT, campusId: null })).toEqual({ ok: false, reason: "ALREADY_MEMBER" });
    expect(await createInvitation(ctx(a), admin.id, { email: gone.email, role: R.PARENT, campusId: null })).toEqual({ ok: false, reason: "DEACTIVATED_MEMBER" });
    expect(await db.invitation.count({ where: { tenantId: a.id } })).toBe(before);
  });

  test("what the administrator learns is about THIS school only: a member of ANOTHER school is simply invitable, exactly like a stranger", async () => {
    const elsewhere = await createUser();
    await addMembership(elsewhere.id, b.id, R.ADMIN);
    const stranger = email("nobody");
    const known = await createInvitation(ctx(a), admin.id, { email: elsewhere.email, role: R.PARENT, campusId: null });
    const unknown = await createInvitation(ctx(a), admin.id, { email: stranger, role: R.PARENT, campusId: null });
    expect(known.ok).toBe(true);
    expect(unknown.ok).toBe(true);
    if (known.ok && unknown.ok) {
      // the same shape; nothing marks the address that has an account
      expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
      expect(Object.keys(known.invitation).sort()).toEqual(Object.keys(unknown.invitation).sort());
    }
  });

  test("a campus of another school — or one that does not exist — is refused alike", async () => {
    const theirs = await db.campus.findFirstOrThrow({ where: { tenantId: b.id } });
    for (const campusId of [theirs.id, "no-such-campus"]) {
      expect(await createInvitation(ctx(a), admin.id, { email: email("campus"), role: R.TEACHING_STAFF, campusId })).toEqual({ ok: false, reason: "INVALID_CAMPUS" });
    }
    const mine = await db.campus.findFirstOrThrow({ where: { tenantId: a.id, name: "Alpha South" } });
    const ok = await invite(email("campus-ok"), { campusId: mine.id });
    expect(ok.invitation).toMatchObject({ campusId: mine.id, campusName: "Alpha South" });
  });
});

test.describe("resend, revoke, list", () => {
  test("resend: a NEW link and a fresh seven days; the old link stops working at once; an expired invitation is revived", async () => {
    const { invitation, token } = await invite(email("resend"));
    await db.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await previewInvitation(token)).toBeNull(); // expired
    const resent = await resendInvitation(ctx(a), admin.id, invitation.id);
    expect(resent).not.toBeNull();
    expect(resent!.token).not.toBe(token);
    expect(await previewInvitation(token)).toBeNull();
    expect(await previewInvitation(resent!.token)).not.toBeNull();
    expect(Math.abs(resent!.invitation.expiresAt.getTime() - (Date.now() + INVITATION_TTL_MS))).toBeLessThan(60_000);
    expect((await db.auditLog.findMany({ where: { targetId: invitation.id, action: "INVITATION_RESENT" } })).length).toBe(1);
  });

  test("resend and revoke refuse — with the one 'no such open invitation' answer — for an accepted, a revoked, another school's and an unknown id", async () => {
    const accepted = await invite(email("done"));
    await acceptInvitation({ token: accepted.token, viewerUserId: null, newAccount: { name: "Done Person", passwordHash: await strongHash() } });
    const revoked = await invite(email("revoked"));
    expect(await revokeInvitation(ctx(a), admin.id, revoked.invitation.id)).toBe(true);
    const theirs = await invite(email("theirs"), { school: b });
    for (const id of [accepted.invitation.id, revoked.invitation.id, theirs.invitation.id, "no-such-invitation"]) {
      expect(await resendInvitation(ctx(a), admin.id, id), id).toBeNull();
      expect(await revokeInvitation(ctx(a), admin.id, id), id).toBe(false);
    }
    expect(await db.invitation.findUniqueOrThrow({ where: { id: theirs.invitation.id } })).toMatchObject({ revokedAt: null }); // B's was not touched
    expect(await previewInvitation(theirs.token)).not.toBeNull();
  });

  test("revoke ends the link, audits once, and a second revoke is 'no such open invitation'", async () => {
    const { invitation, token } = await invite(email("revoke"));
    expect(await revokeInvitation(ctx(a), admin.id, invitation.id)).toBe(true);
    expect(await revokeInvitation(ctx(a), admin.id, invitation.id)).toBe(false);
    expect(await previewInvitation(token)).toBeNull();
    expect(await acceptInvitation({ token, viewerUserId: null, newAccount: { name: "Late", passwordHash: await strongHash() } })).toEqual({ ok: false, reason: "INVALID" });
    expect((await db.auditLog.findMany({ where: { targetId: invitation.id, action: "INVITATION_REVOKED" } })).length).toBe(1);
  });

  test("the list holds a school's OPEN invitations only (pending and expired), newest first, with derived status and no secret", async () => {
    const school = await createTenant({ name: "Gamma School", campuses: [] });
    const run = (to: string) => createInvitation(ctx(school), admin.id, { email: to, role: R.PARENT, campusId: null });
    const old = await run(email("l1"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const mid = await run(email("l2"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const fresh = await run(email("l3"));
    if (!old.ok || !mid.ok || !fresh.ok) throw new Error("setup");
    await db.invitation.update({ where: { id: old.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await revokeInvitation(ctx(school), admin.id, mid.invitation.id);
    const { invitations, total } = await listOpenInvitations(ctx(school), { skip: 0, take: 10 });
    expect(total).toBe(2);
    expect(invitations.map((i) => [i.id, i.status])).toEqual([[fresh.invitation.id, "pending"], [old.invitation.id, "expired"]]);
    expect(JSON.stringify(invitations)).not.toMatch(/tokenHash|"token"/);
    expect((await listOpenInvitations(ctx(school), { skip: 1, take: 1 })).invitations.map((i) => i.id)).toEqual([old.invitation.id]); // paged
    expect((await listOpenInvitations(ctx(a), { skip: 0, take: 100 })).invitations.map((i) => i.id)).not.toContain(fresh.invitation.id); // never another school's
  });
});

test.describe("previewing", () => {
  test("shows the school, the role and a MASKED address, and whether an account already exists for it", async () => {
    const fresh = await invite(email("fresh"), { role: R.PARENT });
    expect(await previewInvitation(fresh.token)).toEqual({ schoolName: "Alpha School", role: "PARENT", maskedEmail: expect.stringMatching(/^f\*\*\*@invite\.test$/), accountExists: false, viewer: "none" });
    const existing = await createUser();
    const hers = await invite(existing.email);
    expect(await previewInvitation(hers.token)).toMatchObject({ accountExists: true, viewer: "none" });
    expect(await previewInvitation(hers.token, existing.id)).toMatchObject({ viewer: "invitee" }); // signed in as that very account
    expect(await previewInvitation(hers.token, (await createUser()).id)).toMatchObject({ viewer: "other" }); // signed in as someone else
  });

  test("unknown, malformed, revoked, expired and accepted links all give the SAME answer: nothing", async () => {
    const gone = await invite(email("gone"));
    await revokeInvitation(ctx(a), admin.id, gone.invitation.id);
    const late = await invite(email("late"));
    await db.invitation.update({ where: { id: late.invitation.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    const used = await invite(email("used"));
    await acceptInvitation({ token: used.token, viewerUserId: null, newAccount: { name: "Used Person", passwordHash: await strongHash() } });
    for (const token of [gone.token, late.token, used.token, newInvitationToken(), "x".repeat(43)]) expect(await previewInvitation(token)).toBeNull();
  });
});

test.describe("accepting — a person with no account", () => {
  test("creates the user (address verified), the membership with the invited role and campus, spends the link, audits — and lets them into the school", async () => {
    const to = email("newbie");
    const north = await db.campus.findFirstOrThrow({ where: { tenantId: a.id, name: "Alpha North" } });
    const { invitation, token } = await invite(to, { role: R.TEACHING_STAFF, campusId: north.id });
    const result = await acceptInvitation({ token, viewerUserId: null, newAccount: { name: "Nia Newbie", passwordHash: await strongHash() } });
    expect(result).toMatchObject({ ok: true, schoolCode: a.code, newAccount: true, reactivated: false });
    const user = await db.user.findUniqueOrThrow({ where: { email: to } });
    expect(user).toMatchObject({ name: "Nia Newbie" });
    expect(user.emailVerified).not.toBeNull(); // the link proved the address
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/); // a bcrypt hash, never the password
    expect(await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: user.id, tenantId: a.id } } })).toMatchObject({ role: "TEACHING_STAFF", campusId: north.id, deactivatedAt: null });
    expect(await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).toMatchObject({ acceptedById: user.id });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedAt).not.toBeNull();
    expect(await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "INVITATION_ACCEPTED", targetId: invitation.id } })).toMatchObject({ actorUserId: user.id, afterValue: { role: "TEACHING_STAFF", newAccount: true, reactivated: false } });
    await withEnv({ DEPLOYMENT_MODE: "saas" }, async () => {
      expect(await resolveTenant({ userId: user.id, code: a.code })).toMatchObject({ ok: true, tenant: { role: "TEACHING_STAFF", campusId: north.id } });
    });
  });

  test("single use: the same link again is INVALID and changes nothing", async () => {
    const { token } = await invite(email("single"));
    const input = { token, viewerUserId: null, newAccount: { name: "One Time", passwordHash: await strongHash() } };
    expect((await acceptInvitation(input)).ok).toBe(true);
    const users = await db.user.count();
    const members = await db.tenantMembership.count({ where: { tenantId: a.id } });
    expect(await acceptInvitation(input)).toEqual({ ok: false, reason: "INVALID" });
    expect(await db.user.count()).toBe(users);
    expect(await db.tenantMembership.count({ where: { tenantId: a.id } })).toBe(members);
  });

  test("two simultaneous accepts of one link: exactly ONE account and ONE membership; the other is told the link is used", async () => {
    const to = email("simul");
    const { token } = await invite(to);
    const hash = await strongHash();
    const results = await Promise.all([
      acceptInvitation({ token, viewerUserId: null, newAccount: { name: "First", passwordHash: hash } }),
      acceptInvitation({ token, viewerUserId: null, newAccount: { name: "Second", passwordHash: hash } }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok && ["INVALID", "SIGN_IN_REQUIRED"]).toContain(loser && !loser.ok ? loser.reason : "");
    expect(await db.user.count({ where: { email: to } })).toBe(1);
    const user = await db.user.findUniqueOrThrow({ where: { email: to } });
    expect(await db.tenantMembership.count({ where: { userId: user.id } })).toBe(1);
  });

  test("a failure part-way rolls EVERYTHING back: no user, no membership, and the link is still unspent", async () => {
    const to = email("rollback");
    const { invitation, token } = await invite(to);
    // A password hash that is not a string fails at the user insert — AFTER the link was claimed inside the transaction.
    await expect(acceptInvitation({ token, viewerUserId: null, newAccount: { name: "Doomed", passwordHash: 12345 as unknown as string } })).rejects.toThrow();
    expect(await db.user.count({ where: { email: to } })).toBe(0);
    expect(await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).toMatchObject({ acceptedAt: null, acceptedById: null });
    expect((await acceptInvitation({ token, viewerUserId: null, newAccount: { name: "Retry", passwordHash: await strongHash() } })).ok).toBe(true); // and it still works
  });

  test("it needs a name and a password: without them the link is NOT spent", async () => {
    const { invitation, token } = await invite(email("input"));
    expect(await acceptInvitation({ token, viewerUserId: null })).toEqual({ ok: false, reason: "INPUT_REQUIRED" });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedAt).toBeNull();
  });

  test("an expired link cannot be accepted — to the millisecond", async () => {
    const { invitation, token } = await invite(email("expired"));
    await db.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await acceptInvitation({ token, viewerUserId: null, newAccount: { name: "Late", passwordHash: await strongHash() } })).toEqual({ ok: false, reason: "INVALID" });
    await db.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() + 30_000) } });
    expect((await acceptInvitation({ token, viewerUserId: null, newAccount: { name: "On Time", passwordHash: await strongHash() } })).ok).toBe(true);
  });
});

test.describe("accepting — an account that already exists is attached only by its OWNER", () => {
  test("signed in as that account: the membership is created with the invited role", async () => {
    const owner = await createUser({ name: "Olu Owner" });
    const { token, invitation } = await invite(owner.email, { role: R.PARENT });
    const result = await acceptInvitation({ token, viewerUserId: owner.id });
    expect(result).toMatchObject({ ok: true, userId: owner.id, newAccount: false, reactivated: false });
    expect(await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: owner.id, tenantId: a.id } } })).toMatchObject({ role: "PARENT" });
    expect(await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).toMatchObject({ acceptedById: owner.id });
  });

  test("nobody signed in: SIGN_IN_REQUIRED — and the account is untouched and the link unspent (a new password is NOT accepted for an existing address)", async () => {
    const owner = await createUser();
    const { token, invitation } = await invite(owner.email);
    const before = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(await acceptInvitation({ token, viewerUserId: null, newAccount: { name: "Impostor", passwordHash: await strongHash() } })).toEqual({ ok: false, reason: "SIGN_IN_REQUIRED" });
    expect(await db.user.findUniqueOrThrow({ where: { id: owner.id } })).toEqual(before); // name, password hash: unchanged
    expect(await db.tenantMembership.count({ where: { userId: owner.id, tenantId: a.id } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedAt).toBeNull();
  });

  test("signed in as SOMEONE ELSE: WRONG_ACCOUNT — neither account gains a membership, and the link is unspent", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { token, invitation } = await invite(owner.email, { role: R.ADMIN });
    expect(await acceptInvitation({ token, viewerUserId: other.id })).toEqual({ ok: false, reason: "WRONG_ACCOUNT" });
    expect(await db.tenantMembership.count({ where: { tenantId: a.id, userId: { in: [owner.id, other.id] } } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedAt).toBeNull();
  });

  test("signed in, but the address has NO account (the session belongs to someone else): WRONG_ACCOUNT, not a silent sign-up", async () => {
    const other = await createUser();
    const { token } = await invite(email("stranger"));
    expect(await acceptInvitation({ token, viewerUserId: other.id, newAccount: { name: "X", passwordHash: await strongHash() } })).toEqual({ ok: false, reason: "WRONG_ACCOUNT" });
  });

  test("already a member: ALREADY_MEMBER, and the link is NOT spent", async () => {
    const member = await createUser();
    await addMembership(member.id, a.id, R.TEACHING_STAFF);
    // Created by the admin client, because the service itself (rightly) refuses to invite an existing member.
    const token = newInvitationToken();
    const row = await db.invitation.create({ data: { tenantId: a.id, email: member.email, role: R.ADMIN, tokenHash: hashInvitationToken(token), expiresAt: new Date(Date.now() + 60_000) } });
    expect(await acceptInvitation({ token, viewerUserId: member.id })).toEqual({ ok: false, reason: "ALREADY_MEMBER" });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).toBeNull();
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: member.id, tenantId: a.id } } })).role).toBe("TEACHING_STAFF"); // not promoted by a stray invitation
  });

  test("a DEACTIVATED member who accepts is reactivated with the invited role and campus (history kept: the same row)", async () => {
    const returning = await createUser();
    const original = await addMembership(returning.id, a.id, R.TEACHING_STAFF);
    await deactivateMembership(returning.id, a.id);
    const token = newInvitationToken();
    await db.invitation.create({ data: { tenantId: a.id, email: returning.email, role: R.NON_TEACHING_STAFF, tokenHash: hashInvitationToken(token), expiresAt: new Date(Date.now() + 60_000) } });
    expect(await acceptInvitation({ token, viewerUserId: returning.id })).toMatchObject({ ok: true, reactivated: true });
    const row = await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: returning.id, tenantId: a.id } } });
    expect(row).toMatchObject({ id: original.id, role: "NON_TEACHING_STAFF", deactivatedAt: null });
  });

  test("an invitation to school A can never create a membership in school B", async () => {
    const owner = await createUser();
    const { token } = await invite(owner.email);
    await acceptInvitation({ token, viewerUserId: owner.id });
    expect(await db.tenantMembership.count({ where: { userId: owner.id } })).toBe(1);
    expect(await db.tenantMembership.count({ where: { userId: owner.id, tenantId: b.id } })).toBe(0);
  });
});
