import "../support/env";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { createArm, createClassGroup, archiveArm } from "@/lib/academics/classes";
import { activateSession, closeSession, createSession } from "@/lib/academics/sessions";
import {
  archiveStudent,
  armOccupancy,
  createStudent,
  enrolStudent,
  getStudent,
  listStudents,
  moveEnrolment,
  restoreStudent,
  updateStudent,
  withdrawEnrolment,
} from "@/lib/people/students";

// Students and their enrolment in-process, as `app_user` (plan "Build design — Phase 1.2", decisions P2–P4 and P7).

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
const south = () => a.campuses[1].id;

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

const PUPIL = { firstName: "Sade", lastName: "Okoro", dateOfBirth: "2012-05-01" };
async function student(over: Record<string, unknown> = {}, school: TestTenant = a) {
  const result = await createStudent(admin(school), boss.id, { ...PUPIL, ...over }, NOW);
  if (!result.ok) throw new Error(`createStudent refused: ${result.reason} ${JSON.stringify(result.detail ?? {})}`);
  return result.student;
}
async function session(
  label = "2026/2027",
  campusId: string | null = null,
  school: TestTenant = a,
  start = "2026-09-01",
  end = "2027-07-31",
) {
  const result = await createSession(admin(school), boss.id, { campusId, label, startDate: start, endDate: end });
  if (!result.ok) throw new Error(`createSession refused: ${result.reason}`);
  return result.session;
}
async function arm(name = "A", campusId: string | null = null, school: TestTenant = a, capacity?: number) {
  const g = await createClassGroup(admin(school), boss.id, { campusId, name: `Class ${name}-${Math.random().toString(36).slice(2, 6)}` });
  if (!g.ok) throw new Error(`createClassGroup refused: ${g.reason}`);
  const r = await createArm(admin(school), boss.id, g.group.id, { name, capacity });
  if (!r.ok) throw new Error(`createArm refused: ${r.reason}`);
  return r.arm;
}
async function closeNow(id: string) {
  expect(await closeSession(admin(), boss.id, id, { force: true })).toMatchObject({ ok: true });
  await db.academicSession.update({ where: { id }, data: { closeAt: new Date(Date.now() - 1000) } });
}
const actions = async (targetId: string) =>
  (await db.auditLog.findMany({ where: { tenantId: a.id, targetId }, orderBy: { createdAt: "asc" } })).map((r) => r.action);
const page = { skip: 0, take: 100 };
const live = { status: "live" as const };

