import "../support/env";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, addMembership, createTenant, createUser, db, deactivateMembership, removeCreatedTenants, seedInstance, type TestTenant, type TestUser } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// The tenant trust boundary over real HTTP (domain-implementation-plan.md §0.5.2). Several schools share one
// database here, so this runs on the SaaS-mode server; the Solo servers fail closed when a second school exists.

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

let a: TestTenant;
let b: TestTenant;
let adminA: TestUser;
let teacherA: TestUser;
let adminB: TestUser;
let both: TestUser; // student in A, admin in B
let outsider: TestUser;
let deactivated: TestUser; // an ADMIN of school A whom an administrator has deactivated there
let cookies: Record<string, string>;

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status, `sign-in of ${user.email}`).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  adminA = await createUser();
  teacherA = await createUser();
  adminB = await createUser();
  both = await createUser();
  outsider = await createUser();
  deactivated = await createUser();
  await addMembership(adminA.id, a.id, Role.ADMIN);
  await addMembership(teacherA.id, a.id, Role.TEACHING_STAFF, a.campuses[1].id);
  await addMembership(adminB.id, b.id, Role.ADMIN);
  await addMembership(both.id, a.id, Role.STUDENT, a.campuses[0].id);
  await addMembership(both.id, b.id, Role.ADMIN);
  await addMembership(deactivated.id, a.id, Role.ADMIN);
  await deactivateMembership(deactivated.id, a.id);
  cookies = {
    adminA: await cookieFor(adminA),
    teacherA: await cookieFor(teacherA),
    adminB: await cookieFor(adminB),
    both: await cookieFor(both),
    outsider: await cookieFor(outsider),
    deactivated: await cookieFor(deactivated),
  };
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

const school = (code: string, who: string, extra: object = {}) => api(`/api/v1/schools/${code}`, { ...SAAS, cookie: cookies[who], ...extra });

