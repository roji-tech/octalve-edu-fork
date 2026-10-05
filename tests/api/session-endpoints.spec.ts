import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, db, sha256Hex } from "../support/db";
import { api, cookieHeader, loginAs, parseSetCookie } from "../support/http";

const ME = "/api/v1/auth/me";
const LOGOUT = "/api/v1/auth/logout";

async function signedIn(role?: Role) {
  const user = await createUser({ role });
  const res = await loginAs(user);
  return { user, token: res.token!, cookie: cookieHeader(res.token!) };
}

test.describe("GET /api/v1/auth/me", () => {
  test("without a session: 401 UNAUTHENTICATED in the standard envelope, uncacheable", async () => {
    const res = await api(ME);
    expect(res.status).toBe(401);
    expect(res.json).toEqual({
      data: null,
      meta: {},
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a signed-in user gets their profile and school memberships, and the response is private/no-store", async () => {
    const { user, cookie } = await signedIn(Role.ADMIN);
    const res = await api(ME, { cookie });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.json.error).toBeNull();
    expect(res.json.data.user).toEqual({ id: user.id, name: user.name, email: user.email });
    expect(res.json.data.memberships).toEqual([
      {
        tenantId: user.tenantId,
        tenantCode: expect.any(String),
        tenantName: "Bright Future Academy",
        campusId: null,
        role: "ADMIN",
      },
    ]);
    expect(res.text).not.toMatch(/passwordHash|tokenHash/);
  });

  test("a user with no school gets an empty membership list, not an error", async () => {
    const { cookie } = await signedIn(undefined);
    const res = await api(ME, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.memberships).toEqual([]);
  });

  test("an idle-expired session is refused", async () => {
    const { token, cookie } = await signedIn();
    await db.session.update({ where: { tokenHash: sha256Hex(token) }, data: { expires: new Date(Date.now() - 1000) } });
    expect((await api(ME, { cookie })).status).toBe(401);
  });

  test("a session past its absolute cap is refused even though its idle window is open", async () => {
    const { token, cookie } = await signedIn();
    await db.session.update({
      where: { tokenHash: sha256Hex(token) },
      data: { expires: new Date(Date.now() + 10 * 86_400_000), absoluteExpires: new Date(Date.now() - 1000) },
    });
    expect((await api(ME, { cookie })).status).toBe(401);
  });

  test("revocation is immediate: delete the row and the very next request is refused", async () => {
    const { token, cookie } = await signedIn();
    expect((await api(ME, { cookie })).status).toBe(200);
    await db.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
    expect((await api(ME, { cookie })).status).toBe(401);
  });

  test("deleting the user ends their sessions too", async () => {
    const { user, cookie } = await signedIn();
    await db.user.delete({ where: { id: user.id } });
    expect((await api(ME, { cookie })).status).toBe(401);
  });

  test("a tampered or foreign cookie value is refused", async () => {
    const { token } = await signedIn();
    const flipped = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect((await api(ME, { cookie: cookieHeader(flipped) })).status).toBe(401);
    expect((await api(ME, { cookie: cookieHeader("garbage") })).status).toBe(401);
    expect((await api(ME, { cookie: `octalve.session-token=${token}x` })).status).toBe(401);
  });

  test("a __Host- prefixed cookie name is NOT accepted on the plain-HTTP deployment (names are per-scheme)", async () => {
    const { token } = await signedIn();
    expect((await api(ME, { cookie: `__Host-octalve.session-token=${token}` })).status).toBe(401);
  });
});

test.describe("POST /api/v1/auth/logout", () => {
  test("deletes the session row, clears the cookie with matching attributes, and the old cookie stops working", async () => {
    const { user, token, cookie } = await signedIn();
    const res = await api(LOGOUT, { method: "POST", body: {}, cookie });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: { loggedOut: true }, meta: {}, error: null });
    expect(res.headers.get("cache-control")).toBe("no-store");

    const cleared = res.setCookies.map(parseSetCookie).find((c) => c.name === "octalve.session-token")!;
    expect(cleared.value).toBe("");
    expect(cleared.attributes.get("max-age")).toBe("0");
    expect(cleared.attributes.get("path")).toBe("/");
    expect(cleared.attributes.get("httponly")).toBe(true);
    expect(String(cleared.attributes.get("samesite")).toLowerCase()).toBe("lax");

    expect(await db.session.count({ where: { userId: user.id } })).toBe(0); // gone server-side, not just in the browser
    expect((await api(ME, { cookie })).status).toBe(401);
    expect(await db.session.count({ where: { tokenHash: sha256Hex(token) } })).toBe(0);
  });

  test("it ends only THIS session: the same user's other device stays signed in", async () => {
    const user = await createUser();
    const laptop = await loginAs(user);
    const phone = await loginAs(user);
    await api(LOGOUT, { method: "POST", body: {}, cookie: cookieHeader(laptop.token!) });
    expect((await api(ME, { cookie: cookieHeader(laptop.token!) })).status).toBe(401);
    expect((await api(ME, { cookie: cookieHeader(phone.token!) })).status).toBe(200);
  });

  test("idempotent: with no cookie, or a stale/garbage one, it is still 200 and still clears the cookie", async () => {
    for (const cookie of [undefined, cookieHeader("f".repeat(64)), cookieHeader("garbage")]) {
      const res = await api(LOGOUT, { method: "POST", body: {}, cookie });
      expect(res.status).toBe(200);
      const cleared = res.setCookies.map(parseSetCookie).find((c) => c.name === "octalve.session-token");
      expect(cleared?.attributes.get("max-age")).toBe("0");
    }
  });

  test("CSRF: a cross-site logout is refused and the session survives", async () => {
    const { user, cookie } = await signedIn();
    for (const origin of [null, "https://evil.example"]) {
      const res = await api(LOGOUT, { method: "POST", body: {}, cookie, origin });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe("CSRF");
      expect(res.setCookies).toHaveLength(0);
    }
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await api(ME, { cookie })).status).toBe(200);
  });
});
