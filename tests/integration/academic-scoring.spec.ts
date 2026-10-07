import "../support/env";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { createClassGroup } from "@/lib/academics/classes";
import {
  archiveScheme,
  createScheme,
  getScheme,
  listSchemes,
  lockScheme,
  newSchemeVersion,
  snapshotOfScheme,
  updateScheme,
} from "@/lib/academics/assessment";
import {
  archiveScale,
  bandFor,
  createScale,
  getDefaultScale,
  getScale,
  listScales,
  lockScale,
  makeDefaultScale,
  newScaleVersion,
  updateScale,
} from "@/lib/academics/grading";

// Assessment schemes and grade scales in-process, as `app_user` (plan "Build design — Phase 1.0 and 1.1", decisions 14 and 15), plus the
// database's own refusal to change a LOCKED one — through the owner role too, whichever code writes.

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
const page = { skip: 0, take: 100 };
const actions = async (targetId: string) =>
  (await db.auditLog.findMany({ where: { tenantId: a.id, targetId }, orderBy: { createdAt: "asc" } })).map((r) => r.action);

const CA = [
  { name: "CA 1", maxScore: 20 },
  { name: "CA 2", maxScore: 20 },
];
async function scheme(
  name = "Standard",
  opts: { classGroupId?: string | null; school?: TestTenant; components?: typeof CA; examMax?: number } = {},
) {
  const result = await createScheme(admin(opts.school ?? a), boss.id, {
    name,
    classGroupId: opts.classGroupId ?? null,
    examMax: opts.examMax ?? 60,
    components: opts.components ?? CA,
  });
  if (!result.ok) throw new Error(`createScheme(${name}) refused: ${result.reason}`);
  return result.scheme;
}
async function group(name: string, campusId: string | null = null) {
  const result = await createClassGroup(admin(), boss.id, { campusId, name });
  if (!result.ok) throw new Error(`createClassGroup(${name}) refused: ${result.reason}`);
  return result.group;
}
const lock = (id: string, school: TestTenant = a) => admin(school).run((tx) => lockScheme(tx, school.id, id));
const lockS = (id: string, school: TestTenant = a) => admin(school).run((tx) => lockScale(tx, school.id, id));

const BANDS = [
  { min: 0, max: 40, letter: "F", remark: "Fail" },
  { min: 40, max: 70, letter: "C", remark: "Credit" },
  { min: 70, max: 100, letter: "A", remark: "Excellent" },
];
async function scale(name = "Standard scale", bands = BANDS, school: TestTenant = a) {
  const result = await createScale(admin(school), boss.id, { name, bands });
  if (!result.ok) throw new Error(`createScale(${name}) refused: ${result.reason}`);
  return result.scale;
}

