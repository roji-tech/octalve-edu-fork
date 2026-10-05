import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, db, seedInstance } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// The tenant boundary on the Solo servers (domain-implementation-plan.md §0.5.2): the install is ONE school,
// resolved from the database, with the membership check intact. A separate file from tenant-boundary.spec.ts on
// purpose — that one puts several schools in the database, which a Solo server (correctly) refuses to serve.

const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

test.beforeAll(async () => {
  await seedInstance();
});

test("the one school: a member gets in, a stranger and a wrong code get the same 403, signed out is 401", async () => {
  const member = await createUser({ role: Role.TEACHING_STAFF });
  const stranger = await createUser();
  const tenant = await db.tenant.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const memberCookie = cookieHeader((await loginAs(member)).token!);
  const strangerCookie = cookieHeader((await loginAs(stranger)).token!);

  const ok = await api(`/api/v1/schools/${tenant.code}`, { cookie: memberCookie });
  expect(ok.status).toBe(200);
  expect(ok.json.data.role).toBe("TEACHING_STAFF");
  const wrongCode = await api("/api/v1/schools/someone-elses", { cookie: memberCookie });
  const noMembership = await api(`/api/v1/schools/${tenant.code}`, { cookie: strangerCookie });
  expect(wrongCode.status).toBe(403);
  expect(noMembership.status).toBe(403);
  expect(wrongCode.json).toEqual(NO_ACCESS);
  expect(noMembership.json).toEqual(NO_ACCESS);
  expect((await api(`/api/v1/schools/${tenant.code}`)).status).toBe(401);
});

test("a second school in a Solo install is a 500 (fail closed), never 'the first school' — and the 500 names nothing", async () => {
  const member = await createUser({ role: Role.ADMIN });
  const tenant = await db.tenant.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const cookie = cookieHeader((await loginAs(member)).token!);
  const extra = await db.tenant.create({ data: { code: "intruder-school", name: "Intruder School" } });
  try {
    const res = await api(`/api/v1/schools/${tenant.code}`, { cookie });
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe("TENANT_MISCONFIGURED");
    expect(res.text).not.toContain("Intruder");
    expect(res.text).not.toContain(extra.id);
    expect((await api(`/api/v1/schools/${extra.code}`, { cookie })).status).toBe(500); // not "now you are in the other one"
  } finally {
    await db.tenant.delete({ where: { id: extra.id } }); // the other specs run against a one-school install
  }
  expect((await api(`/api/v1/schools/${tenant.code}`, { cookie })).status).toBe(200);
});
