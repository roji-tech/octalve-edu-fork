import "../support/env";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import {
  Role as R,
  addMembership,
  createTenant,
  createUser,
  db,
  deactivateMembership,
  removeCreatedTenants,
  seedInstance,
  type TestTenant,
} from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { hashPassword } from "@/lib/auth/password";
import { acceptInvitation, createInvitation, resendInvitation, revokeInvitation } from "@/lib/invitations/service";
import { archiveArm, archiveSubject, createArm, createClassGroup, createSubject, setOfferings } from "@/lib/academics/classes";
import {
  addAssignment,
  archiveStaff,
  createStaff,
  getStaff,
  linkAccount,
  linkableAccounts,
  listStaff,
  removeAssignment,
  restoreStaff,
  staffInviteDetails,
  unlinkAccount,
  updateStaff,
} from "@/lib/people/staff";

// Staff records, their sign-in accounts and what they teach, in-process as `app_user` (plan "Build design — Phase 1.2", reconciliation 2 and decision P5).

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
const strongHash = () => hashPassword("a-Strong-passphrase-2026");

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
const uniqEmail = () => `staff${Date.now().toString(36)}${++n}@example.com`;
async function staff(over: Record<string, unknown> = {}, school: TestTenant = a) {
  const result = await createStaff(admin(school), boss.id, { category: "TEACHING", firstName: `Tola${++n}`, lastName: "Bello", ...over });
  if (!result.ok) throw new Error(`createStaff refused: ${result.reason} ${JSON.stringify(result.detail ?? {})}`);
  return result.staff;
}
async function member(role: Role, school: TestTenant = a, campusId: string | null = null) {
  const user = await createUser({ name: `Member ${++n}` });
  await addMembership(user.id, school.id, role, campusId);
  return user;
}
const actions = async (targetId: string) =>
  (await db.auditLog.findMany({ where: { tenantId: a.id, targetId }, orderBy: { createdAt: "asc" } })).map((r) => r.action);
const page = { skip: 0, take: 100 };
const live = { status: "live" as const };

