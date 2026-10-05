import { test, expect } from "@playwright/test";
import { Role as R, addMembership, createTenant, createUser, db, deactivateMembership, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { changeMember, deactivateMember, listMembers, reactivateMember } from "@/lib/members/service";

// The school's people, in-process, as `app_user` (domain-implementation-plan.md §0.5.4, "Authority rules"): who may change whom,
// the last-administrator guard (including under concurrency), self-changes, and the campus rule.

let a: TestTenant;
let b: TestTenant;

const ctx = (t: TestTenant): TenantAuthContext["tenant"] => ({
  tenantId: trustedTenantId(t.id),
  tenantCode: t.code,
  tenantName: t.name,
  role: "ADMIN",
  campusId: null,
  run: <T>(fn: (tx: Tx) => Promise<T>) => forTenant(trustedTenantId(t.id)).transaction(fn),
});

test.beforeEach(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

async function person(school: TestTenant, role: R, opts: { name?: string; campus?: number } = {}) {
  const user = await createUser({ name: opts.name ?? "Some Person" });
  await addMembership(user.id, school.id, role, opts.campus === undefined ? null : school.campuses[opts.campus].id);
  return user;
}

test.describe("listMembers", () => {
  test("lists the school's people with their role, campus and status — never another school's, and nothing secret", async () => {
    const boss = await person(a, R.ADMIN, { name: "Ada Admin" });
    const teacher = await person(a, R.TEACHING_STAFF, { name: "Tola Teacher", campus: 0 });
    await person(b, R.ADMIN, { name: "Bayo Elsewhere" });
    const { members, total } = await listMembers(ctx(a), { status: "all" }, { skip: 0, take: 50 });
    expect(total).toBe(2);
    expect(members.map((m) => m.userId).sort()).toEqual([boss.id, teacher.id].sort());
    expect(members.find((m) => m.userId === teacher.id)).toMatchObject({ name: "Tola Teacher", role: "TEACHING_STAFF", campusName: "Alpha North", status: "active" });
    const dump = JSON.stringify(members);
    expect(dump).not.toMatch(/passwordHash|\$2[aby]\$/); // the person's name and address go through, nothing else of the User row
    expect(Object.keys(members[0]).sort()).toEqual(["campusId", "campusName", "email", "joinedAt", "name", "role", "status", "userId"]);
  });

  test("filters: role, campus, status (default: active), and a search that matches name or address, case-insensitively, as TEXT", async () => {
    const t1 = await person(a, R.TEACHING_STAFF, { name: "Tola Teacher", campus: 0 });
    const t2 = await person(a, R.TEACHING_STAFF, { name: "Uche Teacher", campus: 1 });
    const parent = await person(a, R.PARENT, { name: "Pat Parent" });
    await deactivateMembership(t2.id, a.id);
    const ids = async (f: Parameters<typeof listMembers>[1]) => (await listMembers(ctx(a), f, { skip: 0, take: 50 })).members.map((m) => m.userId).sort();
    expect(await ids({ status: "active" })).toEqual([t1.id, parent.id].sort());
    expect(await ids({ status: "deactivated" })).toEqual([t2.id]);
    expect(await ids({ status: "all" })).toEqual([t1.id, t2.id, parent.id].sort());
    expect(await ids({ status: "all", role: R.TEACHING_STAFF })).toEqual([t1.id, t2.id].sort());
    expect(await ids({ status: "all", campusId: a.campuses[1].id })).toEqual([t2.id]);
    expect(await ids({ status: "all", q: "TOLA" })).toEqual([t1.id]);
    expect(await ids({ status: "all", q: parent.email.toUpperCase() })).toEqual([parent.id]);
    // wildcards are text, not patterns
    expect(await ids({ status: "all", q: "%" })).toEqual([]);
    expect(await ids({ status: "all", q: "_" })).toEqual([]);
    expect(await ids({ status: "all", q: "Tola%" })).toEqual([]);
  });

  test("pages are exact: stable order, no overlap, no gaps", async () => {
    for (let i = 0; i < 7; i++) await person(a, R.PARENT, { name: `Parent ${i}` });
    const seen: string[] = [];
    for (let skip = 0; skip < 8; skip += 3) {
      const page = await listMembers(ctx(a), { status: "all" }, { skip, take: 3 });
      expect(page.total).toBe(7);
      seen.push(...page.members.map((m) => m.userId));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const names = (await listMembers(ctx(a), { status: "all" }, { skip: 0, take: 50 })).members.map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });
});

test.describe("changeMember — the authority rules", () => {
  test("changes role and campus, audits each with before/after, and takes effect through the membership", async () => {
    const boss = await person(a, R.ADMIN);
    const target = await person(a, R.TEACHING_STAFF, { campus: 0 });
    const result = await changeMember(ctx(a), boss.id, target.id, { role: R.NON_TEACHING_STAFF, campusId: a.campuses[1].id });
    expect(result).toMatchObject({ ok: true, changed: true, member: { role: "NON_TEACHING_STAFF", campusName: "Alpha South" } });
    const audit = await db.auditLog.findMany({ where: { tenantId: a.id, targetId: target.id, action: { startsWith: "MEMBER_" } }, orderBy: { action: "asc" } });
    expect(audit.map((r) => r.action)).toEqual(["MEMBER_CAMPUS_CHANGED", "MEMBER_ROLE_CHANGED"]);
    expect(audit.find((r) => r.action === "MEMBER_ROLE_CHANGED")).toMatchObject({ actorUserId: boss.id, beforeValue: { role: "TEACHING_STAFF" }, afterValue: { role: "NON_TEACHING_STAFF" } });
    expect(audit.find((r) => r.action === "MEMBER_CAMPUS_CHANGED")).toMatchObject({ beforeValue: { campusId: a.campuses[0].id }, afterValue: { campusId: a.campuses[1].id } });
  });

  test("clearing the campus is a change (null), leaving it out is not", async () => {
    const boss = await person(a, R.ADMIN);
    const target = await person(a, R.TEACHING_STAFF, { campus: 0 });
    expect(await changeMember(ctx(a), boss.id, target.id, { role: R.TEACHING_STAFF })).toMatchObject({ ok: true, changed: false });
    expect(await changeMember(ctx(a), boss.id, target.id, { campusId: null })).toMatchObject({ ok: true, changed: true, member: { campusId: null } });
  });

  test("a no-op writes NOTHING (no update, no audit row)", async () => {
    const boss = await person(a, R.ADMIN);
    const target = await person(a, R.TEACHING_STAFF, { campus: 0 });
    const before = await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: target.id, tenantId: a.id } } });
    expect(await changeMember(ctx(a), boss.id, target.id, { role: R.TEACHING_STAFF, campusId: a.campuses[0].id })).toMatchObject({ ok: true, changed: false });
    expect(await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: target.id, tenantId: a.id } } })).toEqual(before);
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: target.id, action: { startsWith: "MEMBER_" } } })).toBe(0);
  });

  test("a person of ANOTHER school — or an unknown id — is simply not found (one answer), and nothing changes", async () => {
    const boss = await person(a, R.ADMIN);
    const theirs = await person(b, R.TEACHING_STAFF);
    expect(await changeMember(ctx(a), boss.id, theirs.id, { role: R.ADMIN })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await changeMember(ctx(a), boss.id, "no-such-user", { role: R.ADMIN })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await deactivateMember(ctx(a), boss.id, theirs.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await reactivateMember(ctx(a), boss.id, theirs.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: theirs.id, tenantId: b.id } } })).role).toBe("TEACHING_STAFF");
  });

  test("nobody changes, deactivates or reactivates THEMSELVES — even an administrator with a colleague to spare", async () => {
    const boss = await person(a, R.ADMIN);
    await person(a, R.ADMIN);
    expect(await changeMember(ctx(a), boss.id, boss.id, { role: R.PARENT })).toEqual({ ok: false, reason: "SELF" });
    expect(await deactivateMember(ctx(a), boss.id, boss.id)).toEqual({ ok: false, reason: "SELF" });
    expect(await reactivateMember(ctx(a), boss.id, boss.id)).toEqual({ ok: false, reason: "SELF" });
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: boss.id, tenantId: a.id } } })).role).toBe("ADMIN");
  });

  test("a campus of another school — or one that does not exist — is refused alike", async () => {
    const boss = await person(a, R.ADMIN);
    const target = await person(a, R.TEACHING_STAFF, { campus: 0 });
    const theirs = await db.campus.findFirstOrThrow({ where: { tenantId: b.id } });
    for (const campusId of [theirs.id, "no-such-campus"]) {
      expect(await changeMember(ctx(a), boss.id, target.id, { campusId })).toEqual({ ok: false, reason: "INVALID_CAMPUS" });
    }
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: target.id, tenantId: a.id } } })).campusId).toBe(a.campuses[0].id);
  });

  test("a deactivated member cannot be changed until reactivated", async () => {
    const boss = await person(a, R.ADMIN);
    const target = await person(a, R.TEACHING_STAFF);
    await deactivateMembership(target.id, a.id);
    expect(await changeMember(ctx(a), boss.id, target.id, { role: R.ADMIN })).toEqual({ ok: false, reason: "DEACTIVATED" });
  });

  test("the LAST active administrator cannot be demoted or deactivated; with a colleague they can; a deactivated admin does not count", async () => {
    const boss = await person(a, R.ADMIN, { name: "Ada" });
    const sole = await person(a, R.ADMIN, { name: "Bea" });
    const actor = await person(a, R.PARENT); // anyone calling: the guard is about the SCHOOL, not the caller
    expect(await changeMember(ctx(a), actor.id, sole.id, { role: R.PARENT })).toMatchObject({ ok: true }); // two admins → one may go
    expect(await changeMember(ctx(a), actor.id, boss.id, { role: R.PARENT })).toEqual({ ok: false, reason: "LAST_ADMIN" });
    expect(await deactivateMember(ctx(a), actor.id, boss.id)).toEqual({ ok: false, reason: "LAST_ADMIN" });
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: boss.id, tenantId: a.id } } })).role).toBe("ADMIN");
    // a deactivated administrator is not an active one: with Bea deactivated (not just demoted) Ada is still the last
    await changeMember(ctx(a), actor.id, sole.id, { role: R.ADMIN });
    await deactivateMember(ctx(a), actor.id, sole.id); // two admins → allowed
    expect(await deactivateMember(ctx(a), actor.id, boss.id)).toEqual({ ok: false, reason: "LAST_ADMIN" });
    // …and a campus-only change to the last admin is fine (it removes nothing)
    expect(await changeMember(ctx(a), actor.id, boss.id, { campusId: a.campuses[0].id })).toMatchObject({ ok: true, changed: true });
  });

  test("the guard is per school: B's administrator is not A's second administrator", async () => {
    const lone = await person(a, R.ADMIN);
    await person(b, R.ADMIN);
    const actor = await person(a, R.PARENT);
    expect(await changeMember(ctx(a), actor.id, lone.id, { role: R.PARENT })).toEqual({ ok: false, reason: "LAST_ADMIN" });
  });

  test("two administrators demoting EACH OTHER at the same instant: exactly one succeeds — the school is never left with none", async () => {
    const first = await person(a, R.ADMIN, { name: "Ada" });
    const second = await person(a, R.ADMIN, { name: "Bea" });
    for (let round = 0; round < 5; round++) {
      await db.tenantMembership.updateMany({ where: { tenantId: a.id, userId: { in: [first.id, second.id] } }, data: { role: R.ADMIN, deactivatedAt: null } });
      const results = await Promise.all([
        changeMember(ctx(a), second.id, first.id, { role: R.PARENT }),
        changeMember(ctx(a), first.id, second.id, { role: R.PARENT }),
      ]);
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "LAST_ADMIN"), `round ${round}`).toHaveLength(1);
      expect(await db.tenantMembership.count({ where: { tenantId: a.id, role: "ADMIN", deactivatedAt: null } }), `round ${round}`).toBe(1);
    }
  });
});

