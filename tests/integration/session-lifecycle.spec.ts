import { HTTP_URL } from "../support/env";
import { NextRequest, NextResponse } from "next/server";
import { test, expect } from "@playwright/test";
import {
  ADMIN_SESSION_ABSOLUTE_MAX_AGE_SECONDS,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_ONLY_MAX_AGE_SECONDS,
  clearSessionCookie,
  createSession,
  deleteSessionByToken,
  getSessionFromRequest,
  purgeExpiredSessions,
  revokeUserSessions,
  setSessionCookie,
} from "@/lib/auth/session";
import { createUser, db, sha256Hex } from "../support/db";
import { parseSetCookie } from "../support/http";

const DAY = 24 * 60 * 60 * 1000;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);
const within = (actual: Date, expectedMs: number, toleranceMs = 60_000) =>
  Math.abs(actual.getTime() - expectedMs) <= toleranceMs;

const requestWith = (token?: string) =>
  new NextRequest(`${HTTP_URL}/anything`, {
    headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
  });
const resolve = (token?: string) => getSessionFromRequest(requestWith(token));
const rowFor = (token: string) => db.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token) } });

test.describe("what is stored", () => {
  test("only a SHA-256 hash of the token is persisted — the plaintext appears nowhere in the database", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);

    expect(token).toMatch(/^[0-9a-f]{64}$/); // 256 bits from a CSPRNG

    const rows = await db.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256Hex(token));
    expect(rows[0].tokenHash).not.toBe(token);

    // Belt and braces: search every column of every Session row for the plaintext.
    const hits = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Session" s WHERE s::text LIKE ${"%" + token + "%"}`;
    expect(hits[0].n).toBe(0);
  });

  test("every session gets a fresh, distinct token (server-generated, never client-chosen)", async () => {
    const a = await createUser();
    const b = await createUser();
    const tokens = new Set<string>();
    for (let i = 0; i < 8; i++) {
      tokens.add((await createSession(a.id)).token);
      tokens.add((await createSession(b.id)).token);
    }
    expect(tokens.size).toBe(16);
  });

  test("the user agent is stored, truncated to 255 characters", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id, "x".repeat(1000));
    expect((await rowFor(token)).userAgent).toHaveLength(255);
    const { token: t2 } = await createSession(user.id, null);
    expect((await rowFor(t2)).userAgent).toBeNull();
  });
});

// Two modes (plan §0.5.A): remembered = the long policy + a persistent cookie; not remembered
// (the DEFAULT — a caller that forgets to say gets the short session) = 12 hours, cap enforced here.
test.describe("lifetimes", () => {
  test("remembered, a normal user: 30-day idle window inside a 90-day absolute cap", async () => {
    const user = await createUser();
    const { token, expires, persistent } = await createSession(user.id, null, { remember: true });
    const row = await rowFor(token);
    expect(within(row.expires, Date.now() + SESSION_MAX_AGE_SECONDS * 1000)).toBe(true);
    expect(within(row.absoluteExpires, Date.now() + SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000)).toBe(true);
    // The value handed back for the cookie is the ABSOLUTE expiry.
    expect(expires.getTime()).toBe(row.absoluteExpires.getTime());
    expect(persistent).toBe(true);
  });

  test("remembered, an admin: the shorter 7-day absolute cap, and the idle window can't outlive it", async () => {
    const user = await createUser();
    const { token, expires, persistent } = await createSession(user.id, null, { admin: true, remember: true });
    const row = await rowFor(token);
    expect(within(row.absoluteExpires, Date.now() + ADMIN_SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000)).toBe(true);
    expect(row.expires.getTime()).toBeLessThanOrEqual(row.absoluteExpires.getTime());
    expect(expires.getTime()).toBe(row.absoluteExpires.getTime());
    expect(persistent).toBe(true);
  });

  test("NOT remembered is the default: 12 hours, idle and absolute alike, and the cookie is not persistent", async () => {
    const user = await createUser();
    for (const opts of [undefined, {}, { remember: false }]) {
      const { token, expires, persistent } = await createSession(user.id, null, opts);
      const row = await rowFor(token);
      expect(within(row.absoluteExpires, Date.now() + SESSION_ONLY_MAX_AGE_SECONDS * 1000)).toBe(true);
      expect(row.expires.getTime()).toBe(row.absoluteExpires.getTime());
      expect(expires.getTime()).toBe(row.absoluteExpires.getTime());
      expect(persistent, JSON.stringify(opts)).toBe(false);
    }
  });

  test("the admin cap composes with the mode: the SHORTER of 12 hours and 7 days wins", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id, null, { admin: true });
    const row = await rowFor(token);
    expect(within(row.absoluteExpires, Date.now() + SESSION_ONLY_MAX_AGE_SECONDS * 1000)).toBe(true);
    expect(SESSION_ONLY_MAX_AGE_SECONDS).toBeLessThan(ADMIN_SESSION_ABSOLUTE_MAX_AGE_SECONDS); // the premise
  });
});

