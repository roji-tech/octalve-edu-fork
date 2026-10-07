import "../support/env";
import { test, expect } from "@playwright/test";
import type { Role } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import {
  activateSession,
  archiveSession,
  cancelClose,
  closeSession,
  createPeriod,
  createSession,
  getSession,
  listSessions,
  reopenSession,
  setCurrentPeriod,
  updateSession,
} from "@/lib/academics/sessions";

// Closing a session takes time (plan, "Design change — closing a session takes time, and a closed session can be reopened"): the schedule, the
// forced one-minute way, cancelling, the lazy settling that happens exactly once, and reopening. In-process, as `app_user`.
// The lengths are product rules, so they are spelled out HERE, not read back from the module under test.
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

let a: TestTenant;
let b: TestTenant;
let boss: { id: string };

const ctx = (t: TestTenant, role: Role = "ADMIN", campusId: string | null = null): TenantAuthContext["tenant"] => ({
  tenantId: trustedTenantId(t.id),
  tenantCode: t.code,
  tenantName: t.name,
  schoolType: "K12",
  role,
  campusId,
  permissions: [],
  run: <T>(fn: (tx: Tx) => Promise<T>) => forTenant(trustedTenantId(t.id)).transaction(fn),
});
const admin = (t: TestTenant = a) => ctx(t);

