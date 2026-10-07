import "../support/env";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { archiveStudent, createStudent } from "@/lib/people/students";
import {
  addGuardian,
  archiveGuardian,
  getGuardian,
  listGuardians,
  listLinks,
  removeLink,
  restoreGuardian,
  updateGuardian,
  updateLink,
} from "@/lib/people/guardians";

// Guardians and their links to students in-process, as `app_user` (plan "Build design — Phase 1.2", reconciliation 4 and decision P6).

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

let n = 0;
async function pupil(over: Record<string, unknown> = {}, school: TestTenant = a) {
  const result = await createStudent(
    admin(school),
    boss.id,
    { firstName: `Pupil${++n}`, lastName: "Okoro", dateOfBirth: "2012-05-01", ...over },
    NOW,
  );
  if (!result.ok) throw new Error(`createStudent refused: ${result.reason}`);
  return result.student;
}
const NEW = { firstName: "Gbenga", lastName: "Okoro", phone: "08031234567", email: "gbenga@example.com", relationship: "FATHER" };
async function link(studentId: string, input: Record<string, unknown> = NEW, school: TestTenant = a) {
  const result = await addGuardian(admin(school), boss.id, studentId, input as Parameters<typeof addGuardian>[3]);
  if (!result.ok) throw new Error(`addGuardian refused: ${result.reason} ${JSON.stringify(result.detail ?? {})}`);
  return result;
}
const actions = async (targetId: string) =>
  (await db.auditLog.findMany({ where: { tenantId: a.id, targetId }, orderBy: { createdAt: "asc" } })).map((r) => r.action);
const livePrimaries = (studentId: string) => db.guardianLink.count({ where: { studentId, isPrimary: true, status: { not: "REVOKED" } } });
const page = { skip: 0, take: 100 };

