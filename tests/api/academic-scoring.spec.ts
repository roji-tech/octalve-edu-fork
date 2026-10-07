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

// Assessment schemes and grade scales over real HTTP against the SaaS-mode server (plan "Build design — Phase 1.0 and 1.1", decisions 14, 15, 17):
// who may read and write, strict bodies, the status and code of every refusal, locking and versions, the one default scale, campus scope and
// identical 404s. Cross-tenant, signed-out and deactivated callers are ALSO covered for every route by tenant-boundary.spec.ts.

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
const schemes = (code = a.code) => `${base(code)}/assessment-schemes`;
const scales = (code = a.code) => `${base(code)}/grade-scales`;
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
const CA = [
  { name: "CA 1", maxScore: 20 },
  { name: "CA 2", maxScore: 20 },
];
const BANDS = [
  { min: 0, max: 40, letter: "F", remark: "Fail" },
  { min: 40, max: 70, letter: "C", remark: "Credit" },
  { min: 70, max: 100, letter: "A", remark: "Excellent" },
];
/// Each test gets its own class group, so "one live scheme per scope" never couples tests together.
async function newScheme(extra: object = {}, groupOpts: { campusId?: string | null; school?: TestTenant } = {}) {
  const g = await seedGroup(groupOpts);
  const res = await api(
    schemes(groupOpts.school?.code ?? a.code),
    as(groupOpts.school ? "outsider" : "admin", {
      method: "POST",
      body: { classGroupId: g.id, name: uniq("Scheme"), examMax: 60, components: CA, ...extra },
    }),
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { group: g, scheme: res.json.data.assessmentScheme as { id: string; name: string } };
}
const newScale = async (name = uniq("Scale"), who = "admin", code = a.code) => {
  const res = await api(scales(code), as(who, { method: "POST", body: { name, bands: BANDS } }));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.data.gradeScale as { id: string; name: string; isDefault: boolean };
};

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
    const { scheme } = await newScheme();
    const scale = await newScale();
    const reads = [schemes(), `${schemes()}/${scheme.id}`, scales(), `${scales()}/${scale.id}`];
    for (const url of reads) {
      for (const who of ["admin", "teacher", "clerk"]) {
        // a teacher at North sees school-wide groups' schemes
        expect((await api(url, as(who))).status, `${who} ${url}`).toBe(200);
      }
      for (const who of ["parent", "student", "former", "outsider"]) {
        const res = await api(url, as(who));
        expect(res.status, `${who} ${url}`).toBe(403);
        expect(res.json, `${who} ${url}`).toEqual(NO_ACCESS);
      }
    }
  });

  test("writes: ONLY an administrator of that school — everyone else is the same 403 and nothing changes", async () => {
    const { scheme } = await newScheme({ name: "Untouchable scheme" });
    const scale = await newScale("Untouchable scale");
    const writes: [string, string, object | undefined][] = [
      ["POST", schemes(), { name: "x", examMax: 60, components: CA }],
      ["PATCH", `${schemes()}/${scheme.id}`, { name: "renamed" }],
      ["POST", `${schemes()}/${scheme.id}/new-version`, {}],
      ["POST", `${schemes()}/${scheme.id}/archive`, undefined],
      ["POST", scales(), { name: "x", bands: BANDS }],
      ["PATCH", `${scales()}/${scale.id}`, { name: "renamed" }],
      ["POST", `${scales()}/${scale.id}/new-version`, {}],
      ["POST", `${scales()}/${scale.id}/make-default`, undefined],
      ["POST", `${scales()}/${scale.id}/archive`, undefined],
    ];
    for (const [method, url, body] of writes) {
      for (const who of ["teacher", "clerk", "parent", "student", "former", "outsider"]) {
        const res = await api(url, as(who, { method, ...(body ? { body } : {}) }));
        expect(res.status, `${who} ${method} ${url}`).toBe(403);
        expect(res.json, `${who} ${method} ${url}`).toEqual(NO_ACCESS);
      }
    }
    expect(await db.assessmentScheme.findUniqueOrThrow({ where: { id: scheme.id } })).toMatchObject({
      name: "Untouchable scheme",
      archivedAt: null,
    });
    expect(await db.gradeScale.findUniqueOrThrow({ where: { id: scale.id } })).toMatchObject({
      name: "Untouchable scale",
      archivedAt: null,
    });
    expect(
      await db.auditLog.count({ where: { tenantId: a.id, targetId: { in: [scheme.id, scale.id] }, action: { contains: "UPDATED" } } }),
    ).toBe(0);
  });

  test("CSRF is enforced on every write", async () => {
    for (const url of [schemes(), scales()]) {
      const res = await api(url, as("admin", { method: "POST", body: { name: uniq("csrf") }, origin: "https://evil.example" }));
      expect(res.status, url).toBe(403);
      expect(res.json.error.code).toBe("CSRF");
    }
  });
});

