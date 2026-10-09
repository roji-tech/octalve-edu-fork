import "../support/env";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { createArm, createClassGroup } from "@/lib/academics/classes";
import { activateSession, closeSession, createSession } from "@/lib/academics/sessions";
import { archiveStudent, createStudent, enrolStudent } from "@/lib/people/students";
import { addGuardian } from "@/lib/people/guardians";
import { toCsv } from "@/lib/people/csv";
import { EXPORT_MAX_ROWS, IMPORT_COLUMNS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, exportStudents, importStudents } from "@/lib/people/import";

// Importing and exporting students as CSV in-process, as `app_user` (plan "Build design — Phase 1.2", decision P8): all or nothing, a dry run that proves nothing to
// the server, idempotent re-runs, name lookups inside the school, and an export that cannot run a formula.

const NOW = new Date("2026-10-07T10:00:00.000Z");
let a: TestTenant;
let b: TestTenant;
let boss: { id: string };

const ctx = (t: TestTenant, role: Role = "ADMIN", campusId: string | null = null): TenantAuthContext["tenant"] => ({
  tenantId: trustedTenantId(t.id),
  tenantCode: t.code,
  tenantName: t.name,
  schoolType: "K12",
  role,
  campusId,
  permissions: [],
  run: <T>(fn: (tx: Tx) => Promise<T>) => forTenant(trustedTenantId(t.id)).transaction(fn),
});
const admin = (t: TestTenant = a) => ctx(t);
const north = () => a.campuses[0].id;

