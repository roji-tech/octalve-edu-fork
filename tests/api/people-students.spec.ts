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

// Students and their enrolment over real HTTP against the SaaS-mode server (plan "Build design — Phase 1.2", decisions P2–P4, P7): who may read and
// write, strict bodies, the status and code of every refusal, campus scope and identical 404s. Cross-tenant, signed-out and deactivated callers are ALSO
// covered for every route by tenant-boundary.spec.ts (it discovers routes from the file system).

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
const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
let counter = 0;
const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++counter}`;
const newStudent = (over: Record<string, unknown> = {}) => ({
  firstName: uniq("Sade"),
  lastName: "Okoro",
  dateOfBirth: "2012-05-01",
  ...over,
});

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}
const seedStudent = (over: { campusId?: string | null; school?: TestTenant; firstName?: string } = {}) =>
  db.studentRecord.create({
    data: {
      tenantId: (over.school ?? a).id,
      campusId: over.campusId ?? null,
      firstName: over.firstName ?? uniq("Seed"),
      lastName: "Pupil",
      dateOfBirth: new Date("2011-03-04"),
      admissionNo: uniq("SEED/"),
    },
  });
const seedSession = (status: "PLANNED" | "ACTIVE" | "CLOSED" = "PLANNED", school: TestTenant = a, campusId: string | null = null) =>
  db.academicSession.create({
    data: { tenantId: school.id, campusId, label: uniq("S"), startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31"), status },
  });
async function seedArm(school: TestTenant = a, campusId: string | null = null) {
  const group = await db.classGroup.create({ data: { tenantId: school.id, campusId, name: uniq("Grp") } });
  return db.classArm.create({ data: { tenantId: school.id, classGroupId: group.id, name: "A", capacity: 2 } });
}

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

test.describe("the role matrix: every route, every kind of caller", () => {
  test("reads: administrators and staff may; a parent, a student, a deactivated member and another school's administrator get the ONE 403 body", async () => {
    const s = await seedStudent();
    const session = await seedSession();
    const reads = [students(), `${students()}/${s.id}`, `${people()}/enrolment-counts?sessionId=${session.id}`];
    for (const url of reads) {
      for (const who of ["admin", "teacher", "clerk"]) expect((await api(url, as(who))).status, `${who} ${url}`).toBe(200);
      for (const who of ["parent", "learner", "former", "outsider"]) {
        const res = await api(url, as(who));
        expect(res.status, `${who} ${url}`).toBe(403);
        expect(res.json, `${who} ${url}`).toEqual(NO_ACCESS);
      }
    }
  });

  test("writes: ONLY an administrator of that school — everyone else is the same 403 and nothing changes", async () => {
    const s = await seedStudent({ firstName: "Untouchable" });
    const session = await seedSession();
    const arm = await seedArm();
    const enrolment = await db.studentEnrollment.create({
      data: { tenantId: a.id, studentId: s.id, sessionId: session.id, classArmId: arm.id },
    });
    const writes: [string, string, object | undefined][] = [
      ["POST", students(), newStudent()],
      ["PATCH", `${students()}/${s.id}`, { firstName: "Renamed" }],
      ["POST", `${students()}/${s.id}/archive`, undefined],
      ["POST", `${students()}/${s.id}/restore`, undefined],
      ["POST", `${students()}/${s.id}/enrolments`, { sessionId: session.id, classArmId: arm.id }],
      ["PATCH", `${students()}/${s.id}/enrolments/${enrolment.id}`, { classArmId: arm.id }],
      ["POST", `${students()}/${s.id}/enrolments/${enrolment.id}/withdraw`, { reason: "Not allowed" }],
    ];
    const before = await db.studentRecord.count({ where: { tenantId: a.id } });
    for (const [method, url, body] of writes) {
      for (const who of ["teacher", "clerk", "parent", "learner", "former", "outsider"]) {
        const res = await api(url, as(who, { method, ...(body ? { body } : {}) }));
        expect(res.status, `${who} ${method} ${url}`).toBe(403);
        expect(res.json, `${who} ${method} ${url}`).toEqual(NO_ACCESS);
      }
    }
    expect(await db.studentRecord.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ firstName: "Untouchable", archivedAt: null });
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(before);
    expect(await db.studentEnrollment.findUniqueOrThrow({ where: { id: enrolment.id } })).toMatchObject({ status: "ACTIVE" });
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: { in: [s.id, enrolment.id] } } })).toBe(0);
  });

  test("CSRF is enforced on every write", async () => {
    const res = await api(students(), as("admin", { method: "POST", body: newStudent(), origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });
});

test.describe("creating and changing a student", () => {
  test("POST makes a student (201) with a cleaned name and a generated YYYY/NNNN number; a typed number is kept; the response is the record and nothing else about the school", async () => {
    const first = uniq("Amina");
    const made = await api(
      students(),
      as("admin", { method: "POST", body: newStudent({ firstName: `  ${first}  `, middleName: " Ruth " }) }),
    );
    expect(made.status).toBe(201);
    expect(made.json.data.student).toMatchObject({
      firstName: first,
      middleName: "Ruth",
      lastName: "Okoro",
      dateOfBirth: "2012-05-01",
      archived: false,
      enrolment: null,
    });
    expect(made.json.data.student.admissionNo).toMatch(/^\d{4}\/\d{4,}$/);
    expect(Object.keys(made.json.data.student).sort()).toEqual(
      ["admissionNo", "archived", "campusId", "campusName", "dateOfBirth", "enrolment", "firstName", "id", "lastName", "middleName"].sort(),
    );
    const typed = await api(students(), as("admin", { method: "POST", body: newStudent({ admissionNo: uniq("OLD/") }) }));
    expect(typed.status).toBe(201);
    expect(typed.json.data.student.admissionNo).toMatch(/^OLD\//);
  });

  test("a duplicate is 409 POSSIBLE_DUPLICATE naming the existing number; a taken number is 409 ADMISSION_NUMBER_TAKEN with the field; neither writes", async () => {
    const body = newStudent();
    const first = await api(students(), as("admin", { method: "POST", body }));
    expect(first.status).toBe(201);
    const dup = await api(students(), as("admin", { method: "POST", body: { ...body, firstName: body.firstName.toUpperCase() } }));
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: "POSSIBLE_DUPLICATE" });
    expect(dup.json.error.message).toContain(first.json.data.student.admissionNo);
    const taken = await api(
      students(),
      as("admin", { method: "POST", body: newStudent({ admissionNo: first.json.data.student.admissionNo.toLowerCase() }) }),
    );
    expect(taken.status).toBe(409);
    expect(taken.json.error).toMatchObject({ code: "ADMISSION_NUMBER_TAKEN", details: [{ path: "body.admissionNo" }] });
    expect(await db.studentRecord.count({ where: { tenantId: a.id, firstName: { equals: body.firstName, mode: "insensitive" } } })).toBe(1);

    const overridden = await api(
      students(),
      as("admin", { method: "POST", body: { ...body, firstName: body.firstName.toUpperCase(), allowDuplicate: true } }),
    );
    expect(overridden.status).toBe(201);
    expect(overridden.json.data.student.admissionNo).not.toBe(first.json.data.student.admissionNo);
    expect(await db.studentRecord.count({ where: { tenantId: a.id, firstName: { equals: body.firstName, mode: "insensitive" } } })).toBe(2);
  });

  test("bad bodies are 400 VALIDATION naming the field; unknown keys (tenantId, userId, archivedAt, id) are refused, not ignored", async () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ firstName: "" }, "body.firstName"],
      [{ firstName: "x".repeat(81) }, "body.firstName"],
      [{ lastName: "   " }, "body.lastName"],
      [{ middleName: "x".repeat(81) }, "body.middleName"],
      [{ dateOfBirth: "2012-02-30" }, "body.dateOfBirth"],
      [{ dateOfBirth: "2999-01-01" }, "body.dateOfBirth"],
      [{ dateOfBirth: "05/01/2012" }, "body.dateOfBirth"],
      [{ admissionNo: "bad number!" }, "body.admissionNo"],
      [{ firstName: 5 }, undefined],
      [{ tenantId: b.id }, undefined],
      [{ userId: learner.id }, undefined],
      [{ archivedAt: "2020-01-01" }, undefined],
      [{ id: "mine" }, undefined],
    ];
    const before = await db.studentRecord.count({ where: { tenantId: a.id } });
    for (const [over, path] of cases) {
      const res = await api(students(), as("admin", { method: "POST", body: newStudent(over) }));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      if (path)
        expect(
          res.json.error.details.map((d: { path: string }) => d.path),
          JSON.stringify(over),
        ).toContain(path);
    }
    const foreignCampus = await api(students(), as("admin", { method: "POST", body: newStudent({ campusId: b.campuses[0].id }) }));
    expect(foreignCampus.status).toBe(400);
    expect(foreignCampus.json.error.details[0].path).toBe("body.campusId");
    expect(
      (await api(students(), as("admin", { method: "POST", rawBody: "{oops", headers: { "content-type": "application/json" } }))).status,
    ).toBe(400);
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(before);
  });

  test("PATCH changes fields (changed: true), says changed: false for a no-op, refuses an empty body and unknown keys, and cannot move the campus", async () => {
    const made = (await api(students(), as("admin", { method: "POST", body: newStudent({ campusId: a.campuses[0].id }) }))).json.data
      .student;
    const url = `${students()}/${made.id}`;
    const changed = await api(url, as("admin", { method: "PATCH", body: { lastName: "Bello", dateOfBirth: "2012-06-01" } }));
    expect(changed.status).toBe(200);
    expect(changed.json.data).toMatchObject({
      changed: true,
      student: { lastName: "Bello", dateOfBirth: "2012-06-01", campusId: a.campuses[0].id },
    });
    expect((await api(url, as("admin", { method: "PATCH", body: { lastName: "Bello" } }))).json.data.changed).toBe(false);
    for (const body of [{}, { campusId: a.campuses[1].id }, { tenantId: b.id }, { firstName: "" }, { admissionNo: "no no" }]) {
      expect((await api(url, as("admin", { method: "PATCH", body }))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await db.studentRecord.findUniqueOrThrow({ where: { id: made.id } })).campusId).toBe(a.campuses[0].id);
  });

  test("archive and restore are idempotent (200, changed false the second time); archiving an enrolled student is 409 HAS_ACTIVE_ENROLMENT; an archived one is read-only", async () => {
    const s = await seedStudent();
    const session = await seedSession();
    const arm = await seedArm();
    const enrol = await api(
      `${students()}/${s.id}/enrolments`,
      as("admin", { method: "POST", body: { sessionId: session.id, classArmId: arm.id } }),
    );
    expect(enrol.status).toBe(201);
    const refused = await api(`${students()}/${s.id}/archive`, as("admin", { method: "POST" }));
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("HAS_ACTIVE_ENROLMENT");
    await api(
      `${students()}/${s.id}/enrolments/${enrol.json.data.enrolment.id}/withdraw`,
      as("admin", { method: "POST", body: { reason: "Left the school" } }),
    );
    expect((await api(`${students()}/${s.id}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      student: { archived: true },
    });
    expect((await api(`${students()}/${s.id}/archive`, as("admin", { method: "POST" }))).json.data.changed).toBe(false);
    const edit = await api(`${students()}/${s.id}`, as("admin", { method: "PATCH", body: { firstName: "Edited" } }));
    expect(edit.status).toBe(409);
    expect(edit.json.error.code).toBe("ARCHIVED");
    expect((await api(`${students()}/${s.id}/restore`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      student: { archived: false },
    });
  });

  test("duplicate override with allowDuplicate: true works on PATCH and restore", async () => {
    await seedStudent({ firstName: "Alhaji" });
    const s2 = await seedStudent({ firstName: "Other" });

    // PATCH to duplicate name
    const blockedPatch = await api(`${students()}/${s2.id}`, as("admin", { method: "PATCH", body: { firstName: "Alhaji" } }));
    expect(blockedPatch.status).toBe(409);
    expect(blockedPatch.json.error.code).toBe("POSSIBLE_DUPLICATE");

    const allowedPatch = await api(
      `${students()}/${s2.id}`,
      as("admin", { method: "PATCH", body: { firstName: "Alhaji", allowDuplicate: true } }),
    );
    expect(allowedPatch.status).toBe(200);
    expect(allowedPatch.json.data.changed).toBe(true);

    // Archive and restore
    expect((await api(`${students()}/${s2.id}/archive`, as("admin", { method: "POST" }))).status).toBe(200);
    const blockedRestore = await api(`${students()}/${s2.id}/restore`, as("admin", { method: "POST" }));
    expect(blockedRestore.status).toBe(409);
    expect(blockedRestore.json.error.code).toBe("POSSIBLE_DUPLICATE");

    const allowedRestore = await api(`${students()}/${s2.id}/restore`, as("admin", { method: "POST", body: { allowDuplicate: true } }));
    expect(allowedRestore.status).toBe(200);
    expect(allowedRestore.json.data.changed).toBe(true);
    expect(allowedRestore.json.data.student.archived).toBe(false);
  });
});

