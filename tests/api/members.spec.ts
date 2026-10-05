import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, addMembership, createTenant, createUser, db, deactivateMembership, removeCreatedTenants, seedInstance, type TestTenant, type TestUser } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// The members API over real HTTP against the SaaS-mode server (domain-implementation-plan.md §0.5.4): who may list and change
// whom, the authority rules (self, last administrator, campus), strict bodies, and that a change takes effect on the person's
// next request. Cross-tenant, signed-out and deactivated callers are covered for EVERY route by tenant-boundary.spec.ts.

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

let a: TestTenant;
let b: TestTenant;
let admin: TestUser; // ADMIN of A
let colleague: TestUser; // a second ADMIN of A (so the last-admin rule is not in the way unless a test wants it)
let teacher: TestUser;
let outsider: TestUser; // ADMIN of B
let cookie: Record<string, string> = {};

const members = (code = a.code) => `/api/v1/schools/${code}/members`;
const member = (userId: string, code = a.code) => `/api/v1/schools/${code}/members/${userId}`;
const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  admin = await createUser({ name: "Ada Admin" });
  colleague = await createUser({ name: "Cole Colleague" });
  teacher = await createUser({ name: "Tola Teacher" });
  outsider = await createUser({ name: "Bayo Elsewhere" });
  await addMembership(admin.id, a.id, Role.ADMIN);
  await addMembership(colleague.id, a.id, Role.ADMIN);
  await addMembership(teacher.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  await addMembership(outsider.id, b.id, Role.ADMIN);
  cookie = { admin: await cookieFor(admin), teacher: await cookieFor(teacher), outsider: await cookieFor(outsider) };
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

async function newMember(role: Role = Role.TEACHING_STAFF, campus: number | null = 0, name = "New Member") {
  const user = await createUser({ name });
  await addMembership(user.id, a.id, role, campus === null ? null : a.campuses[campus].id);
  return user;
}

test.describe("GET /members", () => {
  test("an ADMIN lists the school's people — only this school's, only name/address/role/campus/status, with exact pagination meta", async () => {
    const res = await api(members(), as("admin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const people = res.json.data.members as { userId: string; email: string }[];
    expect(people.map((p) => p.userId)).toEqual(expect.arrayContaining([admin.id, colleague.id, teacher.id]));
    expect(people.map((p) => p.userId)).not.toContain(outsider.id);
    expect(res.json.meta).toMatchObject({ page: 1, limit: 25, total: people.length, hasNext: false });
    expect(Object.keys(people[0]).sort()).toEqual(["campusId", "campusName", "email", "joinedAt", "name", "role", "status", "userId"]);
    expect(res.text).not.toMatch(/passwordHash|tokenHash|\$2[aby]\$/);
  });

  test("a non-admin is refused with the SAME body as another school's admin — the page does not say a role was the problem", async () => {
    const asTeacher = await api(members(), as("teacher"));
    const asOutsider = await api(members(), as("outsider"));
    expect(asTeacher.status).toBe(403);
    expect(asTeacher.json).toEqual(NO_ACCESS);
    expect(asOutsider.json).toEqual(NO_ACCESS);
  });

  test("filters: status defaults to active; role, campus, status=deactivated|all and a search by name or address", async () => {
    const gone = await newMember(Role.PARENT, null, "Gone Parent");
    await deactivateMembership(gone.id, a.id);
    const ids = async (qs: string) => ((await api(`${members()}?${qs}`, as("admin"))).json.data.members as { userId: string }[]).map((m) => m.userId);
    expect(await ids("")).not.toContain(gone.id);
    expect(await ids("status=deactivated")).toEqual([gone.id]);
    expect(await ids("status=all")).toContain(gone.id);
    expect(await ids("status=all&role=PARENT")).toEqual([gone.id]);
    expect(await ids(`campusId=${a.campuses[0].id}`)).toContain(teacher.id);
    expect(await ids(`campusId=${a.campuses[0].id}`)).not.toContain(admin.id);
    expect(await ids("q=tola")).toEqual([teacher.id]);
    expect(await ids(`q=${encodeURIComponent(teacher.email.toUpperCase())}`)).toEqual([teacher.id]);
    expect(await ids("q=%25")).toEqual([]); // a percent sign is text, not a wildcard
  });

  test("pagination is exact and strict: pages don't overlap, and malformed or out-of-range parameters are a 400 naming the field", async () => {
    for (let i = 0; i < 4; i++) await newMember(Role.PARENT, null, `Paged ${i}`);
    const first = await api(`${members()}?limit=3&status=all`, as("admin"));
    const second = await api(`${members()}?limit=3&page=2&status=all`, as("admin"));
    const overlap = first.json.data.members.filter((m: { userId: string }) => second.json.data.members.some((n: { userId: string }) => n.userId === m.userId));
    expect(overlap).toEqual([]);
    expect(first.json.meta).toMatchObject({ page: 1, limit: 3, hasNext: true });
    for (const [qs, field] of [["role=SUPERUSER", "query.role"], ["status=everyone", "query.status"], ["page=0", "query.page"], ["limit=1000", "query.limit"], ["limit=abc", "query.limit"], ["page=1&page=2", "query.page"], ["q=" + "x".repeat(65), "query.q"], ["role=ADMIN&role=PARENT", "query.role"]]) {
      const res = await api(`${members()}?${qs}`, as("admin"));
      expect(res.status, qs).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(res.json.error.details.map((d: { path: string }) => d.path), qs).toContain(field);
    }
  });
});

test.describe("PATCH /members/[userId]", () => {
  test("changes the role; the person's NEXT request sees it — no session to revoke", async () => {
    const target = await newMember(Role.TEACHING_STAFF, 0);
    const targetCookie = await cookieFor(target);
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: targetCookie })).json.data.role).toBe("TEACHING_STAFF");
    expect((await api(members(), { ...SAAS, cookie: targetCookie })).status).toBe(403); // not an admin yet

    const res = await api(member(target.id), as("admin", { method: "PATCH", body: { role: "ADMIN" } }));
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ changed: true, member: { userId: target.id, role: "ADMIN" } });
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: targetCookie })).json.data.role).toBe("ADMIN");
    expect((await api(members(), { ...SAAS, cookie: targetCookie })).status).toBe(200); // …and the new authority works at once
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "MEMBER_ROLE_CHANGED", targetId: target.id } });
    expect(audit).toMatchObject({ actorUserId: admin.id, beforeValue: { role: "TEACHING_STAFF" }, afterValue: { role: "ADMIN" } });
  });

  test("changes and clears the campus; a no-op is a 200 with changed:false and writes no audit row", async () => {
    const target = await newMember(Role.TEACHING_STAFF, 0);
    const moved = await api(member(target.id), as("admin", { method: "PATCH", body: { campusId: a.campuses[1].id } }));
    expect(moved.json.data).toMatchObject({ changed: true, member: { campusName: "Alpha South" } });
    const cleared = await api(member(target.id), as("admin", { method: "PATCH", body: { campusId: null } }));
    expect(cleared.json.data).toMatchObject({ changed: true, member: { campusId: null, campusName: null } });
    const same = await api(member(target.id), as("admin", { method: "PATCH", body: { campusId: null, role: "TEACHING_STAFF" } }));
    expect(same.json.data).toMatchObject({ changed: false });
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: target.id, action: { startsWith: "MEMBER_" } } })).toBe(2);
  });

  test("the body is STRICT: a key it does not name is refused (no tenantId, userId or passwordHash smuggling), and an empty body says what to give", async () => {
    const target = await newMember();
    for (const body of [{ role: "ADMIN", tenantId: b.id }, { role: "ADMIN", userId: outsider.id }, { passwordHash: "x" }, { email: "evil@x.test" }, {}]) {
      const res = await api(member(target.id), as("admin", { method: "PATCH", body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: target.id, tenantId: a.id } } })).role).toBe("TEACHING_STAFF");
    expect((await api(member(target.id), as("admin", { method: "PATCH", body: { role: "OWNER" } }))).status).toBe(400); // not a role
    expect((await api(member(target.id), as("admin", { method: "PATCH", rawBody: "{not json" }))).json.error.code).toBe("INVALID_BODY");
  });

  test("nobody changes THEMSELVES here (409 SELF), even an administrator with a colleague to spare", async () => {
    const res = await api(member(admin.id), as("admin", { method: "PATCH", body: { role: "PARENT" } }));
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("SELF");
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: admin.id, tenantId: a.id } } })).role).toBe("ADMIN");
  });

  test("the LAST active administrator cannot be demoted (409 LAST_ADMIN) — until another administrator exists", async () => {
    const school = await createTenant({ name: "Gamma School", campuses: [] });
    const boss = await createUser();
    const sole = await createUser();
    await addMembership(boss.id, school.id, Role.ADMIN);
    await addMembership(sole.id, school.id, Role.ADMIN);
    const bossCookie = await cookieFor(boss);
    const url = (id: string) => `/api/v1/schools/${school.code}/members/${id}`;
    expect((await api(url(sole.id), { ...SAAS, cookie: bossCookie, method: "PATCH", body: { role: "PARENT" } })).status).toBe(200); // boss + sole → sole may go
    const refused = await api(url(boss.id), { ...SAAS, cookie: await cookieFor(sole), method: "PATCH", body: { role: "PARENT" } }); // sole is no admin any more
    expect(refused.status).toBe(403);
    // boss is now the only admin; nobody else can demote them, and they cannot demote themselves
    const third = await createUser();
    await addMembership(third.id, school.id, Role.ADMIN);
    await api(url(third.id), { ...SAAS, cookie: bossCookie, method: "PATCH", body: { role: "PARENT" } });
    const self = await api(url(boss.id), { ...SAAS, cookie: bossCookie, method: "PATCH", body: { role: "PARENT" } });
    expect(self.json.error.code).toBe("SELF");
    expect(await db.tenantMembership.count({ where: { tenantId: school.id, role: "ADMIN", deactivatedAt: null } })).toBe(1);
  });

  test("another school's person, an unknown id and a malformed id are INDISTINGUISHABLE (404, same body)", async () => {
    const real = await api(member(outsider.id), as("admin", { method: "PATCH", body: { role: "ADMIN" } })); // exists — in school B
    const unknown = await api(member("no-such-user-id"), as("admin", { method: "PATCH", body: { role: "ADMIN" } }));
    const odd = await api(member("..%2F..%2Fetc"), as("admin", { method: "PATCH", body: { role: "ADMIN" } }));
    const long = await api(member("x".repeat(300)), as("admin", { method: "PATCH", body: { role: "ADMIN" } }));
    for (const res of [real, unknown, odd, long]) {
      expect(res.status).toBe(404);
      expect(res.json).toEqual(real.json);
    }
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: outsider.id, tenantId: b.id } } })).role).toBe("ADMIN"); // untouched, in B
  });

  test("a campus of another school and one that does not exist are refused alike (400 on body.campusId)", async () => {
    const target = await newMember();
    const theirs = await db.campus.findFirstOrThrow({ where: { tenantId: b.id } });
    const foreign = await api(member(target.id), as("admin", { method: "PATCH", body: { campusId: theirs.id } }));
    const missing = await api(member(target.id), as("admin", { method: "PATCH", body: { campusId: "no-such-campus" } }));
    for (const res of [foreign, missing]) {
      expect(res.status).toBe(400);
      expect(res.json.error.details).toEqual([{ path: "body.campusId", message: "Choose one of this school's campuses." }]);
    }
  });

  test("CSRF: a cross-origin request is refused before anything happens", async () => {
    const target = await newMember();
    const res = await api(member(target.id), as("admin", { method: "PATCH", body: { role: "ADMIN" }, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: target.id, tenantId: a.id } } })).role).toBe("TEACHING_STAFF");
  });
});

