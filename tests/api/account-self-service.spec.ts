import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, db, sha256Hex, uniqueEmail, uniqueIp } from "../support/db";
import { api, cookieHeader, loginAs, parseSetCookie, sessionCookie } from "../support/http";
import { mailAfterGrace, mailTo, tokenFrom, waitForMail } from "../support/outbox";
import { createEmailChangeToken } from "@/lib/auth/email-change";

// Self-service on the account page (plan §0.5.E): edit the display name, change the email address (confirmed by a
// link to the NEW address), and see / end the places the account is signed in.

const PROFILE = "/api/v1/account/profile";
const SESSIONS = "/api/v1/auth/sessions";
const REVOKE = `${SESSIONS}/revoke`;
const REVOKE_OTHERS = `${SESSIONS}/revoke-others`;
const REQUEST = "/api/v1/auth/email-change/request";
const CONFIRM = "/api/v1/auth/email-change/confirm";
const ME = "/api/v1/auth/me";
const GENERIC = { data: { requested: true }, meta: {}, error: null };

async function signedIn(opts: { role?: Role; name?: string } = {}) {
  const user = await createUser({ role: opts.role ?? Role.TEACHING_STAFF, name: opts.name });
  const res = await loginAs(user);
  return { user, cookie: cookieHeader(res.token!) };
}
type Person = Awaited<ReturnType<typeof signedIn>>;

test.describe("every action needs a session and a same-origin request", () => {
  const actions: [string, string, unknown][] = [
    ["PATCH", PROFILE, { name: "Someone" }],
    ["POST", REVOKE, { sessionId: "x" }],
    ["POST", REVOKE_OTHERS, undefined],
    ["POST", REQUEST, { newEmail: "a@b.test", password: "x" }],
  ];
  for (const [method, path, body] of actions) {
    test(`${method} ${path}: 401 without a session; 403 CSRF cross-origin`, async () => {
      const anon = await api(path, { method, body: body ?? {} });
      expect(anon.status).toBe(401);
      expect(anon.json.error.code).toBe("UNAUTHENTICATED");
      expect(anon.headers.get("cache-control")).toBe("no-store");

      const person = await signedIn();
      for (const origin of ["https://evil.example", null]) {
        const res = await api(path, { method, body: body ?? {}, cookie: person.cookie, origin });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe("CSRF");
      }
    });
  }

  test("GET /auth/sessions needs a session; nothing else answers GET", async () => {
    const anon = await api(SESSIONS);
    expect(anon.status).toBe(401);
    const person = await signedIn();
    for (const path of [PROFILE, REVOKE, REVOKE_OTHERS, REQUEST, CONFIRM]) {
      expect((await api(path, { method: "GET", cookie: person.cookie })).status, path).toBe(405);
    }
  });
});

// --- Profile ------------------------------------------------------------------------------------------------

