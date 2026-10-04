import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, db, sha256Hex, uniqueEmail, uniqueIp } from "../support/db";
import { api, cookieHeader, loginAs, parseSetCookie } from "../support/http";
import { mailAfterGrace, mailTo, tokenFrom, waitForMail } from "../support/outbox";

const FORGOT = "/api/v1/auth/forgot-password";
const RESET = "/api/v1/auth/reset-password";
const CHANGE = "/api/v1/auth/change-password";
const GENERIC = { data: { requested: true }, meta: {}, error: null };

const requestLink = async (email: string, ip?: string) => api(FORGOT, { body: { email }, ip });
async function freshLink(user: { email: string }) {
  await requestLink(user.email);
  const mail = await waitForMail(user.email, 1);
  return tokenFrom(mail[mail.length - 1]);
}

test.describe("POST /forgot-password", () => {
  test("a known and an unknown address get IDENTICAL answers (status, body, headers)", async () => {
    const user = await createUser();
    const known = await requestLink(user.email);
    const unknown = await requestLink(uniqueEmail("nobody"));
    for (const res of [known, unknown]) {
      expect(res.status).toBe(200);
      expect(res.json).toEqual(GENERIC);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(known.text).toBe(unknown.text);
  });

  test("the email goes to the known address only, and its link works", async () => {
    const user = await createUser();
    const ghost = uniqueEmail("ghost");
    await requestLink(user.email);
    await requestLink(ghost);
    const [mail] = await waitForMail(user.email);
    expect(mail.subject).toMatch(/Reset your .* password/);
    expect(mail.text).toMatch(/#token=[A-Za-z0-9_-]{43}/);
    expect(await mailAfterGrace(ghost)).toHaveLength(0);
  });

  test("the token is stored only as its hash", async () => {
    const user = await createUser();
    const token = await freshLink(user);
    const row = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(sha256Hex(token));
  });

  test("asking again kills the earlier link", async () => {
    const user = await createUser();
    const first = await freshLink(user);
    await requestLink(user.email);
    const mail = await waitForMail(user.email, 2);
    const second = tokenFrom(mail[1]);
    expect(second).not.toBe(first);
    const stale = await api(RESET, { body: { token: first, password: "new-password-1" } });
    expect(stale.status).toBe(400);
    expect((await api(RESET, { body: { token: second, password: "new-password-1" } })).status).toBe(200);
  });

  test("the response time doesn't depend on whether the account exists (the work runs after the response)", async () => {
    const user = await createUser();
    const time = async (email: string) => {
      const t = performance.now();
      await requestLink(email);
      return performance.now() - t;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 9; i++) {
      known.push(await time(user.email));
      unknown.push(await time(uniqueEmail("nobody")));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(40); // ms; a skipped DB write + mail would be tens of ms
  });

  test("per address: the 4th request within the window gets the same 200 but NO fourth email (no mail-bombing)", async () => {
    const user = await createUser();
    for (let i = 0; i < 4; i++) {
      const res = await requestLink(user.email, uniqueIp());
      expect(res.json).toEqual(GENERIC); // never a 429 — that would reveal the address was asked for
    }
    await waitForMail(user.email, 3);
    expect(await mailAfterGrace(user.email)).toHaveLength(3);
  });

  test("per IP: the 11th request is a 429", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) expect((await requestLink(uniqueEmail("n"), ip)).status).toBe(200);
    const res = await requestLink(uniqueEmail("n"), ip);
    expect(res.status).toBe(429);
    expect(res.json.error.code).toBe("RATE_LIMITED");
  });

  test("CSRF: a cross-origin request is refused", async () => {
    const res = await api(FORGOT, { body: { email: "a@b.test" }, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });

  test("malformed input: a non-email is the same generic answer; non-JSON is a 400", async () => {
    expect((await api(FORGOT, { body: { email: "not-an-email" } })).json).toEqual(GENERIC);
    expect((await api(FORGOT, { body: {} })).json).toEqual(GENERIC);
    expect((await api(FORGOT, { rawBody: "{nope" })).status).toBe(400);
  });
});

test.describe("POST /reset-password", () => {
  test("success: 200; every session is gone; the old password stops working and the new one signs in", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { token: session } = await loginAs(user, { remember: true });
    const token = await freshLink(user);

    const res = await api(RESET, { body: { token, password: "a-brand-new-pass-1" } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: { reset: true }, meta: {}, error: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The browser is told to drop whatever session cookie it held.
    expect(res.setCookies.map(parseSetCookie).find((c) => c.name === "octalve.session-token")?.attributes.get("max-age")).toBe("0");

    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(session!) })).status).toBe(401);
    expect((await loginAs(user)).status).toBe(401); // old password
    expect((await loginAs({ email: user.email, password: "a-brand-new-pass-1" })).status).toBe(200);
  });

  test("it does NOT sign the person in", async () => {
    const user = await createUser();
    const res = await api(RESET, { body: { token: await freshLink(user), password: "a-brand-new-pass-1" } });
    expect(res.setCookies.map(parseSetCookie).find((c) => c.value)).toBeUndefined();
  });

  test("single use: the same link twice → the second is the generic 400", async () => {
    const user = await createUser();
    const token = await freshLink(user);
    expect((await api(RESET, { body: { token, password: "first-new-pass-1" } })).status).toBe(200);
    const again = await api(RESET, { body: { token, password: "second-new-pass-2" } });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe("INVALID_TOKEN");
  });

  test("unknown, expired and used links all get the IDENTICAL refusal", async () => {
    const user = await createUser();
    const expired = await freshLink(user);
    await db.passwordResetToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const refusals = [
      await api(RESET, { body: { token: "A".repeat(43), password: "a-new-password-1" } }),
      await api(RESET, { body: { token: expired, password: "a-new-password-1" } }),
      await api(RESET, { body: { token: "short", password: "a-new-password-1" } }),
      await api(RESET, { body: { password: "a-new-password-1" } }),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(400);
      expect(res.json).toEqual(refusals[0].json);
    }
  });

  test("a weak password is refused WITH the reason and does NOT use up the link", async () => {
    const user = await createUser();
    const token = await freshLink(user);
    const weak = await api(RESET, { body: { token, password: "short1" } });
    expect(weak.status).toBe(400);
    expect(weak.json.error.code).toBe("VALIDATION");
    expect(weak.json.error.message).toMatch(/at least 8 characters/);
    const tooLong = await api(RESET, { body: { token, password: "a1" + "😀".repeat(18) } });
    expect(tooLong.json.error.message).toMatch(/72 bytes/);
    expect((await api(RESET, { body: { token, password: "a-good-password-1" } })).status).toBe(200); // still live
  });

  test("typos aren't attacks: many weak-password attempts from one IP never lock the person out", async () => {
    const user = await createUser();
    const token = await freshLink(user);
    const ip = uniqueIp();
    for (let i = 0; i < 14; i++) {
      const weak = await api(RESET, { body: { token, password: "short1" }, ip });
      expect(weak.status, `weak attempt #${i}`).toBe(400); // a 400 explaining the rule — never a 429
      expect(weak.json.error.code).toBe("VALIDATION");
    }
    expect((await api(RESET, { body: { token, password: "finally-a-good-one-1" }, ip })).status).toBe(200);
  });

  test("a notice is emailed, and an audit row is written for each school the person belongs to", async () => {
    const user = await createUser({ role: Role.ADMIN });
    await api(RESET, { body: { token: await freshLink(user), password: "a-new-password-1" } });
    const mail = await waitForMail(user.email, 2);
    expect(mail[1].subject).toMatch(/password was changed/);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: user.id, action: "PASSWORD_RESET" } })).toBe(1);
  });

  test("per IP: failures are limited (10), a success is refunded", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) {
      expect((await api(RESET, { body: { token: "B".repeat(43), password: "a-new-password-1" }, ip })).status).toBe(400);
    }
    const blocked = await api(RESET, { body: { token: "B".repeat(43), password: "a-new-password-1" }, ip });
    expect(blocked.status).toBe(429);

    const goodIp = uniqueIp();
    for (let i = 0; i < 12; i++) {
      const user = await createUser();
      const res = await api(RESET, { body: { token: await freshLink(user), password: "a-new-password-1" }, ip: goodIp });
      expect(res.status, `success #${i}`).toBe(200); // never counts against the person
    }
  });

  test("CSRF: a cross-origin request is refused", async () => {
    const res = await api(RESET, { body: { token: "A".repeat(43), password: "a-new-password-1" }, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

test.describe("POST /change-password", () => {
  const NEW = "a-changed-pass-7";

  test("needs a session (401) and passes CSRF (403)", async () => {
    expect((await api(CHANGE, { body: { currentPassword: "x", newPassword: NEW } })).status).toBe(401);
    const user = await createUser();
    const { token } = await loginAs(user);
    const res = await api(CHANGE, { body: { currentPassword: user.password, newPassword: NEW }, cookie: cookieHeader(token!), origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  test("a wrong CURRENT password is refused and nothing changes — a stolen session isn't enough", async () => {
    const user = await createUser();
    const { token } = await loginAs(user);
    const res = await api(CHANGE, { body: { currentPassword: "not-my-password-1", newPassword: NEW }, cookie: cookieHeader(token!) });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_CURRENT_PASSWORD");
    expect((await loginAs(user)).status).toBe(200); // still the old one
  });

  test("success: new password works, old doesn't, THIS session survives, every other one is gone", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const mine = await loginAs(user);
    const otherDevice = await loginAs(user);
    const res = await api(CHANGE, { body: { currentPassword: user.password, newPassword: NEW }, cookie: cookieHeader(mine.token!) });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ changed: true });
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(mine.token!) })).status).toBe(200);
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(otherDevice.token!) })).status).toBe(401);
    expect((await loginAs(user)).status).toBe(401);
    expect((await loginAs({ email: user.email, password: NEW })).status).toBe(200);
    expect((await waitForMail(user.email))[0].subject).toMatch(/password was changed/);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: user.id, action: "PASSWORD_CHANGED" } })).toBe(1);
  });

  test("the new password must follow the rule and differ from the current one", async () => {
    const user = await createUser();
    const { token } = await loginAs(user);
    const cookie = cookieHeader(token!);
    const weak = await api(CHANGE, { body: { currentPassword: user.password, newPassword: "short1" }, cookie });
    expect(weak.json.error.code).toBe("VALIDATION");
    const same = await api(CHANGE, { body: { currentPassword: user.password, newPassword: user.password }, cookie });
    expect(same.status).toBe(400);
    expect(same.json.error.code).toBe("SAME_PASSWORD");
  });

  test("wrong-current failures are limited per account (5), even when a later guess is right; success is refunded", async () => {
    const user = await createUser();
    const { token } = await loginAs(user);
    const cookie = cookieHeader(token!);
    for (let i = 0; i < 5; i++) {
      expect((await api(CHANGE, { body: { currentPassword: `wrong-guess-${i}-x`, newPassword: NEW }, cookie })).status).toBe(400);
    }
    const locked = await api(CHANGE, { body: { currentPassword: user.password, newPassword: NEW }, cookie });
    expect(locked.status).toBe(429);
    expect(await mailTo(user.email)).toHaveLength(0);

    const other = await createUser();
    let password = other.password;
    const { token: t2 } = await loginAs(other);
    for (let i = 0; i < 7; i++) {
      const next = `rotating-pass-${i}-a`;
      expect((await api(CHANGE, { body: { currentPassword: password, newPassword: next }, cookie: cookieHeader(t2!) })).status, `change #${i}`).toBe(200);
      password = next; // (this session survives each change)
    }
  });
});