test.describe("assessment schemes", () => {
  test("POST creates a scheme (201) with cleaned names, ordered components and a default total of 100; GET returns it with its canonical snapshot", async () => {
    const g = await seedGroup();
    const name = uniq("Primary");
    const made = await api(
      schemes(),
      as("admin", {
        method: "POST",
        body: {
          classGroupId: g.id,
          name: `  ${name}  `,
          examMax: 70,
          components: [
            { name: " Test ", maxScore: 10 },
            { name: "Project", maxScore: 20 },
          ],
        },
      }),
    );
    expect(made.status).toBe(201);
    expect(made.json.data.assessmentScheme).toMatchObject({
      name,
      totalMax: 100,
      examMax: 70,
      version: 1,
      locked: false,
      archived: false,
      classGroupId: g.id,
      classGroupName: expect.any(String),
      components: [
        { name: "Test", maxScore: 10, sortOrder: 0 },
        { name: "Project", maxScore: 20, sortOrder: 1 },
      ],
    });
    const shown = await api(`${schemes()}/${made.json.data.assessmentScheme.id}`, as("teacher"));
    expect(shown.status).toBe(200);
    expect(shown.json.data.snapshot).toEqual({
      json: '{"totalMax":"100.00","examMax":"70.00","components":[{"name":"Test","maxScore":"10.00"},{"name":"Project","maxScore":"20.00"}]}',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("bad bodies are 400s naming the field; the sum rule says what it added up to; unknown keys, a stolen tenantId and string numbers are refused", async () => {
    const g = await seedGroup();
    const post = (body: object) => api(schemes(), as("admin", { method: "POST", body: { classGroupId: g.id, ...body } }));
    const paths = (res: { json: { error: { details: { path: string }[] } } }) => res.json.error.details.map((d) => d.path);

    const sum = await post({ name: uniq("S"), examMax: 60, components: [{ name: "CA", maxScore: 30 }] });
    expect(sum.status).toBe(400);
    expect(sum.json.error.code).toBe("VALIDATION");
    expect(sum.json.error.message).toContain("90");
    expect(paths(sum)).toEqual(["body.examMax"]);

    const cases: [object, string][] = [
      [{ name: "", examMax: 60, components: CA }, "body.name"],
      [{ name: uniq("S"), examMax: "60", components: CA }, "body.examMax"],
      [{ name: uniq("S"), examMax: 60 }, "body.components"],
      [{ name: uniq("S"), examMax: 60, components: [] }, "body.components"],
      [{ name: uniq("S"), examMax: 60, components: [{ name: "CA", maxScore: 40.123 }] }, "body.components.0"],
      [
        {
          name: uniq("S"),
          examMax: 60,
          components: [
            { name: "CA", maxScore: 20 },
            { name: "ca", maxScore: 20 },
          ],
        },
        "body.components.1",
      ],
      [
        {
          name: uniq("S"),
          examMax: 60,
          components: [
            { name: "CA", maxScore: 0 },
            { name: "CB", maxScore: 40 },
          ],
        },
        "body.components.0",
      ],
      [{ name: uniq("S"), examMax: -1, components: [{ name: "CA", maxScore: 101 }] }, "body.examMax"],
      [{ name: uniq("S"), totalMax: 0, examMax: 0, components: [{ name: "CA", maxScore: 1 }] }, "body.totalMax"],
      [
        { name: uniq("S"), examMax: 60, components: Array.from({ length: 11 }, (_, i) => ({ name: `C${i}`, maxScore: 4 })) },
        "body.components",
      ],
    ];
    for (const [body, path] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(paths(res), JSON.stringify(body)).toContain(path);
    }
    for (const body of [
      { name: uniq("S"), examMax: 60, components: CA, tenantId: b.id },
      { name: uniq("S"), examMax: 60, components: CA, lockedAt: "2020-01-01" },
      { name: uniq("S"), examMax: 60, components: [{ name: "CA", maxScore: 40, id: "x" }] },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await db.assessmentScheme.count({ where: { tenantId: a.id, classGroupId: g.id } })).toBe(0);
  });

  test("a second scheme for one class is 409 SCOPE_TAKEN; a taken name is 409 NAME_TAKEN; another school's or an unknown class is a 400 on body.classGroupId, alike", async () => {
    const { group, scheme } = await newScheme();
    const dupScope = await api(
      schemes(),
      as("admin", { method: "POST", body: { classGroupId: group.id, name: uniq("Other"), examMax: 60, components: CA } }),
    );
    expect(dupScope.status).toBe(409);
    expect(dupScope.json.error.code).toBe("SCOPE_TAKEN");
    const other = await seedGroup();
    const dupName = await api(
      schemes(),
      as("admin", { method: "POST", body: { classGroupId: other.id, name: scheme.name, examMax: 60, components: CA } }),
    );
    expect(dupName.status).toBe(409);
    expect(dupName.json.error).toMatchObject({ code: "NAME_TAKEN", details: [{ path: "body.name" }] });
    const theirs = await seedGroup({ school: b });
    for (const classGroupId of [theirs.id, "no-such-group"]) {
      const res = await api(
        schemes(),
        as("admin", { method: "POST", body: { classGroupId, name: uniq("X"), examMax: 60, components: CA } }),
      );
      expect(res.status, classGroupId).toBe(400);
      expect(res.json.error.details).toEqual([{ path: "body.classGroupId", message: "Choose one of this school's classes." }]);
    }
  });

  test("the school-wide default scheme: classGroupId omitted or null; a second one is 409 SCOPE_TAKEN until the first is archived", async () => {
    const first = await api(schemes(), as("admin", { method: "POST", body: { name: uniq("Default"), examMax: 60, components: CA } }));
    expect(first.status).toBe(201);
    expect(first.json.data.assessmentScheme.classGroupId).toBeNull();
    const second = await api(
      schemes(),
      as("admin", { method: "POST", body: { classGroupId: null, name: uniq("Default 2"), examMax: 60, components: CA } }),
    );
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("SCOPE_TAKEN");
    await api(`${schemes()}/${first.json.data.assessmentScheme.id}/archive`, as("admin", { method: "POST" }));
    expect(
      (await api(schemes(), as("admin", { method: "POST", body: { name: uniq("Default 3"), examMax: 60, components: CA } }))).status,
    ).toBe(201);
  });

  test("PATCH edits in place (changed:true, then changed:false); an empty body, unknown keys and a bad sum are 400s; a taken name is 409", async () => {
    const { scheme } = await newScheme();
    const { scheme: other } = await newScheme();
    const url = `${schemes()}/${scheme.id}`;
    const patch = (body: object) => api(url, as("admin", { method: "PATCH", body }));
    const renamed = uniq("Renamed");
    expect((await patch({ name: renamed })).json.data).toMatchObject({ changed: true, assessmentScheme: { name: renamed } });
    expect((await patch({ name: renamed })).json.data).toMatchObject({ changed: false });
    expect((await patch({ examMax: 50, components: [{ name: "Quiz", maxScore: 50 }] })).json.data).toMatchObject({
      changed: true,
      assessmentScheme: { examMax: 50, components: [{ name: "Quiz", maxScore: 50 }] },
    });
    expect((await patch({})).status).toBe(400);
    expect((await patch({ locked: false })).status).toBe(400);
    expect((await patch({ classGroupId: null })).status).toBe(400);
    const bad = await patch({ examMax: 10 });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION");
    const taken = await patch({ name: other.name });
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe("NAME_TAKEN");
    expect((await api(url, as("admin"))).json.data.assessmentScheme.components).toEqual([expect.objectContaining({ name: "Quiz" })]);
  });

  test("a LOCKED scheme is 409 LOCKED to edit and takes a new version (201) instead; an unlocked one is 409 NOT_LOCKED for a new version; the old one is archived", async () => {
    const { scheme } = await newScheme();
    const url = `${schemes()}/${scheme.id}`;
    const early = await api(`${url}/new-version`, as("admin", { method: "POST", body: {} }));
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("NOT_LOCKED");
    await db.assessmentScheme.update({ where: { id: scheme.id }, data: { lockedAt: new Date() } }); // what Phase 1.4 will do the first time a result uses it
    const locked = await api(url, as("admin", { method: "PATCH", body: { name: uniq("Nope") } }));
    expect(locked.status).toBe(409);
    expect(locked.json.error.code).toBe("LOCKED");
    const v2 = await api(
      `${url}/new-version`,
      as("admin", { method: "POST", body: { examMax: 50, components: [{ name: "CA", maxScore: 50 }] } }),
    );
    expect(v2.status).toBe(201);
    expect(v2.json.data.assessmentScheme).toMatchObject({
      version: 2,
      supersedesId: scheme.id,
      locked: false,
      examMax: 50,
      classGroupId: expect.any(String),
    });
    expect((await api(url, as("admin"))).json.data.assessmentScheme).toMatchObject({
      archived: true,
      locked: true,
      version: 1,
      examMax: 60,
    });
    // the new version is the live one for the class: a list for that class shows it first among live ones
    const live = await api(`${schemes()}?classGroupId=${v2.json.data.assessmentScheme.classGroupId}`, as("admin"));
    expect(live.json.data.assessmentSchemes.map((s: { id: string }) => s.id)).toEqual([v2.json.data.assessmentScheme.id]);
    // changing a version's unknown keys is refused too
    const strict = await api(
      `${schemes()}/${v2.json.data.assessmentScheme.id}/new-version`,
      as("admin", { method: "POST", body: { version: 9 } }),
    );
    expect(strict.status).toBe(400);
  });

  test("archive is idempotent (changed true, then false); an archived scheme is 409 ARCHIVED to edit; the list filters by status and pages with a true total", async () => {
    const { scheme } = await newScheme();
    const url = `${schemes()}/${scheme.id}`;
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      assessmentScheme: { archived: true },
    });
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({ changed: false });
    const edit = await api(url, as("admin", { method: "PATCH", body: { name: uniq("Late") } }));
    expect(edit.status).toBe(409);
    expect(edit.json.error.code).toBe("ARCHIVED");
    const live = await api(`${schemes()}?limit=100`, as("admin"));
    expect(live.json.data.assessmentSchemes.some((s: { id: string }) => s.id === scheme.id)).toBe(false);
    const archived = await api(`${schemes()}?status=archived&limit=100`, as("admin"));
    expect(archived.json.data.assessmentSchemes.some((s: { id: string }) => s.id === scheme.id)).toBe(true);
    const page = await api(`${schemes()}?status=all&limit=1`, as("admin"));
    expect(page.json.data.assessmentSchemes).toHaveLength(1);
    expect(page.json.meta.total).toBeGreaterThan(1);
    for (const [qs, field] of [
      ["status=everything", "query.status"],
      ["limit=1000", "query.limit"],
      ["page=0", "query.page"],
    ]) {
      const res = await api(`${schemes()}?${qs}`, as("admin"));
      expect(res.status, qs).toBe(400);
      expect(res.json.error.details.map((d: { path: string }) => d.path)).toContain(field);
    }
  });

  test("staff see the schemes of school-wide classes and of THEIR campus's; another campus's scheme is the same 404 as an unknown id, for reads and for writes", async () => {
    const wide = await newScheme();
    const north = await newScheme({}, { campusId: a.campuses[0].id });
    const south = await newScheme({}, { campusId: a.campuses[1].id });
    const seen = async (who: string) =>
      (await api(`${schemes()}?limit=100`, as(who))).json.data.assessmentSchemes.map((s: { id: string }) => s.id);
    expect(await seen("teacher")).toEqual(expect.arrayContaining([wide.scheme.id, north.scheme.id]));
    expect(await seen("teacher")).not.toContain(south.scheme.id);
    expect(await seen("clerk")).toContain(wide.scheme.id);
    expect(await seen("clerk")).not.toContain(north.scheme.id);
    expect(await seen("admin")).toEqual(expect.arrayContaining([wide.scheme.id, north.scheme.id, south.scheme.id]));
    const unknown = await api(`${schemes()}/no-such-scheme`, as("teacher"));
    expect(unknown.status).toBe(404);
    expect((await api(`${schemes()}/${south.scheme.id}`, as("teacher"))).json).toEqual(unknown.json);
    expect((await api(`${schemes()}/${encodeURIComponent("../etc")}`, as("teacher"))).json).toEqual(unknown.json);
  });

  test("another school's scheme is the SAME 404 as an unknown id on every route, and nothing there changes", async () => {
    const theirs = await newScheme({ name: "Beta only" }, { school: b });
    const unknown = await api(`${schemes()}/no-such-scheme`, as("admin"));
    for (const [method, url, body] of [
      ["GET", `${schemes()}/${theirs.scheme.id}`, undefined],
      ["PATCH", `${schemes()}/${theirs.scheme.id}`, { name: "hijack" }],
      ["POST", `${schemes()}/${theirs.scheme.id}/new-version`, {}],
      ["POST", `${schemes()}/${theirs.scheme.id}/archive`, undefined],
    ] as [string, string, object | undefined][]) {
      const res = await api(url, as("admin", { method, ...(body ? { body } : {}) }));
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.json, `${method} ${url}`).toEqual(unknown.json);
    }
    expect(await db.assessmentScheme.findUniqueOrThrow({ where: { id: theirs.scheme.id } })).toMatchObject({
      name: "Beta only",
      archivedAt: null,
    });
    expect((await api(schemes(), as("admin"))).json.data.assessmentSchemes.some((s: { id: string }) => s.id === theirs.scheme.id)).toBe(
      false,
    );
  });
});

test.describe("grade scales", () => {
  test("POST creates a scale (201); the FIRST becomes the default, later ones do not; duplicates are 409 NAME_TAKEN; GET shows bands in score order", async () => {
    // a school of its own, so "first" is really first
    const own = await createTenant({ name: "Gamma School", campuses: [] });
    const boss = await createUser({ name: "Gail Gamma" });
    await addMembership(boss.id, own.id, Role.ADMIN);
    cookie.gamma = await cookieFor(boss);
    const post = (name: string, bands: object[] = BANDS) => api(scales(own.code), as("gamma", { method: "POST", body: { name, bands } }));
    const first = await post("  Main   scale ", [...BANDS].reverse());
    expect(first.status).toBe(201);
    expect(first.json.data.gradeScale).toMatchObject({
      name: "Main scale",
      isDefault: true,
      version: 1,
      locked: false,
      bands: [
        { min: 0, max: 40, letter: "F" },
        { min: 40, max: 70, letter: "C" },
        { min: 70, max: 100, letter: "A" },
      ],
    });
    const second = await post("Second");
    expect(second.json.data.gradeScale.isDefault).toBe(false);
    const dup = await post("Second");
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: "NAME_TAKEN", details: [{ path: "body.name" }] });
    const list = await api(scales(own.code), as("gamma"));
    expect(list.json.data.gradeScales.map((s: { name: string }) => s.name)).toEqual(["Main scale", "Second"]); // the default first
    expect(list.json.meta.total).toBe(2);
  });

  test("every band rule is a 400 naming the band: gap, overlap, start, end, duplicate letter, precision, blank text, unknown keys", async () => {
    const post = (bands: unknown, name = uniq("Bad")) => api(scales(), as("admin", { method: "POST", body: { name, bands } }));
    const path = (res: { json: { error: { details: { path: string }[] } } }) => res.json.error.details.map((d) => d.path);
    const cases: [unknown, string][] = [
      [[], "body.bands"],
      [[{ min: 10, max: 100, letter: "A", remark: "A" }], "body.bands.0"],
      [[{ min: 0, max: 90, letter: "A", remark: "A" }], "body.bands.0"],
      [
        [
          { min: 0, max: 50, letter: "F", remark: "F" },
          { min: 60, max: 100, letter: "P", remark: "P" },
        ],
        "body.bands.1",
      ],
      [
        [
          { min: 0, max: 60, letter: "F", remark: "F" },
          { min: 50, max: 100, letter: "P", remark: "P" },
        ],
        "body.bands.1",
      ],
      [
        [
          { min: 0, max: 50, letter: "A", remark: "F" },
          { min: 50, max: 100, letter: "a", remark: "P" },
        ],
        "body.bands.1",
      ],
      [[{ min: 0, max: 100.123, letter: "A", remark: "A" }], "body.bands.0"],
      [[{ min: 0, max: 100, letter: "", remark: "A" }], "body.bands.0"],
      [[{ min: 0, max: 100, letter: "A", remark: "  " }], "body.bands.0"],
      [[{ min: "0", max: 100, letter: "A", remark: "A" }], "body.bands.0.min"],
      [[{ min: 0, max: 100, letter: "A", remark: "A", tenantId: b.id }], "body.bands.0"],
    ];
    for (const [bands, expected] of cases) {
      const res = await post(bands);
      expect(res.status, JSON.stringify(bands)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(path(res), JSON.stringify(bands)).toContain(expected);
    }
    expect((await api(scales(), as("admin", { method: "POST", body: { name: uniq("X"), bands: BANDS, isDefault: true } }))).status).toBe(
      400,
    );
    expect((await api(scales(), as("admin", { method: "POST", body: { name: uniq("X") } }))).status).toBe(400);
  });

  test("make-default swaps the default (changed:true), is a no-op on the current one, and is a 409 ARCHIVED for an archived scale; the DEFAULT cannot be archived (409 DEFAULT_CANNOT_ARCHIVE)", async () => {
    const one = await newScale();
    const two = await newScale();
    const current = (await api(scales(), as("admin"))).json.data.gradeScales.find((s: { isDefault: boolean }) => s.isDefault);
    expect(current).toBeTruthy();
    const makeTwo = await api(`${scales()}/${two.id}/make-default`, as("admin", { method: "POST" }));
    expect(makeTwo.json.data).toMatchObject({ changed: !two.isDefault, gradeScale: { id: two.id, isDefault: true } });
    expect((await api(`${scales()}/${two.id}/make-default`, as("admin", { method: "POST" }))).json.data).toMatchObject({ changed: false });
    expect(await db.gradeScale.count({ where: { tenantId: a.id, isDefault: true, archivedAt: null } })).toBe(1);
    const refused = await api(`${scales()}/${two.id}/archive`, as("admin", { method: "POST" }));
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("DEFAULT_CANNOT_ARCHIVE");
    expect((await api(`${scales()}/${one.id}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      gradeScale: { archived: true },
    });
    expect((await api(`${scales()}/${one.id}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({ changed: false });
    const archivedDefault = await api(`${scales()}/${one.id}/make-default`, as("admin", { method: "POST" }));
    expect(archivedDefault.status).toBe(409);
    expect(archivedDefault.json.error.code).toBe("ARCHIVED");
    expect(await db.gradeScale.count({ where: { tenantId: a.id, isDefault: true, archivedAt: null } })).toBe(1);
  });

  test("PATCH replaces the bands in place (changed:true, then false); a bad list is 400 and keeps the old bands; a LOCKED scale is 409 LOCKED and takes a new version that keeps the default", async () => {
    const scale = await newScale();
    const url = `${scales()}/${scale.id}`;
    const patch = (body: object) => api(url, as("admin", { method: "PATCH", body }));
    const two = [
      { min: 0, max: 50, letter: "F", remark: "Fail" },
      { min: 50, max: 100, letter: "P", remark: "Pass" },
    ];
    expect((await patch({ bands: two })).json.data).toMatchObject({
      changed: true,
      gradeScale: { bands: [{ letter: "F" }, { letter: "P" }] },
    });
    expect((await patch({ bands: two })).json.data).toMatchObject({ changed: false });
    expect((await patch({})).status).toBe(400);
    expect((await patch({ isDefault: true })).status).toBe(400);
    expect((await patch({ bands: [{ min: 0, max: 60, letter: "F", remark: "x" }] })).status).toBe(400);
    expect((await api(url, as("admin"))).json.data.gradeScale.bands).toHaveLength(2);

    const early = await api(`${url}/new-version`, as("admin", { method: "POST", body: {} }));
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("NOT_LOCKED");
    await db.gradeScale.update({ where: { id: scale.id }, data: { lockedAt: new Date() } });
    const locked = await patch({ name: uniq("Nope") });
    expect(locked.status).toBe(409);
    expect(locked.json.error.code).toBe("LOCKED");
    const wasDefault = (await api(url, as("admin"))).json.data.gradeScale.isDefault as boolean;
    const v2 = await api(`${url}/new-version`, as("admin", { method: "POST", body: { bands: BANDS } }));
    expect(v2.status).toBe(201);
    expect(v2.json.data.gradeScale).toMatchObject({ version: 2, supersedesId: scale.id, isDefault: wasDefault, locked: false });
    expect((await api(url, as("admin"))).json.data.gradeScale).toMatchObject({
      archived: true,
      locked: true,
      isDefault: false,
      version: 1,
    });
    expect(await db.gradeScale.count({ where: { tenantId: a.id, isDefault: true, archivedAt: null } })).toBe(1);
  });

  test("another school's scale is the SAME 404 as an unknown id on every route; a path that cannot be an id is 404 too", async () => {
    const theirs = await newScale("Beta only scale", "outsider", b.code);
    const unknown = await api(`${scales()}/no-such-scale`, as("admin"));
    for (const [method, url, body] of [
      ["GET", `${scales()}/${theirs.id}`, undefined],
      ["PATCH", `${scales()}/${theirs.id}`, { name: "hijack" }],
      ["POST", `${scales()}/${theirs.id}/new-version`, {}],
      ["POST", `${scales()}/${theirs.id}/make-default`, undefined],
      ["POST", `${scales()}/${theirs.id}/archive`, undefined],
    ] as [string, string, object | undefined][]) {
      const res = await api(url, as("admin", { method, ...(body ? { body } : {}) }));
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.json, `${method} ${url}`).toEqual(unknown.json);
    }
    expect((await api(`${scales()}/${encodeURIComponent("../etc")}`, as("admin"))).json).toEqual(unknown.json);
    expect(await db.gradeScale.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
      name: "Beta only scale",
      archivedAt: null,
    });
  });
});
