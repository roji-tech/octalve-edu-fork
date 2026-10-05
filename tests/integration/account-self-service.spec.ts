import "../support/env";
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { createUser, db, sha256Hex, uniqueEmail } from "../support/db";
import { createSession, SESSION_ONLY_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { createResetToken, isLiveResetToken } from "@/lib/auth/password-reset";
import {
  EMAIL_CHANGE_TTL_MS,
  confirmEmailChange,
  createEmailChangeToken,
} from "@/lib/auth/email-change";
import { listSessions, revokeAllOtherSessions, revokeOwnSession } from "@/lib/auth/session-devices";

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const sessionIdOf = async (token: string) =>
  (await db.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token) } })).id;

test.describe("createEmailChangeToken", () => {
  test("only the SHA-256 hash is stored — the plaintext is nowhere in the database", async () => {
    const user = await createUser();
    const newEmail = uniqueEmail("new");
    const token = await createEmailChangeToken(user.id, newEmail);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    const rows = await db.emailChangeToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256Hex(token));
    expect(rows[0].newEmail).toBe(newEmail);
    expect(rows[0].usedAt).toBeNull();
    const hits = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "EmailChangeToken" t WHERE t::text LIKE ${"%" + token + "%"}`;
    expect(hits[0].n).toBe(0);
  });

  test("expires in one hour", async () => {
    const user = await createUser();
    await createEmailChangeToken(user.id, uniqueEmail("new"));
    const row = await db.emailChangeToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(EMAIL_CHANGE_TTL_MS).toBe(60 * 60_000);
    expect(Math.abs(row.expiresAt.getTime() - (Date.now() + EMAIL_CHANGE_TTL_MS))).toBeLessThan(60_000);
  });

  test("one live request per person: asking again kills the earlier link; other people's are untouched", async () => {
    const a = await createUser();
    const b = await createUser();
    const first = await createEmailChangeToken(a.id, uniqueEmail("one"));
    const bToken = await createEmailChangeToken(b.id, uniqueEmail("bee"));
    const second = await createEmailChangeToken(a.id, uniqueEmail("two"));
    expect(await db.emailChangeToken.count({ where: { userId: a.id } })).toBe(1);
    expect(await db.emailChangeToken.count({ where: { tokenHash: sha256Hex(first) } })).toBe(0);
    expect(await db.emailChangeToken.count({ where: { tokenHash: sha256Hex(second) } })).toBe(1);
    expect(await db.emailChangeToken.count({ where: { tokenHash: sha256Hex(bToken) } })).toBe(1);
    expect(await confirmEmailChange(first)).toBeNull();
  });
});

test.describe("confirmEmailChange", () => {
  test("switches the address, marks it verified, and reports old and new", async () => {
    const user = await createUser();
    await db.user.update({ where: { id: user.id }, data: { emailVerified: null } });
    const newEmail = uniqueEmail("new");
    const token = await createEmailChangeToken(user.id, newEmail);

    const result = await confirmEmailChange(token);
    expect(result).toEqual({ userId: user.id, oldEmail: user.email, newEmail });
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.email).toBe(newEmail);
    expect(row.emailVerified).not.toBeNull(); // following the link proved the address is reachable
    expect(row.passwordHash).not.toBeNull(); // nothing else about the account moved
  });

  test("the email is the recovery channel, so EVERYTHING issued for the old one dies with it — and only that person's", async () => {
    const user = await createUser();
    const other = await createUser();
    await createSession(user.id);
    await createSession(user.id);
    const bystanderSession = await createSession(other.id);
    const resetToken = await createResetToken(user.id);
    const otherReset = await createResetToken(other.id);
    await db.mfaChallenge.create({ data: { tokenHash: sha256Hex("c1"), userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
    await db.mfaChallenge.create({ data: { tokenHash: sha256Hex("c2"), userId: other.id, expiresAt: new Date(Date.now() + 60_000) } });
    const token = await createEmailChangeToken(user.id, uniqueEmail("new"));
    // A second pending request cannot exist normally; plant one to prove the transaction sweeps "other" tokens too.
    await db.emailChangeToken.create({
      data: { tokenHash: sha256Hex("planted"), userId: user.id, newEmail: uniqueEmail("planted"), expiresAt: new Date(Date.now() + 60_000) },
    });
    const otherChange = await createEmailChangeToken(other.id, uniqueEmail("others"));

    expect(await confirmEmailChange(token)).not.toBeNull();

    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await isLiveResetToken(resetToken)).toBe(false);
    expect(await db.mfaChallenge.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.emailChangeToken.count({ where: { userId: user.id, tokenHash: sha256Hex("planted") } })).toBe(0);

    expect(await db.session.count({ where: { tokenHash: sha256Hex(bystanderSession.token) } })).toBe(1);
    expect(await isLiveResetToken(otherReset)).toBe(true);
    expect(await db.mfaChallenge.count({ where: { userId: other.id } })).toBe(1);
    expect(await db.emailChangeToken.count({ where: { tokenHash: sha256Hex(otherChange) } })).toBe(1);
  });

  test("single use: the same link a second time is refused and changes nothing", async () => {
    const user = await createUser();
    const first = uniqueEmail("first");
    const token = await createEmailChangeToken(user.id, first);
    expect(await confirmEmailChange(token)).not.toBeNull();
    await db.user.update({ where: { id: user.id }, data: { email: user.email } }); // pretend it was changed back
    expect(await confirmEmailChange(token)).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
  });

  test("20 simultaneous confirmations of one link: exactly one wins", async () => {
    const user = await createUser();
    await createSession(user.id);
    const token = await createEmailChangeToken(user.id, uniqueEmail("race"));
    const results = await Promise.all(Array.from({ length: 20 }, () => confirmEmailChange(token)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("an expired link is refused, changes nothing and keeps the sessions", async () => {
    const user = await createUser();
    await createSession(user.id);
    const token = await createEmailChangeToken(user.id, uniqueEmail("late"));
    await db.emailChangeToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await confirmEmailChange(token)).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  test("unknown and malformed tokens are refused", async () => {
    for (const token of ["", "x", crypto.randomBytes(32).toString("base64url"), "' OR '1'='1", "a".repeat(5000)]) {
      expect(await confirmEmailChange(token)).toBeNull();
    }
  });

  test("the address was taken in the meantime: refused, and the whole transaction rolls back (nothing is half-done)", async () => {
    const user = await createUser();
    const rival = await createUser();
    await createSession(user.id);
    const resetToken = await createResetToken(user.id);
    const wanted = uniqueEmail("contested");
    const token = await createEmailChangeToken(user.id, wanted);
    await db.user.update({ where: { id: rival.id }, data: { email: wanted } }); // somebody registered it first

    expect(await confirmEmailChange(token)).toBeNull();

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1); // still signed in
    expect(await isLiveResetToken(resetToken)).toBe(true);
    expect((await db.emailChangeToken.findFirstOrThrow({ where: { userId: user.id } })).usedAt).toBeNull(); // claim rolled back too
  });

  test("a link for a user that has since been deleted is refused (cascade removed the row)", async () => {
    const user = await createUser();
    const token = await createEmailChangeToken(user.id, uniqueEmail("ghost"));
    await db.user.delete({ where: { id: user.id } });
    expect(await confirmEmailChange(token)).toBeNull();
  });
});

test.describe("session devices", () => {
  test("listSessions: only the person's own, current first, then most recently used; never a token", async () => {
    const user = await createUser();
    const other = await createUser();
    const oldest = await createSession(user.id, CHROME_WIN);
    const middle = await createSession(user.id, SAFARI_IPHONE);
    const current = await createSession(user.id, CHROME_WIN);
    await createSession(other.id, CHROME_WIN);
    await db.session.update({ where: { tokenHash: sha256Hex(oldest.token) }, data: { lastUsedAt: new Date(Date.now() - 3 * 86400_000) } });
    await db.session.update({ where: { tokenHash: sha256Hex(middle.token) }, data: { lastUsedAt: new Date(Date.now() - 3600_000) } });
    // The OLDEST session is the one in use — so "current first" must not collapse into "newest first".
    const inUseId = await sessionIdOf(oldest.token);
    const freshestId = await sessionIdOf(current.token); // never touched since creation: used moments ago
    const middleId = await sessionIdOf(middle.token); // used an hour ago

    const list = await listSessions(user.id, inUseId);
    expect(list.map((s) => s.id)).toEqual([inUseId, freshestId, middleId]);
    expect(list.map((s) => s.current)).toEqual([true, false, false]);
    expect(list[2].device).toBe("Safari on iPhone");
    const serialised = JSON.stringify(list);
    for (const { token } of [oldest, middle, current]) {
      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain(sha256Hex(token));
    }
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "current", "device", "id", "keptSignedIn", "lastUsedAt"]);
  });

  test("expired sessions are not listed (idle-expired and absolute-expired alike)", async () => {
    const user = await createUser();
    const live = await createSession(user.id, CHROME_WIN);
    const idle = await createSession(user.id, CHROME_WIN);
    const absolute = await createSession(user.id, CHROME_WIN);
    await db.session.update({ where: { tokenHash: sha256Hex(idle.token) }, data: { expires: new Date(Date.now() - 1000) } });
    await db.session.update({ where: { tokenHash: sha256Hex(absolute.token) }, data: { absoluteExpires: new Date(Date.now() - 1000) } });
    const list = await listSessions(user.id, await sessionIdOf(live.token));
    expect(list.map((s) => s.id)).toEqual([await sessionIdOf(live.token)]);
  });

  test("keptSignedIn tells the long 'Keep me signed in' session from the 12-hour one", async () => {
    const user = await createUser();
    const short = await createSession(user.id, CHROME_WIN);
    const remembered = await createSession(user.id, CHROME_WIN, { remember: true });
    const list = await listSessions(user.id, await sessionIdOf(short.token));
    const byId = new Map(list.map((s) => [s.id, s]));
    expect(byId.get(await sessionIdOf(short.token))!.keptSignedIn).toBe(false);
    expect(byId.get(await sessionIdOf(remembered.token))!.keptSignedIn).toBe(true);
    expect(SESSION_ONLY_MAX_AGE_SECONDS).toBe(12 * 3600);
  });

  test("revokeOwnSession ends the person's own session", async () => {
    const user = await createUser();
    const target = await createSession(user.id, SAFARI_IPHONE);
    const id = await sessionIdOf(target.token);
    expect(await revokeOwnSession(user.id, id)).toEqual({ device: "Safari on iPhone" });
    expect(await db.session.count({ where: { id } })).toBe(0);
    expect(await revokeOwnSession(user.id, id)).toBeNull(); // already gone
  });

  test("revokeOwnSession cannot touch somebody else's session — it answers exactly like an unknown id", async () => {
    const user = await createUser();
    const victim = await createUser();
    const theirs = await createSession(victim.id, CHROME_WIN);
    const id = await sessionIdOf(theirs.token);
    expect(await revokeOwnSession(user.id, id)).toBeNull();
    expect(await revokeOwnSession(user.id, "does-not-exist")).toBeNull();
    expect(await db.session.count({ where: { id } })).toBe(1); // untouched
  });

  test("revokeAllOtherSessions keeps the one in use, reports the count, and spares everyone else", async () => {
    const user = await createUser();
    const other = await createUser();
    await createSession(user.id, CHROME_WIN);
    await createSession(user.id, SAFARI_IPHONE);
    const keep = await createSession(user.id, CHROME_WIN);
    const bystander = await createSession(other.id, CHROME_WIN);

    expect(await revokeAllOtherSessions(user.id, await sessionIdOf(keep.token))).toBe(2);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.session.count({ where: { tokenHash: sha256Hex(keep.token) } })).toBe(1);
    expect(await db.session.count({ where: { tokenHash: sha256Hex(bystander.token) } })).toBe(1);
    expect(await revokeAllOtherSessions(user.id, await sessionIdOf(keep.token))).toBe(0); // idempotent
  });
});
