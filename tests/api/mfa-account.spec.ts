import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, codeFor, createUser, db, enableMfa, rewindMfa } from "../support/db";
import { api, cookieHeader, loginAs, sessionCookie } from "../support/http";
import { waitForMail } from "../support/outbox";
import { base32Decode } from "@/lib/auth/mfa/base32";

// Managing two-step verification from the account page (plan §0.5.D): enrol → confirm, replace recovery codes,
// turn off. Each action asks again for something a stolen session alone would not have.

const BASE = "/api/v1/auth/mfa";
const ENROLL = `${BASE}/enroll`;
const CONFIRM = `${BASE}/confirm`;
const DISABLE = `${BASE}/disable`;
const RECOVERY = `${BASE}/recovery-codes`;
const LOGIN = "/api/v1/auth/login";
const MFA_LOGIN = "/api/v1/auth/login/mfa";

async function signedIn(role: Role | undefined = Role.TEACHING_STAFF) {
  const user = await createUser({ role });
  const res = await loginAs(user);
  return { user, cookie: cookieHeader(res.token!) };
}

type Person = Awaited<ReturnType<typeof signedIn>>;
const post = (path: string, person: Person, body: unknown) => api(path, { body, cookie: person.cookie });

/// Enrols and confirms through the real routes; returns the secret and the recovery codes.
async function turnOn(person: Person) {
  const enrol = await post(ENROLL, person, { password: person.user.password });
  expect(enrol.status, enrol.text).toBe(200);
  const secret = base32Decode(enrol.json.data.secret)!;
  const confirm = await post(CONFIRM, person, { code: codeFor(secret) });
  expect(confirm.status, confirm.text).toBe(200);
  return { secret, recoveryCodes: confirm.json.data.recoveryCodes as string[] };
}

const wrongCode = (secret: Buffer) => codeFor(secret, 3);

test.describe("every action needs a session and a same-origin request", () => {
  for (const path of [ENROLL, CONFIRM, DISABLE, RECOVERY]) {
    test(`${path}: 401 without a session; 403 CSRF cross-origin; no GET`, async () => {
      const anon = await api(path, { body: {} });
      expect(anon.status).toBe(401);
      expect(anon.json.error.code).toBe("UNAUTHENTICATED");
      expect(anon.headers.get("cache-control")).toBe("no-store");

      const person = await signedIn();
      for (const origin of ["https://evil.example", null]) {
        const res = await api(path, { body: {}, cookie: person.cookie, origin });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe("CSRF");
      }
      expect((await api(path, { method: "GET", cookie: person.cookie })).status).toBe(405);
    });
  }
});