test.describe("PATCH /account/profile", () => {
  const patch = (person: Person, body: unknown, ip?: string) => api(PROFILE, { method: "PATCH", body, cookie: person.cookie, ip });

  test("changes the name, returns the normalised value, and /me shows it", async () => {
    const person = await signedIn({ name: "Old Name" });
    const res = await patch(person, { name: "  Amina   Yusuf-Bello \t" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.json.data.user).toEqual({ id: person.user.id, name: "Amina Yusuf-Bello", email: person.user.email });
    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).name).toBe("Amina Yusuf-Bello");
    expect((await api(ME, { cookie: person.cookie })).json.data.user.name).toBe("Amina Yusuf-Bello");
  });

  test("real-world names are kept intact (NFC), including other scripts", async () => {
    const person = await signedIn();
    for (const name of ["Ọlámidé Adéṣànyà", "عبد الله جميو", "李小龍"]) {
      const res = await patch(person, { name });
      expect(res.status, name).toBe(200);
      expect(res.json.data.user.name).toBe(name.normalize("NFC"));
    }
  });

  test("refused WITH the reason, and nothing is written: empty, blank, too long, control and bidi characters", async () => {
    const person = await signedIn({ name: "Keep Me" });
    const cases: [string, RegExp][] = [
      ["", /enter your name/i],
      ["   ", /enter your name/i],
      ["a".repeat(101), /at most 100/],
      ["Amina\u0000Yusuf", /can't be used/],
      ["Amina‮Yusuf", /can't be used/],
    ];
    for (const [name, message] of cases) {
      const res = await patch(person, { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      expect(res.json.error.message).toMatch(message);
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).name).toBe("Keep Me");
  });

  test("a malformed body is a 400 and nothing is written: wrong types, missing name, no body", async () => {
    const person = await signedIn({ name: "Keep Me" });
    for (const body of [{}, { name: 42 }, { name: null }, { name: ["a"] }, { name: "a".repeat(1001) }, undefined]) {
      const res = await patch(person, body);
      expect(res.status, JSON.stringify(body)?.slice(0, 40)).toBe(400);
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).name).toBe("Keep Me");
  });

  test("non-JSON is a 400", async () => {
    const person = await signedIn();
    const res = await api(PROFILE, { method: "PATCH", rawBody: "{nope", cookie: person.cookie });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_BODY");
  });

  test("it edits the CALLER's name only — extra fields (id, email, passwordHash) are ignored, never mass-assigned", async () => {
    const person = await signedIn();
    const victim = await createUser({ name: "Victim" });
    const res = await patch(person, { name: "Mine", id: victim.id, userId: victim.id, email: "evil@x.test", passwordHash: "x", role: "ADMIN" });
    expect(res.status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: victim.id } })).name).toBe("Victim");
    const mine = await db.user.findUniqueOrThrow({ where: { id: person.user.id } });
    expect(mine.name).toBe("Mine");
    expect(mine.email).toBe(person.user.email);
    expect(mine.passwordHash).not.toBe("x");
  });

  test("a real change is audited once with before and after; an unchanged name writes nothing", async () => {
    const person = await signedIn({ name: "Before Name" });
    await patch(person, { name: "After Name" });
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "PROFILE_UPDATED" } })).toBe(1);
    const row = await db.auditLog.findFirstOrThrow({ where: { actorUserId: person.user.id, action: "PROFILE_UPDATED" } });
    expect(row.beforeValue).toEqual({ name: "Before Name" });
    expect(row.afterValue).toEqual({ name: "After Name" });
    expect(row.targetId).toBe(person.user.id);

    await patch(person, { name: "  After   Name " }); // normalises to the same value
    await new Promise((r) => setTimeout(r, 1000));
    expect(await db.auditLog.count({ where: { actorUserId: person.user.id, action: "PROFILE_UPDATED" } })).toBe(1);
  });

  test("limited per account: the 11th change within the window is a 429", async () => {
    const person = await signedIn();
    for (let i = 0; i < 10; i++) expect((await patch(person, { name: `Name ${i}` })).status, `change #${i}`).toBe(200);
    const res = await patch(person, { name: "One too many" });
    expect(res.status).toBe(429);
    expect(res.json.error.code).toBe("RATE_LIMITED");
    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).name).toBe("Name 9");
  });
});

// --- Active sessions ---------------------------------------------------------------------------------------

