import "../support/env";
import { HTTP_PORT, HTTP_URL, TEST_MFA_KEY } from "../support/env";
import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { codeFor, createUser, db, enableMfa } from "../support/db";
import { createChallenge } from "@/lib/auth/mfa/challenge";
import { SESSION_COOKIE_NAME, createSession } from "@/lib/auth/session";
import { POST as loginMfa } from "@/app/api/v1/auth/login/mfa/route";
import { POST as enroll } from "@/app/api/v1/auth/mfa/enroll/route";
import { POST as confirm } from "@/app/api/v1/auth/mfa/confirm/route";
import { POST as disable } from "@/app/api/v1/auth/mfa/disable/route";
import { POST as recovery } from "@/app/api/v1/auth/mfa/recovery-codes/route";

// With no valid MFA_ENCRYPTION_KEY, two-step verification is simply unavailable: every route answers 503
// MFA_UNAVAILABLE and nothing is spent or changed. (Called in-process — the servers under test run WITH a key.)

const call = (handler: (req: NextRequest, ctx: never) => Promise<Response>, path: string, body: unknown, cookie?: string) =>
  handler(
    new NextRequest(`${HTTP_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: HTTP_URL,
        "x-forwarded-host": `localhost:${HTTP_PORT}`, // what the CSRF check compares Origin against
        "x-real-ip": "10.9.9.9",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    {} as never,
  );

test.describe("no MFA_ENCRYPTION_KEY", () => {
  test.beforeEach(() => {
    delete process.env.MFA_ENCRYPTION_KEY;
  });
  test.afterEach(() => {
    process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;
  });

  test("sign-in step 2 answers 503 and spends neither a challenge attempt nor a code", async () => {
    // (Enrolled and the challenge issued while a key existed.)
    process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;
    const user = await createUser();
    const { secret } = await enableMfa(user.id);
    const challenge = await createChallenge(user.id, false);
    const code = codeFor(secret);
    delete process.env.MFA_ENCRYPTION_KEY;

    const res = await call(loginMfa as never, "/api/v1/auth/login/mfa", { challenge, code });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("MFA_UNAVAILABLE");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.mfaChallenge.findFirstOrThrow({ where: { userId: user.id } })).attempts).toBe(0);
    expect((await db.mfaCredential.findUniqueOrThrow({ where: { userId: user.id } })).lastUsedStep).toBeNull();
  });

  test("every account route answers 503 and changes nothing", async () => {
    process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;
    const user = await createUser();
    await enableMfa(user.id);
    const { token } = await createSession(user.id);
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    delete process.env.MFA_ENCRYPTION_KEY;

    const bodies: [typeof enroll, string, unknown][] = [
      [enroll, "/api/v1/auth/mfa/enroll", { password: user.password }],
      [confirm, "/api/v1/auth/mfa/confirm", { code: "123456" }],
      [disable, "/api/v1/auth/mfa/disable", { password: user.password, code: "123456" }],
      [recovery, "/api/v1/auth/mfa/recovery-codes", { code: "123456" }],
    ];
    for (const [handler, path, body] of bodies) {
      const res = await call(handler as never, path, body, cookie);
      expect(res.status, path).toBe(503);
      expect((await res.json()).error.code).toBe("MFA_UNAVAILABLE");
    }
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } })).toBe(10);
  });
});

// The other way two-step verification becomes unusable: a key IS set, but it is not the one the secrets were
// encrypted under (the key was changed, or restored from the wrong place). Same answer, and nothing is granted.
test.describe("a key that cannot read the stored secrets", () => {
  test.afterEach(() => {
    process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;
  });

  test("step 2 answers 503 (not a 500), grants no session and spends no code; confirm and disable do the same", async () => {
    const user = await createUser();
    const { secret } = await enableMfa(user.id);
    const challenge = await createChallenge(user.id, false);
    const { token } = await createSession(user.id);
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64"); // a different, valid key

    const login = await call(loginMfa as never, "/api/v1/auth/login/mfa", { challenge, code: codeFor(secret) });
    expect(login.status).toBe(503);
    expect((await login.json()).error.code).toBe("MFA_UNAVAILABLE");
    expect(login.headers.get("set-cookie")).toBeNull();

    const off = await call(disable as never, "/api/v1/auth/mfa/disable", { password: user.password, code: codeFor(secret) }, cookie);
    expect(off.status).toBe(503);
    const codes = await call(recovery as never, "/api/v1/auth/mfa/recovery-codes", { code: codeFor(secret) }, cookie);
    expect(codes.status).toBe(503);

    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.mfaCredential.findUniqueOrThrow({ where: { userId: user.id } })).lastUsedStep).toBeNull();
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } })).toBe(10);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1); // only the one made for this test
  });
});
