import "../support/env";
import { test, expect } from "@playwright/test";
import type { Role, SchoolType } from "@prisma/client";
import { Role as R, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { prisma } from "@/lib/db";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import {
  activateSession,
  archivePeriod,
  archiveSession,
  closeSession,
  copyForward,
  createPeriod,
  createSession,
  getSession,
  listPeriods,
  listSessions,
  setCurrentPeriod,
  updatePeriod,
  updateSession,
} from "@/lib/academics/sessions";

// Academic sessions and periods in-process, as `app_user` (plan "Build design — Phase 1.0 and 1.1", decisions 7–12 and 16): the rules, the
// per-scope guarantees under concurrency, scope visibility, and what the DATABASE refuses on its own.

let a: TestTenant;
let b: TestTenant;
let boss: { id: string };

const ctx = (
  t: TestTenant,
  role: Role = "ADMIN",
  campusId: string | null = null,
  schoolType: SchoolType = "K12",
): TenantAuthContext["tenant"] => ({
  tenantId: trustedTenantId(t.id),
  tenantCode: t.code,
  tenantName: t.name,
  schoolType,
  role,
  campusId,
  permissions: [],
  run: <T>(fn: (tx: Tx) => Promise<T>) => forTenant(trustedTenantId(t.id)).transaction(fn),
});
const admin = (t: TestTenant = a) => ctx(t);
/// Closing is a countdown now (plan, "closing a session takes time"); tests that only need the session CLOSED schedule it (the forced, one-minute way) and
/// move the deadline into the past — the next service call settles it, exactly as it would a minute later.
async function closeNow(id: string) {
  expect(await closeSession(admin(), boss.id, id, { force: true })).toMatchObject({ ok: true });
  await db.academicSession.update({ where: { id }, data: { closeAt: new Date(Date.now() - 1000) } });
}

test.beforeEach(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  boss = await createUser({ name: "Ada Admin" });
  await addMembership(boss.id, a.id, R.ADMIN);
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

const north = () => a.campuses[0].id;
const south = () => a.campuses[1].id;
const y2026 = { startDate: "2026-09-07", endDate: "2027-07-23" };
const y2027 = { startDate: "2027-09-06", endDate: "2028-07-21" };

async function session(label: string, dates = y2026, campusId: string | null = null, school: TestTenant = a) {
  const result = await createSession(admin(school), boss.id, { campusId, label, ...dates });
  if (!result.ok) throw new Error(`createSession(${label}) refused: ${result.reason}`);
  return result.session;
}
async function actions(targetId: string) {
  return (await db.auditLog.findMany({ where: { tenantId: a.id, targetId }, orderBy: { createdAt: "asc" } })).map((row) => row.action);
}

test.describe("creating a session (decision 9)", () => {
  test("stores a cleaned label and the dates, starts PLANNED, and is audited in the same transaction", async () => {
    const created = await createSession(admin(), boss.id, { label: "  2026 /  2027 ", ...y2026 });
    expect(created).toMatchObject({
      ok: true,
      session: { label: "2026 / 2027", status: "PLANNED", campusId: null, startDate: "2026-09-07", endDate: "2027-07-23", periodCount: 0 },
    });
    if (!created.ok) return;
    expect(await actions(created.session.id)).toEqual(["SESSION_CREATED"]);
    expect(await db.auditLog.findFirstOrThrow({ where: { targetId: created.session.id } })).toMatchObject({
      actorUserId: boss.id,
      afterValue: { label: "2026 / 2027", startDate: "2026-09-07" },
    });
  });

  test("refuses a bad label, bad dates, and a campus that is another school's or does not exist — and writes nothing", async () => {
    for (const label of ["", "   ", "x".repeat(41), null, 5]) {
      expect(await createSession(admin(), boss.id, { label, ...y2026 }), String(label)).toMatchObject({
        ok: false,
        reason: "INVALID_LABEL",
      });
    }
    for (const [startDate, endDate] of [
      ["2026-09-07", "2026-09-07"],
      ["2026-09-08", "2026-09-07"],
      ["2026-02-30", "2027-01-01"],
      ["soon", "later"],
    ]) {
      expect(await createSession(admin(), boss.id, { label: "L", startDate, endDate }), `${startDate}→${endDate}`).toMatchObject({
        ok: false,
        reason: "INVALID_DATES",
      });
    }
    expect(await createSession(admin(), boss.id, { label: "L", campusId: b.campuses[0].id, ...y2026 })).toMatchObject({
      ok: false,
      reason: "INVALID_CAMPUS",
    });
    expect(await createSession(admin(), boss.id, { label: "L", campusId: "no-such-campus", ...y2026 })).toMatchObject({
      ok: false,
      reason: "INVALID_CAMPUS",
    });
    expect(await db.academicSession.count({ where: { tenantId: a.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { tenantId: a.id, action: { startsWith: "SESSION_" } } })).toBe(0);
  });

  test("a label is unique per scope among LIVE sessions: the same label is fine on another campus, and once the first is archived", async () => {
    const first = await session("2026/2027");
    expect(await createSession(admin(), boss.id, { label: "2026/2027", ...y2027 })).toMatchObject({ ok: false, reason: "LABEL_TAKEN" });
    await session("2026/2027", y2026, north()); // another scope: allowed
    await archiveSession(admin(), boss.id, first.id);
    expect((await createSession(admin(), boss.id, { label: "2026/2027", ...y2026 })).ok).toBe(true); // the archived label is free again
  });

  test("sessions of one scope may not overlap — sharing a single day counts, adjacent days do not — but different scopes may", async () => {
    await session("2026/2027", { startDate: "2026-09-07", endDate: "2027-07-23" });
    expect(await createSession(admin(), boss.id, { label: "clash", startDate: "2027-07-23", endDate: "2028-07-21" })).toMatchObject({
      ok: false,
      reason: "OVERLAP",
      detail: { label: "2026/2027" },
    });
    expect(await createSession(admin(), boss.id, { label: "inside", startDate: "2026-10-01", endDate: "2026-10-02" })).toMatchObject({
      ok: false,
      reason: "OVERLAP",
    });
    expect((await createSession(admin(), boss.id, { label: "adjacent", startDate: "2027-07-24", endDate: "2028-07-21" })).ok).toBe(true);
    expect((await createSession(admin(), boss.id, { label: "north's own calendar", campusId: north(), ...y2026 })).ok).toBe(true); // its own scope
    expect(
      await createSession(admin(), boss.id, { label: "north again", campusId: north(), startDate: "2026-10-01", endDate: "2026-12-01" }),
    ).toMatchObject({ ok: false, reason: "OVERLAP" });
  });

  test("two administrators creating overlapping sessions at the same instant: exactly ONE succeeds (the per-scope lock), repeated so luck cannot hide a missing lock", async () => {
    for (let round = 0; round < 6; round++) {
      await db.academicSession.deleteMany({ where: { tenantId: a.id } });
      const results = await Promise.all([
        createSession(admin(), boss.id, { label: `one-${round}`, ...y2026 }),
        createSession(admin(), boss.id, { label: `two-${round}`, startDate: "2027-01-01", endDate: "2027-12-31" }),
        createSession(admin(), boss.id, { label: `three-${round}`, startDate: "2026-12-01", endDate: "2027-02-01" }),
      ]);
      expect(
        results.filter((r) => r.ok),
        `round ${round}`,
      ).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "OVERLAP")).toBe(true);
      expect(await db.academicSession.count({ where: { tenantId: a.id } })).toBe(1);
    }
  });
});

test.describe("updating a session", () => {
  test("changes label and dates with a before/after audit; a no-op writes nothing; a CLOSED or archived session is read-only", async () => {
    const s = await session("2026/2027");
    expect(await updateSession(admin(), boss.id, s.id, { label: "2026/2027" })).toMatchObject({ ok: true, changed: false });
    expect(await actions(s.id)).toEqual(["SESSION_CREATED"]);
    const moved = await updateSession(admin(), boss.id, s.id, { label: "Year 2026-27", endDate: "2027-07-30" });
    expect(moved).toMatchObject({ ok: true, changed: true, session: { label: "Year 2026-27", endDate: "2027-07-30" } });
    expect(await db.auditLog.findFirstOrThrow({ where: { targetId: s.id, action: "SESSION_UPDATED" } })).toMatchObject({
      beforeValue: { label: "2026/2027", endDate: "2027-07-23" },
      afterValue: { label: "Year 2026-27", endDate: "2027-07-30" },
    });
    await activateSession(admin(), boss.id, s.id, { closeCurrent: false });
    await closeNow(s.id);
    expect(await updateSession(admin(), boss.id, s.id, { label: "Edited after closing" })).toMatchObject({
      ok: false,
      reason: "CLOSED_READONLY",
    });
    await archiveSession(admin(), boss.id, s.id);
    expect(await updateSession(admin(), boss.id, s.id, { label: "Edited after archiving" })).toMatchObject({
      ok: false,
      reason: "ARCHIVED",
    });
  });

  test("moving or shortening is refused when it would overlap a sibling, take a taken label, or strand a period outside the session", async () => {
    const first = await session("2026/2027");
    const second = await session("2027/2028", y2027);
    expect(await updateSession(admin(), boss.id, second.id, { startDate: "2027-07-23" })).toMatchObject({ ok: false, reason: "OVERLAP" });
    expect(await updateSession(admin(), boss.id, second.id, { label: "2026/2027" })).toMatchObject({ ok: false, reason: "LABEL_TAKEN" });
    await createPeriod(admin(), boss.id, first.id, { label: "Term 3", startDate: "2027-05-01", endDate: "2027-07-20" });
    expect(await updateSession(admin(), boss.id, first.id, { endDate: "2027-06-30" })).toMatchObject({
      ok: false,
      reason: "PERIODS_OUTSIDE",
      detail: { count: 1 },
    });
    expect((await updateSession(admin(), boss.id, first.id, { endDate: "2027-07-20" })).ok).toBe(true); // exactly the period's last day is fine
  });
});

test.describe("activating, closing, archiving (decision 10)", () => {
  test("ONE active session per scope: a second activation is REFUSED naming the first — nothing is closed silently", async () => {
    const one = await session("2026/2027");
    const two = await session("2027/2028", y2027);
    expect(await activateSession(admin(), boss.id, one.id, { closeCurrent: false })).toMatchObject({
      ok: true,
      session: { status: "ACTIVE" },
      closed: null,
    });
    const refused = await activateSession(admin(), boss.id, two.id, { closeCurrent: false });
    expect(refused).toMatchObject({ ok: false, reason: "SESSION_ALREADY_ACTIVE", detail: { sessionId: one.id, label: "2026/2027" } });
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: one.id } })).status).toBe("ACTIVE"); // untouched
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: two.id } })).status).toBe("PLANNED");
  });

  test("closeCurrent closes the old one and opens the new one in ONE transaction, audited as two entries, and clears the old one's current period", async () => {
    const one = await session("2026/2027");
    const two = await session("2027/2028", y2027);
    await activateSession(admin(), boss.id, one.id, { closeCurrent: false });
    const term = await createPeriod(admin(), boss.id, one.id, { label: "Term 1", startDate: "2026-09-07", endDate: "2026-12-18" });
    if (!term.ok) throw new Error(term.reason);
    await setCurrentPeriod(admin(), boss.id, term.period.id);
    const swapped = await activateSession(admin(), boss.id, two.id, { closeCurrent: true });
    expect(swapped).toMatchObject({ ok: true, session: { id: two.id, status: "ACTIVE" }, closed: { id: one.id } });
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: one.id } })).status).toBe("CLOSED");
    expect((await db.academicPeriod.findUniqueOrThrow({ where: { id: term.period.id } })).isCurrent).toBe(false);
    expect(await actions(one.id)).toEqual(["SESSION_CREATED", "SESSION_ACTIVATED", "SESSION_CLOSED"]);
    expect(await actions(two.id)).toEqual(["SESSION_CREATED", "SESSION_ACTIVATED"]);
  });

  test("a refusal discovered AFTER the old session was closed rolls the close back: activating a CLOSED session with closeCurrent leaves the active one active", async () => {
    const one = await session("2026/2027");
    const two = await session("2027/2028", y2027);
    const three = await session("2028/2029", { startDate: "2028-09-01", endDate: "2029-07-31" });
    await activateSession(admin(), boss.id, one.id, { closeCurrent: false });
    await activateSession(admin(), boss.id, two.id, { closeCurrent: true }); // one is now CLOSED, two ACTIVE
    await activateSession(admin(), boss.id, three.id, { closeCurrent: true }); // two CLOSED, three ACTIVE
    const refused = await activateSession(admin(), boss.id, one.id, { closeCurrent: true }); // one is CLOSED, not PLANNED
    expect(refused).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: three.id } })).status).toBe("ACTIVE"); // NOT closed by the failed attempt
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: one.id } })).status).toBe("CLOSED");
    expect(await actions(three.id)).toEqual(["SESSION_CREATED", "SESSION_ACTIVATED"]); // no stray SESSION_CLOSED
  });

  test("the scopes are independent: a campus can run its own active session beside the school-wide one — but not two of its own", async () => {
    const wide = await session("School-wide");
    const northOwn = await session("North calendar", y2026, north());
    const northNext = await session("North next", y2027, north());
    const southOwn = await session("South calendar", y2026, south());
    expect((await activateSession(admin(), boss.id, wide.id, { closeCurrent: false })).ok).toBe(true);
    expect((await activateSession(admin(), boss.id, northOwn.id, { closeCurrent: false })).ok).toBe(true);
    expect((await activateSession(admin(), boss.id, southOwn.id, { closeCurrent: false })).ok).toBe(true);
    expect(await activateSession(admin(), boss.id, northNext.id, { closeCurrent: false })).toMatchObject({
      ok: false,
      reason: "SESSION_ALREADY_ACTIVE",
    });
  });

  test("two simultaneous activations in one scope: exactly ONE wins (repeated); the loser is told which session is active", async () => {
    for (let round = 0; round < 5; round++) {
      await db.academicSession.deleteMany({ where: { tenantId: a.id } });
      const x = await session(`x-${round}`, { startDate: "2026-01-01", endDate: "2026-06-30" });
      const y = await session(`y-${round}`, { startDate: "2026-07-01", endDate: "2026-12-31" });
      const results = await Promise.all([
        activateSession(admin(), boss.id, x.id, { closeCurrent: false }),
        activateSession(admin(), boss.id, y.id, { closeCurrent: false }),
      ]);
      expect(
        results.filter((r) => r.ok),
        `round ${round}`,
      ).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "SESSION_ALREADY_ACTIVE" });
      expect(await db.academicSession.count({ where: { tenantId: a.id, status: "ACTIVE" } })).toBe(1);
    }
  });

  test("the conditional update decides: activating a session that is no longer PLANNED (already active, closed, archived) is WRONG_STATE / ARCHIVED, never a second success", async () => {
    const s = await session("2026/2027");
    await activateSession(admin(), boss.id, s.id, { closeCurrent: false });
    expect(await activateSession(admin(), boss.id, s.id, { closeCurrent: false })).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    await closeNow(s.id);
    expect(await activateSession(admin(), boss.id, s.id, { closeCurrent: false })).toMatchObject({ ok: false, reason: "WRONG_STATE" }); // CLOSED is terminal
    await archiveSession(admin(), boss.id, s.id);
    expect(await activateSession(admin(), boss.id, s.id, { closeCurrent: false })).toMatchObject({ ok: false, reason: "ARCHIVED" });
  });

  test("close needs ACTIVE; an ACTIVE session cannot be archived; archiving a closed or planned one archives its periods and frees the label", async () => {
    const planned = await session("2026/2027");
    expect(await closeSession(admin(), boss.id, planned.id)).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    await createPeriod(admin(), boss.id, planned.id, { label: "Term 1", startDate: "2026-09-07", endDate: "2026-12-18" });
    await activateSession(admin(), boss.id, planned.id, { closeCurrent: false });
    expect(await archiveSession(admin(), boss.id, planned.id)).toMatchObject({ ok: false, reason: "ACTIVE_CANNOT_ARCHIVE" });
    await closeNow(planned.id);
    expect(await archiveSession(admin(), boss.id, planned.id)).toMatchObject({ ok: true, changed: true, session: { archived: true } });
    expect(await archiveSession(admin(), boss.id, planned.id)).toMatchObject({ ok: true, changed: false }); // idempotent
    expect(await db.academicPeriod.count({ where: { sessionId: planned.id, archivedAt: null } })).toBe(0);
    expect(await db.academicSession.count({ where: { id: planned.id } })).toBe(1); // still there: archived, never deleted
    expect(await actions(planned.id)).toEqual([
      "SESSION_CREATED",
      "SESSION_ACTIVATED",
      "SESSION_CLOSE_REQUESTED",
      "SESSION_CLOSED",
      "SESSION_ARCHIVED",
    ]);
  });

  test("the list defaults to live sessions, filters by status, hides archived ones unless asked, and pages stably", async () => {
    const one = await session("2026/2027");
    await session("2027/2028", y2027);
    const old = await session("2025/2026", { startDate: "2025-09-01", endDate: "2026-07-31" });
    await archiveSession(admin(), boss.id, old.id);
    await activateSession(admin(), boss.id, one.id, { closeCurrent: false });
    const list = async (status: Parameters<typeof listSessions>[1]["status"], take = 50, skip = 0) =>
      listSessions(admin(), { status }, { skip, take });
    expect((await list("live")).sessions.map((s) => s.label)).toEqual(["2027/2028", "2026/2027"]); // newest first
    expect((await list("archived")).sessions.map((s) => s.label)).toEqual(["2025/2026"]);
    expect((await list("active")).sessions.map((s) => s.label)).toEqual(["2026/2027"]);
    expect((await list("planned")).sessions.map((s) => s.label)).toEqual(["2027/2028"]);
    expect((await list("all")).total).toBe(3);
    const pages = [...(await list("all", 1, 0)).sessions, ...(await list("all", 1, 1)).sessions, ...(await list("all", 1, 2)).sessions];
    expect(new Set(pages.map((s) => s.id)).size).toBe(3);
  });
});