test.describe("reading", () => {
  test("the list is A to Z with paging meta; ?q= ?status= ?campusId= filter; a bad query is a 400 naming the parameter", async () => {
    const tag = uniq("Listy");
    for (const n of ["Charlie", "Alice", "Bob"])
      await api(students(), as("admin", { method: "POST", body: newStudent({ firstName: n, lastName: tag }) }));
    const list = await api(`${students()}?q=${tag}&limit=2`, as("admin"));
    expect(list.status).toBe(200);
    expect(list.json.data.students.map((x: { firstName: string }) => x.firstName)).toEqual(["Alice", "Bob"]);
    expect(list.json.meta).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2, hasNext: true });
    expect(
      (await api(`${students()}?q=${tag}&limit=2&page=2`, as("admin"))).json.data.students.map((x: { firstName: string }) => x.firstName),
    ).toEqual(["Charlie"]);
    expect((await api(`${students()}?q=${tag}&status=archived`, as("admin"))).json.meta.total).toBe(0);
    for (const bad of ["status=bogus", "limit=0", "limit=101", "page=0", "notEnrolled=false", "campusId=", "sessionId=a&sessionId=b"]) {
      const res = await api(`${students()}?${bad}`, as("admin"));
      expect(res.status, bad).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
  });

  test("staff see school-wide students and their own campus's; another campus's student is the same 404 as an unknown id, a foreign school's id, and an implausible one", async () => {
    const wide = await seedStudent({ firstName: uniq("Wide") });
    const north = await seedStudent({ campusId: a.campuses[0].id, firstName: uniq("North") });
    const south = await seedStudent({ campusId: a.campuses[1].id, firstName: uniq("South") });
    const foreign = await seedStudent({ school: b });
    const list = await api(`${students()}?limit=100`, as("teacher"));
    const ids = list.json.data.students.map((x: { id: string }) => x.id);
    expect(ids).toContain(wide.id);
    expect(ids).toContain(north.id);
    expect(ids).not.toContain(south.id);
    expect(ids).not.toContain(foreign.id);
    expect((await api(`${students()}?limit=100`, as("clerk"))).json.data.students.map((x: { id: string }) => x.id)).not.toContain(north.id); // no campus: school-wide only
    expect((await api(`${students()}?limit=100&campusId=${a.campuses[1].id}`, as("teacher"))).json.data.students).toEqual([]);
    expect((await api(`${students()}?limit=100`, as("admin"))).json.data.students.map((x: { id: string }) => x.id)).toEqual(
      expect.arrayContaining([south.id, north.id]),
    );

    const missing = await api(`${students()}/no-such-id`, as("teacher"));
    expect(missing.status).toBe(404);
    for (const id of [south.id, foreign.id, "no-such-id", "x".repeat(65), "has space"]) {
      const res = await api(`${students()}/${encodeURIComponent(id)}`, as("teacher"));
      expect(res.status, id).toBe(404);
      expect(res.json, id).toEqual(missing.json);
    }
    expect((await api(`${students()}/${foreign.id}`, as("admin"))).json).toEqual(missing.json); // even an administrator cannot read another school's student
  });
});

