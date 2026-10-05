import "../support/env";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, addMembership, createTenant, createUser, db, deactivateMembership, removeCreatedTenants, seedInstance, type TestTenant, type TestUser } from "../support/db";
import { api, cookieHeader, loginAs, sessionCookie } from "../support/http";
import { mailAfterGrace, tokenFrom, waitForMail } from "../support/outbox";
import { BREACHED_MESSAGE } from "@/lib/auth/pwned-password";
import { verifyPassword } from "@/lib/auth/password";
import { hashInvitationToken, newInvitationToken } from "@/lib/invitations/token";

// Invitations over real HTTP against the SaaS-mode server (domain-implementation-plan.md §0.5.4): the administrator's side
// (invite, list, resend, revoke — hashed single-use links, mailed after the response, the same answer whatever the address),
// and the invitee's PUBLIC side (preview, accept) with its one rule: an existing account is attached only by its owner.

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };
const INVALID = { data: null, meta: {}, error: { code: "INVALID_TOKEN", message: "This invitation link is invalid or has expired. Ask your administrator to send a new one." } };
const BREACHED = "Tr0ub4dor&3-but-leaked";
const FRESH = "a-fresh-unseen-passphrase-3";

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let teacher: TestUser;
let adminCookies: string[] = [];
let adminTurn = 0;
let teacherCookie: string;

