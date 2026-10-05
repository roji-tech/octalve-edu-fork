import "../support/env";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { test, expect } from "@playwright/test";
import { HTTP_PORT, HTTP_URL } from "../support/env";
import { Role, createUser, db, resetDatabase, seedInstance } from "../support/db";
import { withEnv } from "../support/with-env";
import { createResetToken } from "@/lib/auth/password-reset";
import { SESSION_COOKIE_NAME, createSession } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { BREACHED_MESSAGE } from "@/lib/auth/pwned-password";
import { POST as reset } from "@/app/api/v1/auth/reset-password/route";
import { POST as change } from "@/app/api/v1/auth/change-password/route";
import { POST as setup } from "@/app/api/v1/setup/route";

// The breached-password check wired into the three places a password is chosen (plan §0.5.3, F): the REFUSALS, called
// in-process with a stand-in for the public service. (The success paths call `after()`, which only exists inside a
// real request — they are tested over HTTP in tests/api/breached-password.spec.ts.)

const BREACHED = "Tr0ub4dor&3-but-leaked";
const sha1 = (v: string) => crypto.createHash("sha1").update(v).digest("hex").toUpperCase();

async function withBreachService<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const prefix = String(url).split("/").pop();
    return new Response(sha1(BREACHED).startsWith(prefix ?? "?") ? `${sha1(BREACHED).slice(5)}:1234\r\n` : "ABCDEF0123456789ABCDEF0123456789ABC:0\r\n");
  }) as typeof fetch;
  try {
    return await withEnv({ PWNED_PASSWORD_CHECK: "on" }, fn);
  } finally {
    globalThis.fetch = original;
  }
}

const post = (handler: (req: NextRequest, ctx: never) => Promise<Response>, path: string, body: unknown, cookie?: string) =>
  handler(
    new NextRequest(`${HTTP_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: HTTP_URL, host: `localhost:${HTTP_PORT}`, "x-real-ip": `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    {} as never,
  );
const read = async (res: Response) => ({ status: res.status, json: await res.json() });

test.beforeAll(async () => {
  await seedInstance();
});

test("reset: a breached password is refused WITH the reason and does NOT use up the link", async () => {
  await withBreachService(async () => {
    const user = await createUser();
    const token = await createResetToken(user.id);
    const refused = await read(await post(reset, "/api/v1/auth/reset-password", { token, password: BREACHED }));
    expect(refused).toMatchObject({ status: 400, json: { error: { code: "VALIDATION", message: BREACHED_MESSAGE } } });
    expect(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(1); // …the link is still live
    expect(await verifyPassword(user.password, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });
});

test("change: a breached new password is refused and nothing changes", async () => {
  await withBreachService(async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { token } = await createSession(user.id);
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const refused = await read(await post(change, "/api/v1/auth/change-password", { currentPassword: user.password, newPassword: BREACHED }, cookie));
    expect(refused).toMatchObject({ status: 400, json: { error: { code: "VALIDATION", message: BREACHED_MESSAGE } } });
    expect(await verifyPassword(user.password, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });
});

test("setup: the first administrator cannot choose a breached password either", async () => {
  await withBreachService(async () => {
    await resetDatabase(); // the wizard only exists on a fresh install
    try {
      const body = (password: string) => ({ schoolName: "Test School", name: "Amina Yusuf", email: "amina@breach.test", password });
      const refused = await read(await post(setup, "/api/v1/setup", body(BREACHED)));
      expect(refused).toMatchObject({ status: 400, json: { error: { code: "VALIDATION", message: BREACHED_MESSAGE } } });
      expect(await db.user.count()).toBe(0);
      expect(await db.systemSettings.count({ where: { setupComplete: true } })).toBe(0); // the wizard is still open
    } finally {
      await resetDatabase();
      await seedInstance(); // leave the database usable for whatever runs next
    }
  });
});