test.describe("the record", () => {
  test("a record is created with cleaned names and contact details, audited by category and campus only — never the phone or email", async () => {
    const made = await staff({
      firstName: "  Tola ",
      lastName: " Bello  ",
      phone: " 08031234567 ",
      email: " Tola@Example.COM ",
      campusId: north(),
    });
    expect(made).toMatchObject({
      category: "TEACHING",
      firstName: "Tola",
      lastName: "Bello",
      phone: "08031234567",
      email: "tola@example.com",
      campusId: north(),
      archived: false,
      account: { state: "none" },
      assignmentCount: 0,
    });
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: made.id } });
    expect(entry.action).toBe("STAFF_CREATED");
    expect(JSON.stringify(entry)).not.toContain("08031234567");
    expect(JSON.stringify(entry)).not.toContain("tola@example.com");
  });

  test("bad input is refused naming the field and writes nothing; a campus of another school is INVALID_CAMPUS", async () => {
    const base = { category: "TEACHING", firstName: "Tola", lastName: "Bello" };
    const cases: [Record<string, unknown>, string][] = [
      [{ category: "JANITOR" }, "category"],
      [{ category: undefined }, "category"],
      [{ firstName: "" }, "firstName"],
      [{ lastName: "x".repeat(81) }, "lastName"],
      [{ phone: "12" }, "phone"],
      [{ email: "nope" }, "email"],
    ];
    for (const [over, field] of cases) {
      expect(await createStaff(admin(), boss.id, { ...base, ...over }), JSON.stringify(over)).toMatchObject({
        ok: false,
        reason: "INVALID",
        detail: { field },
      });
    }
    expect(await createStaff(admin(), boss.id, { ...base, campusId: b.campuses[0].id })).toMatchObject({
      ok: false,
      reason: "INVALID_CAMPUS",
    });
    expect(await db.staffRecord.count({ where: { tenantId: a.id } })).toBe(0);
  });

  test("an email is unique among LIVE records ignoring case; archiving frees it; restoring is refused while someone else holds it; two creates at once make one", async () => {
    const first = await staff({ email: "dup@example.com" });
    expect(
      await createStaff(admin(), boss.id, { category: "NON_TEACHING", firstName: "Other", lastName: "Person", email: "DUP@example.com" }),
    ).toMatchObject({
      ok: false,
      reason: "EMAIL_TAKEN",
    });
    expect(await archiveStaff(admin(), boss.id, first.id)).toMatchObject({ ok: true });
    const second = await staff({ email: "dup@example.com" });
    expect(await restoreStaff(admin(), boss.id, first.id)).toMatchObject({ ok: false, reason: "EMAIL_TAKEN" });
    expect(second.email).toBe("dup@example.com");
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        createStaff(admin(), boss.id, { category: "TEACHING", firstName: `Race${i}`, lastName: "Same", email: "race@example.com" }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "EMAIL_TAKEN")).toBe(true);
  });

  test("partial edits; null clears; a no-op writes nothing; the category cannot change while a sign-in account is linked", async () => {
    const s = await staff({ phone: "08031234567", email: uniqEmail() });
    expect(await updateStaff(admin(), boss.id, s.id, { firstName: s.firstName })).toMatchObject({ ok: true, changed: false });
    expect(await actions(s.id)).toEqual(["STAFF_CREATED"]);
    const edited = await updateStaff(admin(), boss.id, s.id, { lastName: "Adeyemi", phone: null, category: "NON_TEACHING" });
    expect(edited).toMatchObject({ ok: true, changed: true, staff: { lastName: "Adeyemi", phone: null, category: "NON_TEACHING" } });
    const entry = await db.auditLog.findFirstOrThrow({ where: { targetId: s.id, action: "STAFF_UPDATED" } });
    expect(entry.afterValue).toMatchObject({ changed: ["category", "lastName", "phone"] });
    expect(JSON.stringify(entry)).not.toContain("Adeyemi");
    for (const [input, field] of [
      [{ firstName: "" }, "firstName"],
      [{ category: "NOPE" }, "category"],
      [{ email: "bad" }, "email"],
    ] as [object, string][]) {
      expect(await updateStaff(admin(), boss.id, s.id, input), JSON.stringify(input)).toMatchObject({
        ok: false,
        reason: "INVALID",
        detail: { field },
      });
    }
    const account = await member(R.NON_TEACHING_STAFF);
    expect(await linkAccount(admin(), boss.id, s.id, { userId: account.id })).toMatchObject({ ok: true });
    expect(await updateStaff(admin(), boss.id, s.id, { category: "TEACHING" })).toMatchObject({
      ok: false,
      reason: "ACCOUNT_MISMATCH",
      detail: { field: "category" },
    });
    expect(await updateStaff(admin(), boss.id, s.id, { lastName: "StillEditable" })).toMatchObject({ ok: true, changed: true });
  });

  test("archiving needs no assignments (HAS_ASSIGNMENTS), is idempotent, and an archived record cannot be edited, linked, invited or given subjects", async () => {
    const s = await staff({ email: uniqEmail() });
    const { arm, subject } = await classWith("JSS1");
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: subject.id, classArmId: arm.id })).toMatchObject({ ok: true });
    expect(await archiveStaff(admin(), boss.id, s.id)).toMatchObject({ ok: false, reason: "HAS_ASSIGNMENTS" });
    expect((await db.staffRecord.findUniqueOrThrow({ where: { id: s.id } })).archivedAt).toBeNull();
    const detail = await getStaff(admin(), s.id);
    if (!detail.ok) throw new Error("setup");
    expect(await removeAssignment(admin(), boss.id, s.id, detail.assignments[0].id)).toMatchObject({ ok: true });
    expect(await archiveStaff(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: true, staff: { archived: true } });
    expect(await archiveStaff(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: false });
    const account = await member(R.TEACHING_STAFF);
    expect(await updateStaff(admin(), boss.id, s.id, { firstName: "Edited" })).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await linkAccount(admin(), boss.id, s.id, { userId: account.id })).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await staffInviteDetails(admin(), s.id)).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: subject.id, classArmId: arm.id })).toMatchObject({
      ok: false,
      reason: "ARCHIVED",
    });
    expect(await restoreStaff(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: true, staff: { archived: false } });
    expect(await restoreStaff(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: false });
  });
});

