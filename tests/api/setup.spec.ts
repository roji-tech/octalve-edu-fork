import "../support/env";
import { test, expect } from "@playwright/test";
import { createUser, db, resetDatabase, seedInstance, uniqueEmail, uniqueIp } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

const SETUP = "/api/v1/setup";

// The first-run wizard endpoint (built in 0.5.0, migrated onto the new limiter
// and password rules in 0.5.1) — and the flow that matters most: what it
// creates must be able to sign in. Every test here needs a fresh install.
test.describe.configure({ mode: "serial" });
test.beforeEach(async () => {
  await resetDatabase();
});

const valid = () => ({
  schoolName: "Bright Future Academy",
  name: "Amina Yusuf",
  email: uniqueEmail("setup"),
  password: "correct-horse-battery-9",
});
const post = (body: unknown, opts: { ip?: string | null; origin?: string | null } = {}) => api(SETUP, { body, ...opts });

test.describe("GET /api/v1/setup", () => {
  test("reports whether setup is complete", async () => {
    expect((await api(SETUP)).json.data).toEqual({ setupComplete: false, requiresToken: false });
    await seedInstance();
    expect((await api(SETUP)).json.data.setupComplete).toBe(true);
  });
});

test.describe("POST /api/v1/setup — success and what it creates", () => {
  test("creates the school, an ADMIN with a bcrypt-hashed password, and an audit row — and that admin can sign in", async () => {
    const body = { ...valid(), email: "Amina@BrightFuture.TEST" };
    const res = await post(body);

    expect(res.status).toBe(201);
    expect(res.json.data.admin).toMatchObject({ name: "Amina Yusuf", email: "amina@brightfuture.test" }); // normalised
    expect(res.json.data.tenant).toMatchObject({ name: "Bright Future Academy", code: "bright-future-academy" });

    const user = await db.user.findUniqueOrThrow({ where: { email: "amina@brightfuture.test" } });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(user.passwordHash).not.toContain(body.password);

    const memberships = await db.tenantMembership.findMany({ where: { userId: user.id } });
    expect(memberships.map((m) => m.role)).toEqual(["ADMIN"]);
    expect((await db.systemSettings.findUniqueOrThrow({ where: { id: "global" } })).setupComplete).toBe(true);

    // The school exists with its kind and its settings row — made by the database trigger, through the wizard's own code path (runtime role,
    // tenant context not yet set): the secure defaults are in place without the wizard knowing the table exists.
    const school = await db.tenant.findUniqueOrThrow({ where: { code: "bright-future-academy" } });
    expect(school.schoolType).toBe("K12");
    expect(await db.schoolSettings.findUniqueOrThrow({ where: { tenantId: school.id } })).toMatchObject({
      resultApprovalRequired: true,
      mfaRequiredForTeaching: true,
    });

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "SETUP_WIZARD_COMPLETE" } });
    expect(audit.actorUserId).toBe(user.id);
    expect(JSON.stringify(audit)).not.toContain(body.password); // the password must never reach the audit trail

    // Flow connectivity: setup -> sign in -> who am I.
    const login = await loginAs({ email: "amina@brightfuture.test", password: body.password });
    expect(login.status).toBe(200);
    const me = await api("/api/v1/auth/me", { cookie: cookieHeader(login.token!) });
    expect(me.json.data.memberships[0]).toMatchObject({ role: "ADMIN", tenantName: "Bright Future Academy" });
  });

  test("a second attempt is refused — the wizard disables itself", async () => {
    expect((await post(valid())).status).toBe(201);
    const again = await post(valid());
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("ALREADY_COMPLETE");
    expect(await db.tenant.count()).toBe(1);
    expect(await db.user.count()).toBe(1);
  });

  test("two simultaneous attempts: exactly one wins (atomic conditional update)", async () => {
    const results = await Promise.all([post(valid()), post(valid())]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.tenant.count()).toBe(1);
    expect(await db.user.count()).toBe(1);
  });

  test("an existing account with the same email is a conflict, not an overwrite", async () => {
    const existing = await createUser({ email: "taken@school.test" });
    await db.systemSettings.deleteMany({}); // instance not yet marked complete
    const res = await post({ ...valid(), email: existing.email });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("DUPLICATE_EMAIL");
  });
});

test.describe("POST /api/v1/setup — guards", () => {
  test("CSRF: refused without a same-origin Origin, and nothing is created", async () => {
    for (const origin of [null, "https://evil.example"]) {
      const res = await post(valid(), { origin });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe("CSRF");
    }
    expect(await db.user.count()).toBe(0);
  });

  test("invalid JSON is a 400", async () => {
    const res = await api(SETUP, { rawBody: "{oops", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_BODY");
  });

  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["blank school name", { schoolName: "   " }, /school name/i],
    ["blank admin name", { name: "" }, /name/i],
    ["not an email", { email: "nope" }, /email/i],
    ["password shorter than 8", { password: "abc123" }, /at least 8/i],
    ["password without a number", { password: "onlyletters" }, /number/i],
    ["password without a letter", { password: "12345678" }, /letter/i],
    ["password over 128 characters", { password: `a1${"b".repeat(130)}` }, /at most 128/i],
    ["password over 72 BYTES (bcrypt would silently truncate it)", { password: `a1${"b".repeat(71)}` }, /72 bytes/i],
    ["a short-looking password that is over 72 bytes (25 emoji + a1)", { password: `a1${"😀".repeat(25)}` }, /72 bytes/i],
  ];
  for (const [label, override, message] of bad) {
    test(`rejects ${label} with a 400 that says why`, async () => {
      const res = await post({ ...valid(), ...override });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(res.json.error.message).toMatch(message);
      expect(await db.user.count()).toBe(0);
    });
  }

  test("a body that names a school type is refused, whatever the value, and nothing is created (the type is the server's decision)", async () => {
    for (const schoolType of ["HIGHER_ED", "VOCATIONAL", "K12", "nonsense", null]) {
      const res = await post({ ...valid(), schoolType });
      expect(res.status, String(schoolType)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(res.json.error.message).toMatch(/set by the server/i);
    }
    expect(await db.user.count()).toBe(0);
    expect(await db.tenant.count()).toBe(0);
  });

  test("a password of exactly 72 bytes is accepted and works at sign-in (no truncation surprises)", async () => {
    const password = `a1${"b".repeat(70)}`;
    expect(Buffer.byteLength(password)).toBe(72);
    const body = { ...valid(), password };
    expect((await post(body)).status).toBe(201);
    expect((await loginAs({ email: body.email, password })).status).toBe(200);
    // …and it is the WHOLE password that counts: a different final character fails.
    expect((await loginAs({ email: body.email, password: password.slice(0, -1) + "c" })).status).toBe(401);
  });

  test("failed attempts are rate limited per IP (6th is 429); the limit key is the trusted client IP", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) expect((await post({ ...valid(), password: "x" }, { ip })).status).toBe(400);
    expect((await post({ ...valid(), password: "x" }, { ip })).status).toBe(429);
    expect((await post(valid(), { ip })).status).toBe(429); // even a valid request from that IP
    expect((await post(valid(), { ip: uniqueIp() })).status).toBe(201); // another IP is fine
  });
});