test.describe("who sees what (decision 7)", () => {
  test("an ADMIN sees every campus; staff see school-wide sessions and their OWN campus's — not another's — and a campus-less member sees school-wide only", async () => {
    const wide = await session("School-wide");
    const n = await session("North", y2027, north());
    const s = await session("South", y2027, south());
    const ids = async (c: TenantAuthContext["tenant"]) =>
      (await listSessions(c, { status: "all" }, { skip: 0, take: 50 })).sessions.map((x) => x.id).sort();
    expect(await ids(ctx(a, "ADMIN", north()))).toEqual([wide.id, n.id, s.id].sort()); // an admin anchored to a campus is still school-wide
    expect(await ids(ctx(a, "TEACHING_STAFF", north()))).toEqual([wide.id, n.id].sort());
    expect(await ids(ctx(a, "NON_TEACHING_STAFF", south()))).toEqual([wide.id, s.id].sort());
    expect(await ids(ctx(a, "TEACHING_STAFF", null))).toEqual([wide.id]);
    // another campus's session is simply not there: the same answer as one that does not exist
    expect(await getSession(ctx(a, "TEACHING_STAFF", north()), s.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await getSession(ctx(a, "TEACHING_STAFF", north()), "no-such-id")).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await listPeriods(ctx(a, "TEACHING_STAFF", north()), s.id, { includeArchived: false })).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
  });

  test("another school's session is NOT_FOUND for every operation — read or write", async () => {
    const theirs = await session("Beta 2026", y2026, null, b);
    const mine = admin();
    expect(await getSession(mine, theirs.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await updateSession(mine, boss.id, theirs.id, { label: "hijack" })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await activateSession(mine, boss.id, theirs.id, { closeCurrent: true })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await closeSession(mine, boss.id, theirs.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await archiveSession(mine, boss.id, theirs.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await createPeriod(mine, boss.id, theirs.id, { label: "T", startDate: "2026-09-07", endDate: "2026-12-18" })).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(await copyForward(mine, boss.id, theirs.id, { startDate: "2027-09-06", dryRun: false })).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: theirs.id } })).label).toBe("Beta 2026");
    expect(
      await db.auditLog.count({
        where: { tenantId: { in: [a.id, b.id] }, action: { startsWith: "SESSION_" }, NOT: { action: "SESSION_CREATED" } },
      }),
    ).toBe(0);
  });
});

