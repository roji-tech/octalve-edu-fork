import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL, UNSAFE_RLS_URL } from "../support/env";
import { Role, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant, type TestUser } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// `assertRlsEnforced()` is wired into the tenant resolver (domain-implementation-plan.md §0.5.2, item 8). A production
// process whose database role bypasses row-level security (the migrator / table owner — the easiest mistake to make, and
// one `CREATE POLICY` never complains about) must REFUSE to serve tenant data, not serve it with the policies silently
// off. The sixth test server is exactly that misconfiguration: SaaS-shaped, production mode, connected as the admin.

let school: TestTenant;
let admin: TestUser;
let cookie: string;

test.beforeAll(async () => {
  await seedInstance();
  school = await createTenant({ name: "Guarded School", campuses: ["Zeta Hall"] });
  admin = await createUser();
  await addMembership(admin.id, school.id, Role.ADMIN);
  const res = await loginAs(admin, { baseUrl: SAAS_URL });
  expect(res.status).toBe(200);
  cookie = cookieHeader(res.token!);
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test("the correctly configured server (runtime role) serves the school", async () => {
  const res = await api(`/api/v1/schools/${school.code}`, { baseUrl: SAAS_URL, cookie });
  expect(res.status).toBe(200);
  expect(res.json.data.school.name).toBe("Guarded School");
});

test("the same request to a server connected as the table owner is REFUSED (500), and says nothing about why", async () => {
  const res = await api(`/api/v1/schools/${school.code}`, { baseUrl: UNSAFE_RLS_URL, cookie });
  expect(res.status).toBe(500);
  expect(res.json.data).toBeNull();
  expect(res.json.error).toEqual({ code: "TENANT_MISCONFIGURED", message: "This installation is misconfigured. Contact your administrator." });
  // The reason goes to the server's log, never to the caller: no role names, no SQL, no "row-level security".
  expect(res.text).not.toMatch(/row-level|bypass|superuser|octalve|app_user|postgres/i);
  expect(res.text).not.toContain("Guarded School");
});

test("…so does the school PAGE: no school DATA is rendered (the person's own school list in the shell is identity, not tenant data)", async () => {
  const res = await fetch(`${UNSAFE_RLS_URL}/schools/${school.code}`, { headers: { cookie, "x-real-ip": "10.55.0.1" }, redirect: "manual" });
  expect(res.status).toBe(500);
  const html = await res.text();
  expect(html).not.toContain("Zeta Hall"); // the school's campus — read through the tenant context, which was refused
  expect(html).not.toContain("Welcome,"); // and nothing of the page itself
});

test("only tenant data is refused — routes that never touch a tenant still work on that server", async () => {
  const res = await api(`/api/v1/auth/me`, { baseUrl: UNSAFE_RLS_URL, cookie });
  expect(res.status).toBe(200);
  expect(res.json.data.user.id).toBe(admin.id);
  expect(await db.tenant.count({ where: { id: school.id } })).toBe(1); // and nothing was written along the way
});