test.describe("GET /api/v1/schools/[code]", () => {
  test("an ADMIN sees their school's role and EVERY campus of it — and nothing of the other school", async () => {
    const res = await school(a.code, "adminA");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.json.data).toEqual({
      school: { code: a.code, name: "Alpha School" },
      role: "ADMIN",
      campusId: null,
      campuses: [{ id: a.campuses[0].id, name: "Alpha North" }, { id: a.campuses[1].id, name: "Alpha South" }],
    });
    expect(res.text).not.toContain("Beta");
    expect(res.text).not.toContain(b.code);
  });

  test("a non-admin sees only THEIR campus", async () => {
    const res = await school(a.code, "teacherA");
    expect(res.json.data.role).toBe("TEACHING_STAFF");
    expect(res.json.data.campuses).toEqual([{ id: a.campuses[1].id, name: "Alpha South" }]);
  });

  test("a non-admin with no campus assigned sees none", async () => {
    const lonely = await createUser();
    await addMembership(lonely.id, a.id, Role.NON_TEACHING_STAFF, null);
    const res = await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie: await cookieFor(lonely) });
    expect(res.status).toBe(200);
    expect(res.json.data.campuses).toEqual([]);
  });

  test("one person in two schools gets each school's OWN role and data", async () => {
    const asA = await school(a.code, "both");
    const asB = await school(b.code, "both");
    expect(asA.json.data).toMatchObject({ school: { code: a.code }, role: "STUDENT", campuses: [{ name: "Alpha North" }] });
    expect(asB.json.data).toMatchObject({ school: { code: b.code }, role: "ADMIN", campuses: [{ name: "Beta Main" }] });
  });

  test("changing [code] to another school's code is a 403 — for an admin, a teacher and a person with no school at all", async () => {
    for (const [who, code] of [["adminA", b.code], ["teacherA", b.code], ["adminB", a.code], ["outsider", a.code], ["outsider", b.code]] as const) {
      const res = await school(code, who);
      expect(res.status, `${who} → ${code}`).toBe(403);
      expect(res.json).toEqual(NO_ACCESS);
    }
  });

  test("another school, an unknown school and a malformed code are INDISTINGUISHABLE (status, body, headers)", async () => {
    const real = await school(b.code, "adminA");
    const others = [
      await school("no-such-school", "adminA"),
      await school("dashboard", "adminA"), // a reserved word
      await school("..%2F..%2Fetc%2Fpasswd", "adminA"),
      await school("A%20B", "adminA"),
      await school("x".repeat(300), "adminA"),
    ];
    for (const res of others) {
      expect(res.status).toBe(real.status);
      expect(res.json).toEqual(real.json);
      expect(res.headers.get("cache-control")).toBe(real.headers.get("cache-control"));
    }
  });

  test("not signed in is a 401, the same for a real code and an unknown one", async () => {
    const real = await api(`/api/v1/schools/${a.code}`, SAAS);
    const unknown = await api("/api/v1/schools/no-such-school", SAAS);
    expect(real.status).toBe(401);
    expect(real.json).toEqual(unknown.json);
    expect(real.json.error.code).toBe("UNAUTHENTICATED");
  });

  test("an ended session is a 401 at once", async () => {
    const user = await createUser();
    await addMembership(user.id, a.id, Role.ADMIN);
    const cookie = await cookieFor(user);
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie })).status).toBe(200);
    await api("/api/v1/auth/logout", { ...SAAS, method: "POST", cookie });
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie })).status).toBe(401);
  });

  test("a membership removed while signed in stops working on the very next request", async () => {
    const user = await createUser();
    const membership = await addMembership(user.id, a.id, Role.TEACHING_STAFF);
    const cookie = await cookieFor(user);
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie })).status).toBe(200);
    await db.tenantMembership.delete({ where: { id: membership.id } });
    expect((await api(`/api/v1/schools/${a.code}`, { ...SAAS, cookie })).status).toBe(403);
  });

  test("a school's name is data: markup in it is returned as a plain JSON string (and never executed — the page spec renders it)", async () => {
    const odd = await createTenant({ name: `<img src=x onerror=alert(1)> & "School"`, campuses: ["<b>Main</b>"] });
    const user = await createUser();
    await addMembership(user.id, odd.id, Role.ADMIN);
    const res = await api(`/api/v1/schools/${odd.code}`, { ...SAAS, cookie: await cookieFor(user) });
    expect(res.json.data.school.name).toBe(`<img src=x onerror=alert(1)> & "School"`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// Every route under /api/v1/schools/ is discovered from the file system, so a route added later without the
// check cannot slip past this file: it is called with ANOTHER school's code, with no session, and with a person
// who belongs to no school, and every one of those must be refused.
test.describe("EVERY tenant route enforces the boundary", () => {
  const root = path.join(process.cwd(), "src/app/api/v1/schools");

  function discover(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return discover(full);
      return entry.name === "route.ts" ? [full] : [];
    });
  }
  const routes = discover(root).map((file) => {
    const source = fs.readFileSync(file, "utf8");
    const methods = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
    const urlPath = "/api/v1/schools/" + path.relative(path.join(root), path.dirname(file)).split(path.sep).join("/");
    return { file: path.relative(process.cwd(), file), source, methods, urlPath: urlPath.replace(/\/$/, "") };
  });

  test("the discovery found the routes it is meant to guard", () => {
    expect(routes.length).toBeGreaterThanOrEqual(1);
    for (const route of routes) expect(route.methods.length, route.file).toBeGreaterThan(0);
  });

  test("every route file wraps ALL its handlers in withAuth(…, { tenant: true … })", () => {
    for (const route of routes) {
      const exported = [...route.source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = withAuth\(/g)].map((m) => m[1]);
      expect(exported.sort(), `${route.file}: a handler is not wrapped in withAuth`).toEqual([...route.methods].sort());
      const tenantOptions = [...route.source.matchAll(/\{\s*tenant:\s*true\b/g)].length;
      expect(tenantOptions, `${route.file}: a handler is missing { tenant: true }`).toBeGreaterThanOrEqual(route.methods.length);
      expect(route.source, `${route.file} must not reach for the raw client`).not.toMatch(/from "@\/lib\/db"/);
    }
  });

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    test(`${method}: another school's code → 403, no session → 401, no school at all → 403 — on every route that has it`, async () => {
      for (const route of routes.filter((r) => r.methods.includes(method))) {
        const url = (code: string) => route.urlPath.replace("[code]", code);
        const body = method === "GET" ? {} : { body: {} };
        const request = (code: string, who?: string) => api(url(code), { ...SAAS, method, ...body, ...(who ? { cookie: cookies[who] } : {}) });
        // adminA is an ADMIN — of school A. On school B they hold nothing.
        const crossTenant = await request(b.code, "adminA");
        expect(crossTenant.status, `${method} ${url(b.code)} as an admin of ANOTHER school`).toBe(403);
        expect(crossTenant.json).toEqual(NO_ACCESS);
        expect((await request(a.code, "outsider")).status, `${method} ${url(a.code)} as a person with no school`).toBe(403);
        // A deactivated member is no member: the same refusal, to the byte, as a stranger's.
        const gone = await request(a.code, "deactivated");
        expect(gone.status, `${method} ${url(a.code)} as a DEACTIVATED member of that very school`).toBe(403);
        expect(gone.json).toEqual(NO_ACCESS);
        expect((await request(a.code)).status, `${method} ${url(a.code)} signed out`).toBe(401);
      }
    });
  }
});