test.describe("periods (decision 12)", () => {
  test("the kind comes from the SCHOOL's type, never the caller: TERM for K12, SEMESTER for higher ed, COHORT (open-ended) for vocational", async () => {
    for (const [type, kind] of [
      ["K12", "TERM"],
      ["HIGHER_ED", "SEMESTER"],
      ["VOCATIONAL", "COHORT"],
    ] as const) {
      const s = await session(`Year ${type}`, y2026);
      const created = await createPeriod(ctx(a, "ADMIN", null, type), boss.id, s.id, {
        label: "First",
        startDate: "2026-09-07",
        ...(type === "VOCATIONAL" ? {} : { endDate: "2026-12-18" }),
        kind: "COHORT",
      } as never);
      expect(created, type).toMatchObject({ ok: true, period: { kind, ordinal: 1 } });
      await archiveSession(admin(), boss.id, s.id);
    }
    const s = await session("No end");
    expect(await createPeriod(admin(), boss.id, s.id, { label: "Open", startDate: "2026-09-07" })).toMatchObject({
      ok: false,
      reason: "INVALID_DATES",
      detail: { problem: "END_REQUIRED" },
    }); // a TERM needs an end
  });

  test("ordinals count up by themselves, must be unique, and the dates must sit inside the session without overlapping their siblings", async () => {
    const s = await session("2026/2027");
    const mk = (input: object) => createPeriod(admin(), boss.id, s.id, input as never);
    expect(await mk({ label: "1st Term", startDate: "2026-09-07", endDate: "2026-12-18" })).toMatchObject({
      ok: true,
      period: { ordinal: 1 },
    });
    expect(await mk({ label: "2nd Term", startDate: "2027-01-05", endDate: "2027-04-02" })).toMatchObject({
      ok: true,
      period: { ordinal: 2 },
    });
    expect(await mk({ label: "Dup ordinal", ordinal: 2, startDate: "2027-04-20", endDate: "2027-07-20" })).toMatchObject({
      ok: false,
      reason: "ORDINAL_TAKEN",
    });
    expect(await mk({ label: "1st Term", startDate: "2027-04-20", endDate: "2027-07-20" })).toMatchObject({
      ok: false,
      reason: "LABEL_TAKEN",
    });
    expect(await mk({ label: "Overlaps", startDate: "2027-04-02", endDate: "2027-07-20" })).toMatchObject({
      ok: false,
      reason: "OVERLAP",
      detail: { label: "2nd Term" },
    });
    expect(await mk({ label: "Too early", startDate: "2026-09-06", endDate: "2026-09-30" })).toMatchObject({
      ok: false,
      reason: "INVALID_DATES",
      detail: { problem: "OUTSIDE_SESSION" },
    });
    expect(await mk({ label: "Too late", startDate: "2027-07-01", endDate: "2027-07-24" })).toMatchObject({
      ok: false,
      reason: "INVALID_DATES",
      detail: { problem: "OUTSIDE_SESSION" },
    });
    expect(await mk({ label: "Bad ordinal", ordinal: 0, startDate: "2027-04-20", endDate: "2027-07-20" })).toMatchObject({
      ok: false,
      reason: "INVALID_DATES",
      detail: { problem: "ORDINAL_INVALID" },
    });
    expect(await mk({ label: "3rd Term", startDate: "2027-04-20", endDate: "2027-07-23" })).toMatchObject({
      ok: true,
      period: { ordinal: 3 },
    }); // the session's very last day
    expect((await listPeriods(admin(), s.id, { includeArchived: false })) as { periods: { ordinal: number }[] }).toMatchObject({
      periods: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }],
    });
  });

  test("a session holds at most twelve periods; a CLOSED or archived session takes no new ones", async () => {
    const s = await session("2026/2027");
    const day = (offset: number) => new Date(Date.UTC(2026, 8, 7) + offset * 86_400_000).toISOString().slice(0, 10); // 7 Sep 2026 + n days
    for (let i = 0; i < 12; i++) {
      expect(
        (await createPeriod(admin(), boss.id, s.id, { label: `P${i + 1}`, startDate: day(i * 20), endDate: day(i * 20 + 2) })).ok,
        `P${i + 1}`,
      ).toBe(true);
    }
    expect(await createPeriod(admin(), boss.id, s.id, { label: "P13", startDate: day(250), endDate: day(251) })).toMatchObject({
      ok: false,
      reason: "TOO_MANY_PERIODS",
    });
    const closed = await session("Closed one", { startDate: "2030-01-01", endDate: "2030-12-31" });
    await activateSession(admin(), boss.id, closed.id, { closeCurrent: true });
    await closeNow(closed.id);
    expect(
      await createPeriod(admin(), boss.id, closed.id, { label: "Late", startDate: "2030-02-01", endDate: "2030-03-01" }),
    ).toMatchObject({ ok: false, reason: "CLOSED_READONLY" });
  });

  test("updating a period: a no-op writes nothing; moves are re-checked against the session, the siblings, the ordinal and the label; audited with before/after", async () => {
    const s = await session("2026/2027");
    const t1 = await createPeriod(admin(), boss.id, s.id, { label: "1st Term", startDate: "2026-09-07", endDate: "2026-12-18" });
    const t2 = await createPeriod(admin(), boss.id, s.id, { label: "2nd Term", startDate: "2027-01-05", endDate: "2027-04-02" });
    if (!t1.ok || !t2.ok) throw new Error("setup");
    expect(await updatePeriod(admin(), boss.id, t1.period.id, { label: "1st Term" })).toMatchObject({ ok: true, changed: false });
    expect(await updatePeriod(admin(), boss.id, t2.period.id, { startDate: "2026-12-18" })).toMatchObject({ ok: false, reason: "OVERLAP" });
    expect(await updatePeriod(admin(), boss.id, t2.period.id, { ordinal: 1 })).toMatchObject({ ok: false, reason: "ORDINAL_TAKEN" });
    expect(await updatePeriod(admin(), boss.id, t2.period.id, { label: "1st Term" })).toMatchObject({ ok: false, reason: "LABEL_TAKEN" });
    expect(await updatePeriod(admin(), boss.id, t2.period.id, { endDate: "2027-08-01" })).toMatchObject({
      ok: false,
      reason: "INVALID_DATES",
    });
    const done = await updatePeriod(admin(), boss.id, t2.period.id, { label: "Spring Term", endDate: "2027-03-26" });
    expect(done).toMatchObject({ ok: true, changed: true, period: { label: "Spring Term", endDate: "2027-03-26" } });
    expect(await db.auditLog.findFirstOrThrow({ where: { targetId: t2.period.id, action: "PERIOD_UPDATED" } })).toMatchObject({
      beforeValue: { label: "2nd Term" },
      afterValue: { label: "Spring Term" },
    });
  });

  test("the CURRENT period: only in an ACTIVE session, one at a time, moved by a conditional step; archiving the current one clears the pointer", async () => {
    const s = await session("2026/2027");
    const t1 = await createPeriod(admin(), boss.id, s.id, { label: "1st Term", startDate: "2026-09-07", endDate: "2026-12-18" });
    const t2 = await createPeriod(admin(), boss.id, s.id, { label: "2nd Term", startDate: "2027-01-05", endDate: "2027-04-02" });
    if (!t1.ok || !t2.ok) throw new Error("setup");
    expect(await setCurrentPeriod(admin(), boss.id, t1.period.id)).toMatchObject({ ok: false, reason: "SESSION_NOT_ACTIVE" }); // PLANNED has no current period
    await activateSession(admin(), boss.id, s.id, { closeCurrent: false });
    expect(await setCurrentPeriod(admin(), boss.id, t1.period.id)).toMatchObject({ ok: true, changed: true, period: { isCurrent: true } });
    expect(await setCurrentPeriod(admin(), boss.id, t1.period.id)).toMatchObject({ ok: true, changed: false });
    expect(await setCurrentPeriod(admin(), boss.id, t2.period.id)).toMatchObject({ ok: true, changed: true });
    expect((await db.academicPeriod.findMany({ where: { sessionId: s.id, isCurrent: true } })).map((p) => p.id)).toEqual([t2.period.id]);
    expect(await db.auditLog.findFirstOrThrow({ where: { targetId: t2.period.id, action: "PERIOD_SET_CURRENT" } })).toMatchObject({
      beforeValue: { current: t1.period.id },
      afterValue: { current: t2.period.id },
    });
    expect(await archivePeriod(admin(), boss.id, t2.period.id)).toMatchObject({
      ok: true,
      changed: true,
      period: { archived: true, isCurrent: false },
    });
    expect(await db.academicPeriod.count({ where: { sessionId: s.id, isCurrent: true } })).toBe(0);
    expect(await setCurrentPeriod(admin(), boss.id, t2.period.id)).toMatchObject({ ok: false, reason: "ARCHIVED" });
    expect(await archivePeriod(admin(), boss.id, t2.period.id)).toMatchObject({ ok: true, changed: false });
    expect(await db.academicPeriod.count({ where: { id: t2.period.id } })).toBe(1); // archived, never deleted
    const live = (await listPeriods(admin(), s.id, { includeArchived: false })) as { periods: { id: string }[] };
    expect(live.periods.map((p) => p.id)).toEqual([t1.period.id]);
    const everything = (await listPeriods(admin(), s.id, { includeArchived: true })) as { periods: { id: string }[] };
    expect(everything.periods).toHaveLength(2);
  });

  test("two simultaneous 'make this current' requests leave exactly ONE current period (repeated)", async () => {
    const s = await session("2026/2027");
    const t1 = await createPeriod(admin(), boss.id, s.id, { label: "1st Term", startDate: "2026-09-07", endDate: "2026-12-18" });
    const t2 = await createPeriod(admin(), boss.id, s.id, { label: "2nd Term", startDate: "2027-01-05", endDate: "2027-04-02" });
    if (!t1.ok || !t2.ok) throw new Error("setup");
    await activateSession(admin(), boss.id, s.id, { closeCurrent: false });
    for (let round = 0; round < 6; round++) {
      await Promise.all([setCurrentPeriod(admin(), boss.id, t1.period.id), setCurrentPeriod(admin(), boss.id, t2.period.id)]);
      expect(await db.academicPeriod.count({ where: { sessionId: s.id, isCurrent: true } }), `round ${round}`).toBe(1);
    }
  });
});

