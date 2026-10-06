import "../support/env";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import {
  archiveArm,
  archiveClassGroup,
  archiveSubject,
  cleanCode,
  createArm,
  createClassGroup,
  createSubject,
  getClassGroup,
  listClassGroups,
  listOfferings,
  listSubjects,
  setOfferings,
  updateArm,
  updateClassGroup,
  updateSubject,
} from "@/lib/academics/classes";

// Class groups, arms, subjects and offerings in-process, as `app_user` (plan "Build design — Phase 1.0 and 1.1", decision 13).

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

const north = () => a.campuses[0].id;
const south = () => a.campuses[1].id;
async function group(name: string, campusId: string | null = null, sortOrder = 0, school: TestTenant = a) {
  const result = await createClassGroup(admin(school), boss.id, { campusId, name, sortOrder });
  if (!result.ok) throw new Error(`createClassGroup(${name}) refused: ${result.reason}`);
  return result.group;
}
async function subject(name: string, code?: string, school: TestTenant = a) {
  const result = await createSubject(admin(school), boss.id, { name, code });
  if (!result.ok) throw new Error(`createSubject(${name}) refused: ${result.reason}`);
  return result.subject;
}
const actions = async (targetId: string) =>
  (await db.auditLog.findMany({ where: { tenantId: a.id, targetId }, orderBy: { createdAt: "asc" } })).map((r) => r.action);
const page = { skip: 0, take: 100 };

