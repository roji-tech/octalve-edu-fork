import { HTTP_PORT, HTTP_URL } from "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, db, sha256Hex, uniqueEmail, uniqueIp } from "../support/db";
import { api, cookieHeader, loginAs, parseSetCookie, sessionCookie } from "../support/http";

const LOGIN = "/api/v1/auth/login";
const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("POST /api/v1/auth/login — success", () => {
  test("returns the user in the standard envelope, sets the session cookie, and is uncacheable", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF, name: "Zainab Bello" });
    const res = await loginAs(user);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      data: { user: { id: user.id, name: "Zainab Bello", email: user.email }, accountThrottled: false },
      meta: {},
      error: null,
    });
    expect(res.text).not.toMatch(/passwordHash|\$2[aby]\$/); // never leaks the hash
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("cookie is HttpOnly, SameSite=Lax, Path=/, not Secure over http, no Domain; ~90d for a remembered non-admin", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const res = await loginAs(user, { remember: true });
    const cookie = sessionCookie(res)!;

    expect(cookie.attributes.get("httponly")).toBe(true);
    expect(String(cookie.attributes.get("samesite")).toLowerCase()).toBe("lax");
    expect(cookie.attributes.get("path")).toBe("/");
    expect(cookie.attributes.has("secure")).toBe(false);
    expect(cookie.attributes.has("domain")).toBe(false);
    const expires = new Date(String(cookie.attributes.get("expires"))).getTime();
    expect(Math.abs(expires - (Date.now() + 90 * DAY_MS))).toBeLessThan(2 * 60_000);
  });

  test("an ADMIN anywhere gets the shorter ~7-day cookie, even when remembered", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const cookie = sessionCookie(await loginAs(admin, { remember: true }))!;
    const expires = new Date(String(cookie.attributes.get("expires"))).getTime();
    expect(Math.abs(expires - (Date.now() + 7 * DAY_MS))).toBeLessThan(2 * 60_000);
  });

  test("email is trimmed and case-insensitive", async () => {
    const user = await createUser({ email: uniqueEmail("case") });
    const res = await loginAs({ email: `  ${user.email.toUpperCase()}  `, password: user.password });
    expect(res.status).toBe(200);
    expect(res.json.data.user.email).toBe(user.email);
  });

  test("the cookie value is stored only as its SHA-256 hash (checked in the real database)", async () => {
    const user = await createUser();
    const { token } = await loginAs(user);
    const rows = await db.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256Hex(token!));
    const plaintextHits = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Session" s WHERE s::text LIKE ${"%" + token + "%"}`;
    expect(plaintextHits[0].n).toBe(0);
  });

  test("records the user agent for the future 'active devices' page", async () => {
    const user = await createUser();
    await loginAs(user, { headers: { "user-agent": "OctalveTest/1.0" } });
    expect((await db.session.findFirstOrThrow({ where: { userId: user.id } })).userAgent).toBe("OctalveTest/1.0");
  });
});

