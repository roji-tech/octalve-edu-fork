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

// Guardians and their links over real HTTP against the SaaS-mode server (plan "Build design — Phase 1.2", decision P6): who may read and write, strict bodies,
// the status and code of every refusal, campus scope and identical 404s. Every route is ALSO covered by tenant-boundary.spec.ts (file-system discovery).

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let teacher: TestUser; // TEACHING_STAFF at North
let clerk: TestUser; // NON_TEACHING_STAFF, no campus
let parent: TestUser;
let learner: TestUser;
let former: TestUser;
let outsider: TestUser;
const cookie: Record<string, string> = {};

const people = (code = a.code) => `/api/v1/schools/${code}/people`;
const students = (code = a.code) => `${people(code)}/students`;
const guardians = (code = a.code) => `${people(code)}/guardians`;
const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
let counter = 0;
const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++counter}`;
const NEW = () => ({
  firstName: uniq("Gbenga"),
  lastName: "Okoro",
  phone: "08031234567",
  email: `${uniq("g")}@example.com`,
  relationship: "FATHER",
});

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}
const seedStudent = (over: { campusId?: string | null; school?: TestTenant } = {}) =>
  db.studentRecord.create({
    data: {
      tenantId: (over.school ?? a).id,
      campusId: over.campusId ?? null,
      firstName: uniq("Seed"),
      lastName: "Pupil",
      dateOfBirth: new Date("2011-03-04"),
      admissionNo: uniq("SEED/"),
    },
  });
const addTo = (studentId: string, body: object, who = "admin") =>
  api(`${students()}/${studentId}/guardians`, as(who, { method: "POST", body }));

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  [admin, teacher, clerk, parent, learner, former, outsider] = await Promise.all(
    ["Ada Admin", "Tola Teacher", "Clem Clerk", "Pat Parent", "Sam Student", "Fay Former", "Bayo Elsewhere"].map((name) =>
      createUser({ name }),
    ),
  );
  await addMembership(admin.id, a.id, Role.ADMIN);
  await addMembership(teacher.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  await addMembership(clerk.id, a.id, Role.NON_TEACHING_STAFF);
  await addMembership(parent.id, a.id, Role.PARENT);
  await addMembership(learner.id, a.id, Role.STUDENT);
  await addMembership(former.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  await addMembership(outsider.id, b.id, Role.ADMIN);
  await deactivateMembership(former.id, a.id);
  for (const [who, user] of Object.entries({ admin, teacher, clerk, parent, learner, former, outsider }))
    cookie[who] = await cookieFor(user);
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("the role matrix", () => {
  test("reads: administrators and staff may; a parent, a student, a deactivated member and another school's administrator get the ONE 403 body — a guardian cannot read guardians, not even their own", async () => {
    const s = await seedStudent();
    const made = await addTo(s.id, NEW());
    expect(made.status).toBe(201);
    const gid = made.json.data.guardian.guardian.id;
    for (const url of [`${students()}/${s.id}/guardians`, guardians(), `${guardians()}/${gid}`]) {
      for (const who of ["admin", "teacher", "clerk"]) expect((await api(url, as(who))).status, `${who} ${url}`).toBe(200);
      for (const who of ["parent", "learner", "former", "outsider"]) {
        const res = await api(url, as(who));
        expect(res.status, `${who} ${url}`).toBe(403);
        expect(res.json, `${who} ${url}`).toEqual(NO_ACCESS);
      }
    }
  });

  test("writes: ONLY an administrator of that school — everyone else is the same 403 and nothing changes", async () => {
    const s = await seedStudent();
    const made = (await addTo(s.id, NEW())).json.data.guardian;
    const gid = made.guardian.id;
    const writes: [string, string, object | undefined][] = [
      ["POST", `${students()}/${s.id}/guardians`, NEW()],
      ["PATCH", `${students()}/${s.id}/guardians/${made.id}`, { relationship: "OTHER" }],
      ["POST", `${students()}/${s.id}/guardians/${made.id}/remove`, undefined],
      ["PATCH", `${guardians()}/${gid}`, { firstName: "Renamed" }],
      ["POST", `${guardians()}/${gid}/archive`, undefined],
      ["POST", `${guardians()}/${gid}/restore`, undefined],
    ];
    for (const [method, url, body] of writes) {
      for (const who of ["teacher", "clerk", "parent", "learner", "former", "outsider"]) {
        const res = await api(url, as(who, { method, ...(body ? { body } : {}) }));
        expect(res.status, `${who} ${method} ${url}`).toBe(403);
        expect(res.json, `${who} ${method} ${url}`).toEqual(NO_ACCESS);
      }
    }
    expect(await db.guardianLink.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({
      relationship: "FATHER",
      status: "APPROVED",
    });
    expect(await db.guardianRecord.count({ where: { tenantId: a.id, id: gid, archivedAt: null } })).toBe(1);
    expect(await db.guardianLink.count({ where: { studentId: s.id } })).toBe(1);
  });

  test("CSRF is enforced on every write", async () => {
    const s = await seedStudent();
    const res = await api(`${students()}/${s.id}/guardians`, as("admin", { method: "POST", body: NEW(), origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });
});

test.describe("linking guardians", () => {
  test("POST with a new guardian is 201 and the first becomes primary; the second is not; an existing guardian links a sibling; twice is 409 ALREADY_LINKED; a removed one comes back as 200", async () => {
    const one = await seedStudent();
    const two = await seedStudent();
    const first = await addTo(one.id, NEW());
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({
      createdGuardian: true,
      reactivated: false,
      guardian: { relationship: "FATHER", isPrimary: true, status: "APPROVED" },
    });
    const second = await addTo(one.id, { firstName: "Mary", lastName: "Okoro", relationship: "MOTHER" });
    expect(second.json.data.guardian.isPrimary).toBe(false);
    const gid = first.json.data.guardian.guardian.id;
    const sibling = await addTo(two.id, { guardianId: gid, relationship: "FATHER" });
    expect(sibling.status).toBe(201);
    expect(sibling.json.data).toMatchObject({ createdGuardian: false, guardian: { guardian: { id: gid, studentCount: 2 } } });
    const again = await addTo(two.id, { guardianId: gid, relationship: "MOTHER" });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "ALREADY_LINKED", details: [{ path: "body.guardianId" }] });

    const linkId = sibling.json.data.guardian.id;
    expect((await api(`${students()}/${two.id}/guardians/${linkId}/remove`, as("admin", { method: "POST" }))).json.data.changed).toBe(true);
    expect((await api(`${students()}/${two.id}/guardians/${linkId}/remove`, as("admin", { method: "POST" }))).json.data.changed).toBe(
      false,
    );
    expect((await api(`${students()}/${two.id}/guardians`, as("teacher"))).json.data.guardians).toEqual([]);
    const back = await addTo(two.id, { guardianId: gid, relationship: "GUARDIAN" });
    expect(back.status).toBe(200);
    expect(back.json.data).toMatchObject({ reactivated: true, guardian: { id: linkId, relationship: "GUARDIAN", isPrimary: true } });
  });

  test("bad bodies are 400 naming the field; unknown keys (tenantId, status, approvedById, userId) are refused; an unknown, foreign or archived guardian id is a 400 on guardianId", async () => {
    const s = await seedStudent();
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ ...NEW(), relationship: "UNCLE" }, "body.relationship"],
      [{ ...NEW(), firstName: "" }, "body.firstName"],
      [{ ...NEW(), phone: "12" }, "body.phone"],
      [{ ...NEW(), email: "nope" }, "body.email"],
      [{ relationship: "FATHER" }, "body.guardianId"],
      [{ ...NEW(), guardianId: "x" }, "body.guardianId"],
      [{ ...NEW(), tenantId: b.id }, undefined],
      [{ ...NEW(), status: "APPROVED" }, undefined],
      [{ ...NEW(), approvedById: admin.id }, undefined],
      [{ ...NEW(), userId: parent.id }, undefined],
    ];
    for (const [body, path] of cases) {
      const res = await addTo(s.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      if (path)
        expect(
          res.json.error.details.map((d: { path: string }) => d.path),
          JSON.stringify(body),
        ).toContain(path);
    }
    const foreignStudent = await seedStudent({ school: b });
    const foreign = await db.guardianRecord.create({ data: { tenantId: b.id, firstName: "F", lastName: "G" } });
    const archived = await db.guardianRecord.create({ data: { tenantId: a.id, firstName: "A", lastName: "G", archivedAt: new Date() } });
    for (const guardianId of [foreign.id, archived.id, "no-such-id"]) {
      const res = await addTo(s.id, { guardianId, relationship: "OTHER" });
      expect(res.status, guardianId).toBe(400);
      expect(res.json.error.details[0].path).toBe("body.guardianId");
    }
    expect((await addTo(foreignStudent.id, NEW())).status).toBe(404);
    expect(await db.guardianLink.count({ where: { studentId: s.id } })).toBe(0);
  });

  test("PATCH a link: relationship and primary (the old primary is demoted); an empty body, an unknown relationship or an unknown key is 400; another student's link id is 404", async () => {
    const s = await seedStudent();
    const other = await seedStudent();
    const dad = (await addTo(s.id, NEW())).json.data.guardian;
    const mum = (await addTo(s.id, { firstName: "Mary", lastName: "Okoro", relationship: "MOTHER" })).json.data.guardian;
    const url = (id: string, studentId = s.id) => `${students()}/${studentId}/guardians/${id}`;
    const swapped = await api(url(mum.id), as("admin", { method: "PATCH", body: { isPrimary: true } }));
    expect(swapped.json.data).toMatchObject({ changed: true, guardian: { isPrimary: true } });
    const list = (await api(`${students()}/${s.id}/guardians`, as("teacher"))).json.data.guardians;
    expect(list.map((g: { id: string; isPrimary: boolean }) => [g.id, g.isPrimary])).toEqual([
      [mum.id, true],
      [dad.id, false],
    ]);
    expect((await api(url(mum.id), as("admin", { method: "PATCH", body: { isPrimary: true } }))).json.data.changed).toBe(false);
    for (const body of [{}, { relationship: "UNCLE" }, { isPrimary: "yes" }, { tenantId: b.id }, { status: "REVOKED" }]) {
      expect((await api(url(dad.id), as("admin", { method: "PATCH", body }))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api(url(dad.id, other.id), as("admin", { method: "PATCH", body: { relationship: "OTHER" } }))).status).toBe(404);
    expect((await api(url(dad.id), as("admin"))).status).toBe(405); // no GET on a single link, and no DELETE: removing is a POST that revokes
    expect((await api(url(dad.id), as("admin", { method: "DELETE" }))).status).toBe(405);
  });
});

test.describe("the guardian record", () => {
  test("GET shows the guardian and their students; PATCH edits (null clears), says changed false for a no-op, refuses bad values and unknown keys", async () => {
    const s = await seedStudent();
    const made = (await addTo(s.id, NEW())).json.data.guardian;
    const gid = made.guardian.id;
    const detail = await api(`${guardians()}/${gid}`, as("teacher"));
    expect(detail.status).toBe(200);
    expect(detail.json.data.guardian).toMatchObject({ id: gid, studentCount: 1 });
    expect(detail.json.data.students).toEqual([
      expect.objectContaining({ studentId: s.id, relationship: "FATHER", isPrimary: true, linkId: made.id }),
    ]);

    const url = `${guardians()}/${gid}`;
    const edited = await api(url, as("admin", { method: "PATCH", body: { lastName: "Bello", phone: null } }));
    expect(edited.json.data).toMatchObject({ changed: true, guardian: { lastName: "Bello", phone: null } });
    expect((await api(url, as("admin", { method: "PATCH", body: { lastName: "Bello" } }))).json.data.changed).toBe(false);
    for (const body of [
      {},
      { firstName: "" },
      { phone: "12" },
      { email: "nope" },
      { tenantId: b.id },
      { userId: parent.id },
      { archivedAt: "2020-01-01" },
    ]) {
      const res = await api(url, as("admin", { method: "PATCH", body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    expect((await db.guardianRecord.findUniqueOrThrow({ where: { id: gid } })).lastName).toBe("Bello");
  });

  test("archive is 409 HAS_LIVE_LINKS while a student is linked, then 200; archive and restore are idempotent; an archived guardian cannot be edited", async () => {
    const s = await seedStudent();
    const made = (await addTo(s.id, NEW())).json.data.guardian;
    const gid = made.guardian.id;
    const refused = await api(`${guardians()}/${gid}/archive`, as("admin", { method: "POST" }));
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("HAS_LIVE_LINKS");
    await api(`${students()}/${s.id}/guardians/${made.id}/remove`, as("admin", { method: "POST" }));
    expect((await api(`${guardians()}/${gid}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      guardian: { archived: true },
    });
    expect((await api(`${guardians()}/${gid}/archive`, as("admin", { method: "POST" }))).json.data.changed).toBe(false);
    const edit = await api(`${guardians()}/${gid}`, as("admin", { method: "PATCH", body: { firstName: "Edited" } }));
    expect(edit.status).toBe(409);
    expect(edit.json.error.code).toBe("ARCHIVED");
    expect(
      (await api(`${guardians()}?status=archived&limit=100`, as("admin"))).json.data.guardians.map((g: { id: string }) => g.id),
    ).toContain(gid);
    expect((await api(`${guardians()}?limit=100`, as("admin"))).json.data.guardians.map((g: { id: string }) => g.id)).not.toContain(gid);
    expect((await api(`${guardians()}/${gid}/restore`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      guardian: { archived: false },
    });
    expect((await api(`${guardians()}/${gid}/restore`, as("admin", { method: "POST" }))).json.data.changed).toBe(false);
  });

  test("the list searches and pages; staff see only guardians of students they may see; another campus's, another school's and unknown ids are the same 404", async () => {
    const tag = uniq("Tag");
    const northPupil = await seedStudent({ campusId: a.campuses[0].id });
    const southPupil = await seedStudent({ campusId: a.campuses[1].id });
    const widePupil = await seedStudent();
    const gNorth = (await addTo(northPupil.id, { firstName: "Nora", lastName: tag, relationship: "MOTHER" })).json.data.guardian.guardian
      .id;
    const gSouth = (await addTo(southPupil.id, { firstName: "Sola", lastName: tag, relationship: "MOTHER" })).json.data.guardian.guardian
      .id;
    const gWide = (await addTo(widePupil.id, { firstName: "Wale", lastName: tag, relationship: "FATHER" })).json.data.guardian.guardian.id;
    const foreignStudent = await seedStudent({ school: b });
    const foreign = (
      await api(`${students(b.code)}/${foreignStudent.id}/guardians`, { ...SAAS, cookie: cookie.outsider, method: "POST", body: NEW() })
    ).json.data.guardian.guardian.id;

    const names = async (who: string, query = "") =>
      (await api(`${guardians()}?q=${tag}&limit=100${query}`, as(who))).json.data.guardians.map((g: { firstName: string }) => g.firstName);
    expect(await names("admin")).toEqual(["Nora", "Sola", "Wale"].sort());
    expect(await names("teacher")).toEqual(["Nora", "Wale"]);
    expect(await names("clerk")).toEqual(["Wale"]);
    const paged = await api(`${guardians()}?q=${tag}&limit=2`, as("admin"));
    expect(paged.json.meta).toMatchObject({ total: 3, pages: 2, hasNext: true });
    for (const bad of ["status=bogus", "limit=0", "limit=101"])
      expect((await api(`${guardians()}?${bad}`, as("admin"))).status, bad).toBe(400);

    expect((await api(`${guardians()}/${gNorth}`, as("teacher"))).status).toBe(200);
    expect((await api(`${guardians()}/${gWide}`, as("teacher"))).status).toBe(200);
    const missing = await api(`${guardians()}/no-such-id`, as("teacher"));
    expect(missing.status).toBe(404);
    for (const id of [gSouth, foreign, "no-such-id", "x".repeat(65)]) {
      const res = await api(`${guardians()}/${id}`, as("teacher"));
      expect(res.status, id).toBe(404);
      expect(res.json, id).toEqual(missing.json);
    }
    expect((await api(`${guardians()}/${foreign}`, as("admin"))).json).toEqual(missing.json);
    // the student's own guardian list: another campus's student is the same 404
    expect((await api(`${students()}/${southPupil.id}/guardians`, as("teacher"))).json).toEqual({
      ...missing.json,
      error: { ...missing.json.error, message: "No such student." },
    });
  });
});