test.beforeEach(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  boss = await createUser({ name: "Ada Admin" });
  await addMembership(boss.id, a.id, R.ADMIN);
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

const HEADER = ["first_name", "last_name", "date_of_birth"];
const file = (header: readonly string[], ...rows: string[][]) => toCsv([[...header], ...rows]);
const simple = (...rows: string[][]) => file(HEADER, ...rows);
async function run(csv: string, dryRun = false, school: TestTenant = a) {
  const result = await importStudents(admin(school), boss.id, { csv, dryRun }, NOW);
  if (!result.ok) throw new Error(`import refused: ${result.reason} ${JSON.stringify(result.detail ?? {})}`);
  return result.report;
}
const counts = async () => ({
  students: await db.studentRecord.count({ where: { tenantId: a.id } }),
  guardians: await db.guardianRecord.count({ where: { tenantId: a.id } }),
  links: await db.guardianLink.count({ where: { tenantId: a.id } }),
  enrolments: await db.studentEnrollment.count({ where: { tenantId: a.id } }),
  counters: await db.admissionCounter.count({ where: { tenantId: a.id } }),
  audits: await db.auditLog.count({ where: { tenantId: a.id } }),
});
const NOTHING = { students: 0, guardians: 0, links: 0, enrolments: 0, counters: 0, audits: 0 };

async function schoolWith() {
  const s = await createSession(admin(), boss.id, { label: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" });
  if (!s.ok) throw new Error("session");
  const g = await createClassGroup(admin(), boss.id, { name: "JSS 1" });
  if (!g.ok) throw new Error("group");
  const arm = await createArm(admin(), boss.id, g.group.id, { name: "A" });
  if (!arm.ok) throw new Error("arm");
  return { session: s.session, group: g.group, arm: arm.arm };
}

test.describe("a real import and a dry run", () => {
  test("the dry run reports exactly what would happen and writes NOTHING — not a student, a number, a guardian, an audit row; the real run then does it", async () => {
    const { session } = await schoolWith();
    const before = await counts();
    const csv = file(
      [...HEADER, "middle_name", "class", "arm", "session", "guardian_name", "guardian_phone", "relationship"],
      ["Sade", "Okoro", "2012-05-01", "Ruth", "JSS 1", "A", "2026/2027", "Gbenga Okoro", "08031234567", "father"],
      ["Tunde", "Bello", "2011-03-04", "", "", "", "", "", "", ""],
    );
    const dry = await run(csv, true);
    expect(dry).toMatchObject({
      dryRun: true,
      committed: false,
      counts: { rows: 2, created: 2, skipped: 0, errors: 0 },
      headerProblems: [],
    });
    expect(dry.rows.map((r) => [r.row, r.status, r.admissionNo])).toEqual([
      [2, "created", "2026/0001"],
      [3, "created", "2026/0002"],
    ]);
    expect(await counts()).toEqual({ ...NOTHING, audits: before.audits }); // …and the audit trail is untouched

    const real = await run(csv, false);
    expect(real).toMatchObject({ dryRun: false, committed: true, counts: { rows: 2, created: 2, skipped: 0, errors: 0 } });
    expect(real.rows.map((r) => r.admissionNo)).toEqual(["2026/0001", "2026/0002"]); // the dry run burned no numbers
    expect(await counts()).toMatchObject({ students: 2, guardians: 1, links: 1, enrolments: 1, counters: 1 });
    const sade = await db.studentRecord.findFirstOrThrow({ where: { tenantId: a.id, firstName: "Sade" } });
    expect(sade).toMatchObject({ middleName: "Ruth", lastName: "Okoro", admissionNo: "2026/0001" });
    expect(await db.studentEnrollment.findFirstOrThrow({ where: { studentId: sade.id } })).toMatchObject({
      sessionId: session.id,
      status: "ACTIVE",
    });
    expect(await db.guardianLink.findFirstOrThrow({ where: { studentId: sade.id } })).toMatchObject({
      isPrimary: true,
      relationship: "FATHER",
      status: "APPROVED",
    });
  });

  test("the audit trail holds one entry for the import (counts and the file's hash) and one per student — and none of it carries a name or a birthday", async () => {
    const csv = simple(["Sade", "Okoro", "2012-05-01"], ["Tunde", "Bello", "2011-03-04"]);
    const report = await run(csv);
    const entry = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "STUDENTS_IMPORTED" } });
    expect(entry.afterValue).toMatchObject({
      rows: 2,
      created: 2,
      skipped: 0,
      fileHash: crypto.createHash("sha256").update(csv).digest("hex"),
    });
    expect(report.fileHash).toBe(crypto.createHash("sha256").update(csv).digest("hex"));
    expect(await db.auditLog.count({ where: { tenantId: a.id, action: "STUDENT_CREATED" } })).toBe(2);
    const everything = JSON.stringify(await db.auditLog.findMany({ where: { tenantId: a.id } }));
    for (const secret of ["Sade", "Okoro", "Bello", "2012-05-01", "2011-03-04"]) expect(everything).not.toContain(secret);
  });

  test("ALL OR NOTHING: one bad row among many writes no one, and EVERY problem in the file is reported with its row and column", async () => {
    await schoolWith();
    const before = await counts();
    const csv = simple(
      ["Good", "One", "2012-05-01"],
      ["", "NoFirst", "2012-05-01"], // row 3
      ["Good", "Two", "2012-05-02"],
      ["Bad", "Date", "2012-02-30"], // row 5
      ["Future", "Born", "2999-01-01"], // row 6
      ["Good", "Three", "2012-05-03"],
    );
    const report = await run(csv);
    expect(report.committed).toBe(false);
    expect(report.counts).toEqual({ rows: 6, created: 3, skipped: 0, errors: 3 });
    const errors = report.rows.filter((r) => r.status === "error");
    expect(errors.map((r) => [r.row, r.problems[0].column])).toEqual([
      [3, "first_name"],
      [5, "date_of_birth"],
      [6, "date_of_birth"],
    ]);
    expect(await counts()).toEqual({ ...NOTHING, audits: before.audits });
  });

  test("a real run re-validates: a dry run that was clean does not vouch for the file once the register has changed", async () => {
    const csv = simple(["Sade", "Okoro", "2012-05-01"]);
    expect((await run(csv, true)).counts.created).toBe(1);
    await createStudent(admin(), boss.id, { firstName: "Sade", lastName: "Okoro", dateOfBirth: "2012-05-01" }, NOW); // someone adds her meanwhile
    const real = await run(csv, false);
    expect(real).toMatchObject({ committed: true, counts: { created: 0, skipped: 1, errors: 0 } });
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(1);
  });
});

