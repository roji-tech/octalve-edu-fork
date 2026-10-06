import "../support/env";
import { NextRequest, NextResponse } from "next/server";
import { test, expect } from "@playwright/test";
import { Permission, Role } from "@prisma/client";
import { HTTP_PORT, HTTP_URL } from "../support/env";
import {
  addMembership,
  createTenant,
  createUser,
  db,
  deactivateMembership,
  removeCreatedTenants,
  seedInstance,
  type TestTenant,
} from "../support/db";
import { withEnv } from "../support/with-env";
import { withAuth, type TenantAuthContext, type TenantRouteContext } from "@/lib/auth/with-auth";
import { SESSION_COOKIE_NAME, createSession } from "@/lib/auth/session";

// `withAuth({ tenant: true, permissions })` end to end against the real resolver and database (domain-implementation-plan.md, "Build
// design — Phase 1.0", decisions 4 and 5): permissions come from the membership IN THE VERIFIED SCHOOL, on every request.

let a: TestTenant;
let b: TestTenant;
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Perm Alpha", campuses: ["A1"] });
  b = await createTenant({ name: "Perm Beta", campuses: ["B1"] });
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

const seen: { userId: string; permissions: readonly Permission[]; role: Role }[] = [];
const handler = async (_req: NextRequest, auth: TenantAuthContext, _ctx: TenantRouteContext) => {
  seen.push({ userId: auth.userId, permissions: auth.tenant.permissions, role: auth.tenant.role });
  return NextResponse.json({ ok: true });
};
const financeOnly = withAuth(handler, { tenant: true, permissions: ["CAN_MANAGE_FINANCE"] });
const financeOrApprove = withAuth(handler, { tenant: true, permissions: ["CAN_MANAGE_FINANCE", "CAN_APPROVE_RESULTS"] });
const teachersOrFinance = withAuth(handler, { tenant: true, roles: ["TEACHING_STAFF"], permissions: ["CAN_MANAGE_FINANCE"] });
const adminsOnly = withAuth(handler, { tenant: true, roles: ["ADMIN"] });
const teachersOnly = withAuth(handler, { tenant: true, roles: ["TEACHING_STAFF"] });

