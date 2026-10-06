import "../support/env";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { Role, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance } from "../support/db";
import { prisma } from "@/lib/db";
import { setTenantContext } from "@/lib/tenant/for-tenant";
import { forTenant } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import { getSchoolSettings } from "@/lib/school-settings/read";

// Phase 1.0 foundations (domain-implementation-plan.md, "Build design — Phase 1.0 and 1.1", decisions 1–4): the school type, the
// settings row every school must have (made by the database), and the permissions column with its staff-only guarantee.

test.beforeAll(async () => {
  await seedInstance();
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

const suffix = () => crypto.randomBytes(4).toString("hex");

test.describe("Tenant.schoolType (decision 1)", () => {
  test("a school created without saying is K12, and the three values exist", async () => {
    const school = await createTenant({ name: "Default Kind" });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: school.id } })).schoolType).toBe("K12");
    for (const kind of ["HIGHER_ED", "VOCATIONAL"] as const) {
      const row = await db.tenant.create({ data: { code: `k-${suffix()}`, name: kind, schoolType: kind } });
      expect(row.schoolType).toBe(kind);
      await db.tenant.delete({ where: { id: row.id } });
    }
    await expect(
      db.$executeRaw`INSERT INTO "Tenant" ("id","code","name","schoolType") VALUES (${suffix()}, ${suffix()}, 'x', 'COLLEGE')`,
    ).rejects.toThrow();
  });
});

test.describe("SchoolSettings: one row per school, made by the database (decisions 2 and 3)", () => {
  test("the secure defaults are SPELLED OUT here (not read back from the schema): approval required, MFA for teaching staff, nothing automatic", async () => {
    const school = await createTenant({ name: "Defaults" });
    const row = await db.schoolSettings.findUniqueOrThrow({ where: { tenantId: school.id } });
    expect(row).toMatchObject({
      resultApprovalRequired: true,
      rolloverMode: "ADMIN_CONFIRMED",
      classAutoAssignment: false,
      billingCycle: "PER_TERM",
      feeReminderEnabled: true,
      discountWorkflowMode: "MANUAL_OVERRIDE",
      feeCostBearer: "SCHOOL_ABSORBS",
      multiCampusEnabled: false,
      mfaRequiredForTeaching: true,
    });
  });

  test("EVERY creation path gets the row: the helper, plain Prisma, and hand-run SQL as the owner", async () => {
    const viaHelper = await createTenant({ name: "Via helper" });
    const viaPrisma = await db.tenant.create({ data: { code: `p-${suffix()}`, name: "Via prisma" } });
    const id = `raw${suffix()}`;
    await db.$executeRaw`INSERT INTO "Tenant" ("id","code","name") VALUES (${id}, ${`r-${suffix()}`}, 'Via raw SQL')`;
    try {
      for (const tenantId of [viaHelper.id, viaPrisma.id, id]) {
        expect(await db.schoolSettings.count({ where: { tenantId } }), tenantId).toBe(1);
      }
    } finally {
      await db.tenant.deleteMany({ where: { id: { in: [viaPrisma.id, id] } } });
    }
  });

  test("created by the RUNTIME role (as the setup wizard does) it works — and the trigger puts the caller's tenant context BACK", async () => {
    const other = await createTenant({ name: "Already in context" });
    const code = `w-${suffix()}`;
    const seen = await prisma.$transaction(async (tx) => {
      await setTenantContext(tx, trustedTenantId(other.id));
      const created = await tx.tenant.create({ data: { code, name: "Created inside another school's context" } });
      const [{ ctx }] = await tx.$queryRaw<{ ctx: string | null }[]>`SELECT current_setting('app.tenant_id', true) AS ctx`;
      return { created, ctx };
    });
    try {
      expect(seen.ctx).toBe(other.id); // NOT the new school's id: the context is the caller's again
      expect(await db.schoolSettings.count({ where: { tenantId: seen.created.id } })).toBe(1);
    } finally {
      await db.tenant.delete({ where: { id: seen.created.id } });
    }
  });

  test("with NO context at all, creating a tenant leaves NO context afterwards (an empty setting still means 'no school')", async () => {
    const code = `n-${suffix()}`;
    const seen = await prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({ data: { code, name: "No context before" } });
      const [{ visible }] = await tx.$queryRaw<{ visible: bigint }[]>`SELECT count(*) AS visible FROM "SchoolSettings"`; // reads nothing: no context
      const [{ ctx }] = await tx.$queryRaw<{ ctx: string | null }[]>`SELECT app_tenant_id() AS ctx`;
      return { created, visible: Number(visible), ctx };
    });
    try {
      expect(seen.visible).toBe(0);
      expect(seen.ctx).toBeNull();
    } finally {
      await db.tenant.delete({ where: { id: seen.created.id } });
    }
  });

  test("no school lacks a row (the invariant itself), and the backfill SQL is idempotent and repairs a missing row", async () => {
    const school = await createTenant({ name: "Backfilled" });
    const orphans = async () =>
      Number(
        (
          await db.$queryRaw<
            { n: bigint }[]
          >`SELECT count(*) AS n FROM "Tenant" t LEFT JOIN "SchoolSettings" s ON s."tenantId" = t."id" WHERE s."tenantId" IS NULL`
        )[0].n,
      );
    expect(await orphans()).toBe(0);
    const before = await db.schoolSettings.count();
    const backfill = () =>
      db.$executeRaw`INSERT INTO "SchoolSettings" ("tenantId") SELECT "id" FROM "Tenant" ON CONFLICT ("tenantId") DO NOTHING`;
    await backfill();
    await backfill();
    expect(await db.schoolSettings.count()).toBe(before); // twice, nothing added
    await db.schoolSettings.update({ where: { tenantId: school.id }, data: { multiCampusEnabled: true } });
    await backfill();
    expect((await db.schoolSettings.findUniqueOrThrow({ where: { tenantId: school.id } })).multiCampusEnabled).toBe(true); // existing values are never overwritten
    await db.schoolSettings.delete({ where: { tenantId: school.id } });
    expect(await orphans()).toBe(1);
    await backfill();
    expect(await orphans()).toBe(0);
  });

  test("getSchoolSettings returns the row — and THROWS when it is missing instead of inventing defaults", async () => {
    const school = await createTenant({ name: "Reader" });
    const id = trustedTenantId(school.id);
    expect(await forTenant(id).transaction((tx) => getSchoolSettings(tx, id))).toMatchObject({
      tenantId: school.id,
      resultApprovalRequired: true,
    });
    await db.schoolSettings.delete({ where: { tenantId: school.id } });
    await expect(forTenant(id).transaction((tx) => getSchoolSettings(tx, id))).rejects.toThrow(/has no settings row/);
  });

  test("the row goes with its school (cascade), and cannot name a school that does not exist", async () => {
    const school = await db.tenant.create({ data: { code: `c-${suffix()}`, name: "Cascade" } });
    expect(await db.schoolSettings.count({ where: { tenantId: school.id } })).toBe(1);
    await db.tenant.delete({ where: { id: school.id } });
    expect(await db.schoolSettings.count({ where: { tenantId: school.id } })).toBe(0);
    await expect(db.schoolSettings.create({ data: { tenantId: "no-such-school" } })).rejects.toThrow(/Foreign key constraint/);
  });
});