test.describe("resolving a cookie to a session", () => {
  test("a valid token resolves to exactly {sessionId, userId, user{id,name,email}} — no password hash leaks", async () => {
    const user = await createUser({ name: "Zainab Bello" });
    const { token } = await createSession(user.id);
    const resolved = await resolve(token);
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe(user.id);
    expect(resolved!.user).toEqual({ id: user.id, name: "Zainab Bello", email: user.email });
    expect(Object.keys(resolved!).sort()).toEqual(["sessionId", "user", "userId"]);
  });

  test("anything that isn't a live token resolves to null", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");

    expect(await resolve(undefined)).toBeNull(); // no cookie
    expect(await resolve("")).toBeNull();
    expect(await resolve("0".repeat(64))).toBeNull(); // well-formed but unknown
    expect(await resolve(flipped)).toBeNull(); // one character off
    expect(await resolve(token.toUpperCase())).toBeNull(); // case matters
    expect(await resolve("' OR '1'='1")).toBeNull(); // injection is just an unknown string
    expect(await resolve("a".repeat(20_000))).toBeNull(); // oversized cookie value
    expect(await resolve(token)).not.toBeNull(); // and the real one still works
  });

  test("the HASH is not itself a credential: presenting tokenHash does not authenticate", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    const { tokenHash } = await rowFor(token);
    expect(await resolve(tokenHash)).toBeNull();
  });

  test("idle expiry: an expired `expires` ends the session", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    await db.session.update({ where: { tokenHash: sha256Hex(token) }, data: { expires: minutesAgo(1) } });
    expect(await resolve(token)).toBeNull();
  });

  test("absolute expiry: a session kept warm past its hard cap still dies", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    await db.session.update({
      where: { tokenHash: sha256Hex(token) },
      data: { expires: daysFromNow(20), absoluteExpires: minutesAgo(1) },
    });
    expect(await resolve(token)).toBeNull();
  });

  test("a deleted user's sessions vanish with them (cascade)", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    await db.user.delete({ where: { id: user.id } });
    expect(await resolve(token)).toBeNull();
    expect(await db.session.count({ where: { tokenHash: sha256Hex(token) } })).toBe(0);
  });
});