test.describe("the sign-in account", () => {
  test("link an active member whose role fits; the view says who, and shows when the member is deactivated or their role no longer fits", async () => {
    const s = await staff();
    const teacher = await member(R.TEACHING_STAFF);
    const linked = await linkAccount(admin(), boss.id, s.id, { userId: teacher.id });
    expect(linked).toMatchObject({
      ok: true,
      staff: {
        account: {
          state: "linked",
          userId: teacher.id,
          name: teacher.name,
          role: "TEACHING_STAFF",
          deactivated: false,
          roleDiffers: false,
        },
      },
    });
    expect(await actions(s.id)).toEqual(["STAFF_CREATED", "STAFF_ACCOUNT_LINKED"]);
    await db.tenantMembership.update({
      where: { userId_tenantId: { userId: teacher.id, tenantId: a.id } },
      data: { role: R.NON_TEACHING_STAFF },
    });
    expect(await getStaff(admin(), s.id)).toMatchObject({ staff: { account: { roleDiffers: true } } });
    await deactivateMembership(teacher.id, a.id);
    expect(await getStaff(admin(), s.id)).toMatchObject({ staff: { account: { state: "linked", deactivated: true } } });
  });

  test("refused: a second link on the same record, a member of another school, a deactivated member, the wrong role, an ADMIN, a stranger, and a member already on another record", async () => {
    const s = await staff();
    const other = await staff();
    const teacher = await member(R.TEACHING_STAFF);
    const clerk = await member(R.NON_TEACHING_STAFF);
    const parent = await member(R.PARENT);
    const former = await member(R.TEACHING_STAFF);
    await deactivateMembership(former.id, a.id);
    const elsewhere = await member(R.TEACHING_STAFF, b);

    for (const user of [clerk, parent, former, elsewhere, boss, { id: "nobody" }]) {
      expect(await linkAccount(admin(), boss.id, s.id, { userId: user.id }), user.id).toMatchObject({
        ok: false,
        reason: "ACCOUNT_MISMATCH",
      });
    }
    expect(await linkAccount(admin(), boss.id, s.id, { userId: teacher.id })).toMatchObject({ ok: true });
    expect(await linkAccount(admin(), boss.id, s.id, { userId: teacher.id })).toMatchObject({
      ok: false,
      reason: "ALREADY_LINKED_ACCOUNT",
    });
    expect(await linkAccount(admin(), boss.id, other.id, { userId: teacher.id })).toMatchObject({ ok: false, reason: "ACCOUNT_TAKEN" });
    expect(await db.staffRecord.count({ where: { tenantId: a.id, userId: { not: null } } })).toBe(1);
    // the same person in another school is a different story (their record there is that school's business)
    expect(await linkAccount(admin(b), boss.id, "nope", { userId: elsewhere.id })).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  test("two administrators linking the same member to two records at once make one link", async () => {
    const one = await staff();
    const two = await staff();
    const teacher = await member(R.TEACHING_STAFF);
    const results = await Promise.all([one, two].map((record) => linkAccount(admin(), boss.id, record.id, { userId: teacher.id })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "ACCOUNT_TAKEN" });
    expect(await db.staffRecord.count({ where: { tenantId: a.id, userId: teacher.id } })).toBe(1);
  });

  test("the linkable list holds only active members of the right role without a record; unlinking clears the link (the membership stays) and a second unlink is NOT_LINKED", async () => {
    const s = await staff();
    const free = await member(R.TEACHING_STAFF);
    const taken = await member(R.TEACHING_STAFF);
    await member(R.NON_TEACHING_STAFF);
    const gone = await member(R.TEACHING_STAFF);
    await deactivateMembership(gone.id, a.id);
    const holder = await staff();
    await linkAccount(admin(), boss.id, holder.id, { userId: taken.id });
    const list = await linkableAccounts(admin(), s.id);
    expect(list.ok && list.accounts.map((x) => x.userId)).toEqual([free.id]);
    await linkAccount(admin(), boss.id, s.id, { userId: free.id });
    expect(await unlinkAccount(admin(), boss.id, s.id)).toMatchObject({ ok: true, staff: { account: { state: "none" } } });
    expect(await db.tenantMembership.count({ where: { userId: free.id, tenantId: a.id, deactivatedAt: null } })).toBe(1);
    expect(await unlinkAccount(admin(), boss.id, s.id)).toMatchObject({ ok: false, reason: "NOT_LINKED" });
    expect(await actions(s.id)).toEqual(["STAFF_CREATED", "STAFF_ACCOUNT_LINKED", "STAFF_ACCOUNT_UNLINKED"]);
    expect(await linkableAccounts(admin(), "nope")).toEqual({ ok: false, reason: "NOT_FOUND" });
  });
});

test.describe("inviting a record to sign in", () => {
  test("the details come from the record (its address, the role its category signs in as, its campus); no address, an account, or archived is refused", async () => {
    const teacher = await staff({ email: "t@example.com", campusId: north() });
    const guard = await staff({ category: "NON_TEACHING", email: "g@example.com" });
    expect(await staffInviteDetails(admin(), teacher.id)).toEqual({
      ok: true,
      email: "t@example.com",
      role: "TEACHING_STAFF",
      campusId: north(),
    });
    expect(await staffInviteDetails(admin(), guard.id)).toEqual({
      ok: true,
      email: "g@example.com",
      role: "NON_TEACHING_STAFF",
      campusId: null,
    });
    const noEmail = await staff();
    expect(await staffInviteDetails(admin(), noEmail.id)).toMatchObject({ ok: false, reason: "EMAIL_REQUIRED" });
    const member1 = await member(R.TEACHING_STAFF);
    await linkAccount(admin(), boss.id, teacher.id, { userId: member1.id });
    expect(await staffInviteDetails(admin(), teacher.id)).toMatchObject({ ok: false, reason: "ALREADY_LINKED_ACCOUNT" });
    expect(await staffInviteDetails(admin(), "nope")).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  test("accepting links the record to the NEW member in the same transaction; the record then reads 'linked'", async () => {
    const s = await staff({ email: "newhire@example.com" });
    const made = await createInvitation(admin(), boss.id, {
      email: "newhire@example.com",
      role: "TEACHING_STAFF",
      campusId: null,
      staffRecordId: s.id,
    });
    if (!made.ok) throw new Error(`invite refused: ${made.reason}`);
    expect(await getStaff(admin(), s.id)).toMatchObject({ staff: { account: { state: "invited", invitationId: made.invitation.id } } });
    const accepted = await acceptInvitation({
      token: made.token,
      viewerUserId: null,
      newAccount: { name: "New Hire", passwordHash: await strongHash() },
    });
    expect(accepted).toMatchObject({ ok: true, newAccount: true, staffRecordLinked: true });
    expect(await getStaff(admin(), s.id)).toMatchObject({
      staff: { account: { state: "linked", name: "New Hire", email: "newhire@example.com", role: "TEACHING_STAFF" } },
    });
    const entry = await db.auditLog.findFirstOrThrow({ where: { action: "INVITATION_ACCEPTED", targetId: made.invitation.id } });
    expect(entry.afterValue).toMatchObject({ staffRecordId: s.id, staffRecordLinked: true });
  });

  test("the invitation survives what the administrator does meanwhile: a record linked, archived or already held by the invitee is skipped — the membership is still created", async () => {
    // linked to someone else while the invitation was open
    const s1 = await staff({ email: "late1@example.com" });
    const inv1 = await createInvitation(admin(), boss.id, {
      email: "late1@example.com",
      role: "TEACHING_STAFF",
      campusId: null,
      staffRecordId: s1.id,
    });
    if (!inv1.ok) throw new Error("setup");
    const other = await member(R.TEACHING_STAFF);
    await linkAccount(admin(), boss.id, s1.id, { userId: other.id });
    const r1 = await acceptInvitation({
      token: inv1.token,
      viewerUserId: null,
      newAccount: { name: "Late One", passwordHash: await strongHash() },
    });
    expect(r1).toMatchObject({ ok: true, staffRecordLinked: false });
    expect((await db.staffRecord.findUniqueOrThrow({ where: { id: s1.id } })).userId).toBe(other.id);
    expect(await db.tenantMembership.count({ where: { tenantId: a.id, user: { email: "late1@example.com" } } })).toBe(1);

    // archived while the invitation was open
    const s2 = await staff({ email: "late2@example.com" });
    const inv2 = await createInvitation(admin(), boss.id, {
      email: "late2@example.com",
      role: "TEACHING_STAFF",
      campusId: null,
      staffRecordId: s2.id,
    });
    if (!inv2.ok) throw new Error("setup");
    await archiveStaff(admin(), boss.id, s2.id);
    expect(
      await acceptInvitation({ token: inv2.token, viewerUserId: null, newAccount: { name: "Late Two", passwordHash: await strongHash() } }),
    ).toMatchObject({
      ok: true,
      staffRecordLinked: false,
    });
    expect((await db.staffRecord.findUniqueOrThrow({ where: { id: s2.id } })).userId).toBeNull();
    const skipped = await db.auditLog.findFirstOrThrow({ where: { action: "INVITATION_ACCEPTED", targetId: inv2.invitation.id } });
    expect(skipped.afterValue).toMatchObject({ staffRecordId: s2.id, staffRecordLinked: false });

    // an existing member who already holds another record accepts an invitation for a second one
    const s3 = await staff({ email: "late3@example.com" });
    const holder = await createUser({ email: "late3@example.com", name: "Has A Record" });
    const own = await staff();
    const inv3 = await createInvitation(admin(), boss.id, {
      email: "late3@example.com",
      role: "TEACHING_STAFF",
      campusId: null,
      staffRecordId: s3.id,
    });
    if (!inv3.ok) throw new Error("setup");
    await addMembership(holder.id, a.id, R.TEACHING_STAFF); // joined meanwhile by another route…
    await linkAccount(admin(), boss.id, own.id, { userId: holder.id });
    await db.tenantMembership.update({
      where: { userId_tenantId: { userId: holder.id, tenantId: a.id } },
      data: { deactivatedAt: new Date() },
    }); // …then deactivated, so the invitation can reactivate them
    expect(await acceptInvitation({ token: inv3.token, viewerUserId: holder.id })).toMatchObject({
      ok: true,
      reactivated: true,
      staffRecordLinked: false,
    });
    expect((await db.staffRecord.findUniqueOrThrow({ where: { id: s3.id } })).userId).toBeNull();
    expect((await db.staffRecord.findUniqueOrThrow({ where: { id: own.id } })).userId).toBe(holder.id);
  });

  test("an invitation can name only a live, unlinked record of THIS school; resending keeps the link; revoking returns the record to 'no account'", async () => {
    const live1 = await staff({ email: "ok@example.com" });
    const archived = await staff({ email: "arch@example.com" });
    await archiveStaff(admin(), boss.id, archived.id);
    const linkedRec = await staff({ email: "linked@example.com" });
    await linkAccount(admin(), boss.id, linkedRec.id, { userId: (await member(R.TEACHING_STAFF)).id });
    const foreign = await staff({ email: "far@example.com" }, b);
    for (const id of [archived.id, linkedRec.id, foreign.id, "nope"]) {
      expect(
        await createInvitation(admin(), boss.id, {
          email: `x${++n}@example.com`,
          role: "TEACHING_STAFF",
          campusId: null,
          staffRecordId: id,
        }),
        id,
      ).toEqual({
        ok: false,
        reason: "INVALID_STAFF_RECORD",
      });
    }
    const made = await createInvitation(admin(), boss.id, {
      email: "ok@example.com",
      role: "TEACHING_STAFF",
      campusId: null,
      staffRecordId: live1.id,
    });
    if (!made.ok) throw new Error("setup");
    const resent = await resendInvitation(admin(), boss.id, made.invitation.id);
    expect(resent).not.toBeNull();
    expect((await db.invitation.findUniqueOrThrow({ where: { id: made.invitation.id } })).staffRecordId).toBe(live1.id);
    expect(await revokeInvitation(admin(), boss.id, made.invitation.id)).toBe(true);
    expect(await getStaff(admin(), live1.id)).toMatchObject({ staff: { account: { state: "none" } } });
  });
});

async function classWith(name: string, campusId: string | null = null, school: TestTenant = a) {
  const g = await createClassGroup(admin(school), boss.id, { campusId, name: `${name}-${Math.random().toString(36).slice(2, 6)}` });
  if (!g.ok) throw new Error(`createClassGroup refused: ${g.reason}`);
  const arm = await createArm(admin(school), boss.id, g.group.id, { name: "A" });
  if (!arm.ok) throw new Error(`createArm refused: ${arm.reason}`);
  const subject = await createSubject(admin(school), boss.id, { name: `Maths ${Math.random().toString(36).slice(2, 6)}` });
  if (!subject.ok) throw new Error(`createSubject refused: ${subject.reason}`);
  const offered = await setOfferings(admin(school), boss.id, g.group.id, [subject.subject.id]);
  if (!offered.ok) throw new Error(`setOfferings refused: ${offered.reason}`);
  return { group: g.group, arm: arm.arm, subject: subject.subject };
}

test.describe("what a person teaches", () => {
  test("assign a subject to a class that studies it; the list is in class order; twice is ALREADY_ASSIGNED; removing deletes and is audited", async () => {
    const s = await staff();
    const one = await classWith("JSS1");
    const two = await classWith("JSS2");
    const first = await addAssignment(admin(), boss.id, s.id, { subjectId: one.subject.id, classArmId: one.arm.id });
    expect(first).toMatchObject({ ok: true, assignment: { subjectName: one.subject.name, armName: "A" } });
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: one.subject.id, classArmId: one.arm.id })).toMatchObject({
      ok: false,
      reason: "ALREADY_ASSIGNED",
    });
    await addAssignment(admin(), boss.id, s.id, { subjectId: two.subject.id, classArmId: two.arm.id });
    expect(await getStaff(admin(), s.id)).toMatchObject({ staff: { assignmentCount: 2 } });
    if (!first.ok) return;
    expect(await removeAssignment(admin(), boss.id, s.id, first.assignment.id)).toEqual({ ok: true, removed: true });
    expect(await removeAssignment(admin(), boss.id, s.id, first.assignment.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await actions(first.assignment.id)).toEqual(["STAFF_ASSIGNED", "STAFF_UNASSIGNED"]);
    expect(await db.staffSubjectAssignment.count({ where: { staffRecordId: s.id } })).toBe(1);
  });

  test("a class must study the subject; subjects and classes must be live and this school's; two assignments at once make one", async () => {
    const s = await staff();
    const one = await classWith("JSS1");
    const two = await classWith("JSS2");
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: two.subject.id, classArmId: one.arm.id })).toMatchObject({
      ok: false,
      reason: "SUBJECT_NOT_OFFERED",
    });
    const foreign = await classWith("Beta", null, b);
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: foreign.subject.id, classArmId: one.arm.id })).toMatchObject({
      ok: false,
      reason: "INVALID_SUBJECT",
    });
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: one.subject.id, classArmId: foreign.arm.id })).toMatchObject({
      ok: false,
      reason: "INVALID_ARM",
    });
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: "nope", classArmId: one.arm.id })).toMatchObject({
      ok: false,
      reason: "INVALID_SUBJECT",
    });
    await archiveSubject(admin(), boss.id, two.subject.id).then(async (r) => {
      // a subject a class still studies cannot be archived; take it out of the class first
      expect(r).toMatchObject({ ok: false, reason: "SUBJECT_IN_USE" });
      await setOfferings(admin(), boss.id, two.group.id, []);
      expect(await archiveSubject(admin(), boss.id, two.subject.id)).toMatchObject({ ok: true });
    });
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: two.subject.id, classArmId: two.arm.id })).toMatchObject({
      ok: false,
      reason: "INVALID_SUBJECT",
    });
    expect(await archiveArm(admin(), boss.id, one.arm.id)).toMatchObject({ ok: true });
    expect(await addAssignment(admin(), boss.id, s.id, { subjectId: one.subject.id, classArmId: one.arm.id })).toMatchObject({
      ok: false,
      reason: "INVALID_ARM",
    });
    const fresh = await classWith("JSS3");
    const results = await Promise.all(
      [1, 2, 3].map(() => addAssignment(admin(), boss.id, s.id, { subjectId: fresh.subject.id, classArmId: fresh.arm.id })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "ALREADY_ASSIGNED")).toBe(true);
    expect(await db.staffSubjectAssignment.count({ where: { staffRecordId: s.id } })).toBe(1);
  });

  test("a record with a campus teaches school-wide or its own campus's classes; a record with no campus may teach any class", async () => {
    const northStaff = await staff({ campusId: north() });
    const visiting = await staff();
    const wide = await classWith("Wide");
    const inNorth = await classWith("North", north());
    const inSouth = await classWith("South", south());
    const assign = (staffId: string, c: { subject: { id: string }; arm: { id: string } }) =>
      addAssignment(admin(), boss.id, staffId, { subjectId: c.subject.id, classArmId: c.arm.id });
    expect(await assign(northStaff.id, wide)).toMatchObject({ ok: true });
    expect(await assign(northStaff.id, inNorth)).toMatchObject({ ok: true });
    expect(await assign(northStaff.id, inSouth)).toMatchObject({ ok: false, reason: "INVALID_ARM" });
    for (const c of [wide, inNorth, inSouth]) expect(await assign(visiting.id, c)).toMatchObject({ ok: true });
  });
});