test.describe("POST /mfa/enroll", () => {
  test("a wrong password is refused and nothing is created", async () => {
    const person = await signedIn();
    const res = await post(ENROLL, person, { password: "not-my-password-1" });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_PASSWORD");
    expect(await db.mfaCredential.count({ where: { userId: person.user.id } })).toBe(0);
  });

  test("returns the manual key and the otpauth URL once — stored encrypted and UNCONFIRMED — never cached", async () => {
    const person = await signedIn();
    const res = await post(ENROLL, person, { password: person.user.password });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const { secret, otpauthUrl } = res.json.data as { secret: string; otpauthUrl: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const url = new URL(otpauthUrl);
    expect(url.protocol).toBe("otpauth:");
    expect(decodeURIComponent(url.pathname)).toBe(`/Octalve Edu:${person.user.email}`);
    expect(url.searchParams.get("secret")).toBe(secret);
    expect(url.searchParams.get("issuer")).toBe("Octalve Edu");

    const row = await db.mfaCredential.findUniqueOrThrow({ where: { userId: person.user.id } });
    expect(row.confirmedAt).toBeNull();
    expect(row.secretEnc).not.toContain(secret);
    // An unconfirmed credential changes nothing about signing in.
    expect((await loginAs(person.user)).json.data.mfaRequired).toBeUndefined();
  });

  test("starting again replaces the secret; the old one cannot be confirmed", async () => {
    const person = await signedIn();
    const first = await post(ENROLL, person, { password: person.user.password });
    const second = await post(ENROLL, person, { password: person.user.password });
    expect(second.json.data.secret).not.toBe(first.json.data.secret);
    const stale = await post(CONFIRM, person, { code: codeFor(base32Decode(first.json.data.secret)!) });
    expect(stale.status).toBe(400);
    expect(stale.json.error.code).toBe("INVALID_CODE");
  });

  test("while it is already on: 409, and the existing credential is untouched", async () => {
    const person = await signedIn();
    await turnOn(person);
    const before = await db.mfaCredential.findUniqueOrThrow({ where: { userId: person.user.id } });
    const res = await post(ENROLL, person, { password: person.user.password });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("ALREADY_ENABLED");
    const after = await db.mfaCredential.findUniqueOrThrow({ where: { userId: person.user.id } });
    expect(after.secretEnc).toBe(before.secretEnc);
  });

  test("wrong passwords are limited per account (5), a correct one is refunded", async () => {
    const person = await signedIn();
    for (let i = 0; i < 8; i++) {
      expect((await post(ENROLL, person, { password: person.user.password })).status).toBe(200);
    }
    for (let i = 0; i < 5; i++) {
      expect((await post(ENROLL, person, { password: "wrong-password-1" })).status).toBe(400);
    }
    const locked = await post(ENROLL, person, { password: person.user.password });
    expect(locked.status).toBe(429);
    expect(locked.json.error.code).toBe("RATE_LIMITED");
  });
});

test.describe("POST /mfa/confirm", () => {
  test("with no enrolment started: 409", async () => {
    const person = await signedIn();
    const res = await post(CONFIRM, person, { code: "123456" });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("NOT_ENROLLING");
  });

  test("a wrong code leaves it off; typos don't count against the person; five wrong codes lock it", async () => {
    const person = await signedIn();
    const enrol = await post(ENROLL, person, { password: person.user.password });
    const secret = base32Decode(enrol.json.data.secret)!;

    for (let i = 0; i < 12; i++) {
      const typo = await post(CONFIRM, person, { code: "12ab" });
      expect(typo.status).toBe(400);
      expect(typo.json.error.code).toBe("VALIDATION");
    }
    for (let i = 0; i < 5; i++) {
      const wrong = await post(CONFIRM, person, { code: wrongCode(secret) });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error.code).toBe("INVALID_CODE");
    }
    const locked = await post(CONFIRM, person, { code: codeFor(secret) });
    expect(locked.status).toBe(429);
    expect(await db.mfaCredential.count({ where: { userId: person.user.id, confirmedAt: { not: null } } })).toBe(0);
  });

  test("success: active, ten recovery codes (shown once), OTHER sessions revoked and this one kept, notice + audit", async () => {
    const person = await signedIn();
    const otherDevice = await loginAs(person.user);
    const enrol = await post(ENROLL, person, { password: person.user.password });
    const secret = base32Decode(enrol.json.data.secret)!;

    const res = await post(CONFIRM, person, { code: codeFor(secret) });
    expect(res.status).toBe(200);
    expect(res.json.data.enabled).toBe(true);
    const codes = res.json.data.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);

    expect((await api("/api/v1/auth/me", { cookie: person.cookie })).status).toBe(200); // this device stays in
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(otherDevice.token!) })).status).toBe(401); // the other is out

    expect(await db.mfaRecoveryCode.count({ where: { userId: person.user.id } })).toBe(10);
    const [mail] = await waitForMail(person.user.email);
    expect(mail.subject).toMatch(/Two-step verification is on/);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "MFA_ENABLED" } })).toBe(1);
  });

  test("the code that confirmed it cannot immediately sign in; the next one can — through both steps", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);

    const first = await api(LOGIN, { body: { email: person.user.email, password: person.user.password } });
    expect(first.json.data.mfaRequired).toBe(true);
    const replay = await api(MFA_LOGIN, { body: { challenge: first.json.data.challenge, code: codeFor(secret) } });
    expect(replay.status).toBe(401); // that step was already spent on confirming

    await rewindMfa(person.user.id); // time passes
    const ok = await api(MFA_LOGIN, { body: { challenge: first.json.data.challenge, code: codeFor(secret) } });
    expect(ok.status).toBe(200);
  });

  test("two simultaneous confirmations: one wins, one set of codes", async () => {
    const person = await signedIn();
    const enrol = await post(ENROLL, person, { password: person.user.password });
    const code = codeFor(base32Decode(enrol.json.data.secret)!);
    const results = await Promise.all(Array.from({ length: 6 }, () => post(CONFIRM, person, { code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.mfaRecoveryCode.count({ where: { userId: person.user.id } })).toBe(10);
  });
});

test.describe("POST /mfa/disable", () => {
  test("while it is off: 409", async () => {
    const person = await signedIn();
    const res = await post(DISABLE, person, { password: person.user.password, code: "123456" });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("NOT_ENABLED");
  });

  test("needs BOTH: a password alone (or a code alone) is a 400 and changes nothing", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);
    await rewindMfa(person.user.id);
    for (const body of [
      { password: person.user.password },
      { code: codeFor(secret) },
      { password: person.user.password, code: codeFor(secret), recoveryCode: "ABCDE-FGHJK" },
      {},
    ]) {
      const res = await post(DISABLE, person, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    expect(await db.mfaCredential.count({ where: { userId: person.user.id } })).toBe(1);
  });

  test("a wrong password is refused WITHOUT spending the one-time code", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);
    await rewindMfa(person.user.id);
    const res = await post(DISABLE, person, { password: "not-my-password-1", code: codeFor(secret) });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_PASSWORD");
    const cred = await db.mfaCredential.findUniqueOrThrow({ where: { userId: person.user.id } });
    expect(cred.lastUsedStep).toBeNull(); // the code was not consumed
    expect((await post(DISABLE, person, { password: person.user.password, code: codeFor(secret) })).status).toBe(200);
  });

  test("a wrong code is refused and everything stays on", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);
    const res = await post(DISABLE, person, { password: person.user.password, code: wrongCode(secret) });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_CODE");
    expect(await db.mfaCredential.count({ where: { userId: person.user.id } })).toBe(1);
    expect(await db.mfaRecoveryCode.count({ where: { userId: person.user.id } })).toBe(10);
  });

  test("password + code removes everything, signs out other devices, emails, audits — and sign-in is single-step again", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);
    // A second device signs in through both steps (the step after the one that confirmed it)…
    const step1 = await loginAs(person.user);
    const secondDevice = await api(MFA_LOGIN, { body: { challenge: step1.json.data.challenge, code: codeFor(secret, 1) } });
    expect(secondDevice.status).toBe(200);
    await rewindMfa(person.user.id); // …and time passes before it is turned off.

    const res = await post(DISABLE, person, { password: person.user.password, code: codeFor(secret) });
    expect(res.status).toBe(200);
    expect(res.json.data.enabled).toBe(false);
    expect(await db.mfaCredential.count({ where: { userId: person.user.id } })).toBe(0);
    expect(await db.mfaRecoveryCode.count({ where: { userId: person.user.id } })).toBe(0);

    expect((await api("/api/v1/auth/me", { cookie: person.cookie })).status).toBe(200);
    expect((await api("/api/v1/auth/me", { cookie: cookieHeader(sessionCookie(secondDevice)!.value) })).status).toBe(401);

    const mails = await waitForMail(person.user.email, 2);
    expect(mails.map((m) => m.subject).join("|")).toMatch(/turned off/);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "MFA_DISABLED" } })).toBe(1);

    const again = await loginAs(person.user);
    expect(again.json.data.mfaRequired).toBeUndefined();
    expect(again.token).not.toBeNull();
  });

  test("a recovery code works in place of the authenticator code, and is spent", async () => {
    const person = await signedIn();
    const { recoveryCodes } = await turnOn(person);
    const res = await post(DISABLE, person, { password: person.user.password, recoveryCode: recoveryCodes[2] });
    expect(res.status).toBe(200);
    expect(await db.mfaCredential.count({ where: { userId: person.user.id } })).toBe(0);
  });

  test("failures (wrong password OR wrong code) are limited per account: the 6th attempt is 429 even with everything right", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);
    for (let i = 0; i < 3; i++) await post(DISABLE, person, { password: "wrong-password-1", code: codeFor(secret) });
    for (let i = 0; i < 2; i++) await post(DISABLE, person, { password: person.user.password, code: wrongCode(secret) });
    const locked = await post(DISABLE, person, { password: person.user.password, code: codeFor(secret) });
    expect(locked.status).toBe(429);
    expect(await db.mfaCredential.count({ where: { userId: person.user.id } })).toBe(1);
  });
});