test.describe("creating a student", () => {
  test("names are cleaned, a number is generated as YYYY/NNNN (the calendar year when no session is active), the audit entry holds no date of birth", async () => {
    const first = await student({ firstName: "  Sade ", middleName: " Ruth  ", lastName: "  Okoro" });
    expect(first).toMatchObject({
      firstName: "Sade",
      middleName: "Ruth",
      lastName: "Okoro",
      dateOfBirth: "2012-05-01",
      admissionNo: "2026/0001",
      archived: false,
    });
    const second = await student({ firstName: "Tunde" });
    expect(second.admissionNo).toBe("2026/0002");
    expect(await actions(first.id)).toEqual(["STUDENT_CREATED"]);
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: first.id } });
    expect(JSON.stringify(entry)).not.toContain("2012-05-01");
    expect(JSON.stringify(entry)).not.toContain("Okoro");
    expect(entry.afterValue).toMatchObject({ admissionNo: "2026/0001", generated: true });
  });

  test("with an ACTIVE session the number carries that session's start year, and campus sessions win for their campus", async () => {
    const s = await session("2025/2026", null, a, "2025-09-01", "2026-07-31");
    expect(await activateSession(admin(), boss.id, s.id, { closeCurrent: false })).toMatchObject({ ok: true });
    expect((await student()).admissionNo).toBe("2025/0001");
    const northSession = await session("North 2024", north(), a, "2024-09-01", "2025-07-31");
    await activateSession(admin(), boss.id, northSession.id, { closeCurrent: false });
    expect((await student({ firstName: "Nora", campusId: north() })).admissionNo).toBe("2024/0001");
    expect((await student({ firstName: "Segun", campusId: south() })).admissionNo).toBe("2025/0002"); // south has none of its own: the school-wide one
  });

  test("a typed number is kept as typed; it is unique ignoring case; the generator steps over typed numbers", async () => {
    const typed = await student({ admissionNo: "  JSS/ab-07 " });
    expect(typed.admissionNo).toBe("JSS/ab-07");
    expect(await createStudent(admin(), boss.id, { ...PUPIL, firstName: "Other", admissionNo: "jss/AB-07" }, NOW)).toMatchObject({
      ok: false,
      reason: "ADMISSION_NUMBER_TAKEN",
    });
    await student({ firstName: "Early", admissionNo: "2026/0001" });
    expect((await student({ firstName: "Gen" })).admissionNo).toBe("2026/0002");
  });

  test("bad input is refused naming the field, and writes nothing", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ firstName: "" }, "firstName"],
      [{ firstName: "x".repeat(81) }, "firstName"],
      [{ lastName: "   " }, "lastName"],
      [{ middleName: "x".repeat(81) }, "middleName"],
      [{ dateOfBirth: "2012-02-30" }, "dateOfBirth"],
      [{ dateOfBirth: "2026-10-08" }, "dateOfBirth"],
      [{ dateOfBirth: "1899-12-31" }, "dateOfBirth"],
      [{ dateOfBirth: 20120501 }, "dateOfBirth"],
      [{ admissionNo: "bad number" }, "admissionNo"],
      [{ admissionNo: "A".repeat(31) }, "admissionNo"],
    ];
    for (const [over, field] of cases) {
      expect(await createStudent(admin(), boss.id, { ...PUPIL, ...over }, NOW), JSON.stringify(over)).toMatchObject({
        ok: false,
        reason: "INVALID",
        detail: { field },
      });
    }
    expect(await createStudent(admin(), boss.id, { ...PUPIL, campusId: b.campuses[0].id }, NOW)).toMatchObject({
      ok: false,
      reason: "INVALID_CAMPUS",
    });
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(0);
    expect(await db.admissionCounter.count({ where: { tenantId: a.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { tenantId: a.id, action: "STUDENT_CREATED" } })).toBe(0);
  });

  test("a duplicate (same name and birthday, any case or spacing) is refused naming the existing number; another birthday, an archived twin or another school are fine", async () => {
    const original = await student();
    expect(await createStudent(admin(), boss.id, { ...PUPIL, firstName: " sade ", lastName: "OKORO" }, NOW)).toMatchObject({
      ok: false,
      reason: "POSSIBLE_DUPLICATE",
      detail: { admissionNo: original.admissionNo },
    });
    expect(await db.admissionCounter.findFirst({ where: { tenantId: a.id } })).toMatchObject({ next: 2 }); // the refusal burned no number
    await student({ dateOfBirth: "2012-05-02" });
    await student({}, b);
    expect(await archiveStudent(admin(), boss.id, original.id)).toMatchObject({ ok: true });
    await student(); // the archived twin no longer blocks
    expect(await restoreStudent(admin(), boss.id, original.id)).toMatchObject({ ok: false, reason: "POSSIBLE_DUPLICATE" });
  });

  test("running out of numbers (50 taken in a row) is refused AND rolls the counter back — the refusal came after a write", async () => {
    await db.studentRecord.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        tenantId: a.id,
        firstName: `Typed${i}`,
        lastName: "Pupil",
        dateOfBirth: new Date("2012-05-01"),
        admissionNo: `2026/${String(i + 1).padStart(4, "0")}`,
      })),
    });
    expect(await createStudent(admin(), boss.id, { ...PUPIL, firstName: "Late" }, NOW)).toMatchObject({
      ok: false,
      reason: "ADMISSION_NUMBER_EXHAUSTED",
    });
    expect(await db.admissionCounter.count({ where: { tenantId: a.id } })).toBe(0);
    expect(await db.studentRecord.count({ where: { tenantId: a.id } })).toBe(50);
    // …and a typed number still works
    expect((await student({ firstName: "Late", admissionNo: "TYPED/1" })).admissionNo).toBe("TYPED/1");
  });

  test("two creates at once get two different numbers; two identical creates at once make one student", async () => {
    const [x, y] = await Promise.all([
      createStudent(admin(), boss.id, { ...PUPIL, firstName: "Xavier" }, NOW),
      createStudent(admin(), boss.id, { ...PUPIL, firstName: "Yetunde" }, NOW),
    ]);
    expect(x).toMatchObject({ ok: true });
    expect(y).toMatchObject({ ok: true });
    if (x.ok && y.ok) expect(new Set([x.student.admissionNo, y.student.admissionNo]).size).toBe(2);
    const twins = await Promise.all([1, 2, 3].map(() => createStudent(admin(), boss.id, { ...PUPIL, firstName: "Twin" }, NOW)));
    expect(twins.filter((r) => r.ok)).toHaveLength(1);
    expect(twins.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "POSSIBLE_DUPLICATE")).toBe(true);
    const sameNumber = await Promise.all(
      [1, 2].map((i) => createStudent(admin(), boss.id, { ...PUPIL, firstName: `Num${i}`, admissionNo: "SAME/1" }, NOW)),
    );
    expect(sameNumber.filter((r) => r.ok)).toHaveLength(1);
    expect(sameNumber.find((r) => !r.ok)).toMatchObject({ reason: "ADMISSION_NUMBER_TAKEN" });
  });
});