test.describe("who sees which record", () => {
  test("an administrator sees every campus; staff see school-wide records and their own campus's; another school's record is just not there", async () => {
    const wide = await staff({ firstName: "Wide" });
    const n1 = await staff({ firstName: "Nora", campusId: north() });
    const s1 = await staff({ firstName: "Segun", campusId: south() });
    const foreign = await staff({ firstName: "Foreign" }, b);
    expect((await listStaff(admin(), live, page)).staff.map((x) => x.firstName).sort()).toEqual(["Nora", "Segun", "Wide"]);
    const teacherNorth = ctx(a, "TEACHING_STAFF", north());
    expect((await listStaff(teacherNorth, live, page)).staff.map((x) => x.firstName).sort()).toEqual(["Nora", "Wide"]);
    expect((await listStaff(ctx(a, "NON_TEACHING_STAFF", null), live, page)).staff.map((x) => x.firstName)).toEqual(["Wide"]);
    expect(await getStaff(teacherNorth, n1.id)).toMatchObject({ ok: true });
    expect(await getStaff(teacherNorth, wide.id)).toMatchObject({ ok: true });
    expect(await getStaff(teacherNorth, s1.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await getStaff(admin(), foreign.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await linkableAccounts(teacherNorth, s1.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  test("search, category and status filters, and paging in a stable order", async () => {
    await staff({ firstName: "Amina", lastName: "Zed", email: "amina.zed@example.com" });
    await staff({ firstName: "Bayo", lastName: "Adams", category: "NON_TEACHING", phone: "08030000001" });
    const old = await staff({ firstName: "Chidi", lastName: "Eze" });
    await archiveStaff(admin(), boss.id, old.id);
    expect((await listStaff(admin(), live, page)).staff.map((x) => x.lastName)).toEqual(["Adams", "Zed"]);
    expect((await listStaff(admin(), { status: "live", category: "NON_TEACHING" }, page)).staff.map((x) => x.firstName)).toEqual(["Bayo"]);
    expect((await listStaff(admin(), { status: "live", q: "amina.zed@" }, page)).total).toBe(1);
    expect((await listStaff(admin(), { status: "live", q: "0803000" }, page)).total).toBe(1);
    expect((await listStaff(admin(), { status: "archived" }, page)).staff.map((x) => x.firstName)).toEqual(["Chidi"]);
    expect((await listStaff(admin(), { status: "all" }, page)).total).toBe(3);
    const first = await listStaff(admin(), live, { skip: 0, take: 1 });
    const second = await listStaff(admin(), live, { skip: 1, take: 1 });
    expect([first.staff[0].lastName, second.staff[0].lastName]).toEqual(["Adams", "Zed"]);
  });
});
