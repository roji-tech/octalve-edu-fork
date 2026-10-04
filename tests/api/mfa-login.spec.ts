import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, codeFor, createUser, db, enableMfa, rewindMfa, sha256Hex, uniqueIp } from "../support/db";
import { api, cookieHeader, loginAs, parseSetCookie, sessionCookie } from "../support/http";
import { mailAfterGrace, tokenFrom, waitForMail } from "../support/outbox";

// Sign-in with two-step verification (plan §0.5.D): step 1 (password) hands out a challenge and NO session;
// step 2 (code) is the only thing that creates one.

const LOGIN = "/api/v1/auth/login";
const MFA = "/api/v1/auth/login/mfa";
const ME = "/api/v1/auth/me";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const near = (actual: Date | number, expected: number) => Math.abs(new Date(actual).getTime() - expected) < 2 * 60_000;

async function mfaUser(role?: Role) {
  const user = await createUser({ role });
  const mfa = await enableMfa(user.id);
  return { user, ...mfa };
}

/// Step 1 for `user`; returns the challenge.
async function challengeFor(user: { email: string; password: string }, opts: { remember?: boolean; ip?: string; cookie?: string } = {}) {
  const res = await api(LOGIN, {
    body: { email: user.email, password: user.password, ...(opts.remember === undefined ? {} : { remember: opts.remember }) },
    ip: opts.ip,
    cookie: opts.cookie,
  });
  expect(res.status, res.text).toBe(200);
  expect(res.json.data.mfaRequired).toBe(true);
  return res.json.data.challenge as string;
}

const step2 = (body: Record<string, unknown>, opts: { ip?: string; cookie?: string; origin?: string | null } = {}) =>
  api(MFA, { body, ip: opts.ip, cookie: opts.cookie, origin: opts.origin });

test.describe("step 1 — the password, for an account with two-step verification", () => {
  test("answers 200 { mfaRequired, challenge } and creates NO session and sets NO cookie", async () => {
    const { user } = await mfaUser();
    const res = await api(LOGIN, { body: { email: user.email, password: user.password } });

    expect(res.status).toBe(200);
    expect(res.json.error).toBeNull();
    expect(res.json.data.mfaRequired).toBe(true);
    expect(res.json.data.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.setCookies).toEqual([]); // not even an empty one
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Nothing about the person is revealed before the second factor.
    expect(res.json.data.user).toBeUndefined();
    expect(res.text).not.toContain(user.email);
    expect(res.text).not.toContain(user.id);

    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    const row = await db.mfaChallenge.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(sha256Hex(res.json.data.challenge));
  });

  test("a wrong password gets the SAME generic 401 as for an account without it (MFA status isn't revealed)", async () => {
    const { user } = await mfaUser();
    const plain = await createUser();
    const withMfa = await api(LOGIN, { body: { email: user.email, password: "wrong-password-1" } });
    const without = await api(LOGIN, { body: { email: plain.email, password: "wrong-password-1" } });
    expect(withMfa.status).toBe(401);
    expect(withMfa.text).toBe(without.text);
    expect(withMfa.setCookies).toEqual([]);
    expect(await db.mfaChallenge.count({ where: { userId: user.id } })).toBe(0);
  });

  test("an enrolment still in progress (unconfirmed) does not change sign-in", async () => {
    const user = await createUser();
    await db.mfaCredential.create({ data: { userId: user.id, secretEnc: "v1.x.y.z" } }); // never confirmed
    const res = await loginAs(user);
    expect(res.status).toBe(200);
    expect(res.json.data.mfaRequired).toBeUndefined();
    expect(res.token).not.toBeNull();
  });

  test("a session cookie presented at step 1 does not skip step 2 — and is only rotated away once step 2 succeeds", async () => {
    const { user, secret } = await mfaUser();
    // A pre-existing session (created while MFA was off, say).
    const old = await db.session.create({
      data: { tokenHash: sha256Hex("old-session"), userId: user.id, expires: new Date(Date.now() + DAY_MS), absoluteExpires: new Date(Date.now() + DAY_MS) },
    });
    const challenge = await challengeFor(user, { cookie: cookieHeader("old-session") });
    expect(await db.session.count({ where: { id: old.id } })).toBe(1); // step 1 doesn't touch it

    const res = await step2({ challenge, code: codeFor(secret) }, { cookie: cookieHeader("old-session") });
    expect(res.status).toBe(200);
    expect(await db.session.count({ where: { id: old.id } })).toBe(0); // rotated
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });
});