test.describe("TenantMembership.permissions (decision 4 and the staff-only CHECK of decision 6)", () => {
  test("a new membership holds none; staff roles can hold any of the four; the raw write is what the CHECK guards", async () => {
    const school = await createTenant({ name: "Perms" });
    const teacher = await createUser();
    const membership = await addMembership(teacher.id, school.id, Role.TEACHING_STAFF);
    expect(membership.permissions).toEqual([]);
    const granted = await db.tenantMembership.update({
      where: { id: membership.id },
      data: { permissions: ["CAN_APPROVE_RESULTS", "CAN_MANAGE_FINANCE", "CAN_PUBLISH_CONTENT", "CAN_MANAGE_USERS"] },
    });
    expect(granted.permissions).toHaveLength(4);
    const bursar = await addMembership(await createUser().then((u) => u.id), school.id, Role.NON_TEACHING_STAFF);
    expect(
      (await db.tenantMembership.update({ where: { id: bursar.id }, data: { permissions: ["CAN_MANAGE_FINANCE"] } })).permissions,
    ).toEqual(["CAN_MANAGE_FINANCE"]);
  });

  test("the database REFUSES a permission on an ADMIN, a STUDENT or a PARENT — however the row is written", async () => {
    const school = await createTenant({ name: "Staff only" });
    for (const role of [Role.ADMIN, Role.STUDENT, Role.PARENT]) {
      const user = await createUser();
      const membership = await addMembership(user.id, school.id, role);
      await expect(
        db.tenantMembership.update({ where: { id: membership.id }, data: { permissions: ["CAN_MANAGE_USERS"] } }),
        `update ${role}`,
      ).rejects.toThrow(/staff_only|check constraint/i);
      await expect(
        db.tenantMembership.create({
          data: { userId: (await createUser()).id, tenantId: school.id, role, permissions: ["CAN_APPROVE_RESULTS"] },
        }),
        `insert ${role}`,
      ).rejects.toThrow(/staff_only|check constraint/i);
      await expect(
        db.$executeRaw`UPDATE "TenantMembership" SET "permissions" = ARRAY['CAN_PUBLISH_CONTENT']::"Permission"[] WHERE "id" = ${membership.id}`,
        `raw ${role}`,
      ).rejects.toThrow(/staff_only|check constraint/i);
    }
  });

  test("demoting a holder to a non-staff role by raw SQL is refused too (the constraint is on the PAIR)", async () => {
    const school = await createTenant({ name: "Pair" });
    const user = await createUser();
    const membership = await addMembership(user.id, school.id, Role.TEACHING_STAFF);
    await db.tenantMembership.update({ where: { id: membership.id }, data: { permissions: ["CAN_MANAGE_FINANCE"] } });
    await expect(db.tenantMembership.update({ where: { id: membership.id }, data: { role: Role.PARENT } })).rejects.toThrow(
      /staff_only|check constraint/i,
    );
    expect(await db.tenantMembership.update({ where: { id: membership.id }, data: { role: Role.PARENT, permissions: [] } })).toMatchObject({
      role: "PARENT",
      permissions: [],
    }); // both together is fine
  });
});
