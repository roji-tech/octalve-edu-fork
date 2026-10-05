import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant, type TestUser } from "../support/db";
import Redis from "ioredis";
import { TEST_REDIS_URL } from "../support/env";
import { api, cookieHeader, loginAs } from "../support/http";

// /api/v1/schools/[code]/campuses — the first consumers of pagination, validation, roles and the tenant context
// (plan §0.5.3, B). Runs on the SaaS-mode server (several schools in one database).

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let teacher: TestUser;
let cookies: Record<string, string>;

const cookieFor = async (user: TestUser) => cookieHeader((await loginAs(user, SAAS)).token!);
const list = (code: string, who: string, query = "") => api(`/api/v1/schools/${code}/campuses${query}`, { ...SAAS, cookie: cookies[who] });
const create = (code: string, who: string, body: unknown, extra: object = {}) => api(`/api/v1/schools/${code}/campuses`, { ...SAAS, cookie: cookies[who], body, ...extra });

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Charlie", "Alpha", "Bravo", "Delta", "Echo"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  admin = await createUser();
  teacher = await createUser();
  await addMembership(admin.id, a.id, Role.ADMIN);
  await addMembership(teacher.id, a.id, Role.TEACHING_STAFF, a.campuses.find((c) => c.name === "Bravo")!.id);
  cookies = { admin: await cookieFor(admin), teacher: await cookieFor(teacher) };
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("GET /campuses", () => {
  test("an ADMIN gets every campus of the school, sorted by name, with pagination meta — and none of another school's", async () => {
    const res = await list(a.code, "admin");
    expect(res.status).toBe(200);
    expect(res.json.data.campuses.map((c: { name: string }) => c.name)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    expect(res.json.meta).toEqual({ page: 1, limit: 25, total: 5, pages: 1, hasNext: false });
    expect(res.text).not.toContain("Beta Main");
  });

  test("pages are exact: limit 2 → 3 pages, no overlap, no gaps, hasNext only while there is more", async () => {
    const seen: string[] = [];
    for (const [page, expectNext] of [[1, true], [2, true], [3, false]] as const) {
      const res = await list(a.code, "admin", `?page=${page}&limit=2`);
      expect(res.json.meta).toEqual({ page, limit: 2, total: 5, pages: 3, hasNext: expectNext });
      seen.push(...res.json.data.campuses.map((c: { name: string }) => c.name));
    }
    expect(seen).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    const past = await list(a.code, "admin", "?page=4&limit=2");
    expect(past.status).toBe(200);
    expect(past.json.data.campuses).toEqual([]); // past the end is an empty page, not an error
  });

  test("a non-admin sees ONLY their own campus (and the total says so)", async () => {
    const res = await list(a.code, "teacher");
    expect(res.json.data.campuses.map((c: { name: string }) => c.name)).toEqual(["Bravo"]);
    expect(res.json.meta.total).toBe(1);
  });

  test("malformed pagination is a 400 that names each field — never clamped, never first-wins", async () => {
    for (const [query, paths] of [
      ["?page=0", ["query.page"]],
      ["?page=abc", ["query.page"]],
      ["?limit=0", ["query.limit"]],
      ["?limit=101", ["query.limit"]],
      ["?limit=-5&page=-1", ["query.limit", "query.page"]],
      ["?page=1&page=2", ["query.page"]],
      ["?limit=1.5", ["query.limit"]],
      ["?page=99999999999", ["query.page"]],
    ] as const) {
      const res = await list(a.code, "admin", query);
      expect(res.status, query).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(res.json.error.details.map((d: { path: string }) => d.path).sort(), query).toEqual([...paths].sort());
    }
  });

  test("another school's code is the same 403 as everywhere else", async () => {
    const res = await list(b.code, "admin");
    expect(res.status).toBe(403);
    expect(res.json).toEqual(NO_ACCESS);
  });
});

test.describe("POST /campuses", () => {
  test("an ADMIN creates a campus: 201, it is in the right school, in the list, and AUDITED with its name", async () => {
    const res = await create(a.code, "admin", { name: "  Foxtrot   Annex " });
    expect(res.status).toBe(201);
    expect(res.json.data.campus).toEqual({ id: expect.any(String), name: "Foxtrot Annex" }); // trimmed, whitespace collapsed
    const row = await db.campus.findUniqueOrThrow({ where: { id: res.json.data.campus.id } });
    expect(row.tenantId).toBe(a.id);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "CAMPUS_CREATED", targetId: row.id } });
    expect(audit).toMatchObject({ tenantId: a.id, actorUserId: admin.id, targetType: "Campus", afterValue: { name: "Foxtrot Annex" } });
    expect((await list(a.code, "admin", "?limit=100")).json.data.campuses.map((c: { name: string }) => c.name)).toContain("Foxtrot Annex");
  });

  test("a non-admin cannot create — the same 403 body as no access, and nothing is written", async () => {
    const before = await db.campus.count({ where: { tenantId: a.id } });
    const res = await create(a.code, "teacher", { name: "Sneaky" });
    expect(res.status).toBe(403);
    expect(res.json).toEqual(NO_ACCESS);
    expect(await db.campus.count({ where: { tenantId: a.id } })).toBe(before);
  });

  test("a duplicate name in the same school is a 409 DUPLICATE naming the field; the same name in ANOTHER school is fine", async () => {
    const first = await create(a.code, "admin", { name: "Golf" });
    expect(first.status).toBe(201);
    const second = await create(a.code, "admin", { name: "Golf" });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatchObject({ code: "DUPLICATE", details: [{ path: "body.name" }] });
    expect(await db.campus.count({ where: { tenantId: a.id, name: "Golf" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "CAMPUS_CREATED", afterValue: { path: ["name"], equals: "Golf" } } })).toBe(1); // the failed attempt left no audit row
    // …and the same name is fine in B (admin of B):
    const adminB = await createUser();
    await addMembership(adminB.id, b.id, Role.ADMIN);
    cookies.adminB = await cookieFor(adminB);
    expect((await create(b.code, "adminB", { name: "Golf" })).status).toBe(201);
  });

  test("validation: every refusal says which field and why, and nothing is created", async () => {
    const before = await db.campus.count();
    for (const [body, message] of [
      [{ name: "" }, /Enter the campus name/],
      [{ name: "   " }, /Enter the campus name/],
      [{ name: "x".repeat(101) }, /at most 100/],
      [{ name: "Bad\u0000Name" }, /can't be used/],
      [{ name: "Bidi‮Name" }, /can't be used/],
      [{}, /Enter the campus name/],
      [{ name: 42 }, /Enter the campus name|expected string/i],
      [{ name: null }, /Enter the campus name|expected string/i],
      [[], /./],
      ["just a string", /./],
    ] as [unknown, RegExp][]) {
      const res = await create(a.code, "admin", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(res.json.error.details[0].message).toMatch(message);
      expect(res.json.error.details[0].path).toMatch(/^body/);
    }
    expect(await db.campus.count()).toBe(before);
  });

  test("MASS ASSIGNMENT: a `tenantId` (or id) in the body is ignored — the campus is created in the school the URL's membership names", async () => {
    const res = await create(a.code, "admin", { name: "Hotel", tenantId: b.id, id: "forced-id", createdAt: "2000-01-01" });
    expect(res.status).toBe(201);
    const row = await db.campus.findUniqueOrThrow({ where: { id: res.json.data.campus.id } });
    expect(row.tenantId).toBe(a.id);
    expect(row.id).not.toBe("forced-id");
    expect(await db.campus.count({ where: { tenantId: b.id, name: "Hotel" } })).toBe(0);
  });

  test("non-JSON is 400 INVALID_BODY; an oversized body is 413; a cross-origin request is a 403 CSRF", async () => {
    const raw = await api(`/api/v1/schools/${a.code}/campuses`, { ...SAAS, cookie: cookies.admin, rawBody: "{nope" });
    expect(raw.status).toBe(400);
    expect(raw.json.error.code).toBe("INVALID_BODY");
    const huge = await api(`/api/v1/schools/${a.code}/campuses`, { ...SAAS, cookie: cookies.admin, rawBody: JSON.stringify({ name: "x".repeat(1024 * 1024 + 10) }) });
    expect(huge.status).toBe(413);
    expect(huge.json.error.code).toBe("PAYLOAD_TOO_LARGE");
    const csrf = await create(a.code, "admin", { name: "Evil" }, { origin: "https://evil.example" });
    expect(csrf.status).toBe(403);
    expect(csrf.json.error.code).toBe("CSRF");
    expect(await db.campus.count({ where: { name: "Evil" } })).toBe(0);
  });

  test("the authorization decision comes BEFORE validation: another school's admin sending garbage gets 403, not a 400 that proves the route exists", async () => {
    const res = await create(b.code, "admin", { name: "" });
    expect(res.status).toBe(403);
    expect(res.json).toEqual(NO_ACCESS);
  });

  test("creating is limited per person per school: the 31st in the window is a 429", async () => {
    const busy = await createUser();
    await addMembership(busy.id, a.id, Role.ADMIN);
    cookies.busy = await cookieFor(busy);
    for (let i = 0; i < 30; i++) expect((await create(a.code, "busy", { name: `Bulk ${i}` })).status, `create #${i}`).toBe(201);
    const blocked = await create(a.code, "busy", { name: "Bulk 30" });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
    expect(await db.campus.count({ where: { tenantId: a.id, name: "Bulk 30" } })).toBe(0);
    // The SaaS server keeps its limits in the shared Redis store: the 30 slots are really there.
    const redis = new Redis(TEST_REDIS_URL);
    try {
      expect(await redis.zcard(`rl:campus:create:${a.id}:${busy.id}`)).toBe(30);
    } finally {
      redis.disconnect();
    }
  });
});
