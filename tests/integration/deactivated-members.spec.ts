import { test, expect } from "@playwright/test";
import { Role, addMembership, createTenant, createUser, db, deactivateMembership, reactivateMembership, removeCreatedTenants, seedInstance } from "../support/db";
import { withEnv } from "../support/with-env";
import { resolveTenant } from "@/lib/tenant/resolve-tenant";
import { getUserMemberships } from "@/lib/auth/memberships";
import { auditPersonEvent } from "@/lib/auth/audit";

// A deactivated membership is NO membership (domain-implementation-plan.md §0.5.4): the row stays — history, and a way back —
// but every reader of memberships treats it as absent. That is a rule many places must remember, so each reader is pinned here
// (the HTTP layer pins the same for every school route, and the sign-in admin policy; see tests/api).

test.beforeAll(async () => {
  await seedInstance();
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

test.describe("resolveTenant", () => {
  test("saas: a deactivated member gets the SAME refusal as a stranger — and the way back is reactivation", async () => {
    await withEnv({ DEPLOYMENT_MODE: "saas" }, async () => {
      const school = await createTenant({ name: "Alpha School", campuses: ["North"] });
      const member = await createUser();
      const stranger = await createUser();
      await addMembership(member.id, school.id, Role.TEACHING_STAFF, school.campuses[0].id);
      expect(await resolveTenant({ userId: member.id, code: school.code })).toMatchObject({ ok: true, tenant: { role: "TEACHING_STAFF" } });

      await deactivateMembership(member.id, school.id);
      const refused = await resolveTenant({ userId: member.id, code: school.code });
      expect(refused).toEqual({ ok: false, status: 403, code: "FORBIDDEN" });
      expect(refused).toEqual(await resolveTenant({ userId: stranger.id, code: school.code })); // indistinguishable from "not a member"

      await reactivateMembership(member.id, school.id);
      expect(await resolveTenant({ userId: member.id, code: school.code })).toMatchObject({ ok: true, tenant: { role: "TEACHING_STAFF", campusId: school.campuses[0].id } });
    });
  });

  test("solo (the install's one school, looked up by id): the same", async () => {
    await withEnv({ DEPLOYMENT_MODE: "solo" }, async () => {
      const tenant = await db.tenant.findFirstOrThrow(); // the install's one tenant (a second would be the Solo misconfiguration)
      const member = await createUser({ role: Role.TEACHING_STAFF });
      const stranger = await createUser();
      expect(await resolveTenant({ userId: member.id, code: tenant.code })).toMatchObject({ ok: true });
      await deactivateMembership(member.id, tenant.id);
      const refused = await resolveTenant({ userId: member.id, code: tenant.code });
      expect(refused).toEqual({ ok: false, status: 403, code: "FORBIDDEN" });
      expect(refused).toEqual(await resolveTenant({ userId: stranger.id, code: tenant.code }));
      await reactivateMembership(member.id, tenant.id);
      expect(await resolveTenant({ userId: member.id, code: tenant.code })).toMatchObject({ ok: true });
    });
  });

  test("deactivation is per school: still a member (with their own role) of the others", async () => {
    await withEnv({ DEPLOYMENT_MODE: "saas" }, async () => {
      const a = await createTenant({ name: "Alpha School", campuses: ["North"] });
      const b = await createTenant({ name: "Beta School", campuses: ["Main"] });
      const user = await createUser();
      await addMembership(user.id, a.id, Role.ADMIN);
      await addMembership(user.id, b.id, Role.PARENT);
      await deactivateMembership(user.id, a.id);
      expect((await resolveTenant({ userId: user.id, code: a.code })).ok).toBe(false);
      expect(await resolveTenant({ userId: user.id, code: b.code })).toMatchObject({ ok: true, tenant: { role: "PARENT" } });
    });
  });
});

test.describe("the other readers", () => {
  test("getUserMemberships (the school list, the front door, the shell) omits it", async () => {
    const a = await createTenant({ name: "Alpha School", campuses: [] });
    const b = await createTenant({ name: "Beta School", campuses: [] });
    const user = await createUser();
    await addMembership(user.id, a.id, Role.ADMIN);
    await addMembership(user.id, b.id, Role.STUDENT);
    expect((await getUserMemberships(user.id)).map((m) => m.tenantCode).sort()).toEqual([a.code, b.code].sort());
    await deactivateMembership(user.id, a.id);
    expect((await getUserMemberships(user.id)).map((m) => m.tenantCode)).toEqual([b.code]);
    await deactivateMembership(user.id, b.id);
    expect(await getUserMemberships(user.id)).toEqual([]);
  });

  test("auditPersonEvent writes a row only for the schools the person is STILL in", async () => {
    const a = await createTenant({ name: "Alpha School", campuses: [] });
    const b = await createTenant({ name: "Beta School", campuses: [] });
    const user = await createUser();
    await addMembership(user.id, a.id, Role.TEACHING_STAFF);
    await addMembership(user.id, b.id, Role.TEACHING_STAFF);
    await deactivateMembership(user.id, a.id);
    await auditPersonEvent(user.id, "DEACTIVATION_PROBE");
    const rows = await db.auditLog.findMany({ where: { action: "DEACTIVATION_PROBE", actorUserId: user.id } });
    expect(rows.map((r) => r.tenantId)).toEqual([b.id]); // not the school they were removed from: it must not learn their later security events
  });
});