test.describe("class groups", () => {
  test("a group is created with a cleaned name and an order, on a campus or school-wide, and audited; bad input and foreign campuses are refused and write nothing", async () => {
    const made = await createClassGroup(admin(), boss.id, { name: "  JSS   1 ", sortOrder: 3 });
    expect(made).toMatchObject({
      ok: true,
      group: { name: "JSS 1", sortOrder: 3, campusId: null, archived: false, arms: [], subjectCount: 0 },
    });
    if (!made.ok) return;
    expect(await actions(made.group.id)).toEqual(["CLASS_GROUP_CREATED"]);
    for (const name of ["", "   ", "x".repeat(61), null, 7])
      expect(await createClassGroup(admin(), boss.id, { name }), String(name)).toMatchObject({ ok: false, reason: "INVALID_NAME" });
    for (const sortOrder of [-1, 1000, 1.5, "2", null])
      expect(await createClassGroup(admin(), boss.id, { name: "X", sortOrder }), String(sortOrder)).toMatchObject({
        ok: false,
        reason: "INVALID_SORT_ORDER",
      });
    expect(await createClassGroup(admin(), boss.id, { name: "X", campusId: b.campuses[0].id })).toMatchObject({
      ok: false,
      reason: "INVALID_CAMPUS",
    });
    expect(await createClassGroup(admin(), boss.id, { name: "X", campusId: "no-such-campus" })).toMatchObject({
      ok: false,
      reason: "INVALID_CAMPUS",
    });
    expect(await db.classGroup.count({ where: { tenantId: a.id } })).toBe(1);
  });

  test("a name is unique per scope among LIVE groups: free on another campus, free again once the first is archived", async () => {
    const first = await group("Year 10");
    expect(await createClassGroup(admin(), boss.id, { name: "Year 10" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    expect((await createClassGroup(admin(), boss.id, { name: "Year 10", campusId: north() })).ok).toBe(true); // its own scope
    await archiveClassGroup(admin(), boss.id, first.id);
    expect((await createClassGroup(admin(), boss.id, { name: "Year 10" })).ok).toBe(true);
  });

  test("two simultaneous creates of the same name: exactly ONE succeeds (repeated)", async () => {
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all([1, 2, 3].map(() => createClassGroup(admin(), boss.id, { name: `Race ${round}` })));
      expect(
        results.filter((r) => r.ok),
        `round ${round}`,
      ).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "NAME_TAKEN")).toBe(true);
    }
  });

  test("update renames and reorders with before/after audit; a no-op writes nothing; a taken name or an archived group is refused", async () => {
    const g = await group("JSS1", null, 1);
    await group("JSS2", null, 2);
    expect(await updateClassGroup(admin(), boss.id, g.id, { name: "JSS1" })).toMatchObject({ ok: true, changed: false });
    expect(await actions(g.id)).toEqual(["CLASS_GROUP_CREATED"]);
    expect(await updateClassGroup(admin(), boss.id, g.id, { name: "JSS2" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    expect(await updateClassGroup(admin(), boss.id, g.id, { sortOrder: 5, name: "Junior 1" })).toMatchObject({
      ok: true,
      changed: true,
      group: { name: "Junior 1", sortOrder: 5 },
    });
    expect(await db.auditLog.findFirstOrThrow({ where: { targetId: g.id, action: "CLASS_GROUP_UPDATED" } })).toMatchObject({
      beforeValue: { name: "JSS1", sortOrder: 1 },
      afterValue: { name: "Junior 1", sortOrder: 5 },
    });
    await archiveClassGroup(admin(), boss.id, g.id);
    expect(await updateClassGroup(admin(), boss.id, g.id, { name: "Late" })).toMatchObject({ ok: false, reason: "ARCHIVED" });
  });

  test("a group with live arms cannot be archived (HAS_ACTIVE_ARMS) — nothing is archived silently; after its arms are, it can, and it is never deleted", async () => {
    const g = await group("JSS1");
    const arm = await createArm(admin(), boss.id, g.id, { name: "A" });
    if (!arm.ok) throw new Error("setup");
    expect(await archiveClassGroup(admin(), boss.id, g.id)).toMatchObject({ ok: false, reason: "HAS_ACTIVE_ARMS" });
    expect((await db.classGroup.findUniqueOrThrow({ where: { id: g.id } })).archivedAt).toBeNull();
    await archiveArm(admin(), boss.id, arm.arm.id);
    expect(await archiveClassGroup(admin(), boss.id, g.id)).toMatchObject({ ok: true, changed: true, group: { archived: true } });
    expect(await archiveClassGroup(admin(), boss.id, g.id)).toMatchObject({ ok: true, changed: false });
    expect(await db.classGroup.count({ where: { id: g.id } })).toBe(1);
    expect(await createArm(admin(), boss.id, g.id, { name: "B" })).toMatchObject({ ok: false, reason: "ARCHIVED" }); // no arms in an archived group
  });

  test("the list is in progression order (then name), hides archived by default, and shows live arms and the subject count", async () => {
    const senior = await group("SS1", null, 10);
    const junior = await group("JSS1", null, 1);
    const old = await group("Primary", null, 0);
    await createArm(admin(), boss.id, junior.id, { name: "B", capacity: 40 });
    await createArm(admin(), boss.id, junior.id, { name: "A" });
    const maths = await subject("Mathematics", "MTH");
    await setOfferings(admin(), boss.id, junior.id, [maths.id]);
    await archiveClassGroup(admin(), boss.id, old.id);
    const live = await listClassGroups(admin(), { status: "live" }, page);
    expect(live.groups.map((g) => g.name)).toEqual(["JSS1", "SS1"]);
    expect(live.groups[0].arms.map((x) => x.name)).toEqual(["A", "B"]);
    expect(live.groups[0].arms[1]).toMatchObject({ capacity: 40 });
    expect(live.groups[0].subjectCount).toBe(1);
    expect((await listClassGroups(admin(), { status: "archived" }, page)).groups.map((g) => g.name)).toEqual(["Primary"]);
    expect((await listClassGroups(admin(), { status: "all" }, page)).total).toBe(3);
    expect(senior.id).toBeTruthy();
  });

  test("campus scope: staff see school-wide groups and their own campus's; another campus's group is NOT_FOUND like an unknown id; an ADMIN sees all", async () => {
    const wide = await group("Wide");
    const n = await group("North only", north());
    const s = await group("South only", south());
    const ids = async (c: TenantAuthContext["tenant"]) =>
      (await listClassGroups(c, { status: "all" }, page)).groups.map((g) => g.id).sort();
    expect(await ids(ctx(a, "ADMIN", north()))).toEqual([wide.id, n.id, s.id].sort());
    expect(await ids(ctx(a, "TEACHING_STAFF", north()))).toEqual([wide.id, n.id].sort());
    expect(await ids(ctx(a, "NON_TEACHING_STAFF", null))).toEqual([wide.id]);
    expect(await getClassGroup(ctx(a, "TEACHING_STAFF", north()), s.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await getClassGroup(ctx(a, "TEACHING_STAFF", north()), "no-such-id")).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await createArm(ctx(a, "TEACHING_STAFF", north()), boss.id, s.id, { name: "A" })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await listOfferings(ctx(a, "TEACHING_STAFF", north()), s.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  test("another school's group is NOT_FOUND for every operation, and nothing there changes", async () => {
    const theirs = await group("Beta JSS1", null, 0, b);
    const bArm = await createArm(admin(b), boss.id, theirs.id, { name: "A" });
    if (!bArm.ok) throw new Error("setup");
    expect(await getClassGroup(admin(), theirs.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await updateClassGroup(admin(), boss.id, theirs.id, { name: "hijack" })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await archiveClassGroup(admin(), boss.id, theirs.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await createArm(admin(), boss.id, theirs.id, { name: "Z" })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await updateArm(admin(), boss.id, bArm.arm.id, { name: "hijack" })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await archiveArm(admin(), boss.id, bArm.arm.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await setOfferings(admin(), boss.id, theirs.id, [])).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await db.classGroup.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ name: "Beta JSS1", archivedAt: null });
    expect(await db.classArm.findUniqueOrThrow({ where: { id: bArm.arm.id } })).toMatchObject({ name: "A", archivedAt: null });
  });
});

test.describe("arms", () => {
  test("capacity is a whole number from 1 to 1000 or empty (no limit); names are unique per group among live arms; at most 26 arms", async () => {
    const g = await group("JSS1");
    for (const capacity of [0, -1, 1001, 1.5, "30", NaN])
      expect(await createArm(admin(), boss.id, g.id, { name: "A", capacity }), String(capacity)).toMatchObject({
        ok: false,
        reason: "INVALID_CAPACITY",
      });
    expect(await createArm(admin(), boss.id, g.id, { name: "A", capacity: 1 })).toMatchObject({ ok: true, arm: { capacity: 1 } });
    expect(await createArm(admin(), boss.id, g.id, { name: "B", capacity: 1000 })).toMatchObject({ ok: true, arm: { capacity: 1000 } });
    expect(await createArm(admin(), boss.id, g.id, { name: "C" })).toMatchObject({ ok: true, arm: { capacity: null } });
    expect(await createArm(admin(), boss.id, g.id, { name: "A" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    expect(await createArm(admin(), boss.id, g.id, { name: "   " })).toMatchObject({ ok: false, reason: "INVALID_NAME" });
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ")
      expect((await createArm(admin(), boss.id, g.id, { name: letter })).ok, letter).toBe(true);
    expect(await createArm(admin(), boss.id, g.id, { name: "AA" })).toMatchObject({ ok: false, reason: "TOO_MANY_ARMS" });
  });

  test("the same arm name is fine in another group; update changes name and capacity (null clears it) with before/after; a no-op writes nothing; archive frees the name", async () => {
    const g1 = await group("JSS1");
    const g2 = await group("JSS2");
    const a1 = await createArm(admin(), boss.id, g1.id, { name: "A", capacity: 30 });
    expect((await createArm(admin(), boss.id, g2.id, { name: "A" })).ok).toBe(true);
    if (!a1.ok) throw new Error("setup");
    expect(await updateArm(admin(), boss.id, a1.arm.id, { name: "A", capacity: 30 })).toMatchObject({ ok: true, changed: false });
    expect(await updateArm(admin(), boss.id, a1.arm.id, { capacity: null })).toMatchObject({
      ok: true,
      changed: true,
      arm: { capacity: null },
    });
    expect(await updateArm(admin(), boss.id, a1.arm.id, { capacity: 0 })).toMatchObject({ ok: false, reason: "INVALID_CAPACITY" });
    expect(await updateArm(admin(), boss.id, a1.arm.id, { name: "Gold", capacity: 25 })).toMatchObject({
      ok: true,
      arm: { name: "Gold", capacity: 25 },
    });
    expect(
      await db.auditLog.findFirstOrThrow({ where: { targetId: a1.arm.id, action: "CLASS_ARM_UPDATED" }, orderBy: { createdAt: "desc" } }),
    ).toMatchObject({ beforeValue: { name: "A", capacity: null }, afterValue: { name: "Gold", capacity: 25 } });
    expect(await archiveArm(admin(), boss.id, a1.arm.id)).toMatchObject({ ok: true, changed: true, arm: { archived: true } });
    expect(await archiveArm(admin(), boss.id, a1.arm.id)).toMatchObject({ ok: true, changed: false });
    expect(await updateArm(admin(), boss.id, a1.arm.id, { name: "Late" })).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect((await createArm(admin(), boss.id, g1.id, { name: "Gold" })).ok).toBe(true); // the archived name is free
    expect(await db.classArm.count({ where: { id: a1.arm.id } })).toBe(1); // never deleted
  });
});

test.describe("subjects", () => {
  test("names and codes are cleaned and unique among LIVE subjects: the code is upper-cased, blank means none, and a bad code is refused", async () => {
    expect(cleanCode(" mth ")).toBe("MTH");
    expect(cleanCode("")).toBeNull();
    expect(cleanCode(null)).toBeNull();
    expect(cleanCode(undefined)).toBeNull();
    for (const bad of ["too long code!!", "A B", "M-1", "x".repeat(13), 5]) expect(cleanCode(bad), String(bad)).toBe("INVALID");
    const maths = await subject("  Mathematics ", "mth");
    expect(maths).toMatchObject({ name: "Mathematics", code: "MTH", archived: false });
    expect(await createSubject(admin(), boss.id, { name: "Mathematics" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    expect(await createSubject(admin(), boss.id, { name: "Maths 2", code: "MTH" })).toMatchObject({ ok: false, reason: "CODE_TAKEN" });
    expect(await createSubject(admin(), boss.id, { name: "Maths 3", code: "no way" })).toMatchObject({ ok: false, reason: "INVALID_CODE" });
    expect((await subject("English")).code).toBeNull();
    expect((await subject("Civic")).code).toBeNull(); // two subjects may both have NO code
    expect(await createSubject(admin(), boss.id, { name: "x".repeat(81) })).toMatchObject({ ok: false, reason: "INVALID_NAME" });
    await archiveSubject(admin(), boss.id, maths.id);
    expect((await createSubject(admin(), boss.id, { name: "Mathematics", code: "MTH" })).ok).toBe(true); // archived name and code are free again
  });

  test("the same subject name is fine in another school; subjects are not campus-scoped, so every reader sees them all", async () => {
    await subject("Physics", "PHY");
    await subject("Physics", "PHY", b);
    expect((await listSubjects(ctx(a, "TEACHING_STAFF", north()), { status: "live" }, page)).subjects.map((s) => s.name)).toEqual([
      "Physics",
    ]);
  });

  test("search treats % _ and \\ as TEXT, matches name or code case-insensitively, and the list is name-ordered and filterable by status", async () => {
    await subject("100% Effort");
    await subject("Under_score");
    await subject("Mathematics", "MTH");
    await subject("Further Maths", "FMT");
    const names = async (q: string) => (await listSubjects(admin(), { status: "live", q }, page)).subjects.map((s) => s.name);
    expect(await names("%")).toEqual(["100% Effort"]); // not "everything"
    expect(await names("_")).toEqual(["Under_score"]);
    expect(await names("\\")).toEqual([]);
    expect(await names("MATHS")).toEqual(["Further Maths"]);
    expect(await names("mth")).toEqual(["Mathematics"]); // by code
    expect((await listSubjects(admin(), { status: "live" }, page)).subjects.map((s) => s.name)).toEqual([
      "100% Effort",
      "Further Maths",
      "Mathematics",
      "Under_score",
    ]);
  });

  test("update changes name and code with before/after; a no-op writes nothing; clashes are refused; an archived subject is read-only", async () => {
    const s1 = await subject("Maths", "MTH");
    await subject("English", "ENG");
    expect(await updateSubject(admin(), boss.id, s1.id, { name: "Maths", code: "mth" })).toMatchObject({ ok: true, changed: false });
    expect(await updateSubject(admin(), boss.id, s1.id, { name: "English" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    expect(await updateSubject(admin(), boss.id, s1.id, { code: "ENG" })).toMatchObject({ ok: false, reason: "CODE_TAKEN" });
    expect(await updateSubject(admin(), boss.id, s1.id, { code: null })).toMatchObject({
      ok: true,
      changed: true,
      subject: { code: null },
    });
    expect(await updateSubject(admin(), boss.id, s1.id, { name: "Mathematics", code: "MAT" })).toMatchObject({
      ok: true,
      subject: { name: "Mathematics", code: "MAT" },
    });
    expect(
      await db.auditLog.findFirstOrThrow({ where: { targetId: s1.id, action: "SUBJECT_UPDATED" }, orderBy: { createdAt: "desc" } }),
    ).toMatchObject({ beforeValue: { name: "Maths", code: null }, afterValue: { name: "Mathematics", code: "MAT" } });
    await archiveSubject(admin(), boss.id, s1.id);
    expect(await updateSubject(admin(), boss.id, s1.id, { name: "Late" })).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await updateSubject(admin(), boss.id, "no-such-subject", { name: "x" })).toEqual({ ok: false, reason: "NOT_FOUND" });
  });
});

test.describe("what each class group studies", () => {
  test("the FULL list is set at once: adds, removes, idempotent (a repeat writes nothing), audited with before/after ids", async () => {
    const g = await group("JSS1");
    const [maths, english, physics] = [await subject("Maths"), await subject("English"), await subject("Physics")];
    expect(await setOfferings(admin(), boss.id, g.id, [maths.id, english.id])).toMatchObject({
      ok: true,
      changed: true,
      subjects: [{ name: "English" }, { name: "Maths" }],
    });
    const before = await db.auditLog.count({ where: { tenantId: a.id, targetId: g.id, action: "SUBJECT_OFFERING_CHANGED" } });
    expect(await setOfferings(admin(), boss.id, g.id, [english.id, maths.id, maths.id])).toMatchObject({ ok: true, changed: false }); // same set, any order, a duplicate
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: g.id, action: "SUBJECT_OFFERING_CHANGED" } })).toBe(before);
    expect(await setOfferings(admin(), boss.id, g.id, [english.id, physics.id])).toMatchObject({
      ok: true,
      changed: true,
      subjects: [{ name: "English" }, { name: "Physics" }],
    });
    const row = await db.auditLog.findFirstOrThrow({
      where: { targetId: g.id, action: "SUBJECT_OFFERING_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toMatchObject({
      beforeValue: { subjectIds: [english.id, maths.id].sort() },
      afterValue: { subjectIds: [english.id, physics.id].sort() },
    });
    expect(await setOfferings(admin(), boss.id, g.id, [])).toMatchObject({ ok: true, changed: true, subjects: [] });
    expect(await db.subjectOffering.count({ where: { classGroupId: g.id } })).toBe(0); // a real removal (nothing references an offering yet)
  });

  test("every id must be a live subject of THIS school: an unknown, another school's or an archived one refuses the WHOLE request and changes nothing", async () => {
    const g = await group("JSS1");
    const mine = await subject("Maths");
    const theirs = await subject("Beta Maths", undefined, b);
    const gone = await subject("Latin");
    await archiveSubject(admin(), boss.id, gone.id);
    await setOfferings(admin(), boss.id, g.id, [mine.id]);
    for (const bad of [theirs.id, "no-such-subject", gone.id]) {
      expect(await setOfferings(admin(), boss.id, g.id, [mine.id, bad]), bad).toMatchObject({ ok: false, reason: "UNKNOWN_SUBJECT" });
    }
    expect((await listOfferings(admin(), g.id)) as { subjects: { name: string }[] }).toMatchObject({ subjects: [{ name: "Maths" }] }); // unchanged
  });

  test("a subject a live class group studies cannot be archived (SUBJECT_IN_USE); once it is removed from those groups it can; archiving a GROUP does not block it", async () => {
    const g1 = await group("JSS1");
    const g2 = await group("JSS2");
    const maths = await subject("Maths");
    await setOfferings(admin(), boss.id, g1.id, [maths.id]);
    await setOfferings(admin(), boss.id, g2.id, [maths.id]);
    expect(await archiveSubject(admin(), boss.id, maths.id)).toMatchObject({ ok: false, reason: "SUBJECT_IN_USE" });
    await archiveClassGroup(admin(), boss.id, g1.id);
    expect(await archiveSubject(admin(), boss.id, maths.id)).toMatchObject({ ok: false, reason: "SUBJECT_IN_USE" }); // g2 still studies it
    await setOfferings(admin(), boss.id, g2.id, []);
    expect(await archiveSubject(admin(), boss.id, maths.id)).toMatchObject({ ok: true, changed: true });
    expect((await listOfferings(admin(), g2.id)) as { subjects: unknown[] }).toMatchObject({ subjects: [] });
    expect(await setOfferings(admin(), boss.id, g1.id, [])).toMatchObject({ ok: false, reason: "ARCHIVED" }); // an archived group's list is frozen
  });

  test("archived subjects drop out of a group's list; the group's subject count is what is stored", async () => {
    const g = await group("JSS1");
    const [maths, english] = [await subject("Maths"), await subject("English")];
    await setOfferings(admin(), boss.id, g.id, [maths.id, english.id]);
    await db.subject.update({ where: { id: english.id }, data: { archivedAt: new Date() } }); // archived behind the service's back
    expect(((await listOfferings(admin(), g.id)) as { subjects: { name: string }[] }).subjects.map((s) => s.name)).toEqual(["Maths"]);
  });
});

test.describe("what the DATABASE refuses on its own", () => {
  test("composite foreign keys keep every row in its school EVEN THROUGH THE OWNER ROLE: another school's campus, group or subject", async () => {
    const theirGroup = await group("Theirs", null, 0, b);
    const theirSubject = await subject("Beta Maths", undefined, b);
    const mine = await group("Mine");
    const mySubject = await subject("Mine Maths");
    await expect(db.classGroup.create({ data: { tenantId: a.id, name: "X", campusId: b.campuses[0].id } })).rejects.toThrow(
      /Foreign key constraint/,
    );
    await expect(db.classArm.create({ data: { tenantId: a.id, classGroupId: theirGroup.id, name: "A" } })).rejects.toThrow(
      /Foreign key constraint/,
    );
    await expect(
      db.subjectOffering.create({ data: { tenantId: a.id, classGroupId: theirGroup.id, subjectId: mySubject.id } }),
    ).rejects.toThrow(/Foreign key constraint/);
    await expect(
      db.subjectOffering.create({ data: { tenantId: a.id, classGroupId: mine.id, subjectId: theirSubject.id } }),
    ).rejects.toThrow(/Foreign key constraint/);
    expect(await db.subjectOffering.count({ where: { tenantId: a.id } })).toBe(0);
  });

  test("CHECK constraints and partial unique indexes: blank names, a 0 capacity, a lower-case code, a repeated live name or arm or code", async () => {
    const g = await db.classGroup.create({ data: { tenantId: a.id, name: "Raw" } });
    await expect(db.classGroup.create({ data: { tenantId: a.id, name: "  " } })).rejects.toThrow(/check constraint|not_blank/i);
    await expect(db.classGroup.create({ data: { tenantId: a.id, name: "Raw" } })).rejects.toThrow(/Unique constraint/);
    await expect(db.classGroup.create({ data: { tenantId: a.id, name: "Z", sortOrder: 1000 } })).rejects.toThrow(/check constraint|range/i);
    await db.classArm.create({ data: { tenantId: a.id, classGroupId: g.id, name: "A", capacity: 10 } });
    await expect(db.classArm.create({ data: { tenantId: a.id, classGroupId: g.id, name: "A" } })).rejects.toThrow(/Unique constraint/);
    await expect(db.classArm.create({ data: { tenantId: a.id, classGroupId: g.id, name: "B", capacity: 0 } })).rejects.toThrow(
      /check constraint|capacity/i,
    );
    await db.subject.create({ data: { tenantId: a.id, name: "S", code: "S1" } });
    await expect(db.subject.create({ data: { tenantId: a.id, name: "S2", code: "s1" } })).rejects.toThrow(/check constraint|code_shape/i);
    await expect(db.subject.create({ data: { tenantId: a.id, name: "S3", code: "S1" } })).rejects.toThrow(/Unique constraint/);
    await expect(db.subject.create({ data: { tenantId: a.id, name: "S" } })).rejects.toThrow(/Unique constraint/);
  });

  test("a request can never DELETE a group, an arm or a subject (no DELETE policy) — only an offering can be removed", async () => {
    const g = await group("Keep");
    const arm = await createArm(admin(), boss.id, g.id, { name: "A" });
    const s = await subject("Keep too");
    await setOfferings(admin(), boss.id, g.id, [s.id]);
    const removed = await forTenant(trustedTenantId(a.id)).transaction(async (tx) => ({
      arms: (await tx.classArm.deleteMany()).count,
      groups: (await tx.classGroup.deleteMany()).count,
      subjects: (await tx.subject.deleteMany()).count,
      offerings: (await tx.subjectOffering.deleteMany()).count,
    }));
    expect(removed).toEqual({ arms: 0, groups: 0, subjects: 0, offerings: 1 });
    expect(arm.ok && (await db.classArm.count({ where: { id: arm.arm.id } }))).toBe(1);
  });

  test("NOTHING references SubjectOffering yet — the day something does, this fails and forces archive-on-reference instead of a real delete", async () => {
    const inbound = await db.$queryRaw<{ child: string }[]>`
      SELECT con.conrelid::regclass::text AS child
        FROM pg_constraint con
       WHERE con.contype = 'f' AND con.confrelid = '"SubjectOffering"'::regclass`;
    expect(inbound).toEqual([]);
  });
});