test.describe("sessions", () => {
  const UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

  /// A second device for the same person: another sign-in, with its own user agent.
  async function secondDevice(user: { email: string; password: string }, userAgent = UA_PHONE) {
    const res = await loginAs(user, { headers: { "user-agent": userAgent } });
    return { cookie: cookieHeader(res.token!), id: (await db.session.findFirstOrThrow({ where: { tokenHash: sha256Hex(res.token!) } })).id };
  }
  const current = async (person: Person) => (await api(SESSIONS, { cookie: person.cookie })).json.data.sessions.find((s: { current: boolean }) => s.current);

  test("GET lists the caller's own sessions with the current one flagged and described; never a token or an IP", async () => {
    const person = await signedIn();
    await secondDevice(person.user);
    const other = await signedIn(); // somebody else's sessions must never appear
    const res = await api(SESSIONS, { cookie: person.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const list = res.json.data.sessions as { id: string; device: string; current: boolean }[];
    expect(list).toHaveLength(2);
    expect(list[0].current).toBe(true);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list[1].device).toBe("Safari on iPhone");
    const otherIds = (await db.session.findMany({ where: { userId: other.user.id } })).map((s) => s.id);
    for (const id of otherIds) expect(list.map((s) => s.id)).not.toContain(id);
    for (const row of await db.session.findMany({ where: { userId: person.user.id } })) {
      expect(res.text).not.toContain(row.tokenHash);
    }
    expect(res.text).not.toMatch(/\b10\.\d+\.\d+\.\d+\b/); // the test client's IP (X-Real-IP) is not stored or returned
  });

  test("POST /revoke ends ONE other session (its cookie stops working), the current one and others stay", async () => {
    const person = await signedIn();
    const phone = await secondDevice(person.user);
    const third = await secondDevice(person.user, "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0");

    const res = await api(REVOKE, { body: { sessionId: phone.id }, cookie: person.cookie });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ revoked: true, device: "Safari on iPhone" });
    expect((await api(ME, { cookie: phone.cookie })).status).toBe(401);
    expect((await api(ME, { cookie: third.cookie })).status).toBe(200);
    expect((await api(ME, { cookie: person.cookie })).status).toBe(200);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "SESSION_REVOKED" } })).toBe(1);
  });

  test("POST /revoke refuses the CURRENT session (that is signing out) and does not end it", async () => {
    const person = await signedIn();
    const mine = await current(person);
    const res = await api(REVOKE, { body: { sessionId: mine.id }, cookie: person.cookie });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("CURRENT_SESSION");
    expect((await api(ME, { cookie: person.cookie })).status).toBe(200);
  });

  test("POST /revoke on somebody else's session answers EXACTLY like an unknown id, and ends nothing", async () => {
    const person = await signedIn();
    const victim = await signedIn();
    const victimSession = await current(victim);
    const foreign = await api(REVOKE, { body: { sessionId: victimSession.id }, cookie: person.cookie });
    const unknown = await api(REVOKE, { body: { sessionId: "clz0000000000000000000000" }, cookie: person.cookie });
    const malformed = await api(REVOKE, { body: { sessionId: 12345 }, cookie: person.cookie });
    for (const res of [foreign, unknown, malformed]) {
      expect(res.status).toBe(404);
      expect(res.json).toEqual(unknown.json);
    }
    expect(unknown.json.error.code).toBe("NOT_FOUND");
    expect((await api(ME, { cookie: victim.cookie })).status).toBe(200); // untouched
  });

  test("POST /revoke is idempotent: the second time it is a 404 (already gone)", async () => {
    const person = await signedIn();
    const phone = await secondDevice(person.user);
    expect((await api(REVOKE, { body: { sessionId: phone.id }, cookie: person.cookie })).status).toBe(200);
    expect((await api(REVOKE, { body: { sessionId: phone.id }, cookie: person.cookie })).status).toBe(404);
  });

  test("POST /revoke-others ends every other session, keeps this one, reports how many, spares other people", async () => {
    const person = await signedIn();
    const a = await secondDevice(person.user);
    const b = await secondDevice(person.user);
    const bystander = await signedIn();

    const res = await api(REVOKE_OTHERS, { method: "POST", cookie: person.cookie });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ revoked: 2 });
    expect((await api(ME, { cookie: a.cookie })).status).toBe(401);
    expect((await api(ME, { cookie: b.cookie })).status).toBe(401);
    expect((await api(ME, { cookie: person.cookie })).status).toBe(200);
    expect((await api(ME, { cookie: bystander.cookie })).status).toBe(200);
    expect((await api(SESSIONS, { cookie: person.cookie })).json.data.sessions).toHaveLength(1);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "SESSIONS_REVOKED" } })).toBe(1);

    const again = await api(REVOKE_OTHERS, { method: "POST", cookie: person.cookie });
    expect(again.json.data).toEqual({ revoked: 0 }); // nothing left; and nothing audited for it
    await new Promise((r) => setTimeout(r, 800));
    expect(await db.auditLog.count({ where: { actorUserId: person.user.id, action: "SESSIONS_REVOKED" } })).toBe(1);
  });

  test("limits per account: revoke 30, revoke-others 10 per window", async () => {
    const person = await signedIn();
    for (let i = 0; i < 30; i++) expect((await api(REVOKE, { body: { sessionId: `nope-${i}` }, cookie: person.cookie })).status).toBe(404);
    const blocked = await api(REVOKE, { body: { sessionId: "nope" }, cookie: person.cookie });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");

    const second = await signedIn();
    for (let i = 0; i < 10; i++) expect((await api(REVOKE_OTHERS, { method: "POST", cookie: second.cookie })).status).toBe(200);
    expect((await api(REVOKE_OTHERS, { method: "POST", cookie: second.cookie })).status).toBe(429);
  });
});

