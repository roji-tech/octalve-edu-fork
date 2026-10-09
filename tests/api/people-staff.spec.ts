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
import { tokenFrom, waitForMail } from "../support/outbox";

// Staff records, their sign-in accounts and what they teach, over real HTTP against the SaaS-mode server (plan "Build design — Phase 1.2", decision P5): who may
// read and write, strict bodies, the status and code of every refusal, campus scope, identical 404s, and the whole invite → mail → accept → linked journey.
// Every route is ALSO covered by tenant-boundary.spec.ts (file-system discovery).

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };
const FRESH = "a-fresh-unseen-passphrase-3";

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
const staffUrl = (code = a.code) => `${people(code)}/staff`;
const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
let counter = 0;
const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++counter}`;
const email = (label = "s") => `${uniq(label)}@staff.test`;
const NEW = (over: Record<string, unknown> = {}) => ({ category: "TEACHING", firstName: uniq("Tola"), lastName: "Bello", ...over });

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}
const make = async (over: Record<string, unknown> = {}, school: TestTenant = a, who = "admin") => {
  const res = await api(staffUrl(school.code), as(who, { method: "POST", body: NEW(over) }));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.data.staff as { id: string; firstName: string };
};
async function classWith(school: TestTenant = a, campusId: string | null = null) {
  const group = await db.classGroup.create({ data: { tenantId: school.id, campusId, name: uniq("Grp") } });
  const arm = await db.classArm.create({ data: { tenantId: school.id, classGroupId: group.id, name: "A" } });
  const subject = await db.subject.create({ data: { tenantId: school.id, name: uniq("Subj") } });
  await db.subjectOffering.create({ data: { tenantId: school.id, classGroupId: group.id, subjectId: subject.id } });
  return { group, arm, subject };
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

test.describe("the role matrix", () => {
  test("reads: administrators and staff may; a parent, a student, a deactivated member and another school's administrator get the ONE 403 body", async () => {
    const s = await make();
    for (const url of [staffUrl(), `${staffUrl()}/${s.id}`]) {
      for (const who of ["admin", "teacher", "clerk"]) expect((await api(url, as(who))).status, `${who} ${url}`).toBe(200);
      for (const who of ["parent", "learner", "former", "outsider"]) {
        const res = await api(url, as(who));
        expect(res.status, `${who} ${url}`).toBe(403);
        expect(res.json, `${who} ${url}`).toEqual(NO_ACCESS);
      }
    }
  });

  test("the admin-only reads: staff get the same 403 for the list of linkable accounts", async () => {
    const s = await make();
    const url = `${staffUrl()}/${s.id}/linkable-accounts`;
    expect((await api(url, as("admin"))).status).toBe(200);
    for (const who of ["teacher", "clerk", "parent", "learner", "former", "outsider"]) {
      const res = await api(url, as(who));
      expect(res.status, who).toBe(403);
      expect(res.json, who).toEqual(NO_ACCESS);
    }
  });

  test("writes: ONLY an administrator of that school — everyone else is the same 403 and nothing changes", async () => {
    const s = await make({ email: email() });
    const c = await classWith();
    const writes: [string, string, object | undefined][] = [
      ["POST", staffUrl(), NEW()],
      ["PATCH", `${staffUrl()}/${s.id}`, { firstName: "Renamed" }],
      ["POST", `${staffUrl()}/${s.id}/archive`, undefined],
      ["POST", `${staffUrl()}/${s.id}/restore`, undefined],
      ["POST", `${staffUrl()}/${s.id}/invite`, undefined],
      ["POST", `${staffUrl()}/${s.id}/link-account`, { userId: teacher.id }],
      ["POST", `${staffUrl()}/${s.id}/unlink-account`, undefined],
      ["POST", `${staffUrl()}/${s.id}/assignments`, { subjectId: c.subject.id, classArmId: c.arm.id }],
      ["POST", `${staffUrl()}/${s.id}/assignments/some-id/remove`, undefined],
    ];
    const before = await db.staffRecord.count({ where: { tenantId: a.id } });
    for (const [method, url, body] of writes) {
      for (const who of ["teacher", "clerk", "parent", "learner", "former", "outsider"]) {
        const res = await api(url, as(who, { method, ...(body ? { body } : {}) }));
        expect(res.status, `${who} ${method} ${url}`).toBe(403);
        expect(res.json, `${who} ${method} ${url}`).toEqual(NO_ACCESS);
      }
    }
    expect(await db.staffRecord.count({ where: { tenantId: a.id } })).toBe(before);
    expect(await db.staffRecord.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({
      firstName: s.firstName,
      archivedAt: null,
      userId: null,
    });
    expect(await db.invitation.count({ where: { tenantId: a.id, staffRecordId: s.id } })).toBe(0);
    expect(await db.staffSubjectAssignment.count({ where: { staffRecordId: s.id } })).toBe(0);
  });

  test("CSRF is enforced on every write", async () => {
    const res = await api(staffUrl(), as("admin", { method: "POST", body: NEW(), origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });
});

test.describe("the record", () => {
  test("POST makes a record (201), cleaned; a duplicate email is 409 EMAIL_TAKEN with the field; bad bodies are 400 naming the field; unknown keys are refused", async () => {
    const to = email("dup");
    const made = await api(
      staffUrl(),
      as("admin", {
        method: "POST",
        body: NEW({ firstName: "  Tola ", email: to.toUpperCase(), phone: "08031234567", campusId: a.campuses[0].id }),
      }),
    );
    expect(made.status).toBe(201);
    expect(made.json.data.staff).toMatchObject({
      firstName: "Tola",
      email: to,
      phone: "08031234567",
      category: "TEACHING",
      campusId: a.campuses[0].id,
      account: { state: "none" },
      archived: false,
    });
    const dup = await api(staffUrl(), as("admin", { method: "POST", body: NEW({ email: to }) }));
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: "EMAIL_TAKEN", details: [{ path: "body.email" }] });
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ category: "JANITOR" }, "body.category"],
      [{ firstName: "" }, "body.firstName"],
      [{ lastName: "x".repeat(81) }, "body.lastName"],
      [{ phone: "12" }, "body.phone"],
      [{ email: "nope" }, "body.email"],
      [{ campusId: b.campuses[0].id }, "body.campusId"],
      [{ tenantId: b.id }, undefined],
      [{ userId: teacher.id }, undefined],
      [{ archivedAt: "2020-01-01" }, undefined],
    ];
    for (const [over, path] of cases) {
      const res = await api(staffUrl(), as("admin", { method: "POST", body: NEW(over) }));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      if (path)
        expect(
          res.json.error.details.map((d: { path: string }) => d.path),
          JSON.stringify(over),
        ).toContain(path);
    }
  });

  test("PATCH changes fields (changed: true), says false for a no-op, refuses an empty body and unknown keys; archive/restore are idempotent and an archived record is read-only (409)", async () => {
    const s = await make({ phone: "08031234567" });
    const url = `${staffUrl()}/${s.id}`;
    const changed = await api(url, as("admin", { method: "PATCH", body: { lastName: "Adeyemi", phone: null } }));
    expect(changed.json.data).toMatchObject({ changed: true, staff: { lastName: "Adeyemi", phone: null } });
    expect((await api(url, as("admin", { method: "PATCH", body: { lastName: "Adeyemi" } }))).json.data.changed).toBe(false);
    for (const body of [{}, { campusId: a.campuses[1].id }, { tenantId: b.id }, { firstName: "" }, { category: "NOPE" }]) {
      expect((await api(url, as("admin", { method: "PATCH", body }))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      staff: { archived: true },
    });
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.data.changed).toBe(false);
    const edit = await api(url, as("admin", { method: "PATCH", body: { firstName: "Edited" } }));
    expect(edit.status).toBe(409);
    expect(edit.json.error.code).toBe("ARCHIVED");
    expect((await api(`${url}/restore`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      staff: { archived: false },
    });
  });

  test("the list is A to Z with paging meta; ?q= ?status= ?category= filter; a bad query is a 400; staff see school-wide and their own campus's; another campus's, another school's and unknown ids are the same 404", async () => {
    const tag = uniq("Tag");
    const wide = await make({ lastName: tag, firstName: "Wide" });
    const north = await make({ lastName: tag, firstName: "North", campusId: a.campuses[0].id });
    const south = await make({ lastName: tag, firstName: "South", campusId: a.campuses[1].id, category: "NON_TEACHING" });
    const foreign = await make({ lastName: tag }, b, "outsider");
    const names = async (who: string, query = "") =>
      (await api(`${staffUrl()}?q=${tag}&limit=100${query}`, as(who))).json.data.staff.map((x: { firstName: string }) => x.firstName);
    expect(await names("admin")).toEqual(["North", "South", "Wide"]);
    expect(await names("teacher")).toEqual(["North", "Wide"]);
    expect(await names("clerk")).toEqual(["Wide"]);
    expect(await names("admin", "&category=NON_TEACHING")).toEqual(["South"]);
    expect(await names("admin", "&status=archived")).toEqual([]);
    const paged = await api(`${staffUrl()}?q=${tag}&limit=2`, as("admin"));
    expect(paged.json.meta).toMatchObject({ total: 3, pages: 2, hasNext: true });
    for (const bad of ["status=bogus", "category=JANITOR", "limit=0", "limit=101"])
      expect((await api(`${staffUrl()}?${bad}`, as("admin"))).status, bad).toBe(400);

    const missing = await api(`${staffUrl()}/no-such-id`, as("teacher"));
    expect(missing.status).toBe(404);
    expect((await api(`${staffUrl()}/${north.id}`, as("teacher"))).status).toBe(200);
    expect((await api(`${staffUrl()}/${wide.id}`, as("teacher"))).status).toBe(200);
    for (const id of [south.id, foreign.id, "no-such-id", "x".repeat(65)]) {
      const res = await api(`${staffUrl()}/${id}`, as("teacher"));
      expect(res.status, id).toBe(404);
      expect(res.json, id).toEqual(missing.json);
    }
    expect((await api(`${staffUrl()}/${foreign.id}`, as("admin"))).json).toEqual(missing.json);
  });
});

test.describe("the sign-in account", () => {
  test("link-account: 200 with the account shown; a second link, the wrong role, a deactivated or foreign member and a member on another record are 409/400 with codes; unlink clears it; the choices list only fitting members", async () => {
    const s = await make();
    const other = await make();
    const fit = await createUser({ name: "Fits Teacher" });
    await addMembership(fit.id, a.id, Role.TEACHING_STAFF);
    const url = (id: string, action: string) => `${staffUrl()}/${id}/${action}`;

    const choices = await api(url(s.id, "linkable-accounts"), as("admin"));
    expect(choices.json.data.accounts.map((x: { userId: string }) => x.userId)).toContain(fit.id);
    expect(choices.json.data.accounts.map((x: { userId: string }) => x.userId)).not.toContain(clerk.id); // wrong role
    expect(choices.json.data.accounts.map((x: { userId: string }) => x.userId)).not.toContain(former.id); // deactivated

    for (const userId of [clerk.id, parent.id, former.id, outsider.id, "nobody"]) {
      const res = await api(url(s.id, "link-account"), as("admin", { method: "POST", body: { userId } }));
      expect(res.status, userId).toBe(409);
      expect(res.json.error.code).toBe("ACCOUNT_MISMATCH");
    }
    const linked = await api(url(s.id, "link-account"), as("admin", { method: "POST", body: { userId: fit.id } }));
    expect(linked.status).toBe(200);
    expect(linked.json.data.staff.account).toMatchObject({
      state: "linked",
      userId: fit.id,
      name: "Fits Teacher",
      role: "TEACHING_STAFF",
      deactivated: false,
      roleDiffers: false,
    });
    expect((await api(url(s.id, "link-account"), as("admin", { method: "POST", body: { userId: fit.id } }))).json.error.code).toBe(
      "ALREADY_LINKED_ACCOUNT",
    );
    expect((await api(url(other.id, "link-account"), as("admin", { method: "POST", body: { userId: fit.id } }))).json.error.code).toBe(
      "ACCOUNT_TAKEN",
    );
    for (const body of [{}, { userId: "" }, { userId: fit.id, role: "ADMIN" }]) {
      expect((await api(url(other.id, "link-account"), as("admin", { method: "POST", body }))).status, JSON.stringify(body)).toBe(400);
    }
    const unlinked = await api(url(s.id, "unlink-account"), as("admin", { method: "POST" }));
    expect(unlinked.json.data.staff.account).toEqual({ state: "none" });
    expect((await api(url(s.id, "unlink-account"), as("admin", { method: "POST" }))).json.error.code).toBe("NOT_LINKED");
    expect(await db.tenantMembership.count({ where: { userId: fit.id, tenantId: a.id, deactivatedAt: null } })).toBe(1);
  });

  test("the whole journey: invite (201, the mail goes to the RECORD's address) → the invitee accepts over HTTP → the record reads 'linked' and they are a member with the right role and campus", async () => {
    const to = email("hire");
    const s = await make({ email: to, campusId: a.campuses[1].id, firstName: "Hira", lastName: "Newhire" });
    const sent = await api(`${staffUrl()}/${s.id}/invite`, as("admin", { method: "POST" }));
    expect(sent.status).toBe(201);
    expect(sent.json.data.invitation).toMatchObject({ email: to, role: "TEACHING_STAFF", campusName: "Alpha South", status: "pending" });
    expect(sent.text).not.toMatch(/token/i);
    expect((await api(`${staffUrl()}/${s.id}`, as("teacher"))).status).toBe(404); // South's record is not the North teacher's to see
    expect((await api(`${staffUrl()}/${s.id}`, as("admin"))).json.data.staff.account).toMatchObject({ state: "invited" });

    const token = tokenFrom((await waitForMail(to))[0]);
    const accepted = await api("/api/v1/invitations/accept", { ...SAAS, body: { token, name: "Hira Newhire", password: FRESH } });
    expect(accepted.status).toBe(200);
    const detail = await api(`${staffUrl()}/${s.id}`, as("admin"));
    expect(detail.json.data.staff.account).toMatchObject({
      state: "linked",
      name: "Hira Newhire",
      email: to,
      role: "TEACHING_STAFF",
      deactivated: false,
    });
    const membership = await db.tenantMembership.findFirstOrThrow({ where: { tenantId: a.id, user: { email: to } } });
    expect(membership).toMatchObject({ role: "TEACHING_STAFF", campusId: a.campuses[1].id });
    expect((await db.staffRecord.findUniqueOrThrow({ where: { id: s.id } })).userId).toBe(membership.userId);
    // a second invitation is no longer possible: the record has an account
    expect((await api(`${staffUrl()}/${s.id}/invite`, as("admin", { method: "POST" }))).json.error.code).toBe("ALREADY_LINKED_ACCOUNT");
  });

  test("invite refusals: no address is 409 EMAIL_REQUIRED; an address that already belongs to a member names that; a deactivated member says reactivate; an archived or foreign record is refused", async () => {
    const noMail = await make();
    const res = await api(`${staffUrl()}/${noMail.id}/invite`, as("admin", { method: "POST" }));
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({ code: "EMAIL_REQUIRED", details: [{ path: "body.email" }] });

    const existing = await make({ email: teacher.email });
    expect((await api(`${staffUrl()}/${existing.id}/invite`, as("admin", { method: "POST" }))).json.error.code).toBe("ALREADY_MEMBER");
    const gone = await make({ email: former.email });
    expect((await api(`${staffUrl()}/${gone.id}/invite`, as("admin", { method: "POST" }))).json.error.code).toBe("DEACTIVATED_MEMBER");

    const archived = await make({ email: email() });
    await api(`${staffUrl()}/${archived.id}/archive`, as("admin", { method: "POST" }));
    expect((await api(`${staffUrl()}/${archived.id}/invite`, as("admin", { method: "POST" }))).json.error.code).toBe("ARCHIVED");
    const foreign = await make({ email: email() }, b, "outsider");
    expect((await api(`${staffUrl()}/${foreign.id}/invite`, as("admin", { method: "POST" }))).status).toBe(404);
    expect(
      await db.invitation.count({ where: { tenantId: a.id, staffRecordId: { in: [noMail.id, existing.id, gone.id, archived.id] } } }),
    ).toBe(0);
  });
});

test.describe("what a person teaches", () => {
  test("assign (201); the detail lists it; again is 409; a class that does not study the subject is 409; unknown or foreign ids are 400; unknown keys are refused; remove is a POST that deletes", async () => {
    const s = await make();
    const c = await classWith();
    const url = `${staffUrl()}/${s.id}/assignments`;
    const made = await api(url, as("admin", { method: "POST", body: { subjectId: c.subject.id, classArmId: c.arm.id } }));
    expect(made.status).toBe(201);
    expect(made.json.data.assignment).toMatchObject({ subjectId: c.subject.id, classArmId: c.arm.id, armName: "A" });
    const detail = await api(`${staffUrl()}/${s.id}`, as("clerk"));
    expect(detail.json.data.assignments.map((x: { id: string }) => x.id)).toEqual([made.json.data.assignment.id]);
    expect(detail.json.data.staff.assignmentCount).toBe(1);
    expect((await api(url, as("admin", { method: "POST", body: { subjectId: c.subject.id, classArmId: c.arm.id } }))).json.error.code).toBe(
      "ALREADY_ASSIGNED",
    );

    const other = await classWith();
    const notOffered = await api(url, as("admin", { method: "POST", body: { subjectId: other.subject.id, classArmId: c.arm.id } }));
    expect(notOffered.status).toBe(409);
    expect(notOffered.json.error.code).toBe("SUBJECT_NOT_OFFERED");
    const foreign = await classWith(b);
    for (const [body, path] of [
      [{ subjectId: foreign.subject.id, classArmId: c.arm.id }, "body.subjectId"],
      [{ subjectId: c.subject.id, classArmId: foreign.arm.id }, "body.classArmId"],
      [{ subjectId: "nope", classArmId: c.arm.id }, "body.subjectId"],
    ] as [object, string][]) {
      const res = await api(url, as("admin", { method: "POST", body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.details[0].path).toBe(path);
    }
    for (const body of [{ subjectId: c.subject.id }, { subjectId: c.subject.id, classArmId: c.arm.id, tenantId: b.id }]) {
      expect((await api(url, as("admin", { method: "POST", body }))).status, JSON.stringify(body)).toBe(400);
    }
    const archiveBlocked = await api(`${staffUrl()}/${s.id}/archive`, as("admin", { method: "POST" }));
    expect(archiveBlocked.json.error.code).toBe("HAS_ASSIGNMENTS");

    const id = made.json.data.assignment.id;
    expect((await api(`${url}/${id}/remove`, as("admin", { method: "POST" }))).json.data.removed).toBe(true);
    expect((await api(`${url}/${id}/remove`, as("admin", { method: "POST" }))).status).toBe(404);
    expect(await db.staffSubjectAssignment.count({ where: { staffRecordId: s.id } })).toBe(0);
    expect((await api(`${url}/${id}`, as("admin", { method: "DELETE" }))).status).toBe(404); // there is no DELETE route: removing is the POST above
  });
});