test.describe("adding a guardian", () => {
  test("a new guardian is created and linked as the primary contact, APPROVED; the audit trail holds ids and relationship, never the phone or email", async () => {
    const s = await pupil();
    const made = await link(s.id);
    expect(made).toMatchObject({
      createdGuardian: true,
      reactivated: false,
      link: {
        relationship: "FATHER",
        isPrimary: true,
        status: "APPROVED",
        guardian: { firstName: "Gbenga", phone: "08031234567", email: "gbenga@example.com", studentCount: 1 },
      },
    });
    expect(await actions(made.link.id)).toEqual(["GUARDIAN_LINKED"]);
    expect(await actions(made.link.guardian.id)).toEqual(["GUARDIAN_CREATED"]);
    const entries = await db.auditLog.findMany({ where: { tenantId: a.id, targetId: { in: [made.link.id, made.link.guardian.id] } } });
    expect(JSON.stringify(entries)).not.toContain("08031234567");
    expect(JSON.stringify(entries)).not.toContain("gbenga@example.com");
    expect((await db.guardianLink.findUniqueOrThrow({ where: { id: made.link.id } })).approvedById).toBe(boss.id);
    // the second guardian is not primary unless asked
    const second = await link(s.id, { firstName: "Mary", lastName: "Okoro", relationship: "MOTHER" });
    expect(second.link).toMatchObject({ isPrimary: false, guardian: { phone: null, email: null } });
    expect(await livePrimaries(s.id)).toBe(1);
  });

  test("asking for primary demotes the current one in the same transaction; two such requests at once still leave exactly one primary", async () => {
    const s = await pupil();
    const first = await link(s.id);
    const second = await link(s.id, { firstName: "Mary", lastName: "Okoro", relationship: "MOTHER", isPrimary: true });
    expect(second.link.isPrimary).toBe(true);
    expect((await db.guardianLink.findUniqueOrThrow({ where: { id: first.link.id } })).isPrimary).toBe(false);
    const results = await Promise.all(
      ["Uncle", "Aunt", "Cousin"].map((firstName) =>
        addGuardian(admin(), boss.id, s.id, { firstName, lastName: "Okoro", relationship: "OTHER", isPrimary: true }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await livePrimaries(s.id)).toBe(1);
    expect(await db.guardianLink.count({ where: { studentId: s.id } })).toBe(5);
  });

  test("bad input is refused naming the field, and writes nothing — not even the guardian record that would have been created", async () => {
    const s = await pupil();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...NEW, relationship: "UNCLE" }, "relationship"],
      [{ ...NEW, relationship: undefined }, "relationship"],
      [{ ...NEW, firstName: "" }, "firstName"],
      [{ ...NEW, lastName: "x".repeat(81) }, "lastName"],
      [{ ...NEW, phone: "123" }, "phone"],
      [{ ...NEW, email: "not-an-email" }, "email"],
      [{ relationship: "FATHER" }, "guardianId"], // neither an existing guardian nor a new one
      [{ ...NEW, guardianId: "some-id" }, "guardianId"], // both
    ];
    for (const [input, field] of cases) {
      expect(await addGuardian(admin(), boss.id, s.id, input as Parameters<typeof addGuardian>[3]), JSON.stringify(input)).toMatchObject({
        ok: false,
        reason: "INVALID",
        detail: { field },
      });
    }
    expect(await db.guardianRecord.count({ where: { tenantId: a.id } })).toBe(0);
    expect(await db.guardianLink.count({ where: { tenantId: a.id } })).toBe(0);
  });

  test("an existing guardian can be linked to a sibling (one person, two children); the same twice is ALREADY_LINKED; unknown, foreign and archived guardians are INVALID_GUARDIAN", async () => {
    const one = await pupil();
    const two = await pupil();
    const parent = (await link(one.id)).link.guardian;
    const sibling = await addGuardian(admin(), boss.id, two.id, { guardianId: parent.id, relationship: "FATHER" });
    expect(sibling).toMatchObject({
      ok: true,
      createdGuardian: false,
      link: { isPrimary: true, guardian: { id: parent.id, studentCount: 2 } },
    });
    expect(await db.guardianRecord.count({ where: { tenantId: a.id } })).toBe(1);
    expect(await addGuardian(admin(), boss.id, two.id, { guardianId: parent.id, relationship: "MOTHER" })).toMatchObject({
      ok: false,
      reason: "ALREADY_LINKED",
    });

    const foreign = await link((await pupil({}, b)).id, NEW, b);
    expect(await addGuardian(admin(), boss.id, one.id, { guardianId: foreign.link.guardian.id, relationship: "OTHER" })).toMatchObject({
      ok: false,
      reason: "INVALID_GUARDIAN",
    });
    expect(await addGuardian(admin(), boss.id, one.id, { guardianId: "nope", relationship: "OTHER" })).toMatchObject({
      ok: false,
      reason: "INVALID_GUARDIAN",
    });
    const loner = await link((await pupil()).id, { firstName: "Old", lastName: "Contact", relationship: "OTHER" });
    await removeLink(
      admin(),
      boss.id,
      (await db.guardianLink.findFirstOrThrow({ where: { guardianId: loner.link.guardian.id } })).studentId,
      loner.link.id,
    );
    expect(await archiveGuardian(admin(), boss.id, loner.link.guardian.id)).toMatchObject({ ok: true });
    expect(await addGuardian(admin(), boss.id, one.id, { guardianId: loner.link.guardian.id, relationship: "OTHER" })).toMatchObject({
      ok: false,
      reason: "INVALID_GUARDIAN",
    });
    expect(await db.guardianLink.count({ where: { studentId: one.id } })).toBe(1);
  });

  test("an archived or unknown student, or another school's, is refused (ARCHIVED / NOT_FOUND) before anything is created", async () => {
    const s = await pupil();
    await archiveStudent(admin(), boss.id, s.id);
    expect(await addGuardian(admin(), boss.id, s.id, NEW)).toMatchObject({ ok: false, reason: "ARCHIVED" });
    const foreignStudent = await pupil({}, b);
    expect(await addGuardian(admin(), boss.id, foreignStudent.id, NEW)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await addGuardian(admin(), boss.id, "nope", NEW)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await db.guardianRecord.count({ where: { tenantId: { in: [a.id, b.id] } } })).toBe(0);
  });
});