test.describe("re-running a file", () => {
  test("typed admission numbers: the second run skips every row (same number, name and birthday), writes nothing new, and the first is still all there", async () => {
    const csv = file([...HEADER, "admission_no"], ["Sade", "Okoro", "2012-05-01", "OLD/001"], ["Tunde", "Bello", "2011-03-04", "OLD/002"]);
    expect(await run(csv)).toMatchObject({ committed: true, counts: { created: 2, skipped: 0 } });
    const before = await counts();
    const again = await run(csv);
    expect(again).toMatchObject({ committed: true, counts: { rows: 2, created: 0, skipped: 2, errors: 0 } });
    expect(again.rows.every((r) => r.status === "skipped" && r.note?.includes("Already in the register"))).toBe(true);
    expect(await counts()).toEqual({ ...before, audits: before.audits + 1 }); // only the import's own entry
  });

  test("no numbers in the file: the second run recognises each student by name and birthday and says which number they have", async () => {
    const csv = simple(["Sade", "Okoro", "2012-05-01"], ["Tunde", "Bello", "2011-03-04"]);
    await run(csv);
    const again = await run(csv);
    expect(again.counts).toEqual({ rows: 2, created: 0, skipped: 2, errors: 0 });
    expect(again.rows.map((r) => r.note)).toEqual([
      "Already in the register as 2026/0001; nothing changed.",
      "Already in the register as 2026/0002; nothing changed.",
    ]);
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(2);
    expect((await db.admissionCounter.findFirstOrThrow({ where: { tenantId: a.id } })).next).toBe(3); // the skipped rows burned no numbers
  });

  test("a number that belongs to someone else is an ERROR (never a silent skip), and so is a typed number repeated for two different people in one file", async () => {
    await createStudent(admin(), boss.id, { firstName: "Real", lastName: "Owner", dateOfBirth: "2010-01-01", admissionNo: "ADM/1" }, NOW);
    const csv = file(
      [...HEADER, "admission_no"],
      ["Someone", "Else", "2012-05-01", "adm/1"],
      ["First", "Person", "2012-05-02", "NEW/9"],
      ["Second", "Person", "2012-05-03", "new/9"],
    );
    const report = await run(csv);
    expect(report.rows.map((r) => [r.row, r.status, r.problems[0]?.column ?? null])).toEqual([
      [2, "error", "admission_no"],
      [3, "created", null],
      [4, "error", "admission_no"],
    ]);
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(1); // rolled back: only the pre-existing one
  });

  test("the same student twice in one file is created once and the repeat is skipped", async () => {
    const report = await run(simple(["Sade", "Okoro", "2012-05-01"], ["  sade ", "OKORO", "2012-05-01"]));
    expect(report).toMatchObject({ committed: true, counts: { rows: 2, created: 1, skipped: 1, errors: 0 } });
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(1);
  });

  test("a typed number for a person who already exists under another number is an error — the register already has them", async () => {
    await createStudent(admin(), boss.id, { firstName: "Sade", lastName: "Okoro", dateOfBirth: "2012-05-01" }, NOW);
    const report = await run(file([...HEADER, "admission_no"], ["Sade", "Okoro", "2012-05-01", "OTHER/5"]));
    expect(report.rows[0]).toMatchObject({ status: "error", problems: [{ column: "first_name" }] });
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(1);
  });

  test("two imports of the same file at once queue behind each other: everyone exists once", async () => {
    const csv = simple(...Array.from({ length: 6 }, (_, i): string[] => [`Racer${i}`, "Same", "2012-05-01"]));
    const [x, y] = await Promise.all([
      importStudents(admin(), boss.id, { csv, dryRun: false }, NOW),
      importStudents(admin(), boss.id, { csv, dryRun: false }, NOW),
    ]);
    expect(x.ok && y.ok).toBe(true);
    if (x.ok && y.ok) expect([x.report.counts.created, y.report.counts.created].sort()).toEqual([0, 6]);
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(6);
  });
});