// "Keep me signed in on this device" (plan §0.5.A). Not remembered — the default — is a
// browser-session cookie AND a hard 12-hour cap held by the SERVER, because a session cookie
// alone can outlive "closing the browser" (session restore). Remembered is the long policy.
test.describe("POST /api/v1/auth/login — remember me", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const near = (actual: Date | number, expected: number) =>
    Math.abs(new Date(actual).getTime() - expected) < 2 * 60_000;

  test("by default (no `remember`): a session cookie with no Expires/Max-Age, and a 12-hour server cap", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const res = await loginAs(user);
    const cookie = sessionCookie(res)!;

    expect(cookie.attributes.has("expires")).toBe(false);
    expect(cookie.attributes.has("max-age")).toBe(false);
    // …but everything else about the cookie is unchanged.
    expect(cookie.attributes.get("httponly")).toBe(true);
    expect(String(cookie.attributes.get("samesite")).toLowerCase()).toBe("lax");
    expect(cookie.attributes.get("path")).toBe("/");

    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(near(row.absoluteExpires, Date.now() + 12 * HOUR_MS)).toBe(true);
    expect(row.expires.getTime()).toBe(row.absoluteExpires.getTime()); // idle can never outlast the cap
  });

  test("`remember: false` is the same as leaving it out", async () => {
    const user = await createUser();
    const res = await loginAs(user, { remember: false });
    expect(sessionCookie(res)!.attributes.has("expires")).toBe(false);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(near(row.absoluteExpires, Date.now() + 12 * HOUR_MS)).toBe(true);
  });

  test("`remember: true`: a persistent cookie, 30-day idle and 90-day absolute in the database", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const res = await loginAs(user, { remember: true });
    const cookie = sessionCookie(res)!;

    expect(near(new Date(String(cookie.attributes.get("expires"))), Date.now() + 90 * DAY_MS)).toBe(true);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(near(row.absoluteExpires, Date.now() + 90 * DAY_MS)).toBe(true);
    expect(near(row.expires, Date.now() + 30 * DAY_MS)).toBe(true);
  });

  test("the admin cap composes: an admin who does not tick the box still gets 12 hours, one who does gets 7 days", async () => {
    const admin = await createUser({ role: Role.ADMIN });

    const plain = await loginAs(admin);
    expect(sessionCookie(plain)!.attributes.has("expires")).toBe(false);
    let row = await db.session.findFirstOrThrow({ where: { tokenHash: sha256Hex(plain.token!) } });
    expect(near(row.absoluteExpires, Date.now() + 12 * HOUR_MS)).toBe(true);

    const remembered = await loginAs(admin, { remember: true });
    expect(near(new Date(String(sessionCookie(remembered)!.attributes.get("expires"))), Date.now() + 7 * DAY_MS)).toBe(true);
    row = await db.session.findFirstOrThrow({ where: { tokenHash: sha256Hex(remembered.token!) } });
    expect(near(row.absoluteExpires, Date.now() + 7 * DAY_MS)).toBe(true);
  });

  test("both kinds of session actually work", async () => {
    const user = await createUser();
    for (const remember of [false, true]) {
      const { token } = await loginAs(user, { remember });
      expect((await api("/api/v1/auth/me", { cookie: cookieHeader(token!) })).status).toBe(200);
    }
  });

  test("`remember` is a STRICT boolean: anything else is the same 401 as any malformed body, and creates nothing", async () => {
    const user = await createUser();
    for (const remember of ["true", "yes", 1, 0, null, [], {}]) {
      const res = await api(LOGIN, { body: { email: user.email, password: user.password, remember } });
      expect(res.status, `remember=${JSON.stringify(remember)}`).toBe(401);
      expect(res.json.error.code).toBe("INVALID_CREDENTIALS");
      expect(sessionCookie(res)).toBeUndefined();
    }
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });
});

test.describe("POST /api/v1/auth/login — session hygiene", () => {
  test("two logins are two independent sessions (multi-device), each with its own token", async () => {
    const user = await createUser();
    const a = await loginAs(user);
    const b = await loginAs(user);
    expect(a.token).not.toBe(b.token);
    for (const t of [a.token!, b.token!]) {
      expect((await api("/api/v1/auth/me", { cookie: cookieHeader(t) })).status).toBe(200);
    }
  });

  test("rotation: logging in while presenting a session deletes that session", async () => {
    const user = await createUser();
    const first = await loginAs(user);
    const second = await loginAs(user, { cookie: cookieHeader(first.token!) });

    expect(second.token).not.toBe(first.token);
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(first.token!) })).status).toBe(401);
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(second.token!) })).status).toBe(200);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  test("session fixation: a client-chosen cookie is never adopted", async () => {
    const user = await createUser();
    const attackerChosen = "a".repeat(64);
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(attackerChosen) })).status).toBe(401);

    const res = await loginAs(user, { cookie: cookieHeader(attackerChosen) });
    expect(res.status).toBe(200);
    expect(res.token).not.toBe(attackerChosen);
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(attackerChosen) })).status).toBe(401);
  });
});

