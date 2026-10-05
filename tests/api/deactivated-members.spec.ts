import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, addMembership, createTenant, createUser, db, deactivateMembership, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// What deactivation means over real HTTP: access ends on the person's NEXT request (the role is read from the membership every
// time, so nothing needs revoking), and the person is no longer treated as an administrator when they sign in.

const SAAS = { baseUrl: SAAS_URL };
const DAY_MS = 86_400_000;
const near = (actual: Date, expected: number) => Math.abs(actual.getTime() - expected) < 60_000;

let school: TestTenant;
test.beforeAll(async () => {
  await seedInstance();
  school = await createTenant({ name: "Alpha School", campuses: ["North"] });
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test("a person deactivated while signed in loses the school on their very next request — and /me stops listing it", async () => {
  const user = await createUser();
  await addMembership(user.id, school.id, Role.TEACHING_STAFF, school.campuses[0].id);
  const login = await loginAs(user, SAAS);
  const cookie = cookieHeader(login.token!);
  expect((await api(`/api/v1/schools/${school.code}`, { ...SAAS, cookie })).status).toBe(200);
  expect((await api("/api/v1/auth/me", { ...SAAS, cookie })).json.data.memberships).toHaveLength(1);

  await deactivateMembership(user.id, school.id);
  const after = await api(`/api/v1/schools/${school.code}`, { ...SAAS, cookie });
  expect(after.status).toBe(403);
  expect((await api("/api/v1/auth/me", { ...SAAS, cookie })).json.data.memberships).toEqual([]);
  expect((await api("/api/v1/auth/me", { ...SAAS, cookie })).status).toBe(200); // they are still a signed-in PERSON
});

test("sign-in treats a deactivated administrator as an ordinary person: the 7-day administrator cap does not apply (and does for an active one)", async () => {
  const active = await createUser();
  const former = await createUser();
  await addMembership(active.id, school.id, Role.ADMIN);
  await addMembership(former.id, school.id, Role.ADMIN);
  await deactivateMembership(former.id, school.id);
  for (const [user, days] of [[active, 7], [former, 90]] as const) {
    const res = await loginAs(user, { ...SAAS, remember: true });
    expect(res.status).toBe(200);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    expect(near(row.absoluteExpires, Date.now() + days * DAY_MS), `${days}-day cap`).toBe(true);
  }
});