test.describe("the file itself", () => {
  test("header problems are reported before any row is read: unknown columns, a duplicated column, a missing required one, no students, a stray quote", async () => {
    const before = await counts();
    const cases: [string, RegExp][] = [
      [file([...HEADER, "shoe_size"], ["A", "B", "2012-05-01", "9"]), /Unknown column "shoe_size"/],
      [file([...HEADER, "first_name"], ["A", "B", "2012-05-01", "C"]), /"first_name" appears more than once/],
      [file(["first_name", "last_name"], ["A", "B"]), /"date_of_birth" is missing/],
      [toCsv([HEADER]), /no students/],
      ["", /no students|missing/],
      ['first_name,last_name,date_of_birth\nA"x,B,2012-05-01', /Line 2/],
      ['first_name,last_name,date_of_birth\n"A,B,2012-05-01', /never closed/],
    ];
    for (const [csv, message] of cases) {
      const report = await run(csv);
      expect(report.committed, csv).toBe(false);
      expect(report.headerProblems.join(" "), csv).toMatch(message);
      expect(report.rows).toEqual([]);
    }
    expect(await counts()).toEqual({ ...NOTHING, audits: before.audits });
  });

  test("headers match in any case with spaces around them; a byte-order mark and CRLF line ends are fine; a ragged row and an over-long cell are row errors", async () => {
    const csv =
      "﻿ First_Name , LAST_NAME,Date_Of_Birth\r\nSade,Okoro,2012-05-01\r\nShort,Row\r\n" + `${"x".repeat(201)},Okoro,2012-05-01\r\n`;
    const report = await run(csv, true);
    expect(report.headerProblems).toEqual([]);
    expect(report.counts).toEqual({ rows: 3, created: 1, skipped: 0, errors: 2 });
    expect(report.rows.find((r) => r.row === 3)?.problems[0]).toEqual({ column: null, message: "Expected 3 values but found 2." });
    expect(report.rows.find((r) => r.row === 4)?.problems[0]).toMatchObject({ column: "first_name" });
  });

  test("the size cap is exact: a file of exactly 1 MiB is read, one byte more is TOO_LARGE; 1,000 students are read, 1,001 are TOO_MANY_ROWS", async () => {
    const base = simple(["Sade", "Okoro", "2012-05-01"]);
    const padded = base + "\n".repeat(IMPORT_MAX_BYTES - Buffer.byteLength(base));
    expect(Buffer.byteLength(padded)).toBe(IMPORT_MAX_BYTES);
    expect((await run(padded, true)).counts.created).toBe(1);
    const result = await importStudents(admin(), boss.id, { csv: padded + "\n", dryRun: true }, NOW);
    expect(result).toMatchObject({ ok: false, reason: "TOO_LARGE", detail: { max: IMPORT_MAX_BYTES } });

    const rows = (n: number) => simple(...Array.from({ length: n }, (): string[] => ["", "NoFirstName", "2012-05-01"])); // cheap rows: each is a row error, no database work
    expect((await run(rows(IMPORT_MAX_ROWS), true)).counts).toEqual({
      rows: IMPORT_MAX_ROWS,
      created: 0,
      skipped: 0,
      errors: IMPORT_MAX_ROWS,
    });
    expect(await importStudents(admin(), boss.id, { csv: rows(IMPORT_MAX_ROWS + 1), dryRun: true }, NOW)).toMatchObject({
      ok: false,
      reason: "TOO_MANY_ROWS",
      detail: { rows: IMPORT_MAX_ROWS + 1, max: IMPORT_MAX_ROWS },
    });
    expect(await counts()).toMatchObject(NOTHING);
  });

  test("the report lists every error row but only the first 100 others, while the counts stay exact", async () => {
    const report = await run(simple(...Array.from({ length: 150 }, (_, i): string[] => [`Pupil${i}`, "Many", "2012-05-01"])), true);
    expect(report.counts).toMatchObject({ rows: 150, created: 150 });
    expect(report.rows).toHaveLength(100);
    const mixed = simple(...Array.from({ length: 150 }, (_, i): string[] => [`Pupil${i}`, "Many", "2012-05-01"]), [
      "",
      "Bad",
      "2012-05-01",
    ]);
    const withError = await run(mixed, true);
    expect(withError.rows.filter((r) => r.status === "error")).toHaveLength(1);
    expect(withError.rows).toHaveLength(101);
  });
});

