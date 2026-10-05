import "../support/env";
import { DEVTOOLS_URL, DEV_TOOLS_TEST_TOKEN, HTTP_URL } from "../support/env";
import { test, expect } from "@playwright/test";
import { createUser, uniqueEmail, uniqueIp } from "../support/db";
import { api, type ApiOptions } from "../support/http";
import { mailAfterGrace } from "../support/outbox";

// The dev email inbox over real HTTP. Two kinds of server: the three production-shaped ones (which must show no
// trace of it) and the staging-mode one on its own port (dev tools on, token required, EMAIL_TRANSPORT unset — so
// mail goes where the app sends it by default in that mode: the in-memory inbox).

const INBOX = "/api/v1/dev/email-inbox";
const TOKEN = { "x-dev-tools-token": DEV_TOOLS_TEST_TOKEN };

const dev = (path: string, opts: ApiOptions = {}) => api(path, { baseUrl: DEVTOOLS_URL, ...opts });
const inbox = (opts: ApiOptions = {}) => dev(INBOX, { headers: TOKEN, ...opts });
type Mail = { id: string; to: string; subject: string; text: string; sentAt: string };
const mailTo = async (to: string): Promise<Mail[]> =>
  ((await inbox()).json.data.emails as Mail[]).filter((m) => m.to === to);
const waitForInbox = async (to: string, count = 1) => {
  await expect.poll(async () => (await mailTo(to)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(count);
  return mailTo(to);
};
const forgot = (email: string) => dev("/api/v1/auth/forgot-password", { body: { email } });

test.describe("a production-shaped server has no dev inbox at all", () => {
  test("GET and DELETE answer 404 — even with the right token and a same-origin request", async () => {
    for (const method of ["GET", "DELETE"]) {
      for (const headers of [undefined, TOKEN]) {
        const res = await api(INBOX, { method, headers });
        expect(res.status, `${method} ${headers ? "with token" : ""}`).toBe(404);
        expect(res.json.error.code).toBe("NOT_FOUND");
        expect(res.text).not.toContain("emails");
      }
    }
  });

  test("its pages don't contain the launcher", async () => {
    const html = await (await fetch(`${HTTP_URL}/login`, { headers: { "x-real-ip": uniqueIp() } })).text();
    expect(html).not.toMatch(/Dev email inbox/i);
  });

  test("its mail goes to its configured transport (the test file), never an inbox", async () => {
    const user = await createUser();
    await api("/api/v1/auth/forgot-password", { body: { email: user.email } });
    await expect.poll(async () => (await mailAfterGrace(user.email, 200)).length).toBeGreaterThan(0);
    expect(await mailTo(user.email)).toEqual([]); // the staging server's inbox never saw it
  });
});

test.describe("the staging-mode server", () => {
  test("the page carries the launcher (and only there)", async () => {
    const html = await (await fetch(`${DEVTOOLS_URL}/login`, { headers: { "x-real-ip": uniqueIp() } })).text();
    expect(html).toMatch(/Dev email inbox/);
  });

  test("it needs the token: none or a wrong one is 401 TOKEN_REQUIRED with no data; the right one is 200, uncacheable, cookie-free", async () => {
    const none = await dev(INBOX);
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe("TOKEN_REQUIRED");
    expect(none.json.data).toBeNull();
    const wrong = await dev(INBOX, { headers: { "x-dev-tools-token": "nope" } });
    expect(wrong.status).toBe(401);
    const prefix = await dev(INBOX, { headers: { "x-dev-tools-token": DEV_TOOLS_TEST_TOKEN.slice(0, -1) } });
    expect(prefix.status).toBe(401);

    const ok = await inbox();
    expect(ok.status).toBe(200);
    expect(ok.json.data.mode).toBe("staging");
    expect(Array.isArray(ok.json.data.emails)).toBe(true);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.setCookies).toEqual([]);
  });

  test("five wrong tokens from one IP shut that IP out — another is unaffected", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) expect((await dev(INBOX, { ip, headers: { "x-dev-tools-token": `guess-${i}` } })).status).toBe(401);
    const blocked = await inbox({ ip });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
    expect((await inbox({ ip: uniqueIp() })).status).toBe(200);
  });

  test("forgot-password → the message is in the inbox, and its link really resets the password", async () => {
    const user = await createUser();
    expect((await forgot(user.email)).status).toBe(200);
    const [mail] = await waitForInbox(user.email);

    expect(mail.subject).toMatch(/Reset your .* password/);
    expect(mail.text).toContain(`${DEVTOOLS_URL}/reset-password#token=`);
    expect(new Date(mail.sentAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    const reset = await dev("/api/v1/auth/reset-password", { body: { token, password: "brand-new-pass-1" } });
    expect(reset.status).toBe(200);
  });

  test("an unknown address puts nothing in the inbox (the same no-oracle rule as ever)", async () => {
    const ghost = uniqueEmail("ghost");
    expect((await forgot(ghost)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await mailTo(ghost)).toEqual([]);
    // Nothing in the inbox is addressed to the unknown address. (Not "the total did not change": mail that an EARLIER test caused is sent
    // after its response and can land in this window on a busy machine — a count would blame this request for it.)
    expect(((await inbox()).json.data.emails as Mail[]).filter((m) => m.to === ghost)).toEqual([]);
  });

  test("newest first", async () => {
    const user = await createUser();
    await forgot(user.email);
    await waitForInbox(user.email, 1);
    await forgot(user.email);
    const mails = await waitForInbox(user.email, 2);
    expect(new Date(mails[0].sentAt).getTime()).toBeGreaterThanOrEqual(new Date(mails[1].sentAt).getTime());
    expect(mails[0].text).not.toBe(mails[1].text); // two different tokens
  });

  test("DELETE needs the token and a same-origin request, and then empties it", async () => {
    const user = await createUser();
    await forgot(user.email);
    await waitForInbox(user.email);

    expect((await dev(INBOX, { method: "DELETE" })).status).toBe(401);
    const cross = await dev(INBOX, { method: "DELETE", headers: TOKEN, origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    expect(cross.json.error.code).toBe("CSRF");
    expect((await dev(INBOX, { method: "DELETE", headers: TOKEN, origin: null })).status).toBe(403);
    expect(await mailTo(user.email)).toHaveLength(1);

    const cleared = await dev(INBOX, { method: "DELETE", headers: TOKEN });
    expect(cleared.status).toBe(200);
    expect(await mailTo(user.email)).toEqual([]);
    expect(((await inbox()).json.data.emails as Mail[])).toEqual([]);
  });
});