// --- Change email ------------------------------------------------------------------------------------------

test.describe("POST /email-change/request", () => {
  const ask = (person: Person, newEmail: string, password = person.user.password, ip?: string) =>
    api(REQUEST, { body: { newEmail, password }, cookie: person.cookie, ip });

  test("success: the generic answer; a link goes to the NEW address, a notice (no link) to the OLD one; nothing changes yet", async () => {
    const person = await signedIn();
    const newEmail = uniqueEmail("new");
    const res = await ask(person, newEmail);
    expect(res.status).toBe(200);
    expect(res.json).toEqual(GENERIC);
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const [link] = await waitForMail(newEmail);
    expect(link.subject).toMatch(/Confirm your new .* email address/);
    expect(link.text).toMatch(/\/confirm-email#token=[A-Za-z0-9_-]{43}/);
    const [notice] = await waitForMail(person.user.email);
    expect(notice.subject).toMatch(/change of email address was requested/);
    expect(notice.text).not.toContain("#token="); // the old address can't be used to take the account over
    expect(notice.text).not.toContain(newEmail); // and is told only a masked version of where it is going
    expect(notice.text).toContain(`${newEmail[0]}***@test.example`);

    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).email).toBe(person.user.email);
    expect((await api(ME, { cookie: person.cookie })).status).toBe(200); // still signed in
    expect((await loginAs(person.user)).status).toBe(200); // the old address still signs in
    const row = await db.emailChangeToken.findFirstOrThrow({ where: { userId: person.user.id } });
    expect(row.tokenHash).toBe(sha256Hex(tokenFrom(link)));
    expect(row.newEmail).toBe(newEmail);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "EMAIL_CHANGE_REQUESTED" } })).toBe(1);
  });

  test("the address is trimmed and lower-cased; a different CASE of your own address is 'already your address'", async () => {
    const person = await signedIn();
    const res = await ask(person, `  ${uniqueEmail("MiXeD").toUpperCase()}  `);
    expect(res.status).toBe(200);
    await expect.poll(() => db.emailChangeToken.count({ where: { userId: person.user.id } })).toBe(1);
    const stored = await db.emailChangeToken.findFirstOrThrow({ where: { userId: person.user.id } });
    expect(stored.newEmail).toBe(stored.newEmail.toLowerCase());
    expect(stored.newEmail).not.toMatch(/\s/);

    const same = await ask(person, person.user.email.toUpperCase());
    expect(same.status).toBe(400);
    expect(same.json.error.code).toBe("SAME_EMAIL");
  });

  test("a free address and a TAKEN one get IDENTICAL answers (status, body, headers) — no probing for accounts", async () => {
    const person = await signedIn();
    const taken = await createUser();
    const free = await ask(person, uniqueEmail("free"));
    const takenRes = await ask(person, taken.email);
    for (const res of [free, takenRes]) {
      expect(res.status).toBe(200);
      expect(res.json).toEqual(GENERIC);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(free.text).toBe(takenRes.text);
  });

  test("a taken address gets a NOTICE and no link; the requester's current address is still told; no token is created", async () => {
    const person = await signedIn();
    const taken = await createUser();
    await ask(person, taken.email);
    const [notice] = await waitForMail(taken.email);
    expect(notice.subject).toMatch(/Someone tried to use your email address/);
    expect(notice.text).not.toContain("#token=");
    await waitForMail(person.user.email);
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "EMAIL_CHANGE_REQUESTED" } })).toBe(1);
    expect(await db.emailChangeToken.count({ where: { userId: person.user.id } })).toBe(0);
  });

  test("the response time doesn't depend on whether the address is taken (the work runs after the response)", async () => {
    const taken = await createUser();
    const time = async (newEmail: string) => {
      const person = await signedIn(); // a fresh person each time: no per-account limit is ever involved
      const t = performance.now();
      await ask(person, newEmail);
      return performance.now() - t;
    };
    const free: number[] = [];
    const takenTimes: number[] = [];
    for (let i = 0; i < 9; i++) {
      free.push(await time(uniqueEmail("free")));
      takenTimes.push(await time(taken.email));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(Math.abs(median(free) - median(takenTimes))).toBeLessThan(40); // ms
  });

  test("a wrong password is refused, nothing is sent and nothing is stored — a stolen session alone isn't enough", async () => {
    const person = await signedIn();
    const newEmail = uniqueEmail("new");
    const res = await ask(person, newEmail, "not-my-password-1");
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_PASSWORD");
    expect(await mailAfterGrace(newEmail)).toHaveLength(0);
    expect(await mailTo(person.user.email)).toHaveLength(0);
    expect(await db.emailChangeToken.count({ where: { userId: person.user.id } })).toBe(0);
  });

  test("password guesses are limited per account (5) — even a later CORRECT one is refused; a success is refunded", async () => {
    const person = await signedIn();
    for (let i = 0; i < 5; i++) expect((await ask(person, uniqueEmail("n"), "wrong-password-1")).status, `guess #${i}`).toBe(400);
    const blocked = await ask(person, uniqueEmail("n"));
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");

    const other = await signedIn();
    for (let i = 0; i < 4; i++) await ask(other, uniqueEmail("n"), "wrong-password-1");
    expect((await ask(other, uniqueEmail("n"))).status).toBe(200); // the 5th attempt, a right one…
    expect((await ask(other, uniqueEmail("n"), "wrong-password-1")).status).toBe(400); // …gave the budget back
  });

  test("verified requests are limited per account (3); wrong passwords and typos do not use that budget", async () => {
    const person = await signedIn();
    await ask(person, "not-an-address"); // a typo
    await ask(person, uniqueEmail("n"), "wrong-password-1"); // a wrong password
    for (let i = 0; i < 3; i++) expect((await ask(person, uniqueEmail("n"))).status, `request #${i}`).toBe(200);
    const blocked = await ask(person, uniqueEmail("n"));
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
  });

  test("per target address: the 4th request for one address from anyone is the same 200 but sends it NO fourth mail (no mail-bombing)", async () => {
    const target = uniqueEmail("victim");
    for (let i = 0; i < 4; i++) {
      const res = await ask(await signedIn(), target);
      expect(res.json).toEqual(GENERIC); // never a 429 — that would reveal how often the address was asked for
    }
    await waitForMail(target, 3);
    expect(await mailAfterGrace(target)).toHaveLength(3);
  });

  test("asking again kills the earlier link", async () => {
    const person = await signedIn();
    const first = uniqueEmail("first");
    const second = uniqueEmail("second");
    await ask(person, first);
    const firstToken = tokenFrom((await waitForMail(first))[0]);
    await ask(person, second);
    const secondToken = tokenFrom((await waitForMail(second))[0]);
    expect((await api(CONFIRM, { body: { token: firstToken } })).status).toBe(400);
    expect((await api(CONFIRM, { body: { token: secondToken } })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).email).toBe(second);
  });

  test("validation: not an address, empty, missing, too long → 400 and the budget is not spent; non-JSON → 400", async () => {
    const person = await signedIn();
    for (const body of [
      { newEmail: "not-an-address", password: person.user.password },
      { newEmail: "", password: person.user.password },
      { newEmail: uniqueEmail("n") },
      { password: person.user.password },
      { newEmail: `${"a".repeat(250)}@x.test`, password: person.user.password },
      { newEmail: ["a@b.test"], password: person.user.password },
    ]) {
      const res = await api(REQUEST, { body, cookie: person.cookie });
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
    }
    const raw = await api(REQUEST, { rawBody: "{nope", cookie: person.cookie });
    expect(raw.status).toBe(400);
    expect(raw.json.error.code).toBe("INVALID_BODY");
    expect((await ask(person, uniqueEmail("n"))).status).toBe(200); // 7 refusals above, and still allowed
  });
});