test.describe("step 2 — the code", () => {
  test("a correct code creates the session: cookie set, /me works, the token is stored only as a hash", async () => {
    const { user, secret } = await mfaUser(Role.TEACHING_STAFF);
    const challenge = await challengeFor(user);
    const res = await step2({ challenge, code: codeFor(secret) });

    expect(res.status).toBe(200);
    expect(res.json.data.user).toEqual({ id: user.id, name: user.name, email: user.email });
    expect(res.json.data.recoveryCodesRemaining).toBeUndefined();
    expect(res.headers.get("cache-control")).toBe("no-store");

    const cookie = sessionCookie(res)!;
    expect(cookie.attributes.get("httponly")).toBe(true);
    expect(String(cookie.attributes.get("samesite")).toLowerCase()).toBe("lax");
    expect(cookie.attributes.get("path")).toBe("/");
    expect(cookie.attributes.has("domain")).toBe(false);

    const me = await api(ME, { cookie: cookieHeader(cookie.value) });
    expect(me.status).toBe(200);
    expect(me.json.data.user.id).toBe(user.id);
    expect(await db.session.count({ where: { tokenHash: sha256Hex(cookie.value) } })).toBe(1);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  test("the code may be typed with a space or a hyphen", async () => {
    const { user, secret } = await mfaUser();
    const code = codeFor(secret);
    const res = await step2({ challenge: await challengeFor(user), code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(res.status).toBe(200);
  });

  test("'Keep me signed in' is decided at step 1 and carried by the challenge: ticked → persistent cookie + 90 days", async () => {
    const { user, secret } = await mfaUser(Role.TEACHING_STAFF);
    const res = await step2({ challenge: await challengeFor(user, { remember: true }), code: codeFor(secret) });
    const cookie = sessionCookie(res)!;
    expect(near(new Date(String(cookie.attributes.get("expires"))), Date.now() + 90 * DAY_MS)).toBe(true);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(near(row.absoluteExpires, Date.now() + 90 * DAY_MS)).toBe(true);
    expect(near(row.expires, Date.now() + 30 * DAY_MS)).toBe(true);
  });

  test("…not ticked → a session cookie and a 12-hour cap; and step 2 cannot upgrade it by asking", async () => {
    const { user, secret } = await mfaUser(Role.TEACHING_STAFF);
    const challenge = await challengeFor(user); // not remembered
    const res = await step2({ challenge, code: codeFor(secret), remember: true });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)!.attributes.has("expires")).toBe(false);
    expect(sessionCookie(res)!.attributes.has("max-age")).toBe(false);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(near(row.absoluteExpires, Date.now() + 12 * HOUR_MS)).toBe(true);
  });

  test("an administrator keeps the shorter cap through step 2 (7 days, remembered)", async () => {
    const { user, secret } = await mfaUser(Role.ADMIN);
    const res = await step2({ challenge: await challengeFor(user, { remember: true }), code: codeFor(secret) });
    expect(near(new Date(String(sessionCookie(res)!.attributes.get("expires"))), Date.now() + 7 * DAY_MS)).toBe(true);
  });

  test("a wrong code: 401 INVALID_CODE, no cookie, no session — and the challenge is still usable", async () => {
    const { user, secret } = await mfaUser();
    const challenge = await challengeFor(user);
    const wrong = String((Number(codeFor(secret)) + 1) % 1_000_000).padStart(6, "0");
    const bad = await step2({ challenge, code: wrong });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("INVALID_CODE");
    expect(bad.setCookies).toEqual([]);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);

    expect((await step2({ challenge, code: codeFor(secret) })).status).toBe(200);
  });

  test("codes from the wrong time (±3 steps) are refused", async () => {
    const { user, secret } = await mfaUser();
    for (const offset of [-3, 3]) {
      const res = await step2({ challenge: await challengeFor(user), code: codeFor(secret, offset) });
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("INVALID_CODE");
    }
  });

  test("a challenge is for ONE person: someone else's valid code does not open it", async () => {
    const a = await mfaUser();
    const b = await mfaUser();
    const res = await step2({ challenge: await challengeFor(a.user), code: codeFor(b.secret) });
    expect(res.status).toBe(401);
    expect(res.setCookies).toEqual([]);
  });

  test("five wrong codes kill the challenge — even the right code is then refused", async () => {
    const { user, secret } = await mfaUser();
    const challenge = await challengeFor(user);
    for (let i = 0; i < 5; i++) {
      expect((await step2({ challenge, code: codeFor(secret, 3) })).json.error.code).toBe("INVALID_CODE");
    }
    const dead = await step2({ challenge, code: codeFor(secret) });
    expect(dead.status).toBe(401);
    expect(dead.json.error.code).toBe("INVALID_CHALLENGE");
    expect(dead.setCookies).toEqual([]);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  test("twenty simultaneous guesses on one challenge: at most five are even checked", async () => {
    const { user, secret } = await mfaUser();
    const challenge = await challengeFor(user);
    const results = await Promise.all(Array.from({ length: 20 }, () => step2({ challenge, code: codeFor(secret, 3) })));
    const checked = results.filter((r) => r.json.error.code === "INVALID_CODE").length;
    expect(checked).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.json.error.code === "INVALID_CHALLENGE").length).toBe(20 - checked);
  });

  test("single use: a challenge that produced a session cannot produce another", async () => {
    const { user, secret } = await mfaUser();
    const challenge = await challengeFor(user);
    expect((await step2({ challenge, code: codeFor(secret) })).status).toBe(200);
    await rewindMfa(user.id); // even if the code were acceptable again
    const again = await step2({ challenge, code: codeFor(secret) });
    expect(again.status).toBe(401);
    expect(again.json.error.code).toBe("INVALID_CHALLENGE");
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  test("expired, unknown and malformed challenges all get the identical answer", async () => {
    const { user, secret } = await mfaUser();
    const expired = await challengeFor(user);
    await db.mfaChallenge.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const code = codeFor(secret);
    const answers = await Promise.all([
      step2({ challenge: expired, code }),
      step2({ challenge: "x".repeat(43), code }),
      step2({ challenge: "short", code }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("INVALID_CHALLENGE");
    }
    expect(answers[0].text).toBe(answers[1].text);
    expect(answers[1].text).toBe(answers[2].text);
  });

  test("replay: a code that already signed someone in cannot sign in again — until time has moved on", async () => {
    const { user, secret } = await mfaUser();
    const code = codeFor(secret);
    expect((await step2({ challenge: await challengeFor(user), code })).status).toBe(200);

    const replay = await step2({ challenge: await challengeFor(user), code });
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe("INVALID_CODE");
    // Nor can the previous step's code (it is older than the one just used).
    expect((await step2({ challenge: await challengeFor(user), code: codeFor(secret, -1) })).status).toBe(401);

    await rewindMfa(user.id);
    expect((await step2({ challenge: await challengeFor(user), code })).status).toBe(200);
  });

  test("replay under concurrency: eight challenges, ONE code, exactly one session", async () => {
    const { user, secret } = await mfaUser();
    const challenges = await Promise.all(Array.from({ length: 8 }, () => challengeFor(user)));
    const code = codeFor(secret);
    const results = await Promise.all(challenges.map((challenge) => step2({ challenge, code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });
});

test.describe("step 2 — recovery codes", () => {
  test("a recovery code signs in, once; the response says how many are left; the person is emailed", async () => {
    const { user, recoveryCodes } = await mfaUser(Role.TEACHING_STAFF);
    const res = await step2({ challenge: await challengeFor(user), recoveryCode: recoveryCodes[0] });
    expect(res.status).toBe(200);
    expect(res.json.data.recoveryCodesRemaining).toBe(9);
    expect(sessionCookie(res)).toBeTruthy();

    const reuse = await step2({ challenge: await challengeFor(user), recoveryCode: recoveryCodes[0] });
    expect(reuse.status).toBe(401);
    expect(reuse.json.error.code).toBe("INVALID_CODE");
    expect(reuse.setCookies).toEqual([]);

    const [mail] = await waitForMail(user.email);
    expect(mail.subject).toMatch(/recovery code was used/i);
    expect(mail.text).toContain("you have 9 left");
    await expect
      .poll(() => db.auditLog.count({ where: { actorUserId: user.id, action: "MFA_RECOVERY_CODE_USED" } }))
      .toBe(1);
  });

  test("lower case and a missing hyphen are fine", async () => {
    const { user, recoveryCodes } = await mfaUser();
    const typed = recoveryCodes[3].toLowerCase().replace("-", "");
    expect((await step2({ challenge: await challengeFor(user), recoveryCode: typed })).status).toBe(200);
  });

  test("a TOTP login sends no recovery-code email", async () => {
    const { user, secret } = await mfaUser();
    await step2({ challenge: await challengeFor(user), code: codeFor(secret) });
    expect(await mailAfterGrace(user.email)).toHaveLength(0);
  });
});

test.describe("step 2 — what is a typo and what is a guess", () => {
  test("malformed bodies are 400 VALIDATION and spend neither a challenge attempt nor the IP's allowance", async () => {
    const { user, secret } = await mfaUser();
    const ip = uniqueIp();
    const challenge = await challengeFor(user, { ip });
    const bodies: Record<string, unknown>[] = [
      { challenge, code: "12345" },
      { challenge, code: "1234567" },
      { challenge, code: "abcdef" },
      { challenge, recoveryCode: "nope" },
      { challenge }, // neither
      { challenge, code: codeFor(secret), recoveryCode: "ABCDE-FGHJK" }, // both
      { code: codeFor(secret) }, // no challenge
    ];
    // 40 typos from one IP — more than the per-IP limit of 30 — and the challenge's five attempts untouched…
    for (let i = 0; i < 40; i++) {
      const res = await step2(bodies[i % bodies.length], { ip });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    // …so the right code still works, from the same IP.
    expect((await step2({ challenge, code: codeFor(secret) }, { ip })).status).toBe(200);
  });

  test("invalid JSON is a 400", async () => {
    const res = await api(MFA, { rawBody: "{nope" });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_BODY");
  });
});

test.describe("step 2 — rate limits", () => {
  test("per IP: 30 wrong codes from one address, then it is shut out — even with a right code", async () => {
    const ip = uniqueIp();
    const users = await Promise.all(Array.from({ length: 7 }, () => mfaUser()));
    const challenges = await Promise.all(users.map((u) => challengeFor(u.user)));
    let refused = 0;
    for (const [i, challenge] of challenges.entries()) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await step2({ challenge, code: codeFor(users[i].secret, 3) }, { ip });
        if (res.status === 429) refused++;
        else expect(res.status).toBe(401);
      }
    }
    expect(refused).toBe(5); // 35 attempts, 30 allowed
    const fresh = await challengeFor(users[0].user);
    const blocked = await step2({ challenge: fresh, code: codeFor(users[0].secret) }, { ip });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
    // Another address is unaffected.
    expect((await step2({ challenge: fresh, code: codeFor(users[0].secret) })).status).toBe(200);
  });

  test("per account: ten wrong codes across ANY challenges lock step 2 for that account — others are unaffected", async () => {
    const { user, secret } = await mfaUser();
    const bystander = await mfaUser();
    for (let c = 0; c < 2; c++) {
      const challenge = await challengeFor(user);
      for (let i = 0; i < 5; i++) {
        expect((await step2({ challenge, code: codeFor(secret, 3) })).status).toBe(401);
      }
    }
    // A brand-new challenge and the CORRECT code: refused — someone who knows the password can mint
    // challenges at will, so this limit is what bounds guessing.
    const locked = await step2({ challenge: await challengeFor(user), code: codeFor(secret) });
    expect(locked.status).toBe(429);
    expect(locked.json.error.code).toBe("RATE_LIMITED");
    expect(locked.setCookies).toEqual([]);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);

    expect((await step2({ challenge: await challengeFor(bystander.user), code: codeFor(bystander.secret) })).status).toBe(200);
  });

  test("a successful sign-in is refunded: signing in many times never locks anyone out", async () => {
    const { user, secret } = await mfaUser();
    for (let i = 0; i < 12; i++) {
      const res = await step2({ challenge: await challengeFor(user), code: codeFor(secret) });
      expect(res.status, `sign-in #${i + 1}`).toBe(200);
      await rewindMfa(user.id);
    }
  });
});

test.describe("step 2 — request guards", () => {
  test("cross-origin and origin-less requests are refused before anything else (CSRF)", async () => {
    const { user, secret } = await mfaUser();
    const challenge = await challengeFor(user);
    for (const origin of ["https://evil.example", null]) {
      const res = await step2({ challenge, code: codeFor(secret) }, { origin });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe("CSRF");
      expect(res.setCookies).toEqual([]);
    }
    expect((await step2({ challenge, code: codeFor(secret) })).status).toBe(200); // the challenge was untouched
  });

  test("GET is not a thing", async () => {
    const res = await api(MFA, { method: "GET" });
    expect(res.status).toBe(405);
  });
});

test.describe("two-step verification and the neighbouring flows", () => {
  test("a password reset does NOT bypass it: after the reset, signing in still needs a code", async () => {
    const { user } = await mfaUser();
    await api("/api/v1/auth/forgot-password", { body: { email: user.email } });
    const token = tokenFrom((await waitForMail(user.email))[0]);
    const reset = await api("/api/v1/auth/reset-password", { body: { token, password: "brand-new-pass-1" } });
    expect(reset.status).toBe(200);
    expect(reset.setCookies.map(parseSetCookie).every((c) => c.value === "")).toBe(true); // a reset signs nobody in

    const res = await api(LOGIN, { body: { email: user.email, password: "brand-new-pass-1" } });
    expect(res.status).toBe(200);
    expect(res.json.data.mfaRequired).toBe(true);
    expect(res.setCookies).toEqual([]);
  });

  test("changing the password kills a pending challenge (it proved the OLD password)", async () => {
    const { user, secret } = await mfaUser();
    const signedIn = await step2({ challenge: await challengeFor(user), code: codeFor(secret) });
    const cookie = cookieHeader(sessionCookie(signedIn)!.value);

    const pending = await challengeFor(user);
    const changed = await api("/api/v1/auth/change-password", {
      body: { currentPassword: user.password, newPassword: "another-new-pass-2" },
      cookie,
    });
    expect(changed.status).toBe(200);
    await rewindMfa(user.id);
    const res = await step2({ challenge: pending, code: codeFor(secret) });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("INVALID_CHALLENGE");
  });
});