test.describe("deactivate and reactivate", () => {
  test("deactivation keeps the row, ends access at once, is audited, and is undone by reactivation (same row, same role and campus)", async () => {
    const boss = await person(a, R.ADMIN);
    const target = await person(a, R.TEACHING_STAFF, { campus: 1 });
    const before = await db.tenantMembership.findUniqueOrThrow({ where: { userId_tenantId: { userId: target.id, tenantId: a.id } } });
    expect(await deactivateMember(ctx(a), boss.id, target.id)).toMatchObject({ ok: true, changed: true, member: { status: "deactivated" } });
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { id: before.id } })).deactivatedAt).not.toBeNull();
    expect(await reactivateMember(ctx(a), boss.id, target.id)).toMatchObject({ ok: true, changed: true, member: { status: "active", role: "TEACHING_STAFF", campusName: "Alpha South" } });
    expect(await db.tenantMembership.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ deactivatedAt: null, role: "TEACHING_STAFF", campusId: a.campuses[1].id });
    const actions = (await db.auditLog.findMany({ where: { tenantId: a.id, targetId: target.id }, orderBy: { createdAt: "asc" } })).map((r) => r.action);
    expect(actions).toEqual(["MEMBER_DEACTIVATED", "MEMBER_REACTIVATED"]);
  });

  test("both are idempotent: doing it twice is a quiet success that writes no second audit row", async () => {
    const boss = await person(a, R.ADMIN);
    const target = await person(a, R.PARENT);
    expect(await reactivateMember(ctx(a), boss.id, target.id)).toMatchObject({ ok: true, changed: false }); // already active
    await deactivateMember(ctx(a), boss.id, target.id);
    expect(await deactivateMember(ctx(a), boss.id, target.id)).toMatchObject({ ok: true, changed: false });
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: target.id, action: "MEMBER_DEACTIVATED" } })).toBe(1);
  });
});