test.describe("assessment schemes", () => {
  test("a scheme is created with cleaned names, components kept in the given order, and audited; invalid input is refused and writes nothing", async () => {
    const made = await createScheme(admin(), boss.id, {
      name: "  Primary   Scheme ",
      examMax: 70,
      components: [
        { name: " Test ", maxScore: 10 },
        { name: "Project", maxScore: 20 },
      ],
    });
    expect(made).toMatchObject({
      ok: true,
      scheme: {
        name: "Primary Scheme",
        totalMax: 100,
        examMax: 70,
        version: 1,
        locked: false,
        archived: false,
        classGroupId: null,
        supersedesId: null,
        components: [
          { name: "Test", maxScore: 10, sortOrder: 0 },
          { name: "Project", maxScore: 20, sortOrder: 1 },
        ],
      },
    });
    if (!made.ok) return;
    expect(await actions(made.scheme.id)).toEqual(["ASSESSMENT_SCHEME_CREATED"]);

    const bad = [
      [{ name: "" }, "INVALID_NAME"],
      [{ name: "x".repeat(61) }, "INVALID_NAME"],
      [{ name: "S2", components: [] }, "SCHEME_INVALID"],
      [{ name: "S2", components: [{ name: "CA", maxScore: 30 }] }, "SCHEME_INVALID"], // 30 + 60 != 100
      [
        {
          name: "S2",
          components: [
            { name: "CA", maxScore: 40 },
            { name: "ca", maxScore: 0 },
          ],
        },
        "SCHEME_INVALID",
      ],
      [{ name: "S2", components: [{ name: "CA", maxScore: 40.123 }] }, "SCHEME_INVALID"],
      [{ name: "S2", examMax: 101, components: [{ name: "CA", maxScore: 1 }] }, "SCHEME_INVALID"],
      [{ name: "S2", totalMax: 0, examMax: 0, components: [{ name: "CA", maxScore: 1 }] }, "SCHEME_INVALID"],
    ] as const;
    for (const [override, reason] of bad) {
      const input = Object.assign({ name: "S2", examMax: 60, components: CA }, override) as Parameters<typeof createScheme>[2];
      expect(await createScheme(admin(), boss.id, input), JSON.stringify(override)).toMatchObject({ ok: false, reason });
    }
    expect(await db.assessmentScheme.count({ where: { tenantId: a.id } })).toBe(1);
    expect(await db.assessmentComponent.count({ where: { tenantId: a.id } })).toBe(2);
  });

  test("the failure says which rule broke and where", async () => {
    expect(await createScheme(admin(), boss.id, { name: "S", examMax: 60, components: [{ name: "CA", maxScore: 30 }] })).toMatchObject({
      ok: false,
      reason: "SCHEME_INVALID",
      detail: { problem: "SUM_MISMATCH", sum: 90 },
    });
    expect(
      await createScheme(admin(), boss.id, {
        name: "S",
        examMax: 60,
        components: [
          { name: "CA", maxScore: 20 },
          { name: "Ca", maxScore: 20 },
        ],
      }),
    ).toMatchObject({ ok: false, detail: { problem: "COMPONENT_NAME_DUPLICATE", index: 1 } });
  });

  test("one LIVE scheme per scope and one live name per school; both free up once archived", async () => {
    const first = await scheme("Default");
    expect(await createScheme(admin(), boss.id, { name: "Other", examMax: 60, components: CA })).toMatchObject({
      ok: false,
      reason: "SCOPE_TAKEN",
    });
    const g1 = await group("JSS1");
    const g2 = await group("JSS2");
    await scheme("For JSS1", { classGroupId: g1.id });
    expect(await createScheme(admin(), boss.id, { name: "Default", classGroupId: g2.id, examMax: 60, components: CA })).toMatchObject({
      ok: false,
      reason: "NAME_TAKEN",
    });
    expect(await createScheme(admin(), boss.id, { name: "Again", classGroupId: g1.id, examMax: 60, components: CA })).toMatchObject({
      ok: false,
      reason: "SCOPE_TAKEN",
    });
    await archiveScheme(admin(), boss.id, first.id);
    expect((await createScheme(admin(), boss.id, { name: "Default", examMax: 60, components: CA })).ok).toBe(true);
  });

  test("a scheme for another school's class group, an archived one, or a made-up id is 'no such class'", async () => {
    const foreignGroup = await db.classGroup.create({ data: { tenantId: b.id, name: "Beta group" } });
    expect(await createScheme(admin(), boss.id, { name: "S", classGroupId: foreignGroup.id, examMax: 60, components: CA })).toMatchObject({
      ok: false,
      reason: "UNKNOWN_CLASS_GROUP",
    });
    expect(await createScheme(admin(), boss.id, { name: "S", classGroupId: "nope", examMax: 60, components: CA })).toMatchObject({
      ok: false,
      reason: "UNKNOWN_CLASS_GROUP",
    });
    const archived = await db.classGroup.create({ data: { tenantId: a.id, name: "Old", archivedAt: new Date() } });
    expect(await createScheme(admin(), boss.id, { name: "S", classGroupId: archived.id, examMax: 60, components: CA })).toMatchObject({
      ok: false,
      reason: "UNKNOWN_CLASS_GROUP",
    });
  });

  test("two simultaneous creates for one scope: exactly ONE succeeds (repeated)", async () => {
    for (let round = 0; round < 4; round++) {
      const g = await group(`Race ${round}`);
      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          createScheme(admin(), boss.id, { name: `Race ${round}.${n}`, classGroupId: g.id, examMax: 60, components: CA }),
        ),
      );
      expect(
        results.filter((r) => r.ok),
        `round ${round}`,
      ).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "SCOPE_TAKEN")).toBe(true);
    }
  });

  test("an unlocked scheme is edited in place: rename, change components and totals together; a no-op writes nothing; before/after audited", async () => {
    const s = await scheme("Edit me");
    expect(await updateScheme(admin(), boss.id, s.id, { name: "Edit me" })).toMatchObject({ ok: true, changed: false });
    expect(await actions(s.id)).toEqual(["ASSESSMENT_SCHEME_CREATED"]);
    const changed = await updateScheme(admin(), boss.id, s.id, {
      name: "Edited",
      examMax: 50,
      components: [
        { name: "Quiz", maxScore: 25 },
        { name: "Practical", maxScore: 25 },
      ],
    });
    expect(changed).toMatchObject({
      ok: true,
      changed: true,
      scheme: {
        name: "Edited",
        examMax: 50,
        components: [
          { name: "Quiz", sortOrder: 0 },
          { name: "Practical", sortOrder: 1 },
        ],
      },
    });
    expect(await actions(s.id)).toEqual(["ASSESSMENT_SCHEME_CREATED", "ASSESSMENT_SCHEME_UPDATED"]);
    const row = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, targetId: s.id, action: "ASSESSMENT_SCHEME_UPDATED" } });
    expect(JSON.stringify(row.beforeValue)).toContain("Edit me");
    expect(JSON.stringify(row.afterValue)).toContain("Edited");
    // the failed edit leaves the old components in place
    expect(await updateScheme(admin(), boss.id, s.id, { components: [{ name: "Only", maxScore: 1 }] })).toMatchObject({
      ok: false,
      reason: "SCHEME_INVALID",
    });
    expect((await getScheme(admin(), s.id)).ok && (await getScheme(admin(), s.id))).toMatchObject({
      scheme: { components: [{ name: "Quiz" }, { name: "Practical" }] },
    });
    expect(await updateScheme(admin(), boss.id, "nope", { name: "X" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });

  test("renaming onto a live name is refused; onto an archived scheme's name is fine", async () => {
    const g = await group("JSS1");
    const s1 = await scheme("One");
    const s2 = await scheme("Two", { classGroupId: g.id });
    expect(await updateScheme(admin(), boss.id, s2.id, { name: "One" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    await archiveScheme(admin(), boss.id, s1.id);
    expect(await updateScheme(admin(), boss.id, s2.id, { name: "One" })).toMatchObject({ ok: true, changed: true });
  });

  test("an archived scheme cannot be edited; archiving twice is a harmless no-op that writes nothing more", async () => {
    const s = await scheme("Gone");
    expect(await archiveScheme(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: true, scheme: { archived: true } });
    expect(await archiveScheme(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: false });
    expect(await updateScheme(admin(), boss.id, s.id, { name: "Back" })).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await newSchemeVersion(admin(), boss.id, s.id, {})).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await actions(s.id)).toEqual(["ASSESSMENT_SCHEME_CREATED", "ASSESSMENT_SCHEME_ARCHIVED"]);
  });

  test("locking is idempotent and returns whether THIS call locked it; a locked scheme refuses in-place edits and gets a new version instead", async () => {
    const s = await scheme("Locked");
    expect(await newSchemeVersion(admin(), boss.id, s.id, {})).toMatchObject({ ok: false, reason: "NOT_LOCKED" });
    expect(await lock(s.id)).toBe(true);
    expect(await lock(s.id)).toBe(false);
    expect(await lock("nope")).toBe(false);
    expect(await updateScheme(admin(), boss.id, s.id, { name: "Changed" })).toMatchObject({ ok: false, reason: "LOCKED" });

    const v2 = await newSchemeVersion(admin(), boss.id, s.id, {
      examMax: 50,
      components: [
        { name: "CA 1", maxScore: 25 },
        { name: "CA 2", maxScore: 25 },
      ],
    });
    expect(v2).toMatchObject({
      ok: true,
      scheme: { name: "Locked", version: 2, locked: false, supersedesId: s.id, examMax: 50, archived: false },
    });
    // the predecessor is archived and untouched; the successor took its scope
    const old = await getScheme(admin(), s.id);
    expect(old).toMatchObject({ ok: true, scheme: { archived: true, locked: true, version: 1, examMax: 60 } });
    expect(await actions(s.id)).toEqual(["ASSESSMENT_SCHEME_CREATED"]);
    if (v2.ok) expect(await actions(v2.scheme.id)).toEqual(["ASSESSMENT_SCHEME_NEW_VERSION"]);
    expect(await db.assessmentScheme.count({ where: { tenantId: a.id, archivedAt: null } })).toBe(1);
    // …and versions chain: lock v2, make v3
    if (!v2.ok) return;
    await lock(v2.scheme.id);
    expect(await newSchemeVersion(admin(), boss.id, v2.scheme.id, { name: "Locked v3" })).toMatchObject({
      ok: true,
      scheme: { version: 3, name: "Locked v3", supersedesId: v2.scheme.id },
    });
  });

  test("a new version that fails validation or takes another live name changes nothing (the predecessor stays live)", async () => {
    const g = await group("JSS1");
    const s = await scheme("Base");
    await scheme("Taken", { classGroupId: g.id });
    await lock(s.id);
    expect(await newSchemeVersion(admin(), boss.id, s.id, { components: [{ name: "Only", maxScore: 1 }] })).toMatchObject({
      ok: false,
      reason: "SCHEME_INVALID",
    });
    expect(await newSchemeVersion(admin(), boss.id, s.id, { name: "Taken" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    expect(await newSchemeVersion(admin(), boss.id, s.id, { name: "  " })).toMatchObject({ ok: false, reason: "INVALID_NAME" });
    expect(await getScheme(admin(), s.id)).toMatchObject({ ok: true, scheme: { archived: false, locked: true } });
    expect(await db.assessmentScheme.count({ where: { tenantId: a.id } })).toBe(2);
  });

  test("two simultaneous new versions of one locked scheme: exactly ONE succeeds", async () => {
    const s = await scheme("Versioned");
    await lock(s.id);
    const results = await Promise.all([1, 2, 3].map(() => newSchemeVersion(admin(), boss.id, s.id, { name: "Versioned" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.assessmentScheme.count({ where: { tenantId: a.id, archivedAt: null } })).toBe(1);
  });

  test("campus visibility: an ADMIN sees every scheme; staff see the school default and schemes of school-wide groups and of THEIR campus's groups", async () => {
    const def = await scheme("Default");
    const wide = await group("Wide");
    const gNorth = await group("North JSS", north());
    const gSouth = await group("South JSS", south());
    const sWide = await scheme("Wide scheme", { classGroupId: wide.id });
    const sNorth = await scheme("North scheme", { classGroupId: gNorth.id });
    const sSouth = await scheme("South scheme", { classGroupId: gSouth.id });
    const names = async (c: TenantAuthContext["tenant"]) =>
      (await listSchemes(c, { status: "live" }, page)).schemes.map((s) => s.name).sort();
    expect(await names(admin())).toEqual(["Default", "North scheme", "South scheme", "Wide scheme"]);
    expect(await names(ctx(a, "TEACHING_STAFF", north()))).toEqual(["Default", "North scheme", "Wide scheme"]);
    expect(await names(ctx(a, "TEACHING_STAFF", south()))).toEqual(["Default", "South scheme", "Wide scheme"]);
    expect(await names(ctx(a, "NON_TEACHING_STAFF", null))).toEqual(["Default", "Wide scheme"]);
    const northStaff = ctx(a, "TEACHING_STAFF", north());
    expect(await getScheme(northStaff, sSouth.id)).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await getScheme(northStaff, sNorth.id)).toMatchObject({ ok: true });
    expect(await getScheme(northStaff, sWide.id)).toMatchObject({ ok: true });
    expect(await getScheme(northStaff, def.id)).toMatchObject({ ok: true });
    // a member cannot WRITE to what they cannot see: it is "not found", not "forbidden"
    expect(await updateScheme(northStaff, boss.id, sSouth.id, { name: "X" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await archiveScheme(northStaff, boss.id, sSouth.id)).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await createScheme(northStaff, boss.id, { name: "N2", classGroupId: gSouth.id, examMax: 60, components: CA })).toMatchObject({
      ok: false,
      reason: "UNKNOWN_CLASS_GROUP",
    });
  });

  test("another school's scheme is invisible in lists and by id, for every operation", async () => {
    const theirs = await scheme("Theirs", { school: b });
    expect((await listSchemes(admin(), { status: "all" }, page)).schemes).toEqual([]);
    expect(await getScheme(admin(), theirs.id)).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await updateScheme(admin(), boss.id, theirs.id, { name: "Mine" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await archiveScheme(admin(), boss.id, theirs.id)).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await newSchemeVersion(admin(), boss.id, theirs.id, {})).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await admin().run((tx) => lockScheme(tx, a.id, theirs.id))).toBe(false);
    expect((await db.assessmentScheme.findUniqueOrThrow({ where: { id: theirs.id } })).lockedAt).toBeNull();
  });

  test("list: status filter, class-group filter, paging with a stable order and a true total", async () => {
    const g = await group("JSS1");
    const s1 = await scheme("Alpha");
    await scheme("Beta", { classGroupId: g.id });
    await lock(s1.id);
    await newSchemeVersion(admin(), boss.id, s1.id, { name: "Alpha" });
    expect((await listSchemes(admin(), { status: "live" }, page)).total).toBe(2);
    expect((await listSchemes(admin(), { status: "archived" }, page)).total).toBe(1);
    expect((await listSchemes(admin(), { status: "all" }, page)).total).toBe(3);
    expect((await listSchemes(admin(), { status: "all", classGroupId: g.id }, page)).schemes.map((s) => s.name)).toEqual(["Beta"]);
    const first = await listSchemes(admin(), { status: "all" }, { skip: 0, take: 2 });
    const second = await listSchemes(admin(), { status: "all" }, { skip: 2, take: 2 });
    expect(first.total).toBe(3);
    expect(first.schemes).toHaveLength(2);
    expect(second.schemes).toHaveLength(1);
    expect(new Set([...first.schemes, ...second.schemes].map((s) => s.id)).size).toBe(3);
    // same name, newest version first
    expect(first.schemes.filter((s) => s.name === "Alpha").map((s) => s.version)).toEqual([2, 1]);
  });

  test("the snapshot is canonical: same bytes for the same scheme, a different hash when anything differs, ids and times are not part of it", async () => {
    const s1 = await scheme("Snap", { components: [{ name: "CA", maxScore: 40 }] });
    const got = await getScheme(admin(), s1.id);
    if (!got.ok) throw new Error("not found");
    expect(got.snapshot.json).toBe('{"totalMax":"100.00","examMax":"60.00","components":[{"name":"CA","maxScore":"40.00"}]}');
    expect(got.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    const fromDb = await admin().run((tx) => snapshotOfScheme(tx, a.id, s1.id));
    expect(fromDb).toEqual(got.snapshot);
    await lock(s1.id);
    const v2 = await newSchemeVersion(admin(), boss.id, s1.id, { name: "Renamed" });
    if (!v2.ok) throw new Error("no v2");
    // a new version with the same numbers has the SAME snapshot (the name, ids and version are not in it)
    expect(await admin().run((tx) => snapshotOfScheme(tx, a.id, v2.scheme.id))).toEqual(got.snapshot);
    await lock(v2.scheme.id);
    const v3 = await newSchemeVersion(admin(), boss.id, v2.scheme.id, { components: [{ name: "CA", maxScore: 30 }], examMax: 70 });
    if (!v3.ok) throw new Error("no v3");
    const other = await admin().run((tx) => snapshotOfScheme(tx, a.id, v3.scheme.id));
    expect(other?.sha256).not.toBe(got.snapshot.sha256);
    expect(await admin().run((tx) => snapshotOfScheme(tx, a.id, "nope"))).toBeNull();
    expect(await admin().run((tx) => snapshotOfScheme(tx, b.id, s1.id))).toBeNull();
  });
});

test.describe("a LOCKED scheme is immutable in the database itself", () => {
  test("the owner role cannot rename it, change its totals, scope or version, or unlock it; archiving (and only that) is still allowed", async () => {
    const g = await group("JSS1");
    const s = await scheme("Frozen", { classGroupId: g.id });
    await lock(s.id);
    for (const change of [
      `"name" = 'Hacked'`,
      `"totalMax" = 200`,
      `"examMax" = 10`,
      `"version" = 9`,
      `"classGroupId" = NULL`,
      `"lockedAt" = NULL`,
      `"supersedesId" = '${s.id}'`,
    ]) {
      await expect(db.$executeRawUnsafe(`UPDATE "AssessmentScheme" SET ${change} WHERE "id" = $1`, s.id), change).rejects.toThrow(/locked/);
    }
    const row = await db.assessmentScheme.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ name: "Frozen", version: 1 });
    expect(await db.$executeRawUnsafe(`UPDATE "AssessmentScheme" SET "archivedAt" = now() WHERE "id" = $1`, s.id)).toBe(1);
  });

  test("its components cannot be added, changed or removed — as app_user or as the owner — and a SIBLING unlocked scheme is unaffected", async () => {
    const g = await group("JSS1");
    const s = await scheme("Frozen");
    const free = await scheme("Free", { classGroupId: g.id });
    await lock(s.id);
    const component = await db.assessmentComponent.findFirstOrThrow({ where: { schemeId: s.id } });
    await expect(db.$executeRawUnsafe(`UPDATE "AssessmentComponent" SET "maxScore" = 1 WHERE "id" = $1`, component.id)).rejects.toThrow(
      /locked/,
    );
    await expect(db.$executeRawUnsafe(`DELETE FROM "AssessmentComponent" WHERE "id" = $1`, component.id)).rejects.toThrow(/locked/);
    await expect(
      db.assessmentComponent.create({ data: { tenantId: a.id, schemeId: s.id, name: "Late", maxScore: 1, sortOrder: 5 } }),
    ).rejects.toThrow(/locked/);
    await expect(admin().run((tx) => tx.assessmentComponent.deleteMany({ where: { schemeId: s.id } }))).rejects.toThrow(/locked/);
    await expect(
      admin().run((tx) =>
        tx.assessmentComponent.createMany({ data: [{ tenantId: a.id, schemeId: s.id, name: "Late", maxScore: 1, sortOrder: 5 }] }),
      ),
    ).rejects.toThrow(/locked/);
    expect(await db.assessmentComponent.count({ where: { schemeId: s.id } })).toBe(2);
    expect(await updateScheme(admin(), boss.id, free.id, { name: "Free 2" })).toMatchObject({ ok: true, changed: true });
  });

  test("deleting a whole school still works when it holds locked schemes (the cascade is the one allowed removal)", async () => {
    const c = await createTenant({ name: "Short Lived", campuses: [] });
    const s = await scheme("Locked there", { school: c });
    await lock(s.id, c);
    expect(await db.assessmentComponent.count({ where: { tenantId: c.id } })).toBe(2);
    await db.tenant.deleteMany({ where: { id: c.id } });
    expect(await db.assessmentScheme.count({ where: { tenantId: c.id } })).toBe(0);
    expect(await db.assessmentComponent.count({ where: { tenantId: c.id } })).toBe(0);
  });
});

test.describe("database rules a bypassing writer still meets", () => {
  test("totals, component maximums and names are CHECKed; a component name is unique per scheme ignoring case", async () => {
    const s = await scheme("Rules");
    await expect(db.assessmentScheme.create({ data: { tenantId: a.id, name: "Bad", totalMax: 0, examMax: 0 } })).rejects.toThrow(
      /AssessmentScheme_totals/,
    );
    await expect(db.assessmentScheme.create({ data: { tenantId: a.id, name: "Bad", totalMax: 50, examMax: 60 } })).rejects.toThrow(
      /AssessmentScheme_totals/,
    );
    await expect(db.assessmentScheme.create({ data: { tenantId: a.id, name: "   ", examMax: 1 } })).rejects.toThrow(
      /AssessmentScheme_name_not_blank/,
    );
    await expect(
      db.assessmentComponent.create({ data: { tenantId: a.id, schemeId: "x", name: "CA", maxScore: 0, sortOrder: 0 } }),
    ).rejects.toThrow();
    const free = await scheme("Rules free", { classGroupId: (await group("JSS1")).id });
    await expect(
      db.assessmentComponent.create({ data: { tenantId: a.id, schemeId: free.id, name: "ca 1", maxScore: 1, sortOrder: 9 } }),
    ).rejects.toThrow(/Unique constraint/);
    await expect(
      db.assessmentComponent.create({ data: { tenantId: a.id, schemeId: free.id, name: "Zero", maxScore: 0, sortOrder: 9 } }),
    ).rejects.toThrow(/AssessmentComponent_max_positive/);
    void s;
  });

  test("a scheme cannot point at another school's class group, nor a component at another school's scheme (composite foreign keys)", async () => {
    const theirGroup = await db.classGroup.create({ data: { tenantId: b.id, name: "Beta group" } });
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "AssessmentScheme" ("id","tenantId","classGroupId","name","examMax") VALUES ('x1', $1, $2, 'Cross', 60)`,
        a.id,
        theirGroup.id,
      ),
    ).rejects.toThrow(/foreign key/i);
    const theirs = await scheme("Theirs", { school: b });
    await expect(
      db.assessmentComponent.create({ data: { tenantId: a.id, schemeId: theirs.id, name: "Cross", maxScore: 5, sortOrder: 7 } }),
    ).rejects.toThrow(/foreign key/i);
  });
});

test.describe("grade scales", () => {
  test("a scale is created with trimmed text and bands in score order; the FIRST live scale becomes the default, later ones do not; audited", async () => {
    const first = await createScale(admin(), boss.id, {
      name: "  Main   scale ",
      bands: [
        { min: 70, max: 100, letter: " A ", remark: " Excellent  work " },
        { min: 0, max: 40, letter: "F", remark: "Fail" },
        { min: 40, max: 70, letter: "C", remark: "Credit" },
      ],
    });
    expect(first).toMatchObject({
      ok: true,
      scale: {
        name: "Main scale",
        isDefault: true,
        version: 1,
        locked: false,
        archived: false,
        bands: [
          { min: 0, max: 40, letter: "F", sortOrder: 0 },
          { min: 40, max: 70, letter: "C", sortOrder: 1 },
          { min: 70, max: 100, letter: "A", remark: "Excellent work", sortOrder: 2 },
        ],
      },
    });
    const second = await scale("Second");
    expect(second.isDefault).toBe(false);
    if (first.ok) expect(await actions(first.scale.id)).toEqual(["GRADE_SCALE_CREATED"]);
  });

  test("invalid bands are refused with the rule and the band index, and nothing is written", async () => {
    const cases: [typeof BANDS, string, number | undefined][] = [
      [[], "NO_BANDS", undefined],
      [[{ min: 10, max: 100, letter: "A", remark: "A" }], "STARTS_ABOVE_ZERO", 0],
      [[{ min: 0, max: 90, letter: "A", remark: "A" }], "ENDS_BELOW_HUNDRED", 0],
      [
        [
          { min: 0, max: 50, letter: "F", remark: "F" },
          { min: 60, max: 100, letter: "P", remark: "P" },
        ],
        "GAP",
        1,
      ],
      [
        [
          { min: 0, max: 60, letter: "F", remark: "F" },
          { min: 50, max: 100, letter: "P", remark: "P" },
        ],
        "OVERLAP",
        1,
      ],
      [
        [
          { min: 0, max: 50, letter: "A", remark: "F" },
          { min: 50, max: 100, letter: "a", remark: "P" },
        ],
        "LETTER_DUPLICATE",
        1,
      ],
      [[{ min: 0, max: 100.123, letter: "A", remark: "A" }], "PRECISION", 0],
      [[{ min: 0, max: 100, letter: "", remark: "A" }], "LETTER_INVALID", 0],
      [[{ min: 0, max: 100, letter: "A", remark: "" }], "REMARK_INVALID", 0],
    ];
    for (const [bands, problem, index] of cases) {
      const result = await createScale(admin(), boss.id, { name: "Bad", bands });
      expect(result, problem).toMatchObject({
        ok: false,
        reason: "BANDS_INVALID",
        detail: { problem, ...(index === undefined ? {} : { index }) },
      });
    }
    expect(await createScale(admin(), boss.id, { name: "", bands: BANDS })).toMatchObject({ ok: false, reason: "INVALID_NAME" });
    expect(await db.gradeScale.count({ where: { tenantId: a.id } })).toBe(0);
    expect(await db.gradeBand.count({ where: { tenantId: a.id } })).toBe(0);
  });

  test("a live name is unique per school (free after archive); two simultaneous first scales leave exactly ONE default", async () => {
    await scale("Same");
    expect(await createScale(admin(), boss.id, { name: "Same", bands: BANDS })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    const results = await Promise.all([1, 2, 3, 4].map((n) => createScale(admin(b), boss.id, { name: `Race ${n}`, bands: BANDS })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await db.gradeScale.count({ where: { tenantId: b.id, isDefault: true, archivedAt: null } })).toBe(1);
  });

  test("bands map every score to exactly one band: boundaries belong to the UPPER band, 100 to the top one, nothing outside 0–100", async () => {
    const s = await scale();
    const at = (score: number) => bandFor(s, score)?.letter ?? null;
    expect([0, 39.99, 40, 69.99, 70, 99.99, 100].map(at)).toEqual(["F", "F", "C", "C", "A", "A", "A"]);
    expect([-0.01, 100.01, Number.NaN, 0.1 + 0.2].map(at)).toEqual([null, null, null, null]);
    expect(at(0.3)).toBe("F");
    // every hundredth from 0.00 to 100.00 lands in exactly one band
    for (let h = 0; h <= 10000; h += 7) expect(at(h / 100), String(h / 100)).not.toBeNull();
  });

  test("the default scale is found by getDefaultScale; make-default swaps in one transaction, is a no-op on the current default, and refuses archived or unknown ones", async () => {
    expect(await getDefaultScale(admin())).toBeNull();
    const one = await scale("One");
    const two = await scale("Two");
    expect((await getDefaultScale(admin()))?.id).toBe(one.id);
    expect(await makeDefaultScale(admin(), boss.id, one.id)).toMatchObject({ ok: true, changed: false });
    expect(await makeDefaultScale(admin(), boss.id, two.id)).toMatchObject({ ok: true, changed: true, scale: { isDefault: true } });
    expect((await getDefaultScale(admin()))?.id).toBe(two.id);
    expect(await getScale(admin(), one.id)).toMatchObject({ ok: true, scale: { isDefault: false } });
    expect(await db.gradeScale.count({ where: { tenantId: a.id, isDefault: true } })).toBe(1);
    expect(await actions(two.id)).toEqual(["GRADE_SCALE_CREATED", "GRADE_SCALE_DEFAULT_CHANGED"]);
    expect(await makeDefaultScale(admin(), boss.id, "nope")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    await archiveScale(admin(), boss.id, one.id);
    expect(await makeDefaultScale(admin(), boss.id, one.id)).toMatchObject({ ok: false, reason: "ARCHIVED" });
    const theirs = await scale("Theirs", BANDS, b);
    expect(await makeDefaultScale(admin(), boss.id, theirs.id)).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect((await getDefaultScale(admin()))?.id).toBe(two.id);
  });

  test("simultaneous make-default calls leave exactly ONE default", async () => {
    await scale("One");
    const others = [await scale("Two"), await scale("Three"), await scale("Four")];
    await Promise.all(others.map((s) => makeDefaultScale(admin(), boss.id, s.id)));
    expect(await db.gradeScale.count({ where: { tenantId: a.id, isDefault: true, archivedAt: null } })).toBe(1);
  });

  test("the DEFAULT scale cannot be archived (make another the default first); a non-default can, and archiving twice is a no-op", async () => {
    const one = await scale("One");
    const two = await scale("Two");
    expect(await archiveScale(admin(), boss.id, one.id)).toMatchObject({ ok: false, reason: "DEFAULT_CANNOT_ARCHIVE" });
    expect(await archiveScale(admin(), boss.id, two.id)).toMatchObject({ ok: true, changed: true, scale: { archived: true } });
    expect(await archiveScale(admin(), boss.id, two.id)).toMatchObject({ ok: true, changed: false });
    expect(await archiveScale(admin(), boss.id, "nope")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await getDefaultScale(admin())).toMatchObject({ id: one.id });
  });

  test("an unlocked scale is edited in place (bands replaced and revalidated); a no-op writes nothing; a failed edit keeps the old bands", async () => {
    const s = await scale("Edit me");
    expect(await updateScale(admin(), boss.id, s.id, { name: "Edit me" })).toMatchObject({ ok: true, changed: false });
    const changed = await updateScale(admin(), boss.id, s.id, {
      name: "Pass / fail",
      bands: [
        { min: 0, max: 50, letter: "F", remark: "Fail" },
        { min: 50, max: 100, letter: "P", remark: "Pass" },
      ],
    });
    expect(changed).toMatchObject({ ok: true, changed: true, scale: { name: "Pass / fail", bands: [{ letter: "F" }, { letter: "P" }] } });
    expect(await updateScale(admin(), boss.id, s.id, { bands: [{ min: 0, max: 60, letter: "F", remark: "x" }] })).toMatchObject({
      ok: false,
      reason: "BANDS_INVALID",
    });
    expect(await getScale(admin(), s.id)).toMatchObject({ ok: true, scale: { bands: [{ letter: "F" }, { letter: "P" }] } });
    expect(await actions(s.id)).toEqual(["GRADE_SCALE_CREATED", "GRADE_SCALE_UPDATED"]);
    expect(await updateScale(admin(), boss.id, "nope", { name: "X" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    const two = await scale("Two");
    expect(await updateScale(admin(), boss.id, two.id, { name: "Pass / fail" })).toMatchObject({ ok: false, reason: "NAME_TAKEN" });
    await archiveScale(admin(), boss.id, two.id);
    expect(await updateScale(admin(), boss.id, two.id, { name: "Two b" })).toMatchObject({ ok: false, reason: "ARCHIVED" });
  });

  test("a locked scale refuses in-place edits; a new version copies it (with changes), archives it, and takes over the DEFAULT flag", async () => {
    const s = await scale("Locked");
    expect(await newScaleVersion(admin(), boss.id, s.id, {})).toMatchObject({ ok: false, reason: "NOT_LOCKED" });
    expect(await lockS(s.id)).toBe(true);
    expect(await lockS(s.id)).toBe(false);
    expect(await lockS("nope")).toBe(false);
    expect(await updateScale(admin(), boss.id, s.id, { name: "Changed" })).toMatchObject({ ok: false, reason: "LOCKED" });
    const v2 = await newScaleVersion(admin(), boss.id, s.id, {
      bands: [
        { min: 0, max: 45, letter: "F", remark: "Fail" },
        { min: 45, max: 100, letter: "P", remark: "Pass" },
      ],
    });
    expect(v2).toMatchObject({
      ok: true,
      scale: { name: "Locked", version: 2, isDefault: true, locked: false, supersedesId: s.id, bands: [{ max: 45 }, { min: 45 }] },
    });
    expect(await getScale(admin(), s.id)).toMatchObject({
      ok: true,
      scale: { archived: true, locked: true, isDefault: false, version: 1, bands: [{ max: 40 }, { max: 70 }, { max: 100 }] },
    });
    expect((await getDefaultScale(admin()))?.id).toBe(v2.ok ? v2.scale.id : "");
    if (v2.ok) expect(await actions(v2.scale.id)).toEqual(["GRADE_SCALE_NEW_VERSION"]);
    // a failed new version leaves the predecessor live and the default in place
    if (!v2.ok) return;
    await lockS(v2.scale.id);
    expect(await newScaleVersion(admin(), boss.id, v2.scale.id, { bands: [{ min: 0, max: 10, letter: "F", remark: "x" }] })).toMatchObject({
      ok: false,
      reason: "BANDS_INVALID",
    });
    expect((await getDefaultScale(admin()))?.id).toBe(v2.scale.id);
  });

  test("a new version of a NON-default scale is not the default; two simultaneous new versions of one locked scale: exactly ONE succeeds", async () => {
    await scale("Default");
    const s = await scale("Other");
    await lockS(s.id);
    const results = await Promise.all([1, 2, 3].map(() => newScaleVersion(admin(), boss.id, s.id, { name: "Other" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = results.find((r) => r.ok);
    expect(winner).toMatchObject({ scale: { isDefault: false, version: 2 } });
    expect(await db.gradeScale.count({ where: { tenantId: a.id, archivedAt: null } })).toBe(2);
  });

  test("list: default first, status filter, paging with a true total; another school's scales never appear", async () => {
    const one = await scale("Bravo");
    await scale("Alpha");
    await scale("Theirs", BANDS, b);
    await lockS(one.id);
    await newScaleVersion(admin(), boss.id, one.id, {});
    const live = await listScales(admin(), { status: "live" }, page);
    expect(live.scales.map((s) => s.name)).toEqual(["Bravo", "Alpha"]); // the default (Bravo v2) first
    expect(live.total).toBe(2);
    expect((await listScales(admin(), { status: "archived" }, page)).total).toBe(1);
    const all = await listScales(admin(), { status: "all" }, { skip: 0, take: 2 });
    expect(all.total).toBe(3);
    expect(all.scales).toHaveLength(2);
    expect(await getScale(admin(), (await db.gradeScale.findFirstOrThrow({ where: { tenantId: b.id } })).id)).toMatchObject({
      ok: false,
      reason: "NOT_FOUND",
    });
  });
});

test.describe("a LOCKED grade scale is immutable in the database itself", () => {
  test("the owner cannot rename, renumber or unlock it, nor touch its bands; archiving is still allowed; a school delete still cascades", async () => {
    const s = await scale("Frozen");
    await lockS(s.id);
    for (const change of [`"name" = 'Hacked'`, `"version" = 9`, `"lockedAt" = NULL`, `"supersedesId" = '${s.id}'`]) {
      await expect(db.$executeRawUnsafe(`UPDATE "GradeScale" SET ${change} WHERE "id" = $1`, s.id), change).rejects.toThrow(/locked/);
    }
    const band = await db.gradeBand.findFirstOrThrow({ where: { scaleId: s.id } });
    await expect(db.$executeRawUnsafe(`UPDATE "GradeBand" SET "letter" = 'Z' WHERE "id" = $1`, band.id)).rejects.toThrow(/locked/);
    await expect(db.$executeRawUnsafe(`DELETE FROM "GradeBand" WHERE "id" = $1`, band.id)).rejects.toThrow(/locked/);
    await expect(
      db.gradeBand.create({ data: { tenantId: a.id, scaleId: s.id, minScore: 0, maxScore: 1, letter: "Q", remark: "Q", sortOrder: 9 } }),
    ).rejects.toThrow(/locked/);
    await expect(admin().run((tx) => tx.gradeBand.deleteMany({ where: { scaleId: s.id } }))).rejects.toThrow(/locked/);
    expect(await db.gradeBand.count({ where: { scaleId: s.id } })).toBe(3);
    expect(await db.$executeRawUnsafe(`UPDATE "GradeScale" SET "isDefault" = false, "archivedAt" = now() WHERE "id" = $1`, s.id)).toBe(1);

    const c = await createTenant({ name: "Short Lived", campuses: [] });
    const cs = await scale("Locked there", BANDS, c);
    await lockS(cs.id, c);
    await db.tenant.deleteMany({ where: { id: c.id } });
    expect(await db.gradeScale.count({ where: { tenantId: c.id } })).toBe(0);
    expect(await db.gradeBand.count({ where: { tenantId: c.id } })).toBe(0);
  });

  test("a bypassing writer still meets the band CHECKs, the unique live default and the unique letter per scale", async () => {
    const one = await scale("One");
    const two = await scale("Two");
    await expect(
      db.gradeBand.create({
        data: { tenantId: a.id, scaleId: two.id, minScore: 50, maxScore: 50, letter: "Q", remark: "Q", sortOrder: 9 },
      }),
    ).rejects.toThrow(/GradeBand_range/);
    await expect(
      db.gradeBand.create({
        data: { tenantId: a.id, scaleId: two.id, minScore: 0, maxScore: 101, letter: "Q", remark: "Q", sortOrder: 9 },
      }),
    ).rejects.toThrow();
    await expect(
      db.gradeBand.create({
        data: { tenantId: a.id, scaleId: two.id, minScore: 0, maxScore: 1, letter: "f", remark: "dup", sortOrder: 9 },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await expect(db.gradeScale.update({ where: { id: two.id }, data: { isDefault: true } })).rejects.toThrow(/Unique constraint/);
    void one;
  });
});