test.beforeEach(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  boss = await createUser({ name: "Ada Admin" });
  await addMembership(boss.id, a.id, R.ADMIN);
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

const y2026 = { startDate: "2026-09-07", endDate: "2027-07-23" };
const y2027 = { startDate: "2027-09-06", endDate: "2028-07-21" };

async function openSession(label: string, dates = y2026, school: TestTenant = a, campusId: string | null = null) {
  const created = await createSession(admin(school), boss.id, { campusId, label, ...dates });
  if (!created.ok) throw new Error(`createSession refused: ${created.reason}`);
  const opened = await activateSession(admin(school), boss.id, created.session.id, { closeCurrent: false });
  if (!opened.ok) throw new Error(`activateSession refused: ${opened.reason}`);
  return opened.session;
}
const actions = async (targetId: string) =>
  (await db.auditLog.findMany({ where: { tenantId: a.id, targetId }, orderBy: { createdAt: "asc" } })).map((row) => row.action);
const row = (id: string) => db.academicSession.findUniqueOrThrow({ where: { id } });
const makeDue = (id: string) => db.academicSession.update({ where: { id }, data: { closeAt: new Date(Date.now() - 1000) } });
const near = (at: Date | string | null, expected: number) => Math.abs(new Date(at as string).getTime() - expected) < 30_000;

test.describe("scheduling", () => {
  test("closing schedules the close a day ahead: nothing closes, the session stays ACTIVE and editable, and the request is audited", async () => {
    const s = await openSession("2026/2027");
    const asked = Date.now();
    const result = await closeSession(admin(), boss.id, s.id);
    expect(result).toMatchObject({ ok: true, changed: true, session: { status: "ACTIVE", closeForced: false } });
    expect(result.ok && near(result.session.closeAt, asked + DAY_MS)).toBe(true);
    const stored = await row(s.id);
    expect(stored).toMatchObject({ status: "ACTIVE", closeRequestedById: boss.id, closeForced: false });
    expect(near(stored.closeAt, asked + DAY_MS)).toBe(true);
    expect(await actions(s.id)).toEqual(["SESSION_CREATED", "SESSION_ACTIVATED", "SESSION_CLOSE_REQUESTED"]);
    // still fully usable
    expect(await updateSession(admin(), boss.id, s.id, { label: "Renamed while closing" })).toMatchObject({ ok: true, changed: true });
    expect(await createPeriod(admin(), boss.id, s.id, { label: "Term 1", startDate: "2026-09-07", endDate: "2026-12-18" })).toMatchObject({
      ok: true,
    });
  });

  test("asking again while a close is scheduled is a quiet no-op: the same time, no second audit row", async () => {
    const s = await openSession("2026/2027");
    const first = await closeSession(admin(), boss.id, s.id);
    const again = await closeSession(admin(), boss.id, s.id);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(first.ok && again.ok && first.session.closeAt === again.session.closeAt).toBe(true);
    expect((await actions(s.id)).filter((x) => x === "SESSION_CLOSE_REQUESTED")).toHaveLength(1);
  });

  test("forcing (the route has checked the password) closes a minute ahead; the sooner time wins in both orders", async () => {
    const s = await openSession("2026/2027");
    const asked = Date.now();
    expect(await closeSession(admin(), boss.id, s.id, { force: true })).toMatchObject({
      ok: true,
      changed: true,
      session: { closeForced: true },
    });
    expect(near((await row(s.id)).closeAt, asked + MINUTE_MS)).toBe(true);
    // a later, slower request must not push the forced time back out
    expect(await closeSession(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: false });
    expect(near((await row(s.id)).closeAt, asked + MINUTE_MS)).toBe(true);

    const t = await openSession("2027/2028", y2027);
    await closeSession(admin(), boss.id, t.id); // a day …
    expect(await closeSession(admin(), boss.id, t.id, { force: true })).toMatchObject({ ok: true, changed: true }); // … brought forward to a minute
    const stored = await row(t.id);
    expect(near(stored.closeAt, Date.now() + MINUTE_MS)).toBe(true);
    expect(stored.closeForced).toBe(true);
    expect(await actions(t.id)).toContain("SESSION_CLOSE_REQUESTED");
  });

  test("only an ACTIVE session can be closed; an archived or unknown one is refused with nothing written", async () => {
    const planned = await createSession(admin(), boss.id, { label: "Planned", ...y2026 });
    if (!planned.ok) throw new Error("setup");
    expect(await closeSession(admin(), boss.id, planned.session.id)).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    expect(await closeSession(admin(), boss.id, "no-such-session")).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect((await row(planned.session.id)).closeAt).toBeNull();
  });

  test("cancelling clears the schedule and is audited; cancelling nothing is a no-op; the session can be scheduled again", async () => {
    const s = await openSession("2026/2027");
    expect(await cancelClose(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: false }); // nothing planned
    await closeSession(admin(), boss.id, s.id);
    expect(await cancelClose(admin(), boss.id, s.id)).toMatchObject({
      ok: true,
      changed: true,
      session: { status: "ACTIVE", closeAt: null },
    });
    expect(await row(s.id)).toMatchObject({ closeAt: null, closeRequestedById: null, closeForced: false });
    expect(await actions(s.id)).toEqual(["SESSION_CREATED", "SESSION_ACTIVATED", "SESSION_CLOSE_REQUESTED", "SESSION_CLOSE_CANCELLED"]);
    expect(await closeSession(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: true });
  });

  test("a close that has already come due cannot be cancelled: the session is CLOSED (reopen is the way back)", async () => {
    const s = await openSession("2026/2027");
    await closeSession(admin(), boss.id, s.id, { force: true });
    await makeDue(s.id);
    expect(await cancelClose(admin(), boss.id, s.id)).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    expect((await row(s.id)).status).toBe("CLOSED");
  });
});

test.describe("coming due", () => {
  test("a due session reads as CLOSED and is written down exactly once, attributed to whoever asked, with the periods' current pointer cleared", async () => {
    const s = await openSession("2026/2027");
    const term = await createPeriod(admin(), boss.id, s.id, { label: "Term 1", startDate: "2026-09-07", endDate: "2026-12-18" });
    if (!term.ok) throw new Error("setup");
    await setCurrentPeriod(admin(), boss.id, term.period.id);
    await closeSession(admin(), boss.id, s.id, { force: true });
    await makeDue(s.id);

    const seen = await getSession(admin(), s.id);
    expect(seen).toMatchObject({ ok: true, session: { status: "CLOSED", closeAt: null } });
    expect(await row(s.id)).toMatchObject({ status: "CLOSED" });
    expect((await db.academicPeriod.findUniqueOrThrow({ where: { id: term.period.id } })).isCurrent).toBe(false);
    await getSession(admin(), s.id);
    await listSessions(admin(), { status: "all" }, { skip: 0, take: 10 });
    const closedRows = await db.auditLog.findMany({ where: { tenantId: a.id, targetId: s.id, action: "SESSION_CLOSED" } });
    expect(closedRows).toHaveLength(1);
    expect(closedRows[0]).toMatchObject({ actorUserId: boss.id, afterValue: { status: "CLOSED", scheduled: true, forced: true } });
  });

  test("many readers at the same instant write ONE audit row (the conditional update decides)", async () => {
    const s = await openSession("2026/2027");
    await closeSession(admin(), boss.id, s.id);
    await makeDue(s.id);
    await Promise.all([
      getSession(admin(), s.id),
      getSession(admin(), s.id),
      listSessions(admin(), { status: "all" }, { skip: 0, take: 10 }),
      listSessions(admin(), { status: "active" }, { skip: 0, take: 10 }),
      updateSession(admin(), boss.id, s.id, { label: "x" }),
    ]);
    expect(await db.auditLog.count({ where: { tenantId: a.id, targetId: s.id, action: "SESSION_CLOSED" } })).toBe(1);
  });

  test("once due, the session is read-only the moment anything touches it, and the 'active' filter no longer lists it", async () => {
    const s = await openSession("2026/2027");
    await closeSession(admin(), boss.id, s.id, { force: true });
    await makeDue(s.id);
    expect(await updateSession(admin(), boss.id, s.id, { label: "Too late" })).toMatchObject({ ok: false, reason: "CLOSED_READONLY" });
    expect(await createPeriod(admin(), boss.id, s.id, { label: "Late", startDate: "2026-09-07", endDate: "2026-12-18" })).toMatchObject({
      ok: false,
      reason: "CLOSED_READONLY",
    });
    const active = await listSessions(admin(), { status: "active" }, { skip: 0, take: 10 });
    expect(active.sessions.map((x) => x.id)).not.toContain(s.id);
    const closed = await listSessions(admin(), { status: "closed" }, { skip: 0, take: 10 });
    expect(closed.sessions.map((x) => x.id)).toContain(s.id);
  });

  test("a due session makes room: the next session can be activated without closeCurrent, but a session still counting down does not", async () => {
    const s = await openSession("2026/2027");
    const next = await createSession(admin(), boss.id, { label: "2027/2028", ...y2027 });
    if (!next.ok) throw new Error("setup");
    await closeSession(admin(), boss.id, s.id, { force: true });
    expect(await activateSession(admin(), boss.id, next.session.id, { closeCurrent: false })).toMatchObject({
      ok: false,
      reason: "SESSION_ALREADY_ACTIVE", // still counting down: still the active one
    });
    await makeDue(s.id);
    expect(await activateSession(admin(), boss.id, next.session.id, { closeCurrent: false })).toMatchObject({ ok: true });
  });

  test("another school's due session is not touched by this school's reads (row-level security), and settles for its own", async () => {
    const mine = await openSession("2026/2027");
    const theirs = await openSession("Their year", y2026, b);
    await closeSession(admin(b), boss.id, theirs.id, { force: true });
    await makeDue(theirs.id);
    await getSession(admin(), mine.id);
    expect((await row(theirs.id)).status).toBe("ACTIVE"); // not written down by A's call
    expect(await getSession(admin(b), theirs.id)).toMatchObject({ ok: true, session: { status: "CLOSED" } });
  });
});

test.describe("reopening", () => {
  async function closedSession(label = "2026/2027", dates = y2026) {
    const s = await openSession(label, dates);
    await closeSession(admin(), boss.id, s.id, { force: true });
    await makeDue(s.id);
    await getSession(admin(), s.id); // settles
    return s;
  }

  test("a CLOSED session reopens with a reason: ACTIVE again, the schedule gone, no term current, and the reason in the audit trail", async () => {
    const s = await closedSession();
    const result = await reopenSession(admin(), boss.id, s.id, "  Closed a day too early by mistake ");
    expect(result).toMatchObject({ ok: true, session: { status: "ACTIVE", closeAt: null } });
    expect(await row(s.id)).toMatchObject({ status: "ACTIVE", closeAt: null, closeRequestedById: null, closeForced: false });
    expect(await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, targetId: s.id, action: "SESSION_REOPENED" } })).toMatchObject({
      actorUserId: boss.id,
      reason: "Closed a day too early by mistake",
    });
    // it can be closed again, the same way
    expect(await closeSession(admin(), boss.id, s.id)).toMatchObject({ ok: true, changed: true });
  });

  test("a reason of 5 to 300 characters is required; nothing is written without one", async () => {
    const s = await closedSession();
    for (const reason of ["", "   ", "no", "x".repeat(301), "bell\u0007 char", 42, null, undefined]) {
      expect(await reopenSession(admin(), boss.id, s.id, reason), String(reason)).toMatchObject({ ok: false, reason: "INVALID_REASON" });
    }
    expect((await row(s.id)).status).toBe("CLOSED");
    expect(await actions(s.id)).not.toContain("SESSION_REOPENED");
  });

  test("refused while another session of the same scope is ACTIVE (naming it), and the refusal writes nothing", async () => {
    const old = await closedSession("2026/2027");
    await openSession("2027/2028", y2027);
    const refused = await reopenSession(admin(), boss.id, old.id, "Because we need it back");
    expect(refused).toMatchObject({ ok: false, reason: "SESSION_ALREADY_ACTIVE", detail: { label: "2027/2028" } });
    expect((await row(old.id)).status).toBe("CLOSED");
    expect(await actions(old.id)).not.toContain("SESSION_REOPENED");
  });

  test("only a CLOSED, unarchived session can be reopened", async () => {
    const open = await openSession("2026/2027");
    expect(await reopenSession(admin(), boss.id, open.id, "It is not closed at all")).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    const planned = await createSession(admin(), boss.id, { label: "Planned", ...y2027 });
    if (!planned.ok) throw new Error("setup");
    expect(await reopenSession(admin(), boss.id, planned.session.id, "It was never opened")).toMatchObject({
      ok: false,
      reason: "WRONG_STATE",
    });
    const gone = await closedSession("2025/2026", { startDate: "2025-09-01", endDate: "2026-07-31" });
    await archiveSession(admin(), boss.id, gone.id);
    expect(await reopenSession(admin(), boss.id, gone.id, "It is archived now")).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await reopenSession(admin(), boss.id, "no-such-session", "There is nothing here")).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  test("another school's session, and another campus's for a campus member, are the same NOT_FOUND for every closing action", async () => {
    const theirs = await openSession("Their year", y2026, b);
    const own = await openSession("North own", y2027, a, a.campuses[0].id);
    const outsider = ctx(a, "TEACHING_STAFF", null); // staff of no campus sees school-wide sessions only
    for (const id of [theirs.id]) {
      expect(await closeSession(admin(), boss.id, id)).toEqual({ ok: false, reason: "NOT_FOUND" });
      expect(await cancelClose(admin(), boss.id, id)).toEqual({ ok: false, reason: "NOT_FOUND" });
      expect(await reopenSession(admin(), boss.id, id, "Not mine to reopen")).toEqual({ ok: false, reason: "NOT_FOUND" });
    }
    expect(await closeSession(outsider, boss.id, own.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect((await row(theirs.id)).closeAt).toBeNull();
  });
});