test.describe("copy-forward (decision 16)", () => {
  async function sourceWithTerms() {
    const s = await session("2026/2027");
    for (const [label, start, end] of [
      ["1st Term", "2026-09-07", "2026-12-18"],
      ["2nd Term", "2027-01-05", "2027-04-02"],
      ["3rd Term", "2027-04-26", "2027-07-23"],
    ]) {
      await createPeriod(admin(), boss.id, s.id, { label, startDate: start, endDate: end });
    }
    await activateSession(admin(), boss.id, s.id, { closeCurrent: false });
    const first = await db.academicPeriod.findFirstOrThrow({ where: { sessionId: s.id, ordinal: 1 } });
    await setCurrentPeriod(admin(), boss.id, first.id);
    return s;
  }
  const counts = async () => ({
    sessions: await db.academicSession.count({ where: { tenantId: a.id } }),
    periods: await db.academicPeriod.count({ where: { tenantId: a.id } }),
    audit: await db.auditLog.count({ where: { tenantId: a.id } }),
  });

  test("a DRY RUN reports the plan — shifted dates, the next label, the periods — and writes NOTHING (rows and audit counted before and after)", async () => {
    const s = await sourceWithTerms();
    const before = await counts();
    const dry = await copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: true });
    expect(dry).toMatchObject({
      ok: true,
      created: null,
      plan: {
        session: { label: "2027/2028", startDate: "2027-09-06", endDate: "2028-07-23", campusId: null },
        periods: [
          { ordinal: 1, label: "1st Term", startDate: "2027-09-07", endDate: "2027-12-18" },
          { ordinal: 2 },
          { ordinal: 3, endDate: "2028-07-23" },
        ],
        conflicts: [],
      },
    });
    expect(await counts()).toEqual(before);
  });

  test("the real run creates a PLANNED copy with its periods (none current), links it to the source, and audits it — then a SECOND run is refused (idempotent)", async () => {
    const s = await sourceWithTerms();
    const done = await copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: false });
    expect(done).toMatchObject({ ok: true, created: { label: "2027/2028", status: "PLANNED", copiedFromId: s.id, periodCount: 3 } });
    if (!done.ok || !done.created) return;
    const periods = await db.academicPeriod.findMany({ where: { sessionId: done.created.id }, orderBy: { ordinal: "asc" } });
    expect(periods.map((p) => p.label)).toEqual(["1st Term", "2nd Term", "3rd Term"]);
    expect(periods.every((p) => !p.isCurrent && p.kind === "TERM")).toBe(true);
    expect(await actions(done.created.id)).toEqual(["SESSION_COPIED_FORWARD"]);
    const before = await counts();
    expect(await copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: false })).toMatchObject({
      ok: false,
      reason: "ALREADY_COPIED",
    });
    expect(await counts()).toEqual(before); // nothing duplicated
    const dry = await copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: true });
    // a dry run says so too — and, since the copy itself now occupies that label and those dates, reports those clashes as well
    expect(dry).toMatchObject({
      ok: true,
      plan: { conflicts: expect.arrayContaining([{ kind: "ALREADY_COPIED", with: expect.objectContaining({ label: "2027/2028" }) }]) },
    });
    await archiveSession(admin(), boss.id, done.created.id);
    expect((await copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: false })).ok).toBe(true); // once the copy is archived, a new one may be made
  });

  test("two simultaneous copy-forwards of one source produce exactly ONE copy", async () => {
    const s = await sourceWithTerms();
    const results = await Promise.all([
      copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: false }),
      copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: false }),
      copyForward(admin(), boss.id, s.id, { startDate: "2027-09-06", dryRun: false }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.academicSession.count({ where: { tenantId: a.id, copiedFromId: s.id } })).toBe(1);
  });

  test("conflicts are refused with their reason: an overlapping year, a taken label; a leap day lands on 28 February; a label is asked for when none can be derived", async () => {
    const s = await sourceWithTerms();
    expect(await copyForward(admin(), boss.id, s.id, { startDate: "2026-09-07", dryRun: false })).toMatchObject({
      ok: false,
      reason: "OVERLAP",
    }); // 0 years later = itself
    await session("2027/2028", { startDate: "2027-09-06", endDate: "2028-07-21" });
    expect(await copyForward(admin(), boss.id, s.id, { startDate: "2028-09-04", label: "2027/2028", dryRun: false })).toMatchObject({
      ok: false,
      reason: "LABEL_TAKEN",
    });
    expect(await copyForward(admin(), boss.id, s.id, { startDate: "2028-09-04", label: "   ", dryRun: false })).toMatchObject({
      ok: false,
      reason: "INVALID_LABEL",
    });
    expect(await copyForward(admin(), boss.id, s.id, { startDate: "not a date", dryRun: false })).toMatchObject({
      ok: false,
      reason: "INVALID_DATES",
    });
    const odd = await session("Autumn", { startDate: "2028-02-29", endDate: "2028-12-31" }, north()); // its own scope, so it cannot clash with the school-wide years
    expect(await copyForward(admin(), boss.id, odd.id, { startDate: "2029-03-01", dryRun: false })).toMatchObject({
      ok: false,
      reason: "INVALID_LABEL",
    }); // "Autumn" has no next label
    const leap = await copyForward(admin(), boss.id, odd.id, { startDate: "2029-03-01", label: "Autumn 2029", dryRun: true });
    expect(leap).toMatchObject({ ok: true, plan: { session: { startDate: "2029-03-01", endDate: "2029-12-31" } } });
  });
});