test.describe("enrolment", () => {
  test("enrol (201) → again is 409 ALREADY_ENROLLED naming the class → move → withdraw needs a reason → re-enrol reactivates (200); the history is on the student", async () => {
    const s = await seedStudent();
    const session = await seedSession("ACTIVE");
    const [one, two] = [await seedArm(), await seedArm()];
    const url = `${students()}/${s.id}/enrolments`;
    const first = await api(url, as("admin", { method: "POST", body: { sessionId: session.id, classArmId: one.id } }));
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({
      reenrolled: false,
      enrolment: { status: "ACTIVE", sessionId: session.id, classArmId: one.id },
    });
    const again = await api(url, as("admin", { method: "POST", body: { sessionId: session.id, classArmId: two.id } }));
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "ALREADY_ENROLLED", details: [{ path: "body.sessionId" }] });
    const id = first.json.data.enrolment.id;
    const moved = await api(`${url}/${id}`, as("admin", { method: "PATCH", body: { classArmId: two.id } }));
    expect(moved.json.data).toMatchObject({ changed: true, enrolment: { classArmId: two.id } });
    expect((await api(`${url}/${id}`, as("admin", { method: "PATCH", body: { classArmId: two.id } }))).json.data.changed).toBe(false);
    for (const reason of ["", "no", "x".repeat(301)]) {
      const res = await api(`${url}/${id}/withdraw`, as("admin", { method: "POST", body: { reason } }));
      expect(res.status, reason).toBe(400);
      expect(res.json.error.details[0].path).toBe("body.reason");
    }
    expect(
      (await api(`${url}/${id}/withdraw`, as("admin", { method: "POST", body: { reason: "Moved to another school" } }))).json.data.enrolment
        .status,
    ).toBe("WITHDRAWN");
    expect((await api(`${url}/${id}/withdraw`, as("admin", { method: "POST", body: { reason: "A second time" } }))).status).toBe(409);
    const back = await api(url, as("admin", { method: "POST", body: { sessionId: session.id, classArmId: one.id } }));
    expect(back.status).toBe(200);
    expect(back.json.data).toMatchObject({ reenrolled: true, enrolment: { id, status: "ACTIVE" } });
    const detail = await api(`${students()}/${s.id}`, as("teacher"));
    expect(detail.json.data.enrolments).toHaveLength(1);
    expect(detail.json.data.enrolments[0]).toMatchObject({ id, status: "ACTIVE" });
  });

  test("a closed session is 409 SESSION_CLOSED; a foreign or unknown session or class is a 400 naming the field; unknown keys are refused; a foreign enrolment id is a 404", async () => {
    const s = await seedStudent();
    const other = await seedStudent();
    const closed = await seedSession("CLOSED");
    const open = await seedSession("PLANNED");
    const arm = await seedArm();
    const url = `${students()}/${s.id}/enrolments`;
    const post = (body: object) => api(url, as("admin", { method: "POST", body }));
    expect((await post({ sessionId: closed.id, classArmId: arm.id })).json.error.code).toBe("SESSION_CLOSED");
    const foreignSession = await seedSession("PLANNED", b);
    const foreignArm = await seedArm(b);
    for (const [body, path] of [
      [{ sessionId: foreignSession.id, classArmId: arm.id }, "body.sessionId"],
      [{ sessionId: "nope", classArmId: arm.id }, "body.sessionId"],
      [{ sessionId: open.id, classArmId: foreignArm.id }, "body.classArmId"],
      [{ sessionId: open.id, classArmId: "nope" }, "body.classArmId"],
    ] as [object, string][]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.details[0].path).toBe(path);
    }
    for (const body of [
      { sessionId: open.id },
      { classArmId: arm.id },
      { sessionId: open.id, classArmId: arm.id, status: "ALUMNI" },
      { sessionId: open.id, classArmId: arm.id, tenantId: b.id },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await db.studentEnrollment.count({ where: { studentId: s.id } })).toBe(0);
    // someone else's enrolment id through this student's URL
    const theirs = await db.studentEnrollment.create({
      data: { tenantId: a.id, studentId: other.id, sessionId: open.id, classArmId: arm.id },
    });
    expect((await api(`${url}/${theirs.id}`, as("admin", { method: "PATCH", body: { classArmId: arm.id } }))).status).toBe(404);
    expect(
      (await api(`${url}/${theirs.id}/withdraw`, as("admin", { method: "POST", body: { reason: "Not theirs to touch" } }))).status,
    ).toBe(404);
    expect((await db.studentEnrollment.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("ACTIVE");
  });

  test("enrolment-counts: how many are actively enrolled per class; capacity is not enforced; a foreign session is a 400, a missing parameter a 400", async () => {
    const session = await seedSession("PLANNED");
    const arm = await seedArm(); // capacity 2
    for (let i = 0; i < 3; i++) {
      const s = await seedStudent();
      expect(
        (
          await api(
            `${students()}/${s.id}/enrolments`,
            as("admin", { method: "POST", body: { sessionId: session.id, classArmId: arm.id } }),
          )
        ).status,
      ).toBe(201);
    }
    const counts = await api(`${people()}/enrolment-counts?sessionId=${session.id}`, as("teacher"));
    expect(counts.json.data.counts[arm.id]).toBe(3); // over its capacity of 2, by design
    const foreign = await seedSession("PLANNED", b);
    expect((await api(`${people()}/enrolment-counts?sessionId=${foreign.id}`, as("admin"))).status).toBe(400);
    expect((await api(`${people()}/enrolment-counts`, as("admin"))).status).toBe(400);
  });
});