test.describe("sliding idle expiry", () => {
  test("recently used: no write (throttled to once per 5 minutes)", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    const where = { tokenHash: sha256Hex(token) };
    const lastUsedAt = minutesAgo(1);
    const expires = daysFromNow(1);
    await db.session.update({ where, data: { lastUsedAt, expires } });

    expect(await resolve(token)).not.toBeNull();
    const row = await db.session.findUniqueOrThrow({ where });
    expect(row.lastUsedAt.getTime()).toBe(lastUsedAt.getTime());
    expect(row.expires.getTime()).toBe(expires.getTime());
  });

  test("stale enough: idle expiry slides forward to now + 30 days and lastUsedAt updates (remembered)", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id, null, { remember: true });
    const where = { tokenHash: sha256Hex(token) };
    await db.session.update({ where, data: { lastUsedAt: minutesAgo(10), expires: daysFromNow(1) } });

    expect(await resolve(token)).not.toBeNull();
    const row = await db.session.findUniqueOrThrow({ where });
    expect(within(row.expires, Date.now() + SESSION_MAX_AGE_SECONDS * 1000)).toBe(true);
    expect(within(row.lastUsedAt, Date.now())).toBe(true);
  });

  test("a 12-hour (not remembered) session can be used but never slid past its 12 hours", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    const where = { tokenHash: sha256Hex(token) };
    await db.session.update({ where, data: { lastUsedAt: minutesAgo(10) } }); // stale enough to slide

    expect(await resolve(token)).not.toBeNull();
    const row = await db.session.findUniqueOrThrow({ where });
    expect(row.expires.getTime()).toBeLessThanOrEqual(row.absoluteExpires.getTime());
    expect(within(row.expires, Date.now() + SESSION_ONLY_MAX_AGE_SECONDS * 1000)).toBe(true); // NOT +30 days
  });

  test("sliding never extends past the absolute cap", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    const where = { tokenHash: sha256Hex(token) };
    const absoluteExpires = daysFromNow(2);
    await db.session.update({ where, data: { lastUsedAt: minutesAgo(10), absoluteExpires } });

    expect(await resolve(token)).not.toBeNull();
    const row = await db.session.findUniqueOrThrow({ where });
    expect(row.expires.getTime()).toBe(absoluteExpires.getTime());
  });
});

test.describe("bounded growth", () => {
  test("at most 10 sessions per user: the oldest are evicted, the newest survive, other users untouched", async () => {
    const user = await createUser();
    const bystander = await createUser();
    const bystanderSession = await createSession(bystander.id);

    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) tokens.push((await createSession(user.id)).token);

    expect(await db.session.count({ where: { userId: user.id } })).toBe(10);
    expect(await resolve(tokens[0])).toBeNull();
    expect(await resolve(tokens[1])).toBeNull();
    for (const token of tokens.slice(2)) expect(await resolve(token)).not.toBeNull();
    expect(await resolve(bystanderSession.token)).not.toBeNull();
  });

  test("creating a session sweeps that user's own already-expired rows (and only theirs)", async () => {
    const user = await createUser();
    const other = await createUser();
    const stale = await createSession(user.id);
    const staleAbsolute = await createSession(user.id);
    const otherStale = await createSession(other.id);
    await db.session.update({ where: { tokenHash: sha256Hex(stale.token) }, data: { expires: minutesAgo(5) } });
    await db.session.update({
      where: { tokenHash: sha256Hex(staleAbsolute.token) },
      data: { absoluteExpires: minutesAgo(5) },
    });
    await db.session.update({ where: { tokenHash: sha256Hex(otherStale.token) }, data: { expires: minutesAgo(5) } });

    await createSession(user.id);

    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.session.count({ where: { userId: other.id } })).toBe(1); // not swept by someone else's login
  });

  test("purgeExpiredSessions removes only expired rows (idle or absolute) and reports the count", async () => {
    await db.session.deleteMany({}); // count assertions below are global
    const user = await createUser();
    const live = await createSession(user.id);
    const idle = await createSession(user.id);
    const absolute = await createSession(user.id);
    await db.session.update({ where: { tokenHash: sha256Hex(idle.token) }, data: { expires: minutesAgo(1) } });
    await db.session.update({
      where: { tokenHash: sha256Hex(absolute.token) },
      data: { absoluteExpires: minutesAgo(1) },
    });

    expect(await purgeExpiredSessions()).toBe(2);
    expect(await purgeExpiredSessions()).toBe(0);
    expect(await resolve(live.token)).not.toBeNull();
    expect(await db.session.count()).toBe(1);
  });
});