test.describe("what the DATABASE refuses on its own (decisions 2 and 9 — even if the service were wrong)", () => {
  test("a second ACTIVE session in a scope, two live copies of one source, two current periods, a repeated ordinal or label — each refused by its own index", async () => {
    const one = await db.academicSession.create({
      data: { tenantId: a.id, label: "One", startDate: new Date("2026-01-01"), endDate: new Date("2026-06-30"), status: "ACTIVE" },
    });
    const base = { tenantId: a.id, startDate: new Date("2026-07-01"), endDate: new Date("2026-12-31") };
    await expect(db.academicSession.create({ data: { ...base, label: "Two", status: "ACTIVE" } })).rejects.toThrow(/Unique constraint/);
    expect(
      (await db.academicSession.create({ data: { ...base, label: "Two campus", campusId: north(), status: "ACTIVE" } })).id,
    ).toBeTruthy(); // another scope
    const copy = await db.academicSession.create({ data: { ...base, label: "Copy", copiedFromId: one.id } });
    await expect(db.academicSession.create({ data: { ...base, label: "Copy 2", copiedFromId: one.id } })).rejects.toThrow(
      /Unique constraint/,
    );
    await db.academicSession.update({ where: { id: copy.id }, data: { archivedAt: new Date() } });
    expect((await db.academicSession.create({ data: { ...base, label: "Copy 3", copiedFromId: one.id } })).id).toBeTruthy(); // the archived copy no longer counts
    const p = {
      tenantId: a.id,
      sessionId: one.id,
      kind: "TERM" as const,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-03-01"),
    };
    await db.academicPeriod.create({ data: { ...p, ordinal: 1, label: "T1", isCurrent: true } });
    await expect(db.academicPeriod.create({ data: { ...p, ordinal: 2, label: "T2", isCurrent: true } })).rejects.toThrow(
      /Unique constraint/,
    );
    await expect(db.academicPeriod.create({ data: { ...p, ordinal: 1, label: "T3" } })).rejects.toThrow(/Unique constraint/);
    await expect(db.academicPeriod.create({ data: { ...p, ordinal: 3, label: "T1" } })).rejects.toThrow(/Unique constraint/);
  });

  test("CHECK constraints: end after start, a term needs an end, a positive ordinal, a non-blank label", async () => {
    const base = { tenantId: a.id, label: "L", startDate: new Date("2026-09-07") };
    await expect(db.academicSession.create({ data: { ...base, endDate: new Date("2026-09-07") } })).rejects.toThrow(
      /dates_ordered|check constraint/i,
    );
    await expect(db.academicSession.create({ data: { ...base, label: "   ", endDate: new Date("2027-01-01") } })).rejects.toThrow(
      /label_not_blank|check constraint/i,
    );
    const s = await db.academicSession.create({ data: { ...base, endDate: new Date("2027-07-23") } });
    const p = { tenantId: a.id, sessionId: s.id, ordinal: 1, label: "T", startDate: new Date("2026-09-07") };
    await expect(db.academicPeriod.create({ data: { ...p, kind: "TERM" } })).rejects.toThrow(
      /end_required_unless_cohort|check constraint/i,
    );
    expect((await db.academicPeriod.create({ data: { ...p, kind: "COHORT" } })).endDate).toBeNull(); // a cohort may stay open
    await expect(
      db.academicPeriod.create({ data: { ...p, kind: "TERM", ordinal: 0, label: "Z", endDate: new Date("2026-12-01") } }),
    ).rejects.toThrow(/ordinal_positive|check constraint/i);
    await expect(
      db.academicPeriod.create({ data: { ...p, kind: "TERM", ordinal: 2, label: "E", endDate: new Date("2026-09-07") } }),
    ).rejects.toThrow(/dates_ordered|check constraint/i);
  });

  test("the composite foreign keys keep a row inside its school EVEN THROUGH THE OWNER ROLE: another school's campus, session or copy source is refused", async () => {
    const theirs = await db.academicSession.create({
      data: { tenantId: b.id, label: "Theirs", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
    });
    const dates = { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") };
    await expect(db.academicSession.create({ data: { tenantId: a.id, label: "X", ...dates, campusId: b.campuses[0].id } })).rejects.toThrow(
      /Foreign key constraint/,
    );
    await expect(db.academicSession.create({ data: { tenantId: a.id, label: "Y", ...dates, copiedFromId: theirs.id } })).rejects.toThrow(
      /Foreign key constraint/,
    );
    await expect(
      db.academicPeriod.create({
        data: {
          tenantId: a.id,
          sessionId: theirs.id,
          kind: "TERM",
          ordinal: 1,
          label: "Z",
          startDate: dates.startDate,
          endDate: new Date("2026-03-01"),
        },
      }),
    ).rejects.toThrow(/Foreign key constraint/);
    expect(await db.academicSession.count({ where: { tenantId: a.id } })).toBe(0);
  });

  test("a request can never DELETE a session or a period (there is no DELETE policy): the runtime role affects 0 rows, even in its own school", async () => {
    const s = await session("Keep me");
    await createPeriod(admin(), boss.id, s.id, { label: "T1", startDate: "2026-09-07", endDate: "2026-12-18" });
    const gone = await forTenant(trustedTenantId(a.id)).transaction(async (tx) => ({
      periods: (await tx.academicPeriod.deleteMany()).count,
      sessions: (await tx.academicSession.deleteMany()).count,
    }));
    expect(gone).toEqual({ periods: 0, sessions: 0 });
    expect(await db.academicSession.count({ where: { id: s.id } })).toBe(1);
    expect(await prisma.academicSession.findMany()).toEqual([]); // and with no context the runtime role sees nothing at all
  });
});