test.describe("POST /api/v1/auth/login — failure responses", () => {
  test("wrong password and unknown account are indistinguishable (status, code, message, headers, no cookie)", async () => {
    const user = await createUser();
    const wrongPassword = await api(LOGIN, { body: { email: user.email, password: "definitely-wrong-1" } });
    const unknownAccount = await api(LOGIN, {
      body: { email: uniqueEmail("nobody"), password: "definitely-wrong-1" },
    });

    for (const res of [wrongPassword, unknownAccount]) {
      expect(res.status).toBe(401);
      expect(res.json).toEqual({
        data: null,
        meta: {},
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.setCookies).toHaveLength(0);
    }
    expect(wrongPassword.text).toBe(unknownAccount.text);
  });

  test("an invited account with no password yet fails exactly like a wrong password", async () => {
    const invited = await createUser({ password: null });
    const res = await api(LOGIN, { body: { email: invited.email, password: "whatever-1234" } });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("INVALID_CREDENTIALS");
    expect(res.setCookies).toHaveLength(0);
  });

  const invalidBodies: [string, unknown][] = [
    ["empty object", {}],
    ["array", []],
    ["a bare string", "hello"],
    ["email is a number", { email: 123, password: "x" }],
    ["not an email", { email: "not-an-email", password: "x" }],
    ["empty password", { email: "a@b.co", password: "" }],
    ["password over the 128-char bound", { email: "a@b.co", password: "x".repeat(129) }],
    ["email over 254 chars", { email: `${"a".repeat(250)}@b.co`, password: "x" }],
    ["missing password", { email: "a@b.co" }],
    ["password is an object", { email: "a@b.co", password: { $ne: "" } }],
  ];
  for (const [label, body] of invalidBodies) {
    test(`schema-invalid input (${label}) gets the same 401 — validation rules aren't probeable`, async () => {
      const res = await api(LOGIN, { body });
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("INVALID_CREDENTIALS");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.setCookies).toHaveLength(0);
    });
  }

  test("an over-long password is rejected by validation BEFORE any password work (it never touches the account's failure budget)", async () => {
    // If the 128-char bound weren't enforced, each of these would be a full
    // failed login that reserves the per-account budget (5) — and the correct
    // login below would come back 429 instead of 200.
    const user = await createUser();
    const ip = uniqueIp();
    for (let i = 0; i < 8; i++) {
      const res = await api(LOGIN, { body: { email: user.email, password: "x".repeat(129) }, ip });
      expect(res.status).toBe(401);
    }
    expect((await loginAs(user, { ip })).status).toBe(200);
  });

  test("a body that isn't JSON is a 400 INVALID_BODY (and still uncacheable)", async () => {
    for (const rawBody of ["{not json", ""]) {
      const res = await api(LOGIN, { rawBody, headers: { "content-type": "application/json" } });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_BODY");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("only POST is allowed", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await api(LOGIN, { method, ip: uniqueIp() });
      expect(res.status).toBe(405);
    }
  });

  test("a plaintext password is never echoed back in any response", async () => {
    const user = await createUser();
    const secret = "S3cret-echo-check-Zx9";
    const res = await api(LOGIN, { body: { email: user.email, password: secret } });
    expect(res.text).not.toContain(secret);
  });
});

test.describe("POST /api/v1/auth/login — CSRF (same-origin check before anything else)", () => {
  const good = (user: { email: string; password: string }) => ({ email: user.email, password: user.password });

  test("no Origin and no Referer is refused, even with correct credentials, and no session is created", async () => {
    const user = await createUser();
    const res = await api(LOGIN, { body: good(user), origin: null });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
    expect(res.setCookies).toHaveLength(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  for (const origin of [
    "https://evil.example",
    `http://localhost:${HTTP_PORT + 1}`, // same host, different port = different origin
    `${HTTP_URL}.evil.example`, // host-suffix trick
    `http://localhost:${HTTP_PORT}@evil.example`, // userinfo trick: the real host is evil.example
    "null", // sandboxed iframes / file:// send the literal string "null"
  ]) {
    test(`Origin ${origin} is refused`, async () => {
      const user = await createUser();
      const res = await api(LOGIN, { body: good(user), origin });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe("CSRF");
      expect(res.setCookies).toHaveLength(0);
    });
  }

  test("a same-origin Referer is accepted when there is no Origin (older browsers / some form posts)", async () => {
    const user = await createUser();
    const res = await api(LOGIN, {
      body: good(user),
      origin: null,
      headers: { referer: `${HTTP_URL}/login` },
    });
    expect(res.status).toBe(200);
  });

  test("a foreign Referer is refused", async () => {
    const user = await createUser();
    const res = await api(LOGIN, {
      body: good(user),
      origin: null,
      headers: { referer: "https://evil.example/login" },
    });
    expect(res.status).toBe(403);
  });

  test("the same-origin Origin is accepted", async () => {
    const user = await createUser();
    expect((await api(LOGIN, { body: good(user), origin: HTTP_URL })).status).toBe(200);
  });
});

test.describe("Set-Cookie parsing sanity (guards the helper the other assertions lean on)", () => {
  test("parseSetCookie splits name, value and attributes", () => {
    const c = parseSetCookie("a=b=c; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(c.name).toBe("a");
    expect(c.value).toBe("b=c");
    expect(c.attributes.get("path")).toBe("/");
    expect(c.attributes.get("httponly")).toBe(true);
    expect(c.attributes.get("max-age")).toBe("0");
  });
});