test.describe("changing and removing links", () => {
  test("relationship and primary can change; making another primary swaps; a no-op writes nothing; a student may be left with no primary", async () => {
    const s = await pupil();
    const dad = (await link(s.id)).link;
    const mum = (await link(s.id, { firstName: "Mary", lastName: "Okoro", relationship: "MOTHER" })).link;
    expect(await updateLink(admin(), boss.id, s.id, dad.id, { relationship: "FATHER", isPrimary: true })).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(await updateLink(admin(), boss.id, s.id, mum.id, { isPrimary: true })).toMatchObject({
      ok: true,
      changed: true,
      link: { isPrimary: true },
    });
    expect((await db.guardianLink.findUniqueOrThrow({ where: { id: dad.id } })).isPrimary).toBe(false);
    expect(await updateLink(admin(), boss.id, s.id, dad.id, { relationship: "GUARDIAN" })).toMatchObject({
      ok: true,
      link: { relationship: "GUARDIAN", isPrimary: false },
    });
    expect(await updateLink(admin(), boss.id, s.id, mum.id, { isPrimary: false })).toMatchObject({ ok: true, changed: true });
    expect(await livePrimaries(s.id)).toBe(0);
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: dad.id, action: "GUARDIAN_LINK_UPDATED" } });
    expect(entry.beforeValue).toMatchObject({ relationship: "FATHER", isPrimary: false });
    expect(entry.afterValue).toMatchObject({ relationship: "GUARDIAN" });
    expect(await updateLink(admin(), boss.id, s.id, dad.id, { relationship: "UNCLE" })).toMatchObject({
      ok: false,
      reason: "INVALID",
      detail: { field: "relationship" },
    });
    expect(await updateLink(admin(), boss.id, s.id, dad.id, { isPrimary: "yes" })).toMatchObject({
      ok: false,
      reason: "INVALID",
      detail: { field: "isPrimary" },
    });
    const other = await pupil();
    expect(await updateLink(admin(), boss.id, other.id, dad.id, { relationship: "OTHER" })).toEqual({ ok: false, reason: "NOT_FOUND" }); // someone else's link
  });

  test("removing revokes the link (kept for history), clears primary, is idempotent, and the same guardian can be linked again into the SAME row", async () => {
    const s = await pupil();
    const dad = (await link(s.id)).link;
    expect(await removeLink(admin(), boss.id, s.id, dad.id)).toEqual({ ok: true, changed: true });
    expect(await db.guardianLink.findUniqueOrThrow({ where: { id: dad.id } })).toMatchObject({ status: "REVOKED", isPrimary: false });
    expect((await db.guardianLink.findUniqueOrThrow({ where: { id: dad.id } })).revokedAt).not.toBeNull();
    expect(await removeLink(admin(), boss.id, s.id, dad.id)).toEqual({ ok: true, changed: false });
    expect(await actions(dad.id)).toEqual(["GUARDIAN_LINKED", "GUARDIAN_LINK_REMOVED"]);
    const listed = await listLinks(admin(), s.id);
    expect(listed).toEqual({ ok: true, links: [] });
    expect(await updateLink(admin(), boss.id, s.id, dad.id, { relationship: "OTHER" })).toEqual({ ok: false, reason: "NOT_FOUND" }); // a removed link cannot be edited
    const back = await addGuardian(admin(), boss.id, s.id, { guardianId: dad.guardian.id, relationship: "GUARDIAN" });
    expect(back).toMatchObject({
      ok: true,
      reactivated: true,
      link: { id: dad.id, relationship: "GUARDIAN", isPrimary: true, status: "APPROVED" },
    });
    expect((await db.guardianLink.findUniqueOrThrow({ where: { id: dad.id } })).revokedAt).toBeNull();
    expect(await db.guardianLink.count({ where: { studentId: s.id } })).toBe(1);
  });

  test("the list is the primary first, then in the order added; removed links are not in it", async () => {
    const s = await pupil();
    await link(s.id, { firstName: "Aa", lastName: "First", relationship: "OTHER" });
    const second = await link(s.id, { firstName: "Bb", lastName: "Second", relationship: "MOTHER", isPrimary: true });
    const third = await link(s.id, { firstName: "Cc", lastName: "Third", relationship: "OTHER" });
    const listed = await listLinks(admin(), s.id);
    expect(listed.ok && listed.links.map((l) => l.guardian.firstName)).toEqual(["Bb", "Aa", "Cc"]);
    await removeLink(admin(), boss.id, s.id, third.link.id);
    const after = await listLinks(admin(), s.id);
    expect(after.ok && after.links.map((l) => l.guardian.firstName)).toEqual(["Bb", "Aa"]);
    expect(second.link.isPrimary).toBe(true);
  });
});