const unique = (label: string) => `${label}-${crypto.randomBytes(3).toString("hex")}@invite.test`;
// The per-administrator invitation limit (30 per 5 minutes) is real, and this file sends more than that — so the school has a few
// administrators (all "Ada Admin") and the helpers take turns, exactly as a busy school's would.
const asAdmin = (extra: object = {}) => ({ ...SAAS, cookie: adminCookies[adminTurn++ % adminCookies.length], ...extra });
const invitations = (code = a.code) => `/api/v1/schools/${code}/invitations`;
const invite = (email: string, role = "TEACHING_STAFF", extra: Record<string, unknown> = {}) => api(invitations(), asAdmin({ method: "POST", body: { email, role, ...extra } }));
async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}
/// Invites and returns the token the way the invitee gets it: from the mailed link.
async function invitedWithToken(email: string, role = "TEACHING_STAFF") {
  const res = await invite(email, role);
  expect(res.status).toBe(201);
  const mail = await waitForMail(email);
  return { res, token: tokenFrom(mail[mail.length - 1]), id: res.json.data.invitation.id as string };
}
const preview = (token: string, extra: object = {}) => api("/api/v1/invitations/preview", { ...SAAS, body: { token }, ...extra });
const accept = (body: unknown, extra: object = {}) => api("/api/v1/invitations/accept", { ...SAAS, body, ...extra });

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  admin = await createUser({ name: "Ada Admin" });
  teacher = await createUser({ name: "Tola Teacher" });
  await addMembership(admin.id, a.id, Role.ADMIN);
  await addMembership(teacher.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  adminCookies = [await cookieFor(admin)];
  for (let i = 0; i < 5; i++) {
    const more = await createUser({ name: "Ada Admin" });
    await addMembership(more.id, a.id, Role.ADMIN);
    adminCookies.push(await cookieFor(more));
  }
  teacherCookie = await cookieFor(teacher);
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("POST /invitations — the administrator invites", () => {
  test("201 with the invitation (no token, no hash); the mail carries a FRAGMENT link; only the hash is stored; the audit row has no secret", async () => {
    const to = unique("new");
    const res = await invite(to, "PARENT", { campusId: a.campuses[1].id });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.json.data.invitation).toMatchObject({ email: to, role: "PARENT", campusName: "Alpha South", status: "pending", invitedByName: "Ada Admin" });
    expect(res.text).not.toMatch(/token/i);

    const [mail] = await waitForMail(to);
    expect(mail.subject).toBe("You're invited to join Alpha School on Octalve Edu");
    expect(mail.text).toContain("Ada Admin invited you to join Alpha School");
    expect(mail.text).toMatch(/\/accept-invite#token=[A-Za-z0-9_-]{43}\b/);
    expect(mail.text).not.toContain("?token=");
    const token = tokenFrom(mail);

    const row = await db.invitation.findUniqueOrThrow({ where: { id: res.json.data.invitation.id } });
    expect(row.tokenHash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(await db.auditLog.findMany({ where: { tenantId: a.id, targetId: row.id } }))).not.toContain(token);
    expect((await preview(token)).status).toBe(200); // and the mailed link really works
  });

  test("the SAME answer whether or not the address has an account — even on another school: the administrator learns nothing about who is registered", async () => {
    const elsewhere = await createUser();
    await addMembership(elsewhere.id, b.id, Role.ADMIN);
    const known = await invite(elsewhere.email, "PARENT");
    const unknown = await invite(unique("stranger"), "PARENT");
    expect(known.status).toBe(unknown.status);
    expect(Object.keys(known.json.data.invitation).sort()).toEqual(Object.keys(unknown.json.data.invitation).sort());
    expect(Object.keys(known.json.data)).toEqual(Object.keys(unknown.json.data));
    expect(known.json.meta).toEqual(unknown.json.meta);
    // …and both are mailed alike
    expect((await waitForMail(elsewhere.email))[0].text).toContain("accept-invite#token=");
  });

  test("inviting the same address again revokes the earlier link (only the newest works)", async () => {
    const to = unique("again");
    const first = await invitedWithToken(to);
    const second = await api(invitations(), asAdmin({ method: "POST", body: { email: to, role: "TEACHING_STAFF" } }));
    expect(second.status).toBe(201);
    const newest = tokenFrom((await waitForMail(to, 2))[1]);
    expect((await preview(first.token)).json).toEqual(INVALID);
    expect((await preview(newest)).status).toBe(200);
    expect(await db.invitation.count({ where: { tenantId: a.id, email: to, acceptedAt: null, revokedAt: null } })).toBe(1);
  });

  test("an address that is already a member (409), one deactivated here (409 — reactivate instead) and a bad campus (400) create nothing and send nothing", async () => {
    const gone = await createUser();
    await addMembership(gone.id, a.id, Role.PARENT);
    await deactivateMembership(gone.id, a.id);
    const before = await db.invitation.count({ where: { tenantId: a.id } });
    const member = await invite(teacher.email);
    expect(member.status).toBe(409);
    expect(member.json.error.code).toBe("ALREADY_MEMBER");
    const deactivated = await invite(gone.email);
    expect(deactivated.status).toBe(409);
    expect(deactivated.json.error.code).toBe("DEACTIVATED_MEMBER");
    const theirs = await db.campus.findFirstOrThrow({ where: { tenantId: b.id } });
    for (const campusId of [theirs.id, "no-such-campus"]) {
      const res = await invite(unique("campus"), "TEACHING_STAFF", { campusId });
      expect(res.status).toBe(400);
      expect(res.json.error.details).toEqual([{ path: "body.campusId", message: "Choose one of this school's campuses." }]);
    }
    expect(await db.invitation.count({ where: { tenantId: a.id } })).toBe(before);
    expect(await mailAfterGrace(gone.email, 600)).toEqual([]);
  });

  test("validation: not an address, empty, too long, a role that does not exist, a body with extra keys — all 400, nothing created", async () => {
    const before = await db.invitation.count({ where: { tenantId: a.id } });
    for (const body of [
      { email: "not-an-address", role: "PARENT" },
      { email: "", role: "PARENT" },
      { email: `${"x".repeat(250)}@x.test`, role: "PARENT" },
      { role: "PARENT" },
      { email: unique("v"), role: "OWNER" },
      { email: unique("v") },
      { email: unique("v"), role: "PARENT", tenantId: b.id },
      { email: unique("v"), role: "PARENT", tokenHash: "x" },
      { email: unique("v"), role: "PARENT", campusId: 5 },
    ]) {
      const res = await api(invitations(), asAdmin({ method: "POST", body }));
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    expect((await api(invitations(), asAdmin({ method: "POST", rawBody: "nope" }))).json.error.code).toBe("INVALID_BODY");
    expect(await db.invitation.count({ where: { tenantId: a.id } })).toBe(before);
  });

  test("the address is trimmed and lower-cased; the per-address limit (3) answers the 4th with a 429", async () => {
    const base = unique("limit");
    const res = await invite(`  ${base.toUpperCase()}  `);
    expect(res.json.data.invitation.email).toBe(base);
    expect((await invite(base)).status).toBe(201);
    expect((await invite(base)).status).toBe(201);
    const fourth = await invite(base);
    expect(fourth.status).toBe(429);
    expect(fourth.json.error.code).toBe("RATE_LIMITED");
  });

  test("a non-admin is refused with the one 403 body, and CSRF is enforced", async () => {
    const as = await api(invitations(), { ...SAAS, cookie: teacherCookie, method: "POST", body: { email: unique("t"), role: "PARENT" } });
    expect(as.status).toBe(403);
    expect(as.json).toEqual(NO_ACCESS);
    const csrf = await api(invitations(), asAdmin({ method: "POST", body: { email: unique("c"), role: "PARENT" }, origin: "https://evil.example" }));
    expect(csrf.status).toBe(403);
    expect(csrf.json.error.code).toBe("CSRF");
  });
});

test.describe("GET, resend, revoke", () => {
  test("the list shows the school's OPEN invitations with status, never a token or hash — and never another school's", async () => {
    const school = await createTenant({ name: "Gamma School", campuses: [] });
    const boss = await createUser();
    await addMembership(boss.id, school.id, Role.ADMIN);
    const bossCookie = await cookieFor(boss);
    const url = `/api/v1/schools/${school.code}/invitations`;
    const mine = unique("listed");
    await api(url, { ...SAAS, cookie: bossCookie, method: "POST", body: { email: mine, role: "PARENT" } });
    await invite(unique("other-school"));
    const res = await api(url, { ...SAAS, cookie: bossCookie });
    expect(res.status).toBe(200);
    expect(res.json.data.invitations.map((i: { email: string }) => i.email)).toEqual([mine]);
    expect(res.json.meta).toMatchObject({ page: 1, total: 1 });
    expect(res.text).not.toMatch(/token/i);
    expect((await api(`${url}?page=0`, { ...SAAS, cookie: bossCookie })).status).toBe(400);
    expect((await api(invitations(), { ...SAAS, cookie: teacherCookie })).json).toEqual(NO_ACCESS);
  });

  test("resend: a NEW mail and link; the old link stops working at once; limited to 3; an unknown or foreign id is the one 404", async () => {
    const to = unique("resend");
    const first = await invitedWithToken(to);
    const resent = await api(`${invitations()}/${first.id}/resend`, asAdmin({ method: "POST", body: {} }));
    expect(resent.status).toBe(200);
    expect(resent.text).not.toMatch(/token/i);
    const second = tokenFrom((await waitForMail(to, 2))[1]);
    expect(second).not.toBe(first.token);
    expect((await preview(first.token)).json).toEqual(INVALID);
    expect((await preview(second)).status).toBe(200);

    await api(`${invitations()}/${first.id}/resend`, asAdmin({ method: "POST", body: {} }));
    await api(`${invitations()}/${first.id}/resend`, asAdmin({ method: "POST", body: {} }));
    expect((await api(`${invitations()}/${first.id}/resend`, asAdmin({ method: "POST", body: {} }))).status).toBe(429);

    const theirs = await db.invitation.create({ data: { tenantId: b.id, email: unique("b"), role: Role.PARENT, tokenHash: hashInvitationToken(newInvitationToken()), expiresAt: new Date(Date.now() + 60_000) } });
    const foreign = await api(`${invitations()}/${theirs.id}/resend`, asAdmin({ method: "POST", body: {} }));
    const unknown = await api(`${invitations()}/no-such-invitation/resend`, asAdmin({ method: "POST", body: {} }));
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(unknown.json);
  });

  test("revoke: the link dies, a second revoke and a foreign or unknown id are the same 404, a non-admin is refused", async () => {
    const to = unique("revoke");
    const { token, id } = await invitedWithToken(to);
    expect((await api(`${invitations()}/${id}`, { ...SAAS, cookie: teacherCookie, method: "DELETE" })).json).toEqual(NO_ACCESS);
    const done = await api(`${invitations()}/${id}`, asAdmin({ method: "DELETE" }));
    expect(done.status).toBe(200);
    expect(done.json.data).toEqual({ revoked: true });
    expect((await preview(token)).json).toEqual(INVALID);
    const again = await api(`${invitations()}/${id}`, asAdmin({ method: "DELETE" }));
    const unknown = await api(`${invitations()}/no-such-invitation`, asAdmin({ method: "DELETE" }));
    expect(again.status).toBe(404);
    expect(again.json).toEqual(unknown.json);
    expect(await db.auditLog.count({ where: { tenantId: a.id, action: "INVITATION_REVOKED", targetId: id } })).toBe(1);
  });
});

test.describe("POST /invitations/preview — public", () => {
  test("shows the school, the role, a MASKED address and whether an account exists — with no-store", async () => {
    const to = unique("peek");
    const { token } = await invitedWithToken(to, "STUDENT");
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json.data).toEqual({ schoolName: "Alpha School", role: "STUDENT", roleLabel: "Student", email: expect.stringMatching(/^p\*\*\*@invite\.test$/), accountExists: false, viewer: "none" });
    expect(res.text).not.toContain(to);
  });

  test("tells a signed-in person whether they are the invitee or someone else", async () => {
    const owner = await createUser();
    const { token } = await invitedWithToken(owner.email, "PARENT");
    expect((await preview(token)).json.data).toMatchObject({ accountExists: true, viewer: "none" });
    expect((await preview(token, { cookie: await cookieFor(owner) })).json.data).toMatchObject({ viewer: "invitee" });
    expect((await preview(token, { cookie: teacherCookie })).json.data).toMatchObject({ viewer: "other" });
  });

  test("unknown, malformed, wrong-length, revoked, expired and used links all get the IDENTICAL answer (400, same body)", async () => {
    const revoked = await invitedWithToken(unique("rv"));
    await api(`${invitations()}/${revoked.id}`, asAdmin({ method: "DELETE" }));
    const expired = await invitedWithToken(unique("ex"));
    await db.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const used = await invitedWithToken(unique("us"));
    await accept({ token: used.token, name: "Used Person", password: FRESH });
    for (const token of [newInvitationToken(), "short", "", "x".repeat(300), revoked.token, expired.token, used.token, "../../etc/passwd", "😀".repeat(20)]) {
      const res = await preview(token);
      expect(res.status, token.slice(0, 20)).toBe(400);
      expect(res.json, token.slice(0, 20)).toEqual(INVALID);
    }
    expect((await api("/api/v1/invitations/preview", { ...SAAS, body: { token: 42 } })).json).toEqual(INVALID);
    expect((await api("/api/v1/invitations/preview", { ...SAAS, body: {} })).json).toEqual(INVALID);
    expect((await api("/api/v1/invitations/preview", { ...SAAS, rawBody: "{" })).json.error.code).toBe("INVALID_BODY");
  });

  test("it is public but not cross-site: a cross-origin request is a 403", async () => {
    const { token } = await invitedWithToken(unique("cs"));
    const res = await preview(token, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });
});

test.describe("POST /invitations/accept — a person with no account", () => {
  test("creates the account and the membership; does NOT sign them in; they then sign in with the password they chose; the link is spent", async () => {
    const to = unique("newbie");
    const { token } = await invitedWithToken(to, "TEACHING_STAFF");
    const res = await accept({ token, name: "  Nia   Newbie ", password: FRESH });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json.data).toEqual({ accepted: true, schoolCode: a.code, newAccount: true });
    expect(sessionCookie(res)).toBeUndefined(); // a link in a mailbox is not a session

    const user = await db.user.findUniqueOrThrow({ where: { email: to } });
    expect(user.name).toBe("Nia Newbie");
    expect(user.emailVerified).not.toBeNull();
    expect(await verifyPassword(FRESH, user.passwordHash)).toBe(true);
    const login = await loginAs({ email: to, password: FRESH }, SAAS);
    expect(login.status).toBe(200);
    const school = await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: cookieHeader(login.token!) });
    expect(school.status).toBe(200);
    expect(school.json.data.role).toBe("TEACHING_STAFF");

    expect((await accept({ token, name: "Again", password: FRESH })).json).toEqual(INVALID); // single use
    expect((await preview(token)).json).toEqual(INVALID);
    expect(await db.user.count({ where: { email: to } })).toBe(1);
  });

  test("a breached or weak password and a bad name are explained field by field BEFORE the link is spent — and the link then still works", async () => {
    const to = unique("fixme");
    const { token, id } = await invitedWithToken(to);
    const breached = await accept({ token, name: "Fix Me", password: BREACHED });
    expect(breached.status).toBe(400);
    expect(breached.json.error).toMatchObject({ code: "VALIDATION", details: [{ path: "body.password", message: BREACHED_MESSAGE }] });
    const weak = await accept({ token, name: "Fix Me", password: "short" });
    expect(weak.json.error.details[0].path).toBe("body.password");
    const noPassword = await accept({ token, name: "Fix Me" });
    expect(noPassword.json.error.details).toEqual([{ path: "body.password", message: "Choose a password." }]);
    const badName = await accept({ token, name: "Evil‮name", password: FRESH });
    expect(badName.json.error.details).toEqual([{ path: "body.name", message: expect.any(String) }]);
    const noName = await accept({ token, password: FRESH });
    expect(noName.json.error.details[0].path).toBe("body.name");
    expect(await db.user.count({ where: { email: to } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id } })).acceptedAt).toBeNull();
    expect((await accept({ token, name: "Fix Me", password: FRESH })).status).toBe(200);
  });

  test("two people opening one link at once: exactly one account is made", async () => {
    const to = unique("simul");
    const { token } = await invitedWithToken(to);
    const results = await Promise.all([accept({ token, name: "First", password: FRESH }), accept({ token, name: "Second", password: FRESH })]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.user.count({ where: { email: to } })).toBe(1);
  });

  test("public but not cross-site (403), and garbage is the same generic 400", async () => {
    const { token } = await invitedWithToken(unique("csrf"));
    expect((await accept({ token, name: "X Y", password: FRESH }, { origin: "https://evil.example" })).json.error.code).toBe("CSRF");
    expect((await accept({ token: "nope", name: "X Y", password: FRESH })).json).toEqual(INVALID);
    expect((await accept("a string, not an object")).json).toEqual(INVALID);
  });

  test("failures are limited per IP (10); a success is refunded, so a person who fixes typos is never locked out", async () => {
    const ip = `10.66.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
    const { token } = await invitedWithToken(unique("ratelimit"));
    for (let i = 0; i < 9; i++) expect((await accept({ token: newInvitationToken(), name: "X Y", password: FRESH }, { ip })).status).toBe(400);
    expect((await accept({ token, name: "Rate Limit", password: FRESH }, { ip })).status).toBe(200); // the 10th: allowed, and refunded
    // Refunded means the budget is back: the next ten failures are still ANSWERED (400), not refused (429).
    for (let i = 0; i < 10; i++) expect((await accept({ token: newInvitationToken(), name: "X Y", password: FRESH }, { ip })).status, `failure ${i + 1} after the success`).toBe(400);
    const blocked = await accept({ token: newInvitationToken(), name: "X Y", password: FRESH }, { ip });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
  });
});

test.describe("POST /invitations/accept — an account that already exists is attached only by its OWNER", () => {
  test("signed in as that account: the membership is created, with the invited role, and the person can use the school", async () => {
    const owner = await createUser({ name: "Olu Owner" });
    const { token } = await invitedWithToken(owner.email, "PARENT");
    const ownerCookie = await cookieFor(owner);
    const res = await accept({ token }, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ accepted: true, schoolCode: a.code, newAccount: false });
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: ownerCookie })).json.data.role).toBe("PARENT");
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).name).toBe("Olu Owner"); // nothing about the account changed
  });

  test("nobody signed in: 409 SIGN_IN_REQUIRED — a name and password in the body are IGNORED, the account is untouched, the link unspent", async () => {
    const owner = await createUser();
    const { token, id } = await invitedWithToken(owner.email);
    const before = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    const res = await accept({ token, name: "Impostor", password: FRESH });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("SIGN_IN_REQUIRED");
    expect(await db.user.findUniqueOrThrow({ where: { id: owner.id } })).toEqual(before);
    expect(await db.tenantMembership.count({ where: { userId: owner.id } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id } })).acceptedAt).toBeNull();
    expect((await accept({ token }, { cookie: await cookieFor(owner) })).status).toBe(200); // and the owner can still use it
  });

  test("signed in as SOMEONE ELSE: 403 WRONG_ACCOUNT — and that is true even when the address has no account at all", async () => {
    const owner = await createUser();
    const { token, id } = await invitedWithToken(owner.email, "ADMIN");
    const wrong = await accept({ token }, { cookie: teacherCookie });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe("WRONG_ACCOUNT");
    expect(await db.tenantMembership.count({ where: { userId: { in: [owner.id, teacher.id] }, role: "ADMIN" } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id } })).acceptedAt).toBeNull();

    const fresh = await invitedWithToken(unique("noaccount"));
    const stillWrong = await accept({ token: fresh.token, name: "New Person", password: FRESH }, { cookie: teacherCookie });
    expect(stillWrong.json.error.code).toBe("WRONG_ACCOUNT"); // not a silent sign-up while signed in as someone else
  });

  test("already a member: 409 ALREADY_MEMBER and the link is not spent; a deactivated member is reactivated by accepting", async () => {
    const member = await createUser();
    await addMembership(member.id, a.id, Role.TEACHING_STAFF);
    const token = newInvitationToken();
    const row = await db.invitation.create({ data: { tenantId: a.id, email: member.email, role: Role.ADMIN, tokenHash: hashInvitationToken(token), expiresAt: new Date(Date.now() + 60_000) } });
    const memberCookie = await cookieFor(member);
    const res = await accept({ token }, { cookie: memberCookie });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("ALREADY_MEMBER");
    expect((await db.invitation.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).toBeNull();

    await deactivateMembership(member.id, a.id);
    const back = await accept({ token }, { cookie: memberCookie });
    expect(back.status).toBe(200);
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: memberCookie })).json.data.role).toBe("ADMIN"); // the invited role
  });
});