test.describe("changing, archiving and restoring", () => {
  test("a change is audited by field NAME (no values for the date of birth); a no-op writes nothing; the campus is fixed", async () => {
    const s = await student({ campusId: north() });
    expect(await updateStudent(admin(), boss.id, s.id, { firstName: "Sade" }, NOW)).toMatchObject({ ok: true, changed: false });
    expect(await actions(s.id)).toEqual(["STUDENT_CREATED"]);
    const changed = await updateStudent(admin(), boss.id, s.id, { lastName: "Bello", dateOfBirth: "2012-06-01", middleName: null }, NOW);
    expect(changed).toMatchObject({
      ok: true,
      changed: true,
      student: { lastName: "Bello", dateOfBirth: "2012-06-01", campusId: north() },
    });
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: s.id, action: "STUDENT_UPDATED" } });
    expect(entry.afterValue).toMatchObject({ changed: ["lastName", "dateOfBirth"] });
    expect(JSON.stringify(entry)).not.toContain("2012-06-01");
    expect(JSON.stringify(entry)).not.toContain("Bello");
    expect(await updateStudent(admin(), boss.id, s.id, { firstName: "" }, NOW)).toMatchObject({
      ok: false,
      reason: "INVALID",
      detail: { field: "firstName" },
    });
    expect(await updateStudent(admin(), boss.id, s.id, { admissionNo: "bad number" }, NOW)).toMatchObject({
      ok: false,
      detail: { field: "admissionNo" },
    });
  });

  test("an update cannot create a duplicate or take another's number; changing only a number or middle name skips the duplicate check", async () => {
    const one = await student({ firstName: "One" });
    const two = await student({ firstName: "Two" });
    expect(await updateStudent(admin(), boss.id, two.id, { firstName: "One" }, NOW)).toMatchObject({
      ok: false,
      reason: "POSSIBLE_DUPLICATE",
    });
    expect(await updateStudent(admin(), boss.id, two.id, { admissionNo: one.admissionNo.toLowerCase() }, NOW)).toMatchObject({
      ok: false,
      reason: "ADMISSION_NUMBER_TAKEN",
    });
    expect(await updateStudent(admin(), boss.id, two.id, { admissionNo: "NEW/2" }, NOW)).toMatchObject({
      ok: true,
      student: { admissionNo: "NEW/2" },
    });
    expect(await updateStudent(admin(), boss.id, two.id, { middleName: "Mid" }, NOW)).toMatchObject({ ok: true, changed: true });
  });

  test("archiving is refused while an ACTIVE enrolment remains (and writes nothing), allowed after withdrawing, idempotent, and an archived student cannot be edited or enrolled", async () => {
    const s = await student();
    const sess = await session();
    const a1 = await arm();
    const enrolled = await enrolStudent(admin(), boss.id, s.id, { sessionId: sess.id, classArmId: a1.id }, NOW);
    expect(enrolled).toMatchObject({ ok: true });
    if (!enrolled.ok) return;
    expect(await archiveStudent(admin(), boss.id, s.id)).toMatchObject({ ok: false, reason: "HAS_ACTIVE_ENROLMENT" });
    expect((await db.studentRecord.findUniqueOrThrow({ where: { id: s.id } })).archivedAt).toBeNull();
    expect(await withdrawEnrolment(admin(), boss.id, s.id, enrolled.enrolment.id, { reason: "Moved abroad with family" })).toMatchObject({
      ok: true,
    });
    expect(await archiveStudent(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: true, student: { archived: true } });
    expect(await archiveStudent(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: false });
    expect(await actions(s.id)).toEqual(["STUDENT_CREATED", "STUDENT_ARCHIVED"]);
    expect(await updateStudent(admin(), boss.id, s.id, { firstName: "Edited" }, NOW)).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await enrolStudent(admin(), boss.id, s.id, { sessionId: sess.id, classArmId: a1.id }, NOW)).toMatchObject({
      ok: false,
      reason: "ARCHIVED",
    });
    expect(await restoreStudent(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: true, student: { archived: false } });
    expect(await restoreStudent(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: false });
  });
});

