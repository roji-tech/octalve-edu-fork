import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import {
  Role,
  addMembership,
  createTenant,
  createUser,
  db,
  deactivateMembership,
  removeCreatedTenants,
  seedInstance,
  type TestTenant,
  type TestUser,
} from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// Academic sessions and periods over real HTTP against the SaaS-mode server (plan "Build design — Phase 1.0 and 1.1", decisions 7–12, 16, 17): who may
// read and write, strict bodies, the status and code of every refusal, campus scope, and identical 404s for unknown / foreign ids. Cross-tenant,
// signed-out and deactivated callers are ALSO covered for every route by tenant-boundary.spec.ts (it discovers the routes from the file system).

const SAAS = { baseUrl: SAAS_URL };
const NO_ACCESS = { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } };

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let teacher: TestUser; // TEACHING_STAFF at North
let clerk: TestUser; // NON_TEACHING_STAFF, no campus
let parent: TestUser;
let student: TestUser;
let former: TestUser; // deactivated teacher
let outsider: TestUser; // ADMIN of B
let cookie: Record<string, string> = {};

const base = (code = a.code) => `/api/v1/schools/${code}/academics`;
const sessions = (code = a.code) => `${base(code)}/sessions`;
const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
const y2026 = { startDate: "2026-09-07", endDate: "2027-07-23" };
let counter = 0;
const uniqueLabel = (prefix = "S") => `${prefix} ${Date.now().toString(36)}-${++counter}`;

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}
/// A session made straight in the database (no rate limit, no overlap worries): dates far apart per call.
let yearOffset = 0;
async function seedSession(
  extra: { campusId?: string | null; status?: "PLANNED" | "ACTIVE" | "CLOSED"; label?: string; school?: TestTenant } = {},
) {
  const year = 2100 + yearOffset++ * 2;
  return db.academicSession.create({
    data: {
      tenantId: (extra.school ?? a).id,
      campusId: extra.campusId ?? null,
      label: extra.label ?? uniqueLabel(),
      startDate: new Date(`${year}-09-01`),
      endDate: new Date(`${year + 1}-07-31`),
      status: extra.status ?? "PLANNED",
    },
  });
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  [admin, teacher, clerk, parent, student, former, outsider] = await Promise.all([
    createUser({ name: "Ada Admin" }),
    createUser({ name: "Tola Teacher" }),
    createUser({ name: "Clem Clerk" }),
    createUser({ name: "Pat Parent" }),
    createUser({ name: "Sam Student" }),
    createUser({ name: "Fay Former" }),
    createUser({ name: "Bayo Elsewhere" }),
  ]);
  await addMembership(admin.id, a.id, Role.ADMIN);
  await addMembership(teacher.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  await addMembership(clerk.id, a.id, Role.NON_TEACHING_STAFF);
  await addMembership(parent.id, a.id, Role.PARENT);
  await addMembership(student.id, a.id, Role.STUDENT);
  await addMembership(former.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
  await addMembership(outsider.id, b.id, Role.ADMIN);
  await deactivateMembership(former.id, a.id);
  cookie = {};
  for (const [who, user] of Object.entries({ admin, teacher, clerk, parent, student, former, outsider }))
    cookie[who] = await cookieFor(user);
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("the role matrix: every route, every kind of caller", () => {
  test("reads: administrators and staff may, a parent, a student, a deactivated member and another school's administrator get the ONE 403 body", async () => {
    const s = await seedSession();
    const reads = [sessions(), `${sessions()}/${s.id}`, `${sessions()}/${s.id}/periods`];
    for (const url of reads) {
      for (const who of ["admin", "teacher", "clerk"]) expect((await api(url, as(who))).status, `${who} ${url}`).toBe(200);
      for (const who of ["parent", "student", "former", "outsider"]) {
        const res = await api(url, as(who));
        expect(res.status, `${who} ${url}`).toBe(403);
        expect(res.json, `${who} ${url}`).toEqual(NO_ACCESS);
      }
    }
  });

  test("writes: ONLY an administrator of that school — staff, a parent, a student, a deactivated member and another school's administrator are all the same 403, and nothing changes", async () => {
    const s = await seedSession({ status: "PLANNED" });
    const p = await db.academicPeriod.create({
      data: {
        tenantId: a.id,
        sessionId: s.id,
        kind: "TERM",
        ordinal: 1,
        label: "T1",
        startDate: s.startDate,
        endDate: new Date(s.startDate.getTime() + 86_400_000 * 30),
      },
    });
    const writes: [string, string, object | undefined][] = [
      ["POST", sessions(), { label: "x", ...y2026 }],
      ["PATCH", `${sessions()}/${s.id}`, { label: "renamed" }],
      ["POST", `${sessions()}/${s.id}/activate`, {}],
      ["POST", `${sessions()}/${s.id}/close`, {}],
      ["POST", `${sessions()}/${s.id}/close/cancel`, {}],
      ["POST", `${sessions()}/${s.id}/reopen`, { reason: "A reason that is long enough" }],
      ["POST", `${sessions()}/${s.id}/archive`, undefined],
      ["POST", `${sessions()}/${s.id}/copy-forward`, { startDate: "2200-09-01" }],
      ["POST", `${sessions()}/${s.id}/periods`, { label: "x", startDate: "2100-10-01", endDate: "2100-11-01" }],
      ["PATCH", `${base()}/periods/${p.id}`, { label: "renamed" }],
      ["POST", `${base()}/periods/${p.id}/current`, undefined],
      ["POST", `${base()}/periods/${p.id}/archive`, undefined],
    ];
    for (const [method, url, body] of writes) {
      for (const who of ["teacher", "clerk", "parent", "student", "former", "outsider"]) {
        const res = await api(url, as(who, { method, ...(body ? { body } : {}) }));
        expect(res.status, `${who} ${method} ${url}`).toBe(403);
        expect(res.json, `${who} ${method} ${url}`).toEqual(NO_ACCESS);
      }
    }
    expect(await db.academicSession.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "PLANNED", archivedAt: null });
    expect((await db.academicPeriod.findUniqueOrThrow({ where: { id: p.id } })).label).toBe("T1");
    expect(await db.auditLog.count({ where: { tenantId: a.id, action: { startsWith: "SESSION_" } } })).toBe(0);
  });

  test("CSRF is enforced on every write: a cross-origin request is refused before anything happens", async () => {
    const res = await api(
      sessions(),
      as("admin", { method: "POST", body: { label: uniqueLabel(), ...y2026 }, origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  });
});

test.describe("creating and changing a session", () => {
  test("POST creates a PLANNED session: 201, the cleaned label, the dates, the envelope — and it is audited", async () => {
    const label = uniqueLabel("Year");
    const res = await api(sessions(), as("admin", { method: "POST", body: { label: `  ${label}  `, ...y2026 } }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      data: {
        session: {
          label,
          status: "PLANNED",
          campusId: null,
          startDate: "2026-09-07",
          endDate: "2027-07-23",
          periodCount: 0,
          archived: false,
        },
      },
      error: null,
    });
    expect(await db.auditLog.count({ where: { tenantId: a.id, action: "SESSION_CREATED", targetId: res.json.data.session.id } })).toBe(1);
    const overlap = await api(
      sessions(),
      as("admin", { method: "POST", body: { label: uniqueLabel(), startDate: "2027-07-23", endDate: "2028-01-01" } }),
    );
    expect(overlap.status).toBe(409);
    expect(overlap.json.error).toMatchObject({ code: "OVERLAP", message: expect.stringContaining(label) });
    const dup = await api(sessions(), as("admin", { method: "POST", body: { label, startDate: "2030-01-01", endDate: "2030-12-31" } }));
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: "LABEL_TAKEN", details: [{ path: "body.label" }] });
  });

  test("the body is STRICT and validated: unknown keys, a bad date, a non-string name and a missing field are 400s that name the field", async () => {
    const good = { label: uniqueLabel(), startDate: "2040-09-01", endDate: "2041-07-31" };
    for (const [body, path] of [
      [{ ...good, tenantId: b.id }, undefined],
      [{ ...good, status: "ACTIVE" }, undefined],
      [{ ...good, id: "x" }, undefined],
      [{ ...good, startDate: "2040-02-30" }, "body.startDate"],
      [{ ...good, endDate: "tomorrow" }, "body.endDate"],
      [{ ...good, label: 42 }, "body.label"],
      [{ startDate: good.startDate, endDate: good.endDate }, "body.label"],
      [{ ...good, endDate: good.startDate }, "body.endDate"],
    ] as [object, string | undefined][]) {
      const res = await api(sessions(), as("admin", { method: "POST", body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION");
      if (path)
        expect(
          res.json.error.details.map((d: { path: string }) => d.path),
          JSON.stringify(body),
        ).toContain(path);
    }
    expect((await api(sessions(), as("admin", { method: "POST", rawBody: "{" }))).json.error.code).toBe("INVALID_BODY");
    expect(await db.academicSession.count({ where: { tenantId: a.id, startDate: new Date("2040-09-01") } })).toBe(0);
  });

  test("a campus of another school or one that does not exist is a 400 on body.campusId, alike; a real campus gives that campus its own session", async () => {
    for (const campusId of [b.campuses[0].id, "no-such-campus"]) {
      const res = await api(
        sessions(),
        as("admin", { method: "POST", body: { label: uniqueLabel(), campusId, startDate: "2050-09-01", endDate: "2051-07-31" } }),
      );
      expect(res.status, campusId).toBe(400);
      expect(res.json.error.details).toEqual([{ path: "body.campusId", message: "Choose one of this school's campuses." }]);
    }
    const own = await api(
      sessions(),
      as("admin", {
        method: "POST",
        body: { label: uniqueLabel("North"), campusId: a.campuses[0].id, startDate: "2050-09-01", endDate: "2051-07-31" },
      }),
    );
    expect(own.status).toBe(201);
    expect(own.json.data.session).toMatchObject({ campusId: a.campuses[0].id, campusName: "Alpha North" });
  });

  test("PATCH renames and moves; a no-op is a 200 with changed:false; an empty body says what to give; the kind of refusal for a closed session is 409 CLOSED_READONLY", async () => {
    const s = await seedSession();
    const url = `${sessions()}/${s.id}`;
    const renamed = await api(url, as("admin", { method: "PATCH", body: { label: "Renamed" } }));
    expect(renamed.json.data).toMatchObject({ changed: true, session: { label: "Renamed" } });
    expect((await api(url, as("admin", { method: "PATCH", body: { label: "Renamed" } }))).json.data).toMatchObject({ changed: false });
    expect((await api(url, as("admin", { method: "PATCH", body: {} }))).status).toBe(400);
    expect((await api(url, as("admin", { method: "PATCH", body: { status: "CLOSED" } }))).status).toBe(400); // status is not a field
    await db.academicSession.update({ where: { id: s.id }, data: { status: "CLOSED" } });
    const closed = await api(url, as("admin", { method: "PATCH", body: { label: "Too late" } }));
    expect(closed.status).toBe(409);
    expect(closed.json.error.code).toBe("CLOSED_READONLY");
  });
});

test.describe("activating, closing, archiving over HTTP", () => {
  test("activate is refused with 409 SESSION_ALREADY_ACTIVE naming the active one; closeCurrent closes it and opens the new one; the response says which was closed", async () => {
    await db.academicSession.updateMany({ where: { tenantId: a.id, campusId: null, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const one = await seedSession({ label: uniqueLabel("One") });
    const two = await seedSession({ label: uniqueLabel("Two") });
    expect((await api(`${sessions()}/${one.id}/activate`, as("admin", { method: "POST", body: {} }))).json.data.session.status).toBe(
      "ACTIVE",
    );
    const refused = await api(`${sessions()}/${two.id}/activate`, as("admin", { method: "POST", body: {} }));
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "SESSION_ALREADY_ACTIVE", message: expect.stringContaining(one.label) });
    // closing the open one on the spot needs the administrator's own password — and a wrong or missing one changes nothing
    const noPassword = await api(`${sessions()}/${two.id}/activate`, as("admin", { method: "POST", body: { closeCurrent: true } }));
    expect(noPassword.status).toBe(400);
    expect(noPassword.json.error.details).toEqual([{ path: "body.password", message: "Enter your password to confirm." }]);
    const wrong = await api(
      `${sessions()}/${two.id}/activate`,
      as("admin", { method: "POST", body: { closeCurrent: true, password: "not-the-password-1" } }),
    );
    expect(wrong.status).toBe(403);
    expect(wrong.json.error).toMatchObject({ code: "WRONG_PASSWORD", details: [{ path: "body.password" }] });
    expect(wrong.text).not.toContain("not-the-password-1");
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: one.id } })).status).toBe("ACTIVE"); // nothing was closed
    const swapped = await api(
      `${sessions()}/${two.id}/activate`,
      as("admin", { method: "POST", body: { closeCurrent: true, password: admin.password } }),
    );
    expect(swapped.status).toBe(200);
    expect(swapped.json.data).toMatchObject({ session: { id: two.id, status: "ACTIVE" }, closed: { id: one.id, label: one.label } });
    expect((await api(`${sessions()}/${two.id}/activate`, as("admin", { method: "POST", body: { closeCurrent: "yes" } }))).status).toBe(
      400,
    ); // a real boolean only
    expect(
      (
        await api(
          `${sessions()}/${two.id}/activate`,
          as("admin", { method: "POST", body: { closeCurrent: true, password: admin.password, extra: 1 } }),
        )
      ).status,
    ).toBe(400);
  });

  test("close, then archive: the states are enforced (409 WRONG_STATE / ACTIVE_CANNOT_ARCHIVE), archiving is idempotent, and an archived session leaves the default list but is still there", async () => {
    await db.academicSession.updateMany({ where: { tenantId: a.id, campusId: null, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const s = await seedSession({ label: uniqueLabel("Cycle") });
    const url = `${sessions()}/${s.id}`;
    expect((await api(`${url}/close`, as("admin", { method: "POST", body: {} }))).json.error.code).toBe("WRONG_STATE"); // not active yet
    await api(`${url}/activate`, as("admin", { method: "POST", body: {} }));
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.error.code).toBe("ACTIVE_CANNOT_ARCHIVE");
    // closing is a countdown: the session stays ACTIVE (and cannot be archived) until the time comes
    const scheduled = await api(`${url}/close`, as("admin", { method: "POST", body: {} }));
    expect(scheduled.json.data).toMatchObject({ changed: true, session: { status: "ACTIVE", closeForced: false } });
    expect(Math.abs(new Date(scheduled.json.data.session.closeAt).getTime() - (Date.now() + 24 * 60 * 60 * 1000))).toBeLessThan(60_000);
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.error.code).toBe("ACTIVE_CANNOT_ARCHIVE");
    await db.academicSession.update({ where: { id: s.id }, data: { closeAt: new Date(Date.now() - 1000) } }); // the day has passed
    expect((await api(url, as("admin"))).json.data.session.status).toBe("CLOSED");
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      session: { archived: true },
    });
    expect((await api(`${url}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({ changed: false });
    const live = await api(`${sessions()}?status=live&limit=100`, as("admin"));
    expect(live.json.data.sessions.some((x: { id: string }) => x.id === s.id)).toBe(false);
    const archived = await api(`${sessions()}?status=archived&limit=100`, as("admin"));
    expect(archived.json.data.sessions.some((x: { id: string }) => x.id === s.id)).toBe(true);
    expect(await db.academicSession.count({ where: { id: s.id } })).toBe(1);
  });
});

test.describe("closing a session over HTTP (a countdown, a forced one-minute close, cancel, reopen)", () => {
  test("close with no password schedules a day ahead; with the right password a minute ahead; the password is never echoed; a wrong one changes nothing and is counted", async () => {
    await db.academicSession.updateMany({ where: { tenantId: a.id, campusId: null, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const s = await seedSession({ label: uniqueLabel("Countdown"), status: "ACTIVE" });
    const url = `${sessions()}/${s.id}`;
    const wrong = await api(`${url}/close`, as("admin", { method: "POST", body: { password: "definitely-not-it-1" } }));
    expect(wrong.status).toBe(403);
    expect(wrong.json.error).toMatchObject({
      code: "WRONG_PASSWORD",
      details: [{ path: "body.password", message: "That password isn't right." }],
    });
    expect(wrong.text).not.toContain("definitely-not-it-1");
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: s.id } })).closeAt).toBeNull();

    const forced = await api(`${url}/close`, as("admin", { method: "POST", body: { password: admin.password } }));
    expect(forced.status).toBe(200);
    expect(forced.json.data).toMatchObject({ changed: true, session: { status: "ACTIVE", closeForced: true } });
    expect(Math.abs(new Date(forced.json.data.session.closeAt).getTime() - (Date.now() + 60_000))).toBeLessThan(30_000);
    expect(forced.text).not.toContain(admin.password);
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, targetId: s.id, action: "SESSION_CLOSE_REQUESTED" } });
    expect(JSON.stringify(audit)).not.toContain(admin.password);
    expect(audit).toMatchObject({ actorUserId: admin.id, afterValue: { forced: true } });
  });

  test("failed password proofs are rate-limited per account (5), a success is refunded, and the strict body refuses stray keys", async () => {
    const bossy = await createUser({ name: "Limited Admin" });
    await addMembership(bossy.id, a.id, Role.ADMIN);
    const bossCookie = await cookieFor(bossy);
    await db.academicSession.updateMany({ where: { tenantId: a.id, campusId: null, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const s = await seedSession({ label: uniqueLabel("Limit"), status: "ACTIVE" });
    const url = `${sessions()}/${s.id}/close`;
    const attempt = (password: string) => api(url, { ...SAAS, cookie: bossCookie, method: "POST", body: { password } });
    for (let i = 0; i < 5; i++) expect((await attempt("wrong-password-9")).status, `failure ${i + 1}`).toBe(403);
    const blocked = await attempt(bossy.password);
    expect(blocked.status).toBe(429); // even the right one: the account is locked out for the window
    expect(blocked.json.error.code).toBe("RATE_LIMITED");
    expect((await db.academicSession.findUniqueOrThrow({ where: { id: s.id } })).closeAt).toBeNull();
    expect((await api(url, as("admin", { method: "POST", body: { password: admin.password, tenantId: b.id } }))).status).toBe(400);
  });

  test("cancel takes a planned close back (idempotent), and a closed session is reopened with a reason — refused without one, or while another is open", async () => {
    await db.academicSession.updateMany({ where: { tenantId: a.id, campusId: null, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const s = await seedSession({ label: uniqueLabel("Reopen"), status: "ACTIVE" });
    const url = `${sessions()}/${s.id}`;
    await api(`${url}/close`, as("admin", { method: "POST", body: {} }));
    const cancelled = await api(`${url}/close/cancel`, as("admin", { method: "POST", body: {} }));
    expect(cancelled.json.data).toMatchObject({ changed: true, session: { status: "ACTIVE", closeAt: null } });
    expect((await api(`${url}/close/cancel`, as("admin", { method: "POST", body: {} }))).json.data).toMatchObject({ changed: false });

    await api(`${url}/close`, as("admin", { method: "POST", body: { password: admin.password } }));
    await db.academicSession.update({ where: { id: s.id }, data: { closeAt: new Date(Date.now() - 1000) } });
    expect((await api(`${url}/close/cancel`, as("admin", { method: "POST", body: {} }))).json.error.code).toBe("WRONG_STATE");

    const noReason = await api(`${url}/reopen`, as("admin", { method: "POST", body: { reason: "no" } }));
    expect(noReason.status).toBe(400);
    expect(noReason.json.error.details).toEqual([{ path: "body.reason", message: "Give a reason of 5 to 300 characters." }]);
    expect((await api(`${url}/reopen`, as("admin", { method: "POST", body: {} }))).status).toBe(400);
    expect((await api(`${url}/reopen`, as("admin", { method: "POST", body: { reason: "ok reason", extra: 1 } }))).status).toBe(400);
    const other = await seedSession({ label: uniqueLabel("Other"), status: "ACTIVE" });
    const refused = await api(`${url}/reopen`, as("admin", { method: "POST", body: { reason: "We closed it by mistake" } }));
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "SESSION_ALREADY_ACTIVE", message: expect.stringContaining(other.label) });
    await db.academicSession.update({ where: { id: other.id }, data: { status: "CLOSED" } });
    const reopened = await api(`${url}/reopen`, as("admin", { method: "POST", body: { reason: "We closed it by mistake" } }));
    expect(reopened.status).toBe(200);
    expect(reopened.json.data.session).toMatchObject({ status: "ACTIVE", closeAt: null });
    expect(await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, targetId: s.id, action: "SESSION_REOPENED" } })).toMatchObject({
      reason: "We closed it by mistake",
    });
  });

  test("a non-admin can read a scheduled close (the list shows it) but cannot schedule, cancel or reopen: the one 403", async () => {
    await db.academicSession.updateMany({ where: { tenantId: a.id, campusId: null, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const s = await seedSession({ label: uniqueLabel("Visible"), status: "ACTIVE" });
    await api(`${sessions()}/${s.id}/close`, as("admin", { method: "POST", body: {} }));
    const seen = await api(`${sessions()}/${s.id}`, as("teacher"));
    expect(seen.json.data.session).toMatchObject({ status: "ACTIVE", closeForced: false });
    expect(seen.json.data.session.closeAt).toEqual(expect.any(String));
    for (const path of ["close", "close/cancel"]) {
      const res = await api(`${sessions()}/${s.id}/${path}`, as("teacher", { method: "POST", body: {} }));
      expect(res.status, path).toBe(403);
      expect(res.json, path).toEqual(NO_ACCESS);
    }
  });
});

test.describe("periods over HTTP", () => {
  test("POST derives the kind from the SCHOOL (a `kind` key is refused), numbers it, and the list returns them in order; a bad date is a 400 naming the field", async () => {
    const s = await seedSession({ label: uniqueLabel("Terms") });
    const day = (n: number) => new Date(s.startDate.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const url = `${sessions()}/${s.id}/periods`;
    const t1 = await api(url, as("admin", { method: "POST", body: { label: "1st Term", startDate: day(0), endDate: day(90) } }));
    expect(t1.status).toBe(201);
    expect(t1.json.data.period).toMatchObject({ kind: "TERM", ordinal: 1, isCurrent: false, archived: false });
    expect(
      (await api(url, as("admin", { method: "POST", body: { label: "Sneaky", kind: "COHORT", startDate: day(100), endDate: day(120) } })))
        .status,
    ).toBe(400);
    const t2 = await api(url, as("admin", { method: "POST", body: { label: "2nd Term", startDate: day(100), endDate: day(190) } }));
    expect(t2.json.data.period.ordinal).toBe(2);
    const clash = await api(url, as("admin", { method: "POST", body: { label: "Clash", startDate: day(190), endDate: day(200) } }));
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe("OVERLAP");
    const noEnd = await api(url, as("admin", { method: "POST", body: { label: "No end", startDate: day(210) } }));
    expect(noEnd.status).toBe(400);
    expect(noEnd.json.error.details[0].path).toBe("body.endDate");
    const outside = await api(
      url,
      as("admin", { method: "POST", body: { label: "Outside", startDate: "2000-01-01", endDate: "2000-02-01" } }),
    );
    expect(outside.status).toBe(400);
    const list = await api(url, as("teacher"));
    expect(list.json.data.periods.map((p: { label: string }) => p.label)).toEqual(["1st Term", "2nd Term"]);
  });

  test("current and archive: only a term of an ACTIVE session can be current (409 SESSION_NOT_ACTIVE); archiving clears it; the audit trail names each step", async () => {
    await db.academicSession.updateMany({ where: { tenantId: a.id, campusId: null, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const s = await seedSession({ label: uniqueLabel("Pointer") });
    const p = await db.academicPeriod.create({
      data: {
        tenantId: a.id,
        sessionId: s.id,
        kind: "TERM",
        ordinal: 1,
        label: "T1",
        startDate: s.startDate,
        endDate: new Date(s.startDate.getTime() + 86_400_000 * 60),
      },
    });
    const notActive = await api(`${base()}/periods/${p.id}/current`, as("admin", { method: "POST" }));
    expect(notActive.status).toBe(409);
    expect(notActive.json.error.code).toBe("SESSION_NOT_ACTIVE");
    await api(`${sessions()}/${s.id}/activate`, as("admin", { method: "POST", body: {} }));
    expect((await api(`${base()}/periods/${p.id}/current`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      period: { isCurrent: true },
    });
    expect((await api(`${base()}/periods/${p.id}/archive`, as("admin", { method: "POST" }))).json.data).toMatchObject({
      changed: true,
      period: { archived: true, isCurrent: false },
    });
    expect((await db.auditLog.findMany({ where: { targetId: p.id }, orderBy: { createdAt: "asc" } })).map((r) => r.action)).toEqual([
      "PERIOD_SET_CURRENT",
      "PERIOD_ARCHIVED",
    ]);
    const withArchived = await api(`${sessions()}/${s.id}/periods?archived=true`, as("admin"));
    expect(withArchived.json.data.periods).toHaveLength(1);
    expect((await api(`${sessions()}/${s.id}/periods`, as("admin"))).json.data.periods).toHaveLength(0);
  });
});

test.describe("campus scope and 404 sameness", () => {
  test("staff see school-wide sessions and their OWN campus's; another campus's session is the same 404 as an unknown id — for every read and for the periods under it", async () => {
    const wide = await seedSession({ label: uniqueLabel("Wide") });
    const north = await seedSession({ label: uniqueLabel("North"), campusId: a.campuses[0].id });
    const south = await seedSession({ label: uniqueLabel("South"), campusId: a.campuses[1].id });
    const seen = async (who: string) =>
      (await api(`${sessions()}?status=all&limit=100`, as(who))).json.data.sessions.map((s: { id: string }) => s.id);
    const teacherSees = await seen("teacher");
    expect(teacherSees).toContain(wide.id);
    expect(teacherSees).toContain(north.id);
    expect(teacherSees).not.toContain(south.id);
    const clerkSees = await seen("clerk"); // no campus: school-wide only
    expect(clerkSees).toContain(wide.id);
    expect(clerkSees).not.toContain(north.id);
    expect(clerkSees).not.toContain(south.id);
    const adminSees = await seen("admin");
    for (const s of [wide, north, south]) expect(adminSees).toContain(s.id);

    const foreign = await api(`${sessions()}/${south.id}`, as("teacher"));
    const unknown = await api(`${sessions()}/no-such-session`, as("teacher"));
    const malformed = await api(`${sessions()}/${encodeURIComponent("../etc")}`, as("teacher"));
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(unknown.json);
    expect(malformed.json).toEqual(unknown.json);
    expect((await api(`${sessions()}/${south.id}/periods`, as("teacher"))).json).toEqual(unknown.json);
  });

  test("another school's session and period ids are the SAME 404 as unknown ones, on every write too — and nothing in the other school changes", async () => {
    const theirs = await seedSession({ school: b, label: uniqueLabel("Beta") });
    const p = await db.academicPeriod.create({
      data: {
        tenantId: b.id,
        sessionId: theirs.id,
        kind: "TERM",
        ordinal: 1,
        label: "BT1",
        startDate: theirs.startDate,
        endDate: new Date(theirs.startDate.getTime() + 86_400_000 * 60),
      },
    });
    const unknown = await api(`${sessions()}/no-such-session`, as("admin"));
    for (const [method, url, body] of [
      ["GET", `${sessions()}/${theirs.id}`, undefined],
      ["PATCH", `${sessions()}/${theirs.id}`, { label: "hijack" }],
      ["POST", `${sessions()}/${theirs.id}/activate`, { closeCurrent: true, password: admin.password }],
      ["POST", `${sessions()}/${theirs.id}/close`, {}],
      ["POST", `${sessions()}/${theirs.id}/close/cancel`, {}],
      ["POST", `${sessions()}/${theirs.id}/reopen`, { reason: "A reason that is long enough" }],
      ["POST", `${sessions()}/${theirs.id}/archive`, undefined],
      ["POST", `${sessions()}/${theirs.id}/copy-forward`, { startDate: "2300-09-01" }],
      ["GET", `${sessions()}/${theirs.id}/periods`, undefined],
      ["POST", `${sessions()}/${theirs.id}/periods`, { label: "x", startDate: "2100-10-01", endDate: "2100-11-01" }],
    ] as [string, string, object | undefined][]) {
      const res = await api(url, as("admin", { method, ...(body ? { body } : {}) }));
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.json, `${method} ${url}`).toEqual(unknown.json);
    }
    for (const [method, url, body] of [
      ["PATCH", `${base()}/periods/${p.id}`, { label: "hijack" }],
      ["POST", `${base()}/periods/${p.id}/current`, undefined],
      ["POST", `${base()}/periods/${p.id}/archive`, undefined],
    ] as [string, string, object | undefined][]) {
      const res = await api(url, as("admin", { method, ...(body ? { body } : {}) }));
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    expect(await db.academicSession.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
      status: "PLANNED",
      archivedAt: null,
      label: theirs.label,
    });
    expect(await db.academicPeriod.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ label: "BT1", archivedAt: null });
  });
});

test.describe("listing and paging", () => {
  test("status filters work, the default hides archived, paging is exact and strict (a bad parameter is a 400 naming the field)", async () => {
    for (let i = 0; i < 4; i++) await seedSession({ label: uniqueLabel("Page") });
    const first = await api(`${sessions()}?status=all&limit=3`, as("admin"));
    const second = await api(`${sessions()}?status=all&limit=3&page=2`, as("admin"));
    const ids = [...first.json.data.sessions, ...second.json.data.sessions].map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // pages do not overlap
    expect(first.json.meta).toMatchObject({ page: 1, limit: 3, hasNext: true });
    for (const [qs, field] of [
      ["status=everything", "query.status"],
      ["page=0", "query.page"],
      ["limit=1000", "query.limit"],
      ["limit=abc", "query.limit"],
      ["page=1&page=2", "query.page"],
    ]) {
      const res = await api(`${sessions()}?${qs}`, as("admin"));
      expect(res.status, qs).toBe(400);
      expect(
        res.json.error.details.map((d: { path: string }) => d.path),
        qs,
      ).toContain(field);
    }
    expect(
      (await api(`${sessions()}?status=planned&limit=100`, as("admin"))).json.data.sessions.every(
        (s: { status: string }) => s.status === "PLANNED",
      ),
    ).toBe(true);
  });
});

test.describe("copy-forward over HTTP", () => {
  test("a dry run returns the plan and writes nothing; the real run is 201 with the new session; the second is 409 ALREADY_COPIED; a bad start date is a 400", async () => {
    const s = await seedSession({ label: "2100/2101" });
    await db.academicPeriod.create({
      data: {
        tenantId: a.id,
        sessionId: s.id,
        kind: "TERM",
        ordinal: 1,
        label: "1st Term",
        startDate: s.startDate,
        endDate: new Date(s.startDate.getTime() + 86_400_000 * 90),
      },
    });
    const url = `${sessions()}/${s.id}/copy-forward`;
    const next = `${s.startDate.getUTCFullYear() + 1}-09-01`;
    const dry = await api(url, as("admin", { method: "POST", body: { startDate: next, dryRun: true } }));
    expect(dry.status).toBe(200);
    expect(dry.json.data.session).toBeNull();
    expect(dry.json.data.plan).toMatchObject({
      session: { label: "2101/2102", startDate: next },
      periods: [{ label: "1st Term" }],
      conflicts: [],
    });
    expect(await db.academicSession.count({ where: { copiedFromId: s.id } })).toBe(0);
    const real = await api(url, as("admin", { method: "POST", body: { startDate: next } }));
    expect(real.status).toBe(201);
    expect(real.json.data.session).toMatchObject({ label: "2101/2102", status: "PLANNED", copiedFromId: s.id, periodCount: 1 });
    const again = await api(url, as("admin", { method: "POST", body: { startDate: next } }));
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("ALREADY_COPIED");
    expect((await api(url, as("admin", { method: "POST", body: { startDate: "2101-02-30" } }))).status).toBe(400);
    expect((await api(url, as("admin", { method: "POST", body: { startDate: next, tenantId: b.id } }))).status).toBe(400);
  });
});