test.describe("the guardian record", () => {
  test("partial edits, null clears a phone or email, a no-op writes nothing, invalid values are refused naming the field, and the audit trail names fields only", async () => {
    const s = await pupil();
    const g = (await link(s.id)).link.guardian;
    expect(await updateGuardian(admin(), boss.id, g.id, { firstName: "Gbenga" })).toMatchObject({ ok: true, changed: false });
    expect(await actions(g.id)).toEqual(["GUARDIAN_CREATED"]);
    expect(await updateGuardian(admin(), boss.id, g.id, { lastName: "Bello", phone: null, email: "NEW@Example.com" })).toMatchObject({
      ok: true,
      changed: true,
      guardian: { lastName: "Bello", phone: null, email: "new@example.com" },
    });
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: g.id, action: "GUARDIAN_UPDATED" } });
    expect(entry.afterValue).toMatchObject({ changed: ["lastName", "phone", "email"] });
    expect(JSON.stringify(entry)).not.toContain("new@example.com");
    expect(JSON.stringify(entry)).not.toContain("Bello");
    for (const [input, field] of [
      [{ firstName: "" }, "firstName"],
      [{ phone: "12" }, "phone"],
      [{ email: "nope" }, "email"],
    ] as [object, string][]) {
      expect(await updateGuardian(admin(), boss.id, g.id, input), JSON.stringify(input)).toMatchObject({
        ok: false,
        reason: "INVALID",
        detail: { field },
      });
    }
  });

  test("archiving needs no live links (HAS_LIVE_LINKS otherwise), is idempotent, an archived guardian cannot be edited, and restoring brings it back", async () => {
    const s = await pupil();
    const made = (await link(s.id)).link;
    expect(await archiveGuardian(admin(), boss.id, made.guardian.id)).toMatchObject({ ok: false, reason: "HAS_LIVE_LINKS" });
    expect((await db.guardianRecord.findUniqueOrThrow({ where: { id: made.guardian.id } })).archivedAt).toBeNull();
    await removeLink(admin(), boss.id, s.id, made.id);
    expect(await archiveGuardian(admin(), boss.id, made.guardian.id)).toMatchObject({
      ok: true,
      changed: true,
      guardian: { archived: true },
    });
    expect(await archiveGuardian(admin(), boss.id, made.guardian.id)).toMatchObject({ ok: true, changed: false });
    expect(await updateGuardian(admin(), boss.id, made.guardian.id, { firstName: "Edited" })).toMatchObject({
      ok: false,
      reason: "ARCHIVED",
    });
    expect((await listGuardians(admin(), { status: "live" }, page)).total).toBe(0);
    expect((await listGuardians(admin(), { status: "archived" }, page)).total).toBe(1);
    expect(await restoreGuardian(admin(), boss.id, made.guardian.id)).toMatchObject({
      ok: true,
      changed: true,
      guardian: { archived: false },
    });
    expect(await restoreGuardian(admin(), boss.id, made.guardian.id)).toMatchObject({ ok: true, changed: false });
  });

  test("search by name, phone or email; a guardian shows the students linked to them (siblings), A to Z", async () => {
    const one = await pupil({ firstName: "Zed" });
    const two = await pupil({ firstName: "Amy" });
    const parent = (await link(one.id)).link.guardian;
    await addGuardian(admin(), boss.id, two.id, { guardianId: parent.id, relationship: "FATHER" });
    await link(one.id, { firstName: "Other", lastName: "Person", phone: "07000000001", relationship: "OTHER" });
    expect((await listGuardians(admin(), { status: "live", q: "gbenga" }, page)).guardians.map((g) => g.id)).toEqual([parent.id]);
    expect((await listGuardians(admin(), { status: "live", q: "08031234567" }, page)).total).toBe(1);
    expect((await listGuardians(admin(), { status: "live", q: "EXAMPLE.com" }, page)).total).toBe(1);
    const detail = await getGuardian(admin(), parent.id);
    expect(detail.ok && detail.students.map((s) => s.firstName)).toEqual(["Amy", "Zed"]);
    expect(detail.ok && detail.guardian.studentCount).toBe(2);
  });
});