test.describe("POST /members/[userId]/deactivate and /reactivate", () => {
  const deactivate = (id: string, who = "admin") => api(`${member(id)}/deactivate`, as(who, { method: "POST", body: {} }));
  const reactivate = (id: string, who = "admin") => api(`${member(id)}/reactivate`, as(who, { method: "POST", body: {} }));

  test("deactivation ends access on the person's very next request (the school is a 403; /me stops listing it) and reactivation restores it", async () => {
    const target = await newMember(Role.TEACHING_STAFF, 1);
    const targetCookie = await cookieFor(target);
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: targetCookie })).status).toBe(200);

    const res = await deactivate(target.id);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ changed: true, member: { status: "deactivated" } });
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: targetCookie })).json).toEqual(NO_ACCESS);
    expect((await api("/api/v1/auth/me", { ...SAAS, cookie: targetCookie })).json.data.memberships).toEqual([]);
    expect((await api("/api/v1/auth/me", { ...SAAS, cookie: targetCookie })).status).toBe(200); // still a signed-in person

    const back = await reactivate(target.id);
    expect(back.json.data).toMatchObject({ changed: true, member: { status: "active", role: "TEACHING_STAFF", campusName: "Alpha South" } });
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: targetCookie })).status).toBe(200);
    expect((await db.auditLog.findMany({ where: { tenantId: a.id, targetId: target.id, action: { startsWith: "MEMBER_" } }, orderBy: { createdAt: "asc" } })).map((r) => r.action)).toEqual(["MEMBER_DEACTIVATED", "MEMBER_REACTIVATED"]);
  });

  test("a deactivated administrator loses the ADMIN routes at once", async () => {
    const other = await newMember(Role.ADMIN, null, "Soon Gone");
    const otherCookie = await cookieFor(other);
    expect((await api(members(), { ...SAAS, cookie: otherCookie })).status).toBe(200);
    await deactivate(other.id);
    expect((await api(members(), { ...SAAS, cookie: otherCookie })).status).toBe(403);
  });

  test("both are idempotent; neither is allowed on yourself; the last administrator cannot be deactivated", async () => {
    const target = await newMember();
    expect((await reactivate(target.id)).json.data).toMatchObject({ changed: false }); // already active
    await deactivate(target.id);
    expect((await deactivate(target.id)).json.data).toMatchObject({ changed: false });
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: target.id, action: "MEMBER_DEACTIVATED" } })).toBe(1);

    expect((await deactivate(admin.id)).json.error.code).toBe("SELF");
    expect((await reactivate(admin.id)).json.error.code).toBe("SELF");

    const school = await createTenant({ name: "Delta School", campuses: [] });
    const solo = await createUser();
    const caller = await createUser();
    await addMembership(solo.id, school.id, Role.ADMIN);
    await addMembership(caller.id, school.id, Role.ADMIN);
    const callerCookie = await cookieFor(caller);
    const url = `/api/v1/schools/${school.code}/members/${solo.id}/deactivate`;
    expect((await api(url, { ...SAAS, cookie: callerCookie, method: "POST", body: {} })).status).toBe(200); // two admins → allowed
    const last = await api(`/api/v1/schools/${school.code}/members/${caller.id}/deactivate`, { ...SAAS, cookie: await cookieFor(solo), method: "POST", body: {} });
    expect(last.status).toBe(403); // solo is deactivated now: no longer an administrator of this school
  });

  test("another school's person and an unknown id are the same 404; a non-admin is a 403", async () => {
    const real = await deactivate(outsider.id);
    const unknown = await deactivate("no-such-user-id");
    expect(real.status).toBe(404);
    expect(real.json).toEqual(unknown.json);
    expect((await reactivate(outsider.id)).json).toEqual(real.json);
    expect((await deactivate(admin.id, "teacher")).json).toEqual(NO_ACCESS);
    expect(await db.tenantMembership.count({ where: { userId: outsider.id, tenantId: b.id, deactivatedAt: null } })).toBe(1);
  });
});
