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
import { toCsv } from "@/lib/people/csv";
import { IMPORT_MAX_BYTES } from "@/lib/people/import";

// Importing and exporting students over real HTTP against the SaaS-mode server (plan "Build design — Phase 1.2", decision P8): who may, the strict body, the
// cap statuses, a report that tells the whole truth, and an export that is a file nobody can run as a formula. Both routes are ALSO covered by tenant-boundary.spec.ts.

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let teacher: TestUser;
let clerk: TestUser;
let parent: TestUser;
let learner: TestUser;
let former: TestUser;
let outsider: TestUser;
const cookie: Record<string, string> = {};

const students = (code = a.code) => `/api/v1/schools/${code}/people/students`;
const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
let counter = 0;
const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++counter}`;
const HEADER = ["first_name", "last_name", "date_of_birth"];
const csvOf = (...rows: string[][]) => toCsv([HEADER, ...rows]);
const send = (csv: string, dryRun: boolean, who = "admin", extra: object = {}) =>
  api(`${students()}/import`, as(who, { method: "POST", body: { csv, dryRun }, ...extra }));

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
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

test.describe("who may import and export", () => {
  test("ONLY an administrator of that school: staff, parents, students, deactivated members and other schools' administrators all get the same 403, and nothing is written or exported", async () => {
    const tag = uniq("Nope");
    const before = await db.studentRecord.count({ where: { tenantId: a.id } });
    for (const who of ["teacher", "clerk", "parent", "learner", "former", "outsider"]) {
      const imp = await send(csvOf([tag, "Person", "2012-05-01"]), false, who);
      expect(imp.status, `import ${who}`).toBe(403);
      expect(imp.json, `import ${who}`).toEqual(NO_ACCESS);
      const exp = await api(`${students()}/export`, as(who));
      expect(exp.status, `export ${who}`).toBe(403);
      expect(exp.json, `export ${who}`).toEqual(NO_ACCESS);
    }
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(before);
    expect(await db.auditLog.count({ where: { tenantId: a.id, action: { in: ["STUDENTS_IMPORTED", "STUDENTS_EXPORTED"] } } })).toBe(0);
  });

  test("CSRF is enforced on the import", async () => {
    const res = await send(csvOf(["A", "B", "2012-05-01"]), false, "admin", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });
});

test.describe("importing", () => {
  test("a dry run answers 200 with committed false and writes nothing; the real run answers 200 with committed true; the report has the whole truth", async () => {
    const first = uniq("Imp");
    const csv = csvOf([first, "Okoro", "2012-05-01"], [`${first}b`, "Bello", "2011-03-04"]);
    const dry = await send(csv, true);
    expect(dry.status).toBe(200);
    expect(dry.json.data.report).toMatchObject({
      dryRun: true,
      committed: false,
      counts: { rows: 2, created: 2, skipped: 0, errors: 0 },
      headerProblems: [],
    });
    expect(dry.json.data.report.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.studentRecord.count({ where: { tenantId: a.id, firstName: { startsWith: first } } })).toBe(0);

    const real = await send(csv, false);
    expect(real.status).toBe(200);
    expect(real.json.data.report).toMatchObject({ dryRun: false, committed: true, counts: { created: 2 } });
    expect(
      real.json.data.report.rows.map((r: { admissionNo: string }) => r.admissionNo).every((n: string) => /^\d{4}\/\d{4,}$/.test(n)),
    ).toBe(true);
    expect(await db.studentRecord.count({ where: { tenantId: a.id, firstName: { startsWith: first } } })).toBe(2);

    const again = await send(csv, false);
    expect(again.json.data.report).toMatchObject({ committed: true, counts: { created: 0, skipped: 2, errors: 0 } }); // idempotent
    expect(await db.studentRecord.count({ where: { tenantId: a.id, firstName: { startsWith: first } } })).toBe(2);
  });

  test("a real run with a problem writes nobody and says which row and column; the cell values are not echoed back as a way into the page", async () => {
    const tag = uniq("Half");
    const res = await send(csvOf([tag, "Fine", "2012-05-01"], ["<script>alert(1)</script>", "Bad", "2012-02-30"]), false);
    expect(res.status).toBe(200);
    expect(res.json.data.report.committed).toBe(false);
    expect(res.json.data.report.counts).toMatchObject({ rows: 2, created: 1, errors: 1 });
    const bad = res.json.data.report.rows.find((r: { status: string }) => r.status === "error");
    expect(bad).toMatchObject({ row: 3, problems: [{ column: "date_of_birth" }] });
    expect(await db.studentRecord.count({ where: { tenantId: a.id, firstName: tag } })).toBe(0);
  });

  test("header problems come back as a report (200) with no rows; the strict body refuses a missing dryRun, a non-boolean, a missing csv and unknown keys", async () => {
    const res = await send(
      toCsv([
        [...HEADER, "shoe_size"],
        ["A", "B", "2012-05-01", "9"],
      ]),
      true,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.report.headerProblems.join(" ")).toMatch(/Unknown column "shoe_size"/);
    expect(res.json.data.report.rows).toEqual([]);
    for (const body of [
      { csv: "x" },
      { csv: "x", dryRun: "yes" },
      { dryRun: true },
      { csv: 5, dryRun: true },
      { csv: "x", dryRun: true, tenantId: b.id },
      { csv: "x", dryRun: true, campusId: a.campuses[0].id },
    ]) {
      const bad = await api(`${students()}/import`, as("admin", { method: "POST", body }));
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.json.error.code).toBe("VALIDATION");
    }
    expect(
      (
        await api(
          `${students()}/import`,
          as("admin", { method: "POST", rawBody: "{oops", headers: { "content-type": "application/json" } }),
        )
      ).status,
    ).toBe(400);
  });

  test("the caps: one byte over 1 MiB is 413 TOO_LARGE; 1,001 students is 400 TOO_MANY_ROWS naming the number; a file at the limits is read", async () => {
    const base = csvOf(["Sade", uniq("Cap"), "2012-05-01"]);
    const exact = base + "\n".repeat(IMPORT_MAX_BYTES - Buffer.byteLength(base));
    const ok = await send(exact, true);
    expect(ok.status).toBe(200);
    expect(ok.json.data.report.counts.created).toBe(1);
    const tooBig = await send(exact + "\n", true);
    expect(tooBig.status).toBe(413);
    expect(tooBig.json.error.code).toBe("TOO_LARGE");
    const many = (n: number) => csvOf(...Array.from({ length: n }, (): string[] => ["", "NoFirstName", "2012-05-01"]));
    expect((await send(many(1000), true)).json.data.report.counts.rows).toBe(1000);
    const over = await send(many(1001), true);
    expect(over.status).toBe(400);
    expect(over.json.error.code).toBe("TOO_MANY_ROWS");
    expect(over.json.error.message).toContain("1001");
  });
});

test.describe("exporting", () => {
  test("a CSV attachment that is never cached and cannot run a formula; the columns are the import's; the same filters as the list; audited; only the school's own students", async () => {
    const tag = uniq("Exp");
    for (const [first, last] of [
      [`${tag}`, "Plain"],
      ["=SUM(1+1)", tag],
    ]) {
      await db.studentRecord.create({
        data: { tenantId: a.id, firstName: first, lastName: last, dateOfBirth: new Date("2012-05-01"), admissionNo: uniq("EXP/") },
      });
    }
    await db.studentRecord.create({
      data: { tenantId: b.id, firstName: tag, lastName: "Foreign", dateOfBirth: new Date("2012-05-01"), admissionNo: uniq("EXP/") },
    });
    const res = await api(`${students()}/export?q=${tag}`, as("admin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="students-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-row-count")).toBe("2");
    const lines = res.text.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "first_name,last_name,middle_name,date_of_birth,admission_no,campus,class,arm,session,guardian_name,guardian_phone,guardian_email,relationship",
    );
    expect(lines).toHaveLength(3);
    expect(res.text).toContain("'=SUM(1+1)");
    expect(res.text).not.toContain("Foreign");
    const entry = await db.auditLog.findFirstOrThrow({
      where: { tenantId: a.id, action: "STUDENTS_EXPORTED" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.afterValue).toMatchObject({ count: 2, filters: { search: true } });
    expect(JSON.stringify(entry)).not.toContain(tag);
  });

  test("a bad query is a 400 naming the parameter, and an unknown one is ignored no more than the list ignores it; the status filter works", async () => {
    for (const bad of ["status=bogus", "notEnrolled=false", "campusId=", "q=" + "x".repeat(101)]) {
      expect((await api(`${students()}/export?${bad}`, as("admin"))).status, bad).toBe(400);
    }
    const archived = await api(`${students()}/export?status=archived&q=${uniq("nobodyhasthis")}`, as("admin"));
    expect(archived.status).toBe(200);
    expect(archived.headers.get("x-row-count")).toBe("0");
  });
});