test.describe("POST /mfa/recovery-codes", () => {
  test("while it is off: 409", async () => {
    const person = await signedIn();
    const res = await post(RECOVERY, person, { code: "123456" });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("NOT_ENABLED");
  });

  test("needs an authenticator code — a recovery code (or a typo) is not accepted here", async () => {
    const person = await signedIn();
    const { recoveryCodes } = await turnOn(person);
    for (const code of [recoveryCodes[0], "12345", ""]) {
      const res = await post(RECOVERY, person, { code });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    expect(await db.mfaRecoveryCode.count({ where: { userId: person.user.id, usedAt: null } })).toBe(10);
  });

  test("a wrong code is refused", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);
    const res = await post(RECOVERY, person, { code: wrongCode(secret) });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_CODE");
  });

  test("replaces ALL codes: the old set dies, the new set works at sign-in; the person is told", async () => {
    const person = await signedIn();
    const { secret, recoveryCodes: old } = await turnOn(person);
    await rewindMfa(person.user.id);

    const res = await post(RECOVERY, person, { code: codeFor(secret) });
    expect(res.status).toBe(200);
    const fresh = res.json.data.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => old.includes(c))).toBe(false);
    expect(await db.mfaRecoveryCode.count({ where: { userId: person.user.id } })).toBe(10);

    const challenge = async () =>
      (await api(LOGIN, { body: { email: person.user.email, password: person.user.password } })).json.data.challenge;
    const oldTry = await api(MFA_LOGIN, { body: { challenge: await challenge(), recoveryCode: old[0] } });
    expect(oldTry.status).toBe(401);
    const newTry = await api(MFA_LOGIN, { body: { challenge: await challenge(), recoveryCode: fresh[0] } });
    expect(newTry.status).toBe(200);

    const mails = await waitForMail(person.user.email, 2);
    expect(mails.some((m) => /New recovery codes/.test(m.subject))).toBe(true);
    await expect
      .poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "MFA_RECOVERY_CODES_REPLACED" } }))
      .toBe(1);
  });

  test("the code used to ask is spent (no replay)", async () => {
    const person = await signedIn();
    const { secret } = await turnOn(person);
    await rewindMfa(person.user.id);
    const code = codeFor(secret);
    expect((await post(RECOVERY, person, { code })).status).toBe(200);
    expect((await post(RECOVERY, person, { code })).status).toBe(400);
  });
});

test.describe("what another account holder cannot do", () => {
  test("one person's session cannot touch another's second factor", async () => {
    const victim = await createUser();
    await enableMfa(victim.id);
    const attacker = await signedIn();
    // Every route works on the SESSION's person, never on an id from the request.
    const res = await post(DISABLE, attacker, { password: attacker.user.password, code: "123456", userId: victim.id });
    expect(res.status).toBe(409); // the attacker has nothing enabled
    expect(await db.mfaCredential.count({ where: { userId: victim.id } })).toBe(1);
  });

  test("a recovery code stored for one person is not valid for sign-in as another", async () => {
    const a = await createUser();
    const b = await createUser();
    const ma = await enableMfa(a.id);
    await enableMfa(b.id);
    const challenge = (await api(LOGIN, { body: { email: b.email, password: b.password } })).json.data.challenge;
    const res = await api(MFA_LOGIN, { body: { challenge, recoveryCode: ma.recoveryCodes[0] } });
    expect(res.status).toBe(401);
    expect(await db.mfaRecoveryCode.count({ where: { userId: a.id, usedAt: { not: null } } })).toBe(0);
  });
});