test.describe("who sees which student", () => {
  test("an administrator sees every campus; staff see school-wide students and their own campus's; another school's student is just not there", async () => {
    const wide = await student({ firstName: "Wide" });
    const n = await student({ firstName: "Nora", campusId: north() });
    const so = await student({ firstName: "Segun", campusId: south() });
    const foreign = await student({ firstName: "Foreign" }, b);

    const adminList = await listStudents(admin(), live, page);
    expect(adminList.students.map((x) => x.firstName).sort()).toEqual(["Nora", "Segun", "Wide"]);
    const staffNorth = ctx(a, "TEACHING_STAFF", north());
    expect((await listStudents(staffNorth, live, page)).students.map((x) => x.firstName).sort()).toEqual(["Nora", "Wide"]);
    expect((await listStudents(ctx(a, "NON_TEACHING_STAFF", null), live, page)).students.map((x) => x.firstName)).toEqual(["Wide"]);

    expect(await getStudent(staffNorth, n.id)).toMatchObject({ ok: true });
    expect(await getStudent(staffNorth, wide.id)).toMatchObject({ ok: true });
    expect(await getStudent(staffNorth, so.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await getStudent(admin(), foreign.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await getStudent(admin(), "no-such-id")).toEqual({ ok: false, reason: "NOT_FOUND" });
    // a campus filter cannot widen staff's view
    expect((await listStudents(staffNorth, { status: "live", campusId: south() }, page)).students).toEqual([]);
  });
});

test.describe("listing", () => {
  test("search by name parts and number, status filter, paging with a stable order and a total", async () => {
    await student({ firstName: "Amina", lastName: "Bello" });
    await student({ firstName: "Amina", lastName: "Adeyemi", dateOfBirth: "2011-01-01" });
    const old = await student({ firstName: "Chidi", lastName: "Eze", admissionNo: "OLD/77" });
    await archiveStudent(admin(), boss.id, old.id);

    const all = await listStudents(admin(), live, page);
    expect(all.students.map((x) => `${x.lastName} ${x.firstName}`)).toEqual(["Adeyemi Amina", "Bello Amina"]); // last name, first name
    expect(all.total).toBe(2);
    expect((await listStudents(admin(), { status: "live", q: "amina bel" }, page)).students.map((x) => x.lastName)).toEqual(["Bello"]);
    expect((await listStudents(admin(), { status: "live", q: "ADEY" }, page)).total).toBe(1);
    expect((await listStudents(admin(), { status: "live", q: "2026/0001" }, page)).total).toBe(1);
    expect((await listStudents(admin(), { status: "archived" }, page)).students.map((x) => x.admissionNo)).toEqual(["OLD/77"]);
    expect((await listStudents(admin(), { status: "all" }, page)).total).toBe(3);
    const first = await listStudents(admin(), live, { skip: 0, take: 1 });
    const second = await listStudents(admin(), live, { skip: 1, take: 1 });
    expect([first.students[0].lastName, second.students[0].lastName]).toEqual(["Adeyemi", "Bello"]);
    expect(first.total).toBe(2);
  });

  test("by class and session: who is in a class, who is not enrolled yet — and each row carries its enrolment for that session", async () => {
    const sess = await session();
    const other = await session("2027/2028", null, a, "2027-09-01", "2028-07-31");
    const a1 = await arm("A");
    const a2 = await arm("B");
    const s1 = await student({ firstName: "Inclass" });
    const s2 = await student({ firstName: "Otherclass" });
    const s3 = await student({ firstName: "Notenrolled" });
    await enrolStudent(admin(), boss.id, s1.id, { sessionId: sess.id, classArmId: a1.id }, NOW);
    await enrolStudent(admin(), boss.id, s2.id, { sessionId: sess.id, classArmId: a2.id }, NOW);

    const inA1 = await listStudents(admin(), { status: "live", sessionId: sess.id, classArmId: a1.id }, page);
    expect(inA1.students.map((x) => x.firstName)).toEqual(["Inclass"]);
    expect(inA1.students[0].enrolment).toMatchObject({ armName: "A", sessionLabel: "2026/2027", status: "ACTIVE" });
    const waiting = await listStudents(admin(), { status: "live", sessionId: sess.id, notEnrolled: true }, page);
    expect(waiting.students.map((x) => x.firstName)).toEqual(["Notenrolled"]);
    expect(waiting.students[0].enrolment).toBeNull();
    expect(s3.id).toBe(waiting.students[0].id);
    // in the OTHER session nobody is enrolled
    expect((await listStudents(admin(), { status: "live", sessionId: other.id, notEnrolled: true }, page)).total).toBe(3);
    // no session named → no enrolment attached
    expect((await listStudents(admin(), live, page)).students.every((x) => x.enrolment === null)).toBe(true);
  });
});

test.describe("enrolment", () => {
  test("one per student per session: a second is refused naming the class; a withdrawn student comes back into the SAME row; a later session is separate", async () => {
    const s = await student();
    const s1 = await session("2026/2027");
    const s2 = await session("2027/2028", null, a, "2027-09-01", "2028-07-31");
    const a1 = await arm("A");
    const a2 = await arm("B");
    const first = await enrolStudent(admin(), boss.id, s.id, { sessionId: s1.id, classArmId: a1.id }, NOW);
    expect(first).toMatchObject({ ok: true, reenrolled: false, enrolment: { status: "ACTIVE", armName: "A", sessionLabel: "2026/2027" } });
    if (!first.ok) return;
    expect(await enrolStudent(admin(), boss.id, s.id, { sessionId: s1.id, classArmId: a2.id }, NOW)).toMatchObject({
      ok: false,
      reason: "ALREADY_ENROLLED",
      detail: { armName: "A", classArmId: a1.id },
    });
    expect(await withdrawEnrolment(admin(), boss.id, s.id, first.enrolment.id, { reason: "Left the school" })).toMatchObject({
      ok: true,
      enrolment: { status: "WITHDRAWN" },
    });
    const back = await enrolStudent(admin(), boss.id, s.id, { sessionId: s1.id, classArmId: a2.id }, NOW);
    expect(back).toMatchObject({ ok: true, reenrolled: true, enrolment: { id: first.enrolment.id, status: "ACTIVE", armName: "B" } });
    expect(await db.studentEnrollment.count({ where: { studentId: s.id, sessionId: s1.id } })).toBe(1);
    expect(await enrolStudent(admin(), boss.id, s.id, { sessionId: s2.id, classArmId: a1.id }, NOW)).toMatchObject({
      ok: true,
      reenrolled: false,
    });
    expect(await actions(first.enrolment.id)).toEqual(["ENROLMENT_CREATED", "ENROLMENT_WITHDRAWN", "ENROLMENT_REACTIVATED"]);
    const detail = await getStudent(admin(), s.id);
    expect(detail.ok && detail.enrolments.map((e) => e.sessionLabel)).toEqual(["2027/2028", "2026/2027"]); // newest session first
  });

  test("the session must be planned or active — never closed or archived — and the class live; closing a session after enrolment leaves the enrolment alone", async () => {
    const s = await student();
    const sess = await session();
    const a1 = await arm("A");
    await activateSession(admin(), boss.id, sess.id, { closeCurrent: false });
    const enrolled = await enrolStudent(admin(), boss.id, s.id, { sessionId: sess.id, classArmId: a1.id }, NOW);
    expect(enrolled).toMatchObject({ ok: true });
    await closeNow(sess.id);
    const t = await student({ firstName: "Late" });
    expect(await enrolStudent(admin(), boss.id, t.id, { sessionId: sess.id, classArmId: a1.id }, NOW)).toMatchObject({
      ok: false,
      reason: "SESSION_CLOSED",
    });
    expect(await db.studentEnrollment.count({ where: { studentId: s.id, status: "ACTIVE" } })).toBe(1); // untouched
    // an archived class
    const a2 = await arm("Z");
    const planned = await session("2027/2028", null, a, "2027-09-01", "2028-07-31");
    expect(await archiveArm(admin(), boss.id, a2.id)).toMatchObject({ ok: true });
    expect(await enrolStudent(admin(), boss.id, t.id, { sessionId: planned.id, classArmId: a2.id }, NOW)).toMatchObject({
      ok: false,
      reason: "INVALID_ARM",
    });
    expect(await enrolStudent(admin(), boss.id, t.id, { sessionId: planned.id, classArmId: a1.id }, NOW)).toMatchObject({ ok: true });
  });

  test("a campus's student fits a school-wide or their own campus's session and class, never another campus's; a student with no campus fits only school-wide ones; foreign ids are refused", async () => {
    const northStudent = await student({ firstName: "Nora", campusId: north() });
    const wideStudent = await student({ firstName: "Wide" });
    const wideSession = await session("Wide 2026");
    const northSession = await session("North 2026", north());
    const southSession = await session("South 2026", south());
    const wideArm = await arm("W");
    const northArm = await arm("N", north());
    const southArm = await arm("S", south());
    const enrol = (studentId: string, sessionId: string, classArmId: string) =>
      enrolStudent(admin(), boss.id, studentId, { sessionId, classArmId }, NOW);

    expect(await enrol(northStudent.id, southSession.id, wideArm.id)).toMatchObject({ ok: false, reason: "INVALID_SESSION" });
    expect(await enrol(northStudent.id, wideSession.id, southArm.id)).toMatchObject({ ok: false, reason: "INVALID_ARM" });
    expect(await enrol(wideStudent.id, northSession.id, wideArm.id)).toMatchObject({ ok: false, reason: "INVALID_SESSION" });
    expect(await enrol(wideStudent.id, wideSession.id, northArm.id)).toMatchObject({ ok: false, reason: "INVALID_ARM" });
    expect(await enrol(northStudent.id, northSession.id, northArm.id)).toMatchObject({ ok: true });
    expect(await enrol(wideStudent.id, wideSession.id, wideArm.id)).toMatchObject({ ok: true });

    const foreignSession = await session("Beta 2026", null, b);
    const foreignArm = await arm("F", null, b);
    const other = await student({ firstName: "Other" });
    expect(await enrol(other.id, foreignSession.id, wideArm.id)).toMatchObject({ ok: false, reason: "INVALID_SESSION" });
    expect(await enrol(other.id, wideSession.id, foreignArm.id)).toMatchObject({ ok: false, reason: "INVALID_ARM" });
    expect(await enrol(other.id, "nope", wideArm.id)).toMatchObject({ ok: false, reason: "INVALID_SESSION" });
    expect(await db.studentEnrollment.count({ where: { studentId: other.id } })).toBe(0);
  });

  test("moving: to another class in the same session (audited before/after), same class is a no-op, withdrawn or closed refuses", async () => {
    const s = await student();
    const sess = await session();
    const a1 = await arm("A");
    const a2 = await arm("B");
    const e = await enrolStudent(admin(), boss.id, s.id, { sessionId: sess.id, classArmId: a1.id }, NOW);
    if (!e.ok) throw new Error("setup");
    expect(await moveEnrolment(admin(), boss.id, s.id, e.enrolment.id, { classArmId: a1.id }, NOW)).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(await moveEnrolment(admin(), boss.id, s.id, e.enrolment.id, { classArmId: a2.id }, NOW)).toMatchObject({
      ok: true,
      changed: true,
      enrolment: { armName: "B" },
    });
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: e.enrolment.id, action: "ENROLMENT_MOVED" } });
    expect(entry.beforeValue).toMatchObject({ classArmId: a1.id });
    expect(entry.afterValue).toMatchObject({ classArmId: a2.id });
    expect(await moveEnrolment(admin(), boss.id, s.id, e.enrolment.id, { classArmId: "nope" }, NOW)).toMatchObject({
      ok: false,
      reason: "INVALID_ARM",
    });
    expect(await moveEnrolment(admin(), boss.id, s.id, "nope", { classArmId: a1.id }, NOW)).toEqual({ ok: false, reason: "NOT_FOUND" });
    const stranger = await student({ firstName: "Stranger" });
    expect(await moveEnrolment(admin(), boss.id, stranger.id, e.enrolment.id, { classArmId: a1.id }, NOW)).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    }); // someone else's enrolment
    await withdrawEnrolment(admin(), boss.id, s.id, e.enrolment.id, { reason: "Transferred out" });
    expect(await moveEnrolment(admin(), boss.id, s.id, e.enrolment.id, { classArmId: a1.id }, NOW)).toMatchObject({
      ok: false,
      reason: "WRONG_STATE",
    });
  });

  test("withdrawing needs a reason of 5–300 characters, which is recorded in the audit entry; twice is refused", async () => {
    const s = await student();
    const sess = await session();
    const a1 = await arm("A");
    const e = await enrolStudent(admin(), boss.id, s.id, { sessionId: sess.id, classArmId: a1.id }, NOW);
    if (!e.ok) throw new Error("setup");
    for (const reason of ["", "no", "    ", "x".repeat(301), null, 12345]) {
      expect(await withdrawEnrolment(admin(), boss.id, s.id, e.enrolment.id, { reason }), String(reason)).toMatchObject({
        ok: false,
        reason: "INVALID",
        detail: { field: "reason" },
      });
    }
    expect((await db.studentEnrollment.findUniqueOrThrow({ where: { id: e.enrolment.id } })).status).toBe("ACTIVE");
    expect(await withdrawEnrolment(admin(), boss.id, s.id, e.enrolment.id, { reason: "  Family moved   to Abuja " })).toMatchObject({
      ok: true,
    });
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: e.enrolment.id, action: "ENROLMENT_WITHDRAWN" } });
    expect(entry.reason).toBe("Family moved to Abuja");
    expect(await withdrawEnrolment(admin(), boss.id, s.id, e.enrolment.id, { reason: "Second attempt" })).toMatchObject({
      ok: false,
      reason: "WRONG_STATE",
    });
  });

  test("two enrolments of one student in one session at once make one row", async () => {
    const s = await student();
    const sess = await session();
    const a1 = await arm("A");
    const a2 = await arm("B");
    const results = await Promise.all(
      [a1, a2, a1, a2].map((x) => enrolStudent(admin(), boss.id, s.id, { sessionId: sess.id, classArmId: x.id }, NOW)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "ALREADY_ENROLLED")).toBe(true);
    expect(await db.studentEnrollment.count({ where: { studentId: s.id } })).toBe(1);
  });

  test("occupancy counts ACTIVE enrolments of live, visible students per class; capacity is shown, never enforced", async () => {
    const sess = await session();
    const tiny = await arm("T", null, a, 1);
    const roomy = await arm("R");
    const kids = await Promise.all(["P1", "P2", "P3"].map((n) => student({ firstName: n })));
    for (const k of kids.slice(0, 2))
      expect(await enrolStudent(admin(), boss.id, k.id, { sessionId: sess.id, classArmId: tiny.id }, NOW)).toMatchObject({ ok: true }); // capacity 1, two in
    const third = await enrolStudent(admin(), boss.id, kids[2].id, { sessionId: sess.id, classArmId: roomy.id }, NOW);
    if (!third.ok) throw new Error("setup");
    expect(await armOccupancy(admin(), sess.id)).toEqual({ ok: true, counts: { [tiny.id]: 2, [roomy.id]: 1 } });
    await withdrawEnrolment(admin(), boss.id, kids[2].id, third.enrolment.id, { reason: "Left the school" });
    expect(await armOccupancy(admin(), sess.id)).toEqual({ ok: true, counts: { [tiny.id]: 2 } });
    expect(await armOccupancy(admin(), "nope")).toMatchObject({ ok: false, reason: "INVALID_SESSION" });
    const foreign = await session("Beta 2026", null, b);
    expect(await armOccupancy(admin(), foreign.id)).toMatchObject({ ok: false, reason: "INVALID_SESSION" });
  });
});