test.describe("columns that point at the school", () => {
  test("campus, class, arm and session are matched BY NAME (any case) inside this school; a stranger's names, ids and missing parts are row errors naming the column", async () => {
    await schoolWith();
    const h = [...HEADER, "campus", "class", "arm", "session"];
    const csv = file(
      h,
      ["Fine", "One", "2012-05-01", "alpha north", "jss 1", "a", "2026/2027"],
      ["Wrong", "Campus", "2012-05-02", "Gamma", "", "", ""],
      ["Wrong", "Class", "2012-05-03", "", "SSS 3", "A", "2026/2027"],
      ["Wrong", "Arm", "2012-05-04", "", "JSS 1", "Z", "2026/2027"],
      ["Wrong", "Session", "2012-05-05", "", "JSS 1", "A", "1999/2000"],
      ["Partial", "Place", "2012-05-06", "", "JSS 1", "", ""],
    );
    const report = await run(csv, true);
    const byRow = Object.fromEntries(report.rows.map((r) => [r.row, r]));
    expect(byRow[2].status).toBe("created");
    expect(byRow[3].problems.map((p) => p.column)).toEqual(["campus"]);
    expect(byRow[4].problems.map((p) => p.column)).toEqual(["class"]);
    expect(byRow[5].problems.map((p) => p.column)).toEqual(["arm"]);
    expect(byRow[6].problems.map((p) => p.column)).toEqual(["session"]);
    expect(byRow[7].problems.map((p) => p.column)).toEqual(["arm", "session"]);
    // another school's names do not exist here
    const foreign = await createClassGroup(admin(b), boss.id, { name: "Beta Only" });
    expect(foreign.ok).toBe(true);
    const stranger = await run(file(h, ["Stranger", "Class", "2012-05-01", "", "Beta Only", "A", "2026/2027"]), true);
    expect(stranger.rows[0].problems[0]).toMatchObject({ column: "class" });
  });

  test("the same class name on two campuses is ambiguous for a student with no campus and resolved by the student's own campus; a closed session is a row error that rolls the whole file back", async () => {
    const wide = await createSession(admin(), boss.id, { label: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" });
    if (!wide.ok) throw new Error("session");
    for (const campusId of [north(), a.campuses[1].id]) {
      const g = await createClassGroup(admin(), boss.id, { campusId, name: "Year 1" });
      if (!g.ok) throw new Error("group");
      await createArm(admin(), boss.id, g.group.id, { name: "A" });
    }
    const h = [...HEADER, "campus", "class", "arm", "session"];
    const ambiguous = await run(file(h, ["No", "Campus", "2012-05-01", "", "Year 1", "A", "2026/2027"]), true);
    expect(ambiguous.rows[0].problems.find((p) => p.column === "class")?.message).toMatch(/No class called|More than one/);
    const resolved = await run(file(h, ["With", "Campus", "2012-05-01", "Alpha North", "Year 1", "A", "2026/2027"]), true);
    expect(resolved.rows[0].status).toBe("created");

    // close the session: enrolling into it is refused, the row is an error, and the other rows are rolled back with it
    expect(await activateSession(admin(), boss.id, wide.session.id, { closeCurrent: false })).toMatchObject({ ok: true });
    expect(await closeSession(admin(), boss.id, wide.session.id, { force: true })).toMatchObject({ ok: true });
    await db.academicSession.update({ where: { id: wide.session.id }, data: { closeAt: new Date("2026-01-01T00:00:00Z") } });
    const closed = await run(
      file(h, ["Fine", "Row", "2012-05-02", "Alpha North", "Year 1", "A", "2026/2027"], ["Plain", "Row", "2012-05-03", "", "", "", ""]),
    );
    expect(closed.committed).toBe(false);
    expect(closed.rows.find((r) => r.status === "error")?.problems[0]).toMatchObject({ column: "session" });
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(0);
  });

  test("guardian columns: a full name (first and last), optional phone and email, a relationship; siblings in one file share ONE guardian; bad values name their column", async () => {
    const h = [...HEADER, "guardian_name", "guardian_phone", "guardian_email", "relationship"];
    const report = await run(
      file(
        h,
        ["Ade", "Okoro", "2012-05-01", "Gbenga Okoro", "08031234567", "g@example.com", "Father"],
        ["Bisi", "Okoro", "2014-02-02", "  gbenga   OKORO ", "08031234567", "g@example.com", "FATHER"],
        ["Chi", "Eze", "2013-03-03", "Mary Jane Eze", "", "", "mother"],
      ),
    );
    expect(report).toMatchObject({ committed: true, counts: { created: 3, errors: 0 } });
    expect(await db.guardianRecord.count({ where: { tenantId: a.id } })).toBe(2);
    expect(await db.guardianLink.count({ where: { tenantId: a.id } })).toBe(3);
    const mary = await db.guardianRecord.findFirstOrThrow({ where: { tenantId: a.id, lastName: "Eze" } });
    expect(mary).toMatchObject({ firstName: "Mary Jane", phone: null, email: null });

    const bad = await run(
      file(
        h,
        ["A", "B", "2012-05-01", "Madonna", "", "", "mother"],
        ["C", "D", "2012-05-01", "Two Names", "12", "", "mother"],
        ["E", "F", "2012-05-01", "Two Names", "", "nope", "mother"],
        ["G", "H", "2012-05-01", "Two Names", "", "", "uncle"],
        ["I", "J", "2012-05-01", "", "08031234567", "", ""],
      ),
      true,
    );
    expect(bad.rows.map((r) => r.problems.map((p) => p.column))).toEqual([
      ["guardian_name"],
      ["guardian_phone"],
      ["guardian_email"],
      ["relationship"],
      ["guardian_name", "relationship"],
    ]);
  });
});

test.describe("exporting", () => {
  const live = { status: "live" as const };

  test("the export has exactly the import's columns, so it round-trips into another school; class, arm and session are filled when a session is named; archived students only on request", async () => {
    const { session, arm } = await schoolWith();
    const s1 = await createStudent(
      admin(),
      boss.id,
      { firstName: "Sade", middleName: "Ruth", lastName: "Okoro", dateOfBirth: "2012-05-01", campusId: north() },
      NOW,
    );
    const s2 = await createStudent(admin(), boss.id, { firstName: "Old", lastName: "Boy", dateOfBirth: "2009-01-01" }, NOW);
    if (!s1.ok || !s2.ok) throw new Error("setup");
    await enrolStudent(admin(), boss.id, s1.student.id, { sessionId: session.id, classArmId: arm.id }, NOW);
    await addGuardian(admin(), boss.id, s1.student.id, {
      firstName: "Gbenga",
      lastName: "Okoro",
      phone: "08031234567",
      email: "g@example.com",
      relationship: "FATHER",
    });
    await archiveStudent(admin(), boss.id, s2.student.id);

    const out = await exportStudents(admin(), boss.id, { ...live, sessionId: session.id });
    if (!out.ok) throw new Error(out.reason);
    expect(out.count).toBe(1);
    const lines = out.csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(IMPORT_COLUMNS.join(","));
    expect(lines[1]).toBe(
      [
        "Sade",
        "Okoro",
        "Ruth",
        "2012-05-01",
        s1.student.admissionNo,
        "Alpha North",
        "JSS 1",
        "A",
        "2026/2027",
        "Gbenga Okoro",
        "08031234567",
        "g@example.com",
        "father",
      ].join(","),
    );
    const archived = await exportStudents(admin(), boss.id, { status: "archived" });
    expect(archived.ok && archived.csv.split("\r\n")[1].startsWith("Old,Boy,,2009-01-01")).toBe(true);

    // …and that file imports into ANOTHER school that has the same classes (names are matched, ids never travel)
    const target = await createTenant({ name: "Target School", campuses: ["Alpha North"] });
    const s = await createSession(admin(target), boss.id, { label: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" });
    const g = await createClassGroup(admin(target), boss.id, { name: "JSS 1" });
    if (!s.ok || !g.ok) throw new Error("target setup");
    await createArm(admin(target), boss.id, g.group.id, { name: "A" });
    const moved = await importStudents(admin(target), boss.id, { csv: out.csv, dryRun: false }, NOW);
    expect(moved).toMatchObject({ ok: true, report: { committed: true, counts: { created: 1, errors: 0 } } });
    expect(await db.studentRecord.findFirstOrThrow({ where: { tenantId: target.id } })).toMatchObject({
      firstName: "Sade",
      admissionNo: s1.student.admissionNo,
    });
  });

  test("no cell can run as a formula, quotes and commas survive, and the export is audited with the filters but never the search text", async () => {
    const evil = await createStudent(
      admin(),
      boss.id,
      { firstName: '=HYPERLINK("http://x","y")', lastName: "+cmd|' /C calc'!A0", dateOfBirth: "2012-05-01" },
      NOW,
    );
    const comma = await createStudent(
      admin(),
      boss.id,
      { firstName: "Comma, Name", lastName: 'Quote "Q"', dateOfBirth: "2012-05-02" },
      NOW,
    );
    if (!evil.ok || !comma.ok) throw new Error("setup");
    const out = await exportStudents(admin(), boss.id, { ...live, q: "secret-search" });
    expect(out).toMatchObject({ ok: true, count: 0 });
    const all = await exportStudents(admin(), boss.id, live);
    if (!all.ok) throw new Error("export");
    expect(all.csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(all.csv).toContain(`,'+cmd|' /C calc'!A0,`); // neutralised with a leading apostrophe; it holds no comma or quote, so it needs no quoting
    expect(all.csv).toContain(`"Comma, Name","Quote ""Q"""`); // quoted, quotes doubled
    expect(all.csv.split("\r\n").filter(Boolean)).toHaveLength(3);
    const entries = await db.auditLog.findMany({ where: { tenantId: a.id, action: "STUDENTS_EXPORTED" }, orderBy: { createdAt: "asc" } });
    expect(entries).toHaveLength(2);
    expect(entries[0].afterValue).toMatchObject({ count: 0, filters: { status: "live", search: true, campusId: null } });
    expect(JSON.stringify(entries)).not.toContain("secret-search");
    expect(entries[0].actorUserId).toBe(boss.id);
  });

  test("staff see only their campus in an export (the same scope as the list), and more than 10,000 rows is refused until the filter is narrowed", async () => {
    test.setTimeout(240_000); // ten thousand rows to insert, export and then remove
    await createStudent(admin(), boss.id, { firstName: "Wide", lastName: "One", dateOfBirth: "2012-05-01" }, NOW);
    await createStudent(admin(), boss.id, { firstName: "North", lastName: "One", dateOfBirth: "2012-05-01", campusId: north() }, NOW);
    await createStudent(
      admin(),
      boss.id,
      { firstName: "South", lastName: "One", dateOfBirth: "2012-05-01", campusId: a.campuses[1].id },
      NOW,
    );
    const staff = await exportStudents(ctx(a, "TEACHING_STAFF", north()), boss.id, live);
    expect(
      staff.ok &&
        staff.csv
          .split("\r\n")
          .filter(Boolean)
          .slice(1)
          .map((l) => l.split(",")[0])
          .sort(),
    ).toEqual(["North", "Wide"]);

    await db.studentRecord.createMany({
      data: Array.from({ length: EXPORT_MAX_ROWS - 2 }, (_, i) => ({
        tenantId: a.id,
        firstName: `Bulk${i}`,
        lastName: "Fill",
        dateOfBirth: new Date("2012-05-01"),
        admissionNo: `BULK/${i}`,
      })),
    });
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(EXPORT_MAX_ROWS + 1);
    expect(await exportStudents(admin(), boss.id, live)).toMatchObject({
      ok: false,
      reason: "TOO_MANY_ROWS",
      detail: { max: EXPORT_MAX_ROWS, export: true },
    });
    const narrowed = await exportStudents(admin(), boss.id, { ...live, q: "Wide" });
    expect(narrowed).toMatchObject({ ok: true, count: 1 });
    await db.studentRecord.deleteMany({ where: { tenantId: a.id, lastName: "Fill", firstName: "Bulk0" } });
    expect(await exportStudents(admin(), boss.id, live)).toMatchObject({ ok: true, count: EXPORT_MAX_ROWS }); // exactly the cap is fine
    // remove the bulk rows now (as the owner role): dropping a whole school with ten thousand students in the teardown hook is the slow way
    await db.studentRecord.deleteMany({ where: { tenantId: a.id, lastName: "Fill" } });
  });
});