async function call(route: (req: NextRequest, ctx: TenantRouteContext) => Promise<Response>, school: TestTenant, userId: string) {
  const { token } = await createSession(userId);
  const req = new NextRequest(`${HTTP_URL}/api/v1/schools/${school.code}/thing`, {
    headers: { "x-forwarded-host": `localhost:${HTTP_PORT}`, cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  return withEnv({ DEPLOYMENT_MODE: "saas" }, () => route(req, { params: Promise.resolve({ code: school.code }) }));
}
const person = async (school: TestTenant, role: Role, permissions: Permission[] = []) => {
  const user = await createUser();
  const membership = await addMembership(user.id, school.id, role);
  if (permissions.length > 0) await db.tenantMembership.update({ where: { id: membership.id }, data: { permissions } });
  return { user, membership };
};

test.describe("permissions on a school route", () => {
  test("an ADMIN passes without holding any (it implies them all); staff pass only with a LISTED permission; everyone else gets the one 403", async () => {
    const boss = await person(a, Role.ADMIN);
    const bursar = await person(a, Role.NON_TEACHING_STAFF, ["CAN_MANAGE_FINANCE"]);
    const teacherWithOther = await person(a, Role.TEACHING_STAFF, ["CAN_APPROVE_RESULTS"]);
    const teacherPlain = await person(a, Role.TEACHING_STAFF);
    const parent = await person(a, Role.PARENT);

    expect((await call(financeOnly, a, boss.user.id)).status).toBe(200);
    expect((await call(financeOnly, a, bursar.user.id)).status).toBe(200);
    for (const denied of [teacherWithOther, teacherPlain, parent]) {
      const res = await call(financeOnly, a, denied.user.id);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(NO_ACCESS); // the same body whatever the reason
    }
    expect((await call(financeOrApprove, a, teacherWithOther.user.id)).status).toBe(200); // ANY listed permission is enough
  });

  test("the handler sees the permissions held IN THIS SCHOOL (and an ADMIN's stored list is empty)", async () => {
    const bursar = await person(a, Role.NON_TEACHING_STAFF, ["CAN_MANAGE_FINANCE", "CAN_PUBLISH_CONTENT"]);
    seen.length = 0;
    await call(financeOnly, a, bursar.user.id);
    expect(seen.at(-1)).toMatchObject({ userId: bursar.user.id, role: "NON_TEACHING_STAFF" });
    expect([...seen.at(-1)!.permissions].sort()).toEqual(["CAN_MANAGE_FINANCE", "CAN_PUBLISH_CONTENT"]);
    const boss = await person(a, Role.ADMIN);
    await call(financeOnly, a, boss.user.id);
    expect(seen.at(-1)!.permissions).toEqual([]);
  });

  test("a permission held in school A is NOT honoured in school B (a membership of B with none) — and not by being a member of both", async () => {
    const both = await createUser();
    const inA = await addMembership(both.id, a.id, Role.NON_TEACHING_STAFF);
    await addMembership(both.id, b.id, Role.NON_TEACHING_STAFF);
    await db.tenantMembership.update({ where: { id: inA.id }, data: { permissions: ["CAN_MANAGE_FINANCE"] } });
    expect((await call(financeOnly, a, both.id)).status).toBe(200);
    expect((await call(financeOnly, b, both.id)).status).toBe(403); // B's membership holds none
    const stranger = await person(a, Role.NON_TEACHING_STAFF, ["CAN_MANAGE_FINANCE"]);
    expect((await call(financeOnly, b, stranger.user.id)).status).toBe(403); // not a member of B at all
  });

  test("granting and revoking take effect on the person's NEXT request — nothing is cached in the session", async () => {
    const teacher = await person(a, Role.TEACHING_STAFF);
    expect((await call(financeOnly, a, teacher.user.id)).status).toBe(403);
    await db.tenantMembership.update({ where: { id: teacher.membership.id }, data: { permissions: ["CAN_MANAGE_FINANCE"] } });
    expect((await call(financeOnly, a, teacher.user.id)).status).toBe(200);
    await db.tenantMembership.update({ where: { id: teacher.membership.id }, data: { permissions: [] } });
    expect((await call(financeOnly, a, teacher.user.id)).status).toBe(403);
  });

  test("a DEACTIVATED member holds no permission: the school is a 403 whatever they were granted — and reactivation restores it", async () => {
    const bursar = await person(a, Role.NON_TEACHING_STAFF, ["CAN_MANAGE_FINANCE"]);
    expect((await call(financeOnly, a, bursar.user.id)).status).toBe(200);
    await deactivateMembership(bursar.user.id, a.id);
    const res = await call(financeOnly, a, bursar.user.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(NO_ACCESS);
    await db.tenantMembership.update({ where: { id: bursar.membership.id }, data: { deactivatedAt: null } });
    expect((await call(financeOnly, a, bursar.user.id)).status).toBe(200);
  });

  test("role OR permission: a teacher passes by role, a bursar by permission, a plain non-teaching member is refused — and roles-only routes do not widen", async () => {
    const teacher = await person(a, Role.TEACHING_STAFF);
    const bursar = await person(a, Role.NON_TEACHING_STAFF, ["CAN_MANAGE_FINANCE"]);
    const plain = await person(a, Role.NON_TEACHING_STAFF);
    expect((await call(teachersOrFinance, a, teacher.user.id)).status).toBe(200);
    expect((await call(teachersOrFinance, a, bursar.user.id)).status).toBe(200);
    expect((await call(teachersOrFinance, a, plain.user.id)).status).toBe(403);
    // the same bursar on a roles-only route: the permission does not widen it, and an admin is not implied into a teachers-only route
    expect((await call(teachersOnly, a, bursar.user.id)).status).toBe(403);
    expect((await call(teachersOnly, a, (await person(a, Role.ADMIN)).user.id)).status).toBe(403);
    expect((await call(adminsOnly, a, bursar.user.id)).status).toBe(403);
  });

  test("the unlisted permissions never open a route: every OTHER permission is refused on a finance-only route", async () => {
    for (const other of Object.values(Permission).filter((p) => p !== "CAN_MANAGE_FINANCE")) {
      const staff = await person(a, Role.TEACHING_STAFF, [other]);
      expect((await call(financeOnly, a, staff.user.id)).status, other).toBe(403);
    }
  });
});