test.describe("who sees which guardian", () => {
  test("an administrator sees every guardian; staff see those linked to a student they may see; another campus's and another school's are just not there", async () => {
    const northPupil = await pupil({ campusId: north() });
    const southPupil = await pupil({ campusId: south() });
    const widePupil = await pupil();
    const gNorth = (await link(northPupil.id, { firstName: "Nora", lastName: "Parent", relationship: "MOTHER" })).link;
    const gSouth = (await link(southPupil.id, { firstName: "Sola", lastName: "Parent", relationship: "MOTHER" })).link;
    const gWide = (await link(widePupil.id, { firstName: "Wale", lastName: "Parent", relationship: "FATHER" })).link;
    const foreign = (await link((await pupil({}, b)).id, NEW, b)).link;

    const staffNorth = ctx(a, "TEACHING_STAFF", north());
    expect((await listGuardians(admin(), { status: "live" }, page)).guardians.map((g) => g.firstName).sort()).toEqual([
      "Nora",
      "Sola",
      "Wale",
    ]);
    expect((await listGuardians(staffNorth, { status: "live" }, page)).guardians.map((g) => g.firstName).sort()).toEqual(["Nora", "Wale"]);
    expect((await listGuardians(ctx(a, "NON_TEACHING_STAFF", null), { status: "live" }, page)).guardians.map((g) => g.firstName)).toEqual([
      "Wale",
    ]);
    expect(await getGuardian(staffNorth, gNorth.guardian.id)).toMatchObject({ ok: true });
    expect(await getGuardian(staffNorth, gSouth.guardian.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await getGuardian(admin(), foreign.guardian.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await listLinks(staffNorth, southPupil.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await listLinks(staffNorth, widePupil.id)).toMatchObject({ ok: true });
    expect(gWide.guardian.id).toBeTruthy();
  });

  test("a guardian linked to a visible AND an invisible student shows staff only the visible one", async () => {
    const northPupil = await pupil({ campusId: north() });
    const southPupil = await pupil({ campusId: south() });
    const parent = (await link(northPupil.id)).link.guardian;
    await addGuardian(admin(), boss.id, southPupil.id, { guardianId: parent.id, relationship: "FATHER" });
    const seen = await getGuardian(ctx(a, "TEACHING_STAFF", north()), parent.id);
    expect(seen.ok && seen.students.map((s) => s.studentId)).toEqual([northPupil.id]);
    const all = await getGuardian(admin(), parent.id);
    expect(all.ok && all.students).toHaveLength(2);
  });
});
