import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import {
  Role,
  addMembership,
  createTenant,
  createUser,
  db,
  deactivateMembership,
  removeCreatedTenants,
  seedInstance,
  type TestTenant,
  type TestUser,
} from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// Class groups, arms, subjects and what each class studies, over real HTTP against the SaaS-mode server (plan "Build design — Phase 1.0 and 1.1",
// decision 13, 17): who may read and write, strict bodies, the status and code of every refusal, campus scope and identical 404s. Cross-tenant,
// signed-out and deactivated callers are ALSO covered for every route by tenant-boundary.spec.ts (it discovers routes from the file system).

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let teacher: TestUser; // TEACHING_STAFF at North
let clerk: TestUser; // NON_TEACHING_STAFF, no campus
let parent: TestUser;
let student: TestUser;
let former: TestUser;
let outsider: TestUser;
const cookie: Record<string, string> = {};

const base = (code = a.code) => `/api/v1/schools/${code}/academics`;
const groups = (code = a.code) => `${base(code)}/class-groups`;
const subjects = (code = a.code) => `${base(code)}/subjects`;
const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
let counter = 0;
const uniq = (prefix: string) => `${prefix} ${Date.now().toString(36)}-${++counter}`;

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}
const seedGroup = (extra: { campusId?: string | null; name?: string; school?: TestTenant } = {}) =>
  db.classGroup.create({ data: { tenantId: (extra.school ?? a).id, campusId: extra.campusId ?? null, name: extra.name ?? uniq("Group") } });