test.describe("revocation", () => {
  test("deleteSessionByToken ends that session only, and is idempotent", async () => {
    const user = await createUser();
    const a = await createSession(user.id);
    const b = await createSession(user.id);
    await deleteSessionByToken(a.token);
    await deleteSessionByToken(a.token); // already gone — must not throw
    await deleteSessionByToken("0".repeat(64)); // never existed — must not throw
    expect(await resolve(a.token)).toBeNull();
    expect(await resolve(b.token)).not.toBeNull();
  });

  test("revokeUserSessions ends every session for that user and no one else's", async () => {
    const user = await createUser();
    const other = await createUser();
    const mine = [await createSession(user.id), await createSession(user.id), await createSession(user.id)];
    const theirs = await createSession(other.id);

    await revokeUserSessions(user.id);

    for (const s of mine) expect(await resolve(s.token)).toBeNull();
    expect(await resolve(theirs.token)).not.toBeNull();
  });

  test("revokeUserSessions can spare the session that made the change (e.g. a password change)", async () => {
    const user = await createUser();
    const keep = await createSession(user.id);
    const drop = await createSession(user.id);
    await revokeUserSessions(user.id, keep.token);
    expect(await resolve(keep.token)).not.toBeNull();
    expect(await resolve(drop.token)).toBeNull();
  });
});

test.describe("cookie attributes (plain-HTTP deployment; the HTTPS shape is proven in the https project)", () => {
  test("name is unprefixed and the cookie is HttpOnly, SameSite=Lax, Path=/, not Secure, no Domain", async () => {
    expect(SESSION_COOKIE_NAME).toBe("octalve.session-token"); // APP_URL is http://
    const expires = new Date(Date.now() + 7 * DAY);
    const res = setSessionCookie(NextResponse.json({}), "abc123", expires);
    const cookie = parseSetCookie(res.headers.getSetCookie()[0]);

    expect(cookie.name).toBe("octalve.session-token");
    expect(cookie.value).toBe("abc123");
    expect(cookie.attributes.get("httponly")).toBe(true);
    expect(String(cookie.attributes.get("samesite")).toLowerCase()).toBe("lax");
    expect(cookie.attributes.get("path")).toBe("/");
    expect(cookie.attributes.has("secure")).toBe(false); // a Secure cookie over http would be silently dropped
    expect(cookie.attributes.has("domain")).toBe(false);
    expect(new Date(String(cookie.attributes.get("expires"))).getTime()).toBe(Math.floor(expires.getTime() / 1000) * 1000);
  });

  test("`expires: null` is a browser-session cookie: no Expires, no Max-Age, every other attribute unchanged", async () => {
    const res = setSessionCookie(NextResponse.json({}), "abc123", null);
    const cookie = parseSetCookie(res.headers.getSetCookie()[0]);

    expect(cookie.value).toBe("abc123");
    expect(cookie.attributes.has("expires")).toBe(false);
    expect(cookie.attributes.has("max-age")).toBe(false);
    expect(cookie.attributes.get("httponly")).toBe(true);
    expect(String(cookie.attributes.get("samesite")).toLowerCase()).toBe("lax");
    expect(cookie.attributes.get("path")).toBe("/");
    expect(cookie.attributes.has("domain")).toBe(false);
  });

  test("the clearing cookie repeats the same attributes with an empty value and Max-Age=0", async () => {
    const res = clearSessionCookie(NextResponse.json({}));
    const cookie = parseSetCookie(res.headers.getSetCookie()[0]);
    expect(cookie.name).toBe("octalve.session-token");
    expect(cookie.value).toBe("");
    expect(cookie.attributes.get("max-age")).toBe("0");
    expect(cookie.attributes.get("httponly")).toBe(true);
    expect(cookie.attributes.get("path")).toBe("/");
    expect(String(cookie.attributes.get("samesite")).toLowerCase()).toBe("lax");
  });
});