test.describe("POST /email-change/confirm", () => {
  /// A person with a live change request, the way the request route leaves it (token created directly).
  async function pending() {
    const person = await signedIn({ role: Role.ADMIN });
    const newEmail = uniqueEmail("new");
    const token = await createEmailChangeToken(person.user.id, newEmail);
    return { person, newEmail, token };
  }

  test("success: the address changes, EVERY session is gone, the old address stops signing in and the new one works", async () => {
    const { person, newEmail, token } = await pending();
    const second = await loginAs(person.user);

    const res = await api(CONFIRM, { body: { token } }); // no cookie at all: it is opened from a mail client
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: { changed: true }, meta: {}, error: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.setCookies.map(parseSetCookie).find((c) => c.name === "octalve.session-token")?.attributes.get("max-age")).toBe("0");
    expect(sessionCookie(res)?.value ?? "").toBe(""); // it does NOT sign anybody in

    expect((await api(ME, { cookie: person.cookie })).status).toBe(401);
    expect((await api(ME, { cookie: cookieHeader(second.token!) })).status).toBe(401);
    expect((await loginAs(person.user)).status).toBe(401); // the old address
    expect((await loginAs({ email: newEmail, password: person.user.password })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).emailVerified).not.toBeNull();
  });

  test("the OLD address is told afterwards (with the masked new one and no link), and the change is audited", async () => {
    const { person, newEmail, token } = await pending();
    await api(CONFIRM, { body: { token } });
    const notices = await waitForMail(person.user.email);
    const notice = notices.find((m) => /was changed/.test(m.subject))!;
    expect(notice).toBeTruthy();
    expect(notice.text).toContain(`${newEmail[0]}***@test.example`);
    expect(notice.text).not.toContain(newEmail);
    expect(notice.text).not.toContain("#token=");
    await expect.poll(() => db.auditLog.count({ where: { actorUserId: person.user.id, action: "EMAIL_CHANGED" } })).toBe(1);
    const row = await db.auditLog.findFirstOrThrow({ where: { actorUserId: person.user.id, action: "EMAIL_CHANGED" } });
    expect(row.beforeValue).toEqual({ email: person.user.email });
    expect(row.afterValue).toEqual({ email: newEmail });
  });

  test("single use: the same link twice → the second is the generic 400 and changes nothing", async () => {
    const { person, newEmail, token } = await pending();
    expect((await api(CONFIRM, { body: { token } })).status).toBe(200);
    await db.user.update({ where: { id: person.user.id }, data: { email: person.user.email } });
    const again = await api(CONFIRM, { body: { token } });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe("INVALID_TOKEN");
    expect((await db.user.findUniqueOrThrow({ where: { id: person.user.id } })).email).not.toBe(newEmail);
  });

  test("unknown, expired, used, malformed and 'taken in the meantime' all get the IDENTICAL refusal", async () => {
    const expired = await pending();
    await db.emailChangeToken.updateMany({ where: { userId: expired.person.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const contested = await pending();
    const rival = await createUser();
    await db.user.update({ where: { id: rival.id }, data: { email: contested.newEmail } }); // taken before the link was opened
    const used = await pending();
    await api(CONFIRM, { body: { token: used.token } });

    const refusals = [
      await api(CONFIRM, { body: { token: "A".repeat(43) } }),
      await api(CONFIRM, { body: { token: expired.token } }),
      await api(CONFIRM, { body: { token: contested.token } }),
      await api(CONFIRM, { body: { token: used.token } }),
      await api(CONFIRM, { body: { token: "short" } }),
      await api(CONFIRM, { body: {} }),
      await api(CONFIRM, { body: { token: 12345 } }),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(400);
      expect(res.json).toEqual(refusals[0].json);
    }
    expect(refusals[0].json.error.code).toBe("INVALID_TOKEN");
    // …and the contested one changed nothing at all:
    expect((await db.user.findUniqueOrThrow({ where: { id: contested.person.user.id } })).email).toBe(contested.person.user.email);
    expect((await api(ME, { cookie: contested.person.cookie })).status).toBe(200);
  });

  test("a link works for the person it was issued to, whoever opens it — and only changes THEIR account", async () => {
    const a = await pending();
    const b = await pending();
    const bystander = await signedIn();
    await api(CONFIRM, { body: { token: a.token }, cookie: bystander.cookie }); // opened while signed in as someone else
    expect((await db.user.findUniqueOrThrow({ where: { id: a.person.user.id } })).email).toBe(a.newEmail);
    expect((await db.user.findUniqueOrThrow({ where: { id: b.person.user.id } })).email).toBe(b.person.user.email);
    expect((await api(ME, { cookie: bystander.cookie })).status).toBe(200); // the bystander's own session is untouched
  });

  test("it also kills pending password-reset links (they were issued for the old address)", async () => {
    const { person, token } = await pending();
    await api("/api/v1/auth/forgot-password", { body: { email: person.user.email } });
    const reset = tokenFrom((await waitForMail(person.user.email)).find((m) => /Reset your/.test(m.subject))!);
    await api(CONFIRM, { body: { token } });
    const res = await api("/api/v1/auth/reset-password", { body: { token: reset, password: "a-brand-new-pass-1" } });
    expect(res.status).toBe(400);
  });

  test("public, but not cross-site: a cross-origin request is a 403, bad JSON a 400", async () => {
    const { token } = await pending();
    expect((await api(CONFIRM, { body: { token }, origin: "https://evil.example" })).status).toBe(403);
    expect((await api(CONFIRM, { body: { token }, origin: null })).status).toBe(403);
    expect((await api(CONFIRM, { rawBody: "{nope" })).status).toBe(400);
    expect((await api(CONFIRM, { body: { token } })).status).toBe(200); // none of that spent it
  });

  test("per IP: failures are limited (10), a success is refunded", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) expect((await api(CONFIRM, { body: { token: "B".repeat(43) }, ip })).status).toBe(400);
    expect((await api(CONFIRM, { body: { token: "B".repeat(43) }, ip })).status).toBe(429);

    const goodIp = uniqueIp();
    for (let i = 0; i < 12; i++) {
      const { token } = await pending();
      expect((await api(CONFIRM, { body: { token }, ip: goodIp })).status, `success #${i}`).toBe(200);
    }
  });
});
