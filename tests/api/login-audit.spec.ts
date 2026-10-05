import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, db, seedInstance, uniqueEmail, uniqueIp } from "../support/db";
import { api, loginAs } from "../support/http";

// Sign-ins on the person's audit trail (plan §0.5.3, E): LOGIN_SUCCEEDED always; LOGIN_BLOCKED once per window for a
// KNOWN account; never an IP address; never a row for an unknown address.

const LOGIN = "/api/v1/auth/login";
const wrong = (email: string) => ({ email, password: "definitely-wrong-1" });
const UA_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";

test.beforeAll(async () => {
  await seedInstance();
});

const rows = (userId: string, action: string) => db.auditLog.findMany({ where: { actorUserId: userId, action } });

test("a successful sign-in is audited with the KIND of device and whether it was remembered — and no IP address anywhere", async () => {
  const user = await createUser({ role: Role.TEACHING_STAFF });
  const ip = "10.77.66.55";
  await loginAs(user, { ip, headers: { "user-agent": UA_FIREFOX }, remember: true });
  await expect.poll(async () => (await rows(user.id, "LOGIN_SUCCEEDED")).length).toBe(1);
  const [row] = await rows(user.id, "LOGIN_SUCCEEDED");
  expect(row.afterValue).toEqual({ device: "Firefox on Linux", remembered: true });
  expect(row.targetId).toBe(user.id);
  expect(JSON.stringify(row)).not.toContain(ip);
  expect(JSON.stringify(row)).not.toContain("Mozilla"); // the raw user agent is not copied either
});

test("a failed sign-in is NOT audited as a success; each success adds exactly one row", async () => {
  const user = await createUser({ role: Role.TEACHING_STAFF });
  await api(LOGIN, { body: wrong(user.email) });
  await loginAs(user);
  await loginAs(user);
  await expect.poll(async () => (await rows(user.id, "LOGIN_SUCCEEDED")).length).toBe(2);
  await new Promise((r) => setTimeout(r, 800));
  expect((await rows(user.id, "LOGIN_SUCCEEDED")).length).toBe(2);
});

test("being blocked: ONE LOGIN_BLOCKED row per window however many attempts follow; the 429 is the same for a known and an unknown address", async () => {
  const user = await createUser({ role: Role.TEACHING_STAFF });
  const ghost = uniqueEmail("ghost");
  const ip = uniqueIp();
  const ghostIp = uniqueIp();
  for (let i = 0; i < 5; i++) {
    await api(LOGIN, { body: wrong(user.email), ip });
    await api(LOGIN, { body: wrong(ghost), ip: ghostIp });
  }
  const knownBlocked = await api(LOGIN, { body: wrong(user.email), ip });
  const ghostBlocked = await api(LOGIN, { body: wrong(ghost), ip: ghostIp });
  expect(knownBlocked.status).toBe(429);
  expect(knownBlocked.json).toEqual(ghostBlocked.json);
  for (let i = 0; i < 6; i++) await api(LOGIN, { body: wrong(user.email), ip }); // keep hammering
  await expect.poll(async () => (await rows(user.id, "LOGIN_BLOCKED")).length).toBe(1);
  await new Promise((r) => setTimeout(r, 800));
  expect((await rows(user.id, "LOGIN_BLOCKED")).length).toBe(1);
  expect((await rows(user.id, "LOGIN_BLOCKED"))[0].reason).toMatch(/Too many failed sign-in attempts/);
  // Nothing at all for the address that has no account:
  expect(await db.auditLog.count({ where: { action: "LOGIN_BLOCKED", reason: { contains: ghost } } })).toBe(0);
});