const seedSubject = (extra: { name?: string; code?: string; school?: TestTenant } = {}) =>
  db.subject.create({ data: { tenantId: (extra.school ?? a).id, name: extra.name ?? uniq("Subject"), code: extra.code ?? null } });

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  [admin, teacher, clerk, parent, student, former, outsider] = await Promise.all(
    ["Ada Admin", "Tola Teacher", "Clem Clerk", "Pat Parent", "Sam Student", "Fay Former", "Bayo Elsewhere"].map((name) =>
      createUser({ name }),
    ),
  );
  await addMembership(admin.id, a.id, Role.ADMIN);
  await addMembership(teacher.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  await addMembership(clerk.id, a.id, Role.NON_TEACHING_STAFF);
  await addMembership(parent.id, a.id, Role.PARENT);
  await addMembership(student.id, a.id, Role.STUDENT);
  await addMembership(former.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  await addMembership(outsider.id, b.id, Role.ADMIN);
  await deactivateMembership(former.id, a.id);
  for (const [who, user] of Object.entries({ admin, teacher, clerk, parent, student, former, outsider }))
    cookie[who] = await cookieFor(user);
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("the role matrix: every route, every kind of caller", () => {
  test("reads: administrators and staff may; a parent, a student, a deactivated member and another school's administrator get the ONE 403 body", async () => {
    const g = await seedGroup();
    const reads = [groups(), `${groups()}/${g.id}`, `${groups()}/${g.id}/subjects`, subjects()];
    for (const url of reads) {
      for (const who of ["admin", "teacher", "clerk"]) expect((await api(url, as(who))).status, `${who} ${url}`).toBe(200);
      for (const who of ["parent", "student", "former", "outsider"]) {
        const res = await api(url, as(who));
        expect(res.status, `${who} ${url}`).toBe(403);
        expect(res.json, `${who} ${url}`).toEqual(NO_ACCESS);
      }
    }
  });

  test("writes: ONLY an administrator of that school — everyone else is the same 403 and nothing changes", async () => {
    const g = await seedGroup({ name: "Untouchable" });
    const arm = await db.classArm.create({ data: { tenantId: a.id, classGroupId: g.id, name: "A" } });
    const s = await seedSubject({ name: "Untouchable subject" });
    const writes: [string, string, object | undefined][] = [
      ["POST", groups(), { name: "x" }],
      ["PATCH", `${groups()}/${g.id}`, { name: "renamed" }],
      ["POST", `${groups()}/${g.id}/archive`, undefined],
      ["POST", `${groups()}/${g.id}/arms`, { name: "B" }],
      ["PUT", `${groups()}/${g.id}/subjects`, { subjectIds: [s.id] }],
      ["PATCH", `${base()}/arms/${arm.id}`, { name: "renamed" }],
      ["POST", `${base()}/arms/${arm.id}/archive`, undefined],
      ["POST", subjects(), { name: "x" }],
      ["PATCH", `${subjects()}/${s.id}`, { name: "renamed" }],
      ["POST", `${subjects()}/${s.id}/archive`, undefined],
    ];
    for (const [method, url, body] of writes) {
      for (const who of ["teacher", "clerk", "parent", "student", "former", "outsider"]) {
        const res = await api(url, as(who, { method, ...(body ? { body } : {}) }));
        expect(res.status, `${who} ${method} ${url}`).toBe(403);
        expect(res.json, `${who} ${method} ${url}`).toEqual(NO_ACCESS);
      }
    }
    expect(await db.classGroup.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ name: "Untouchable", archivedAt: null });
    expect(await db.classArm.findUniqueOrThrow({ where: { id: arm.id } })).toMatchObject({ name: "A", archivedAt: null });
    expect(await db.subject.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ name: "Untouchable subject", archivedAt: null });
    expect(await db.subjectOffering.count({ where: { classGroupId: g.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: { in: [g.id, arm.id, s.id] } } })).toBe(0);
  });

  test("CSRF is enforced on every write", async () => {
    const res = await api(groups(), as("admin", { method: "POST", body: { name: uniq("csrf") }, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });
});

test.describe("class groups and arms", () => {
  test("POST creates a group (201) with a cleaned name and an order; duplicates are 409 NAME_TAKEN; bad bodies are 400s naming the field; unknown keys are refused", async () => {
    const name = uniq("JSS");
    const made = await api(groups(), as("admin", { method: "POST", body: { name: `  ${name}  `, sortOrder: 2 } }));
    expect(made.status).toBe(201);
    expect(made.json.data.classGroup).toMatchObject({ name, sortOrder: 2, campusId: null, arms: [], subjectCount: 0, archived: false });
    const dup = await api(groups(), as("admin", { method: "POST", body: { name } }));
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: "NAME_TAKEN", details: [{ path: "body.name" }] });
    for (const [body, path] of [
      [{ name: "" }, "body.name"],
      [{ name: "x".repeat(61) }, "body.sortOrder-or-name"],
      [{ name: uniq("o"), sortOrder: -1 }, "body.sortOrder"],
      [{ name: uniq("o"), sortOrder: 1000 }, "body.sortOrder"],
      [{ name: uniq("o"), sortOrder: 1.5 }, "body.sortOrder"],
      [{ name: 5 }, "body.name"],
      [{ name: uniq("o"), tenantId: b.id }, undefined],
      [{ name: uniq("o"), archivedAt: "2020-01-01" }, undefined],
      [{}, "body.name"],
    ] as [object, string | undefined][]) {
      const res = await api(groups(), as("admin", { method: "POST", body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      if (path && !path.includes("-or-"))
        expect(
          res.json.error.details.map((d: { path: string }) => d.path),
          JSON.stringify(body),
        ).toContain(path);
    }
  });

  test("a campus of another school or one that does not exist is a 400 on body.campusId, alike; a real campus gives the group to that campus", async () => {
    for (const campusId of [b.campuses[0].id, "no-such-campus"]) {
      const res = await api(groups(), as("admin", { method: "POST", body: { name: uniq("C"), campusId } }));
      expect(res.status, campusId).toBe(400);
      expect(res.json.error.details).toEqual([{ path: "body.campusId", message: "Choose one of this school's campuses." }]);
    }
    const own = await api(groups(), as("admin", { method: "POST", body: { name: uniq("North"), campusId: a.campuses[0].id } }));
    expect(own.json.data.classGroup).toMatchObject({ campusId: a.campuses[0].id, campusName: "Alpha North" });
  });

  test("arms: created with an optional capacity (1–1000); a duplicate name is 409; the group's GET shows its live arms in name order; PATCH renames and clears the capacity with null", async () => {
    const g = await api(groups(), as("admin", { method: "POST", body: { name: uniq("JSS") } }));
    const id = g.json.data.classGroup.id as string;
    const arm = async (body: object) => api(`${groups()}/${id}/arms`, as("admin", { method: "POST", body }));
    const b1 = await arm({ name: "B", capacity: 40 });
    expect(b1.status).toBe(201);
    expect(b1.json.data.arm).toMatchObject({ name: "B", capacity: 40, archived: false });
    await arm({ name: "A" });
    expect((await arm({ name: "A" })).json.error.code).toBe("NAME_TAKEN");
    for (const capacity of [0, 1001, 1.5, "30"]) expect((await arm({ name: "Z", capacity })).status, String(capacity)).toBe(400);
    expect((await arm({ name: "Z", extra: 1 })).status).toBe(400);
    const shown = await api(`${groups()}/${id}`, as("teacher"));
    expect(shown.json.data.classGroup.arms.map((x: { name: string }) => x.name)).toEqual(["A", "B"]);
    const armId = b1.json.data.arm.id as string;
    const patch = (body: object) => api(`${base()}/arms/${armId}`, as("admin", { method: "PATCH", body }));
    expect((await patch({ capacity: null })).json.data).toMatchObject({ changed: true, arm: { capacity: null } });
    expect((await patch({ capacity: null })).json.data).toMatchObject({ changed: false });
    expect((await patch({ name: "A" })).json.error.code).toBe("NAME_TAKEN");
    expect((await patch({})).status).toBe(400);
    expect((await api(`${base()}/arms/${armId}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      arm: { archived: true },
    });
    expect((await api(`${groups()}/${id}`, as("admin"))).json.data.classGroup.arms.map((x: { name: string }) => x.name)).toEqual(["A"]); // archived arms leave the view
  });

  test("a group with live arms is 409 HAS_ACTIVE_ARMS on archive; once its arms are archived it archives, idempotently, and leaves the default list", async () => {
    const g = await seedGroup({ name: uniq("Archive me") });
    const arm = await db.classArm.create({ data: { tenantId: a.id, classGroupId: g.id, name: "A" } });
    const refused = await api(`${groups()}/${g.id}/archive`, as("admin", { method: "POST" }));
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("HAS_ACTIVE_ARMS");
    await api(`${base()}/arms/${arm.id}/archive`, as("admin", { method: "POST" }));
    expect((await api(`${groups()}/${g.id}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      classGroup: { archived: true },
    });
    expect((await api(`${groups()}/${g.id}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({ changed: false });
    const live = await api(`${groups()}?limit=100`, as("admin"));
    expect(live.json.data.classGroups.some((x: { id: string }) => x.id === g.id)).toBe(false);
    const archived = await api(`${groups()}?status=archived&limit=100`, as("admin"));
    expect(archived.json.data.classGroups.some((x: { id: string }) => x.id === g.id)).toBe(true);
    const edit = await api(`${groups()}/${g.id}`, as("admin", { method: "PATCH", body: { name: "Late" } }));
    expect(edit.status).toBe(409);
    expect(edit.json.error.code).toBe("ARCHIVED");
    expect(await db.classGroup.count({ where: { id: g.id } })).toBe(1);
  });

  test("staff see school-wide groups and their OWN campus's; another campus's group is the same 404 as an unknown id — for the group, its arms and its subjects", async () => {
    const wide = await seedGroup({ name: uniq("Wide") });
    const north = await seedGroup({ name: uniq("North"), campusId: a.campuses[0].id });
    const south = await seedGroup({ name: uniq("South"), campusId: a.campuses[1].id });
    const seen = async (who: string) =>
      (await api(`${groups()}?status=all&limit=100`, as(who))).json.data.classGroups.map((g: { id: string }) => g.id);
    expect(await seen("teacher")).toEqual(expect.arrayContaining([wide.id, north.id]));
    expect(await seen("teacher")).not.toContain(south.id);
    expect(await seen("clerk")).toEqual(expect.arrayContaining([wide.id]));
    expect(await seen("clerk")).not.toEqual(expect.arrayContaining([north.id]));
    expect(await seen("admin")).toEqual(expect.arrayContaining([wide.id, north.id, south.id]));
    const unknown = await api(`${groups()}/no-such-group`, as("teacher"));
    expect(unknown.status).toBe(404);
    expect((await api(`${groups()}/${south.id}`, as("teacher"))).json).toEqual(unknown.json);
    expect((await api(`${groups()}/${south.id}/subjects`, as("teacher"))).json).toEqual(unknown.json);
    expect((await api(`${groups()}/${encodeURIComponent("../etc")}`, as("teacher"))).json).toEqual(unknown.json);
  });

  test("another school's group, arm and subject ids are the SAME 404 as unknown ones — on every write too — and nothing there changes", async () => {
    const theirs = await seedGroup({ school: b, name: "Beta only" });
    const theirArm = await db.classArm.create({ data: { tenantId: b.id, classGroupId: theirs.id, name: "A" } });
    const theirSubject = await seedSubject({ school: b, name: "Beta subject" });
    const unknown = await api(`${groups()}/no-such-group`, as("admin"));
    for (const [method, url, body] of [
      ["GET", `${groups()}/${theirs.id}`, undefined],
      ["PATCH", `${groups()}/${theirs.id}`, { name: "hijack" }],
      ["POST", `${groups()}/${theirs.id}/archive`, undefined],
      ["POST", `${groups()}/${theirs.id}/arms`, { name: "Z" }],
      ["GET", `${groups()}/${theirs.id}/subjects`, undefined],
      ["PUT", `${groups()}/${theirs.id}/subjects`, { subjectIds: [] }],
    ] as [string, string, object | undefined][]) {
      const res = await api(url, as("admin", { method, ...(body ? { body } : {}) }));
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.json, `${method} ${url}`).toEqual(unknown.json);
    }
    for (const [method, url, body] of [
      ["PATCH", `${base()}/arms/${theirArm.id}`, { name: "hijack" }],
      ["POST", `${base()}/arms/${theirArm.id}/archive`, undefined],
      ["PATCH", `${subjects()}/${theirSubject.id}`, { name: "hijack" }],
      ["POST", `${subjects()}/${theirSubject.id}/archive`, undefined],
    ] as [string, string, object | undefined][]) {
      expect((await api(url, as("admin", { method, ...(body ? { body } : {}) }))).status, `${method} ${url}`).toBe(404);
    }
    expect(await db.classGroup.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ name: "Beta only", archivedAt: null });
    expect(await db.classArm.findUniqueOrThrow({ where: { id: theirArm.id } })).toMatchObject({ name: "A", archivedAt: null });
    expect(await db.subject.findUniqueOrThrow({ where: { id: theirSubject.id } })).toMatchObject({
      name: "Beta subject",
      archivedAt: null,
    });
  });
});

test.describe("subjects and what each class studies", () => {
  test("POST creates a subject (201) with an upper-cased code; duplicates are 409 NAME_TAKEN / CODE_TAKEN; a bad code is a 400 on body.code; unknown keys are refused", async () => {
    const name = uniq("Maths");
    const code = `M${counter}X`.toUpperCase();
    const made = await api(subjects(), as("admin", { method: "POST", body: { name, code: code.toLowerCase() } }));
    expect(made.status).toBe(201);
    expect(made.json.data.subject).toMatchObject({ name, code, archived: false });
    expect((await api(subjects(), as("admin", { method: "POST", body: { name, code: null } }))).json.error).toMatchObject({
      code: "NAME_TAKEN",
    });
    expect((await api(subjects(), as("admin", { method: "POST", body: { name: uniq("Other"), code } }))).json.error).toMatchObject({
      code: "CODE_TAKEN",
      details: [{ path: "body.code" }],
    });
    const badCode = await api(subjects(), as("admin", { method: "POST", body: { name: uniq("Bad"), code: "no way!" } }));
    expect(badCode.status).toBe(400);
    expect(badCode.json.error.details[0].path).toBe("body.code");
    expect((await api(subjects(), as("admin", { method: "POST", body: { name: uniq("X"), tenantId: b.id } }))).status).toBe(400);
    expect((await api(subjects(), as("admin", { method: "POST", body: { name: uniq("Nocode") } }))).json.data.subject.code).toBeNull();
  });

  test("the list is paged, name-ordered and searchable: `%` and `_` are text, name or code both match; paging is strict (a bad parameter is a 400 naming the field)", async () => {
    const tag = Date.now().toString(36);
    await seedSubject({ name: `${tag} 100% effort` });
    await seedSubject({ name: `${tag} under_score` });
    await seedSubject({ name: `${tag} plain`, code: `Q${counter}Z` });
    const names = async (q: string) =>
      (await api(`${subjects()}?q=${encodeURIComponent(q)}&limit=100`, as("teacher"))).json.data.subjects.map(
        (s: { name: string }) => s.name,
      );
    expect(await names(`${tag} 100%`)).toEqual([`${tag} 100% effort`]);
    expect(await names(`${tag} under_`)).toEqual([`${tag} under_score`]);
    expect((await names("%")).every((n: string) => n.includes("%"))).toBe(true); // "%" is a character, never "everything"
    expect(await names(`${tag}`)).toEqual([`${tag} 100% effort`, `${tag} plain`, `${tag} under_score`]);
    const first = await api(`${subjects()}?limit=2`, as("admin"));
    const second = await api(`${subjects()}?limit=2&page=2`, as("admin"));
    const ids = [...first.json.data.subjects, ...second.json.data.subjects].map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [qs, field] of [
      ["status=all-of-them", "query.status"],
      ["page=0", "query.page"],
      ["limit=1000", "query.limit"],
      ["q=" + "x".repeat(65), "query.q"],
    ]) {
      const res = await api(`${subjects()}?${qs}`, as("admin"));
      expect(res.status, qs).toBe(400);
      expect(
        res.json.error.details.map((d: { path: string }) => d.path),
        qs,
      ).toContain(field);
    }
  });

  test("PUT the class's full subject list: idempotent (changed:false the second time), unknown / foreign / archived ids refuse the WHOLE request (400 on body.subjectIds), GET shows them by name", async () => {
    const g = await seedGroup({ name: uniq("Offered") });
    const [m, e] = [await seedSubject({ name: uniq("Maths") }), await seedSubject({ name: uniq("English") })];
    const theirs = await seedSubject({ school: b, name: uniq("Beta") });
    const gone = await seedSubject({ name: uniq("Latin") });
    await api(`${subjects()}/${gone.id}/archive`, as("admin", { method: "POST" }));
    const url = `${groups()}/${g.id}/subjects`;
    const put = (subjectIds: string[]) => api(url, as("admin", { method: "PUT", body: { subjectIds } }));
    const first = await put([e.id, m.id]);
    expect(first.json.data).toMatchObject({ changed: true });
    expect(first.json.data.subjects.map((s: { id: string }) => s.id).sort()).toEqual([e.id, m.id].sort());
    expect((await put([m.id, e.id, m.id])).json.data.changed).toBe(false);
    for (const bad of [theirs.id, "no-such-subject", gone.id]) {
      const res = await put([m.id, bad]);
      expect(res.status, bad).toBe(400);
      expect(res.json.error.details).toEqual([{ path: "body.subjectIds", message: "Choose from this school's subjects." }]);
    }
    expect((await api(url, as("admin", { method: "PUT", body: { subjectIds: "all" } }))).status).toBe(400);
    expect((await api(url, as("admin", { method: "PUT", body: { subjectIds: [], extra: 1 } }))).status).toBe(400);
    expect((await api(url, as("teacher"))).json.data.subjects).toHaveLength(2); // unchanged by the refusals
    const refused = await api(`${subjects()}/${m.id}/archive`, as("admin", { method: "POST" }));
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("SUBJECT_IN_USE");
    await put([]);
    expect((await api(`${subjects()}/${m.id}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      subject: { archived: true },
    });
  });

  test("PATCH a subject: rename, clear the code with null, no-op → changed:false, an empty body → 400, an archived subject → 409 ARCHIVED", async () => {
    const s = await seedSubject({ name: uniq("Chem"), code: `C${counter}H` });
    const patch = (body: object) => api(`${subjects()}/${s.id}`, as("admin", { method: "PATCH", body }));
    expect((await patch({ code: null })).json.data).toMatchObject({ changed: true, subject: { code: null } });
    expect((await patch({ code: null })).json.data.changed).toBe(false);
    expect((await patch({})).status).toBe(400);
    await api(`${subjects()}/${s.id}/archive`, as("admin", { method: "POST" }));
    const late = await patch({ name: "Late" });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("ARCHIVED");
  });
});
