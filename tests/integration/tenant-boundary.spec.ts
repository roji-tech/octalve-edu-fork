import { HTTP_PORT, HTTP_URL } from "../support/env";
import { NextRequest, NextResponse } from "next/server";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { Role, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance } from "../support/db";
import { withEnv } from "../support/with-env";
import { TEST_DATABASE_URL } from "../support/env";
import { SESSION_COOKIE_NAME, createSession } from "@/lib/auth/session";
import { withAuth, type TenantAuthContext, type TenantRouteContext } from "@/lib/auth/with-auth";
import { resolveTenant } from "@/lib/tenant/resolve-tenant";
import { forTenant, forUser, setTenantContext, setUserContext } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import { getUserMemberships } from "@/lib/auth/memberships";
import { auditPersonEvent } from "@/lib/auth/audit";

// The tenant trust boundary, in-process (domain-implementation-plan.md §0.5.2): the URL's code is a lookup key and
// the caller's OWN membership decides — checked here against the real database; the HTTP layer has its own spec.

const SAAS = { DEPLOYMENT_MODE: "saas" };
const SOLO = { DEPLOYMENT_MODE: "solo" };

test.beforeAll(async () => {
  await seedInstance();
});
test.afterEach(async () => {
  await removeCreatedTenants(); // the Solo servers fail closed when a second school exists
});

async function twoSchools() {
  const a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  const b = await createTenant({ name: "Beta School", campuses: ["Beta Main"] });
  return { a, b };
}

test.describe("resolveTenant", () => {
  test("a member gets their tenant, their role IN IT and their campus", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.TEACHING_STAFF, a.campuses[0].id);
      const result = await resolveTenant({ userId: user.id, code: a.code });
      expect(result).toEqual({
        ok: true,
        tenant: { tenantId: a.id, tenantCode: a.code, tenantName: "Alpha School", role: "TEACHING_STAFF", campusId: a.campuses[0].id },
      });
    });
  });

  test("unknown code, malformed code and 'not a member' get the SAME refusal — the answer can't be used to find schools", async () => {
    await withEnv(SAAS, async () => {
      const { a, b } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.ADMIN);
      const refusals = [
        await resolveTenant({ userId: user.id, code: b.code }), // exists, but not theirs
        await resolveTenant({ userId: user.id, code: "no-such-school" }),
        await resolveTenant({ userId: user.id, code: "" }),
        await resolveTenant({ userId: user.id, code: "../etc/passwd" }),
        await resolveTenant({ userId: user.id, code: "A B" }),
        await resolveTenant({ userId: user.id, code: "dashboard" }), // a reserved word, never a school
        await resolveTenant({ userId: user.id, code: "x".repeat(200) }),
        await resolveTenant({ userId: user.id, code: undefined as unknown as string }),
      ];
      for (const refusal of refusals) expect(refusal).toEqual({ ok: false, status: 403, code: "FORBIDDEN" });
    });
  });

  test("a person with no membership anywhere is refused everywhere", async () => {
    await withEnv(SAAS, async () => {
      const { a, b } = await twoSchools();
      const user = await createUser();
      for (const t of [a, b]) expect(await resolveTenant({ userId: user.id, code: t.code })).toMatchObject({ ok: false, status: 403 });
    });
  });

  test("an ADMIN of school A is NOT an admin of school B — a role means something only against a verified membership", async () => {
    await withEnv(SAAS, async () => {
      const { a, b } = await twoSchools();
      const admin = await createUser();
      await addMembership(admin.id, a.id, Role.ADMIN);
      expect(await resolveTenant({ userId: admin.id, code: a.code })).toMatchObject({ ok: true });
      expect(await resolveTenant({ userId: admin.id, code: b.code })).toEqual({ ok: false, status: 403, code: "FORBIDDEN" });
    });
  });

  test("one person in two schools gets each school's own role", async () => {
    await withEnv(SAAS, async () => {
      const { a, b } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.STUDENT);
      await addMembership(user.id, b.id, Role.ADMIN);
      const asA = await resolveTenant({ userId: user.id, code: a.code });
      const asB = await resolveTenant({ userId: user.id, code: b.code });
      expect(asA).toMatchObject({ ok: true, tenant: { tenantId: a.id, role: "STUDENT" } });
      expect(asB).toMatchObject({ ok: true, tenant: { tenantId: b.id, role: "ADMIN" } });
    });
  });

  test("the code is matched case-insensitively and trimmed, nothing more", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.PARENT);
      expect(await resolveTenant({ userId: user.id, code: `  ${a.code.toUpperCase()} ` })).toMatchObject({ ok: true, tenant: { tenantId: a.id } });
      expect(await resolveTenant({ userId: user.id, code: `${a.code}/extra` })).toMatchObject({ ok: false });
      expect(await resolveTenant({ userId: user.id, code: a.code.slice(0, -1) })).toMatchObject({ ok: false });
    });
  });

  test("a membership that was removed stops working at once (nothing is cached)", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.TEACHING_STAFF);
      expect(await resolveTenant({ userId: user.id, code: a.code })).toMatchObject({ ok: true });
      await db.tenantMembership.deleteMany({ where: { userId: user.id, tenantId: a.id } });
      expect(await resolveTenant({ userId: user.id, code: a.code })).toMatchObject({ ok: false, status: 403 });
    });
  });

  test.describe("DEPLOYMENT_MODE=solo", () => {
    test("with exactly one tenant: a member gets in; a wrong code is the same 403; MEMBERSHIP IS STILL REQUIRED", async () => {
      await withEnv(SOLO, async () => {
        const member = await createUser({ role: Role.TEACHING_STAFF });
        const stranger = await createUser(); // signed in to this install, but belongs to no school
        const tenant = await db.tenant.findFirstOrThrow();
        expect(await resolveTenant({ userId: member.id, code: tenant.code })).toMatchObject({ ok: true, tenant: { tenantId: tenant.id } });
        expect(await resolveTenant({ userId: member.id, code: "someone-elses" })).toEqual({ ok: false, status: 403, code: "FORBIDDEN" });
        expect(await resolveTenant({ userId: stranger.id, code: tenant.code })).toEqual({ ok: false, status: 403, code: "FORBIDDEN" });
      });
    });

    test("a SECOND tenant is a misconfiguration: 500, never 'whichever row is first' — even for a legitimate member", async () => {
      await withEnv(SOLO, async () => {
        const member = await createUser({ role: Role.ADMIN });
        const tenant = await db.tenant.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
        await createTenant(); // …appears in what is supposed to be a Solo install
        const errors: unknown[][] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => void errors.push(args);
        try {
          expect(await resolveTenant({ userId: member.id, code: tenant.code })).toEqual({ ok: false, status: 500, code: "TENANT_MISCONFIGURED" });
        } finally {
          console.error = original;
        }
        expect(String(errors[0]?.[0])).toContain("TENANT_MISCONFIGURED"); // and it is logged loudly
      });
    });

    test("a MALFORMED code is a plain 403 even on a misconfigured install — garbage is refused before the install's state is consulted", async () => {
      await withEnv(SOLO, async () => {
        const member = await createUser({ role: Role.ADMIN });
        await createTenant(); // a second tenant: a well-formed code now gets the 500…
        const tenant = await db.tenant.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
        const original = console.error;
        console.error = () => undefined;
        try {
          expect(await resolveTenant({ userId: member.id, code: tenant.code })).toMatchObject({ ok: false, status: 500 });
          for (const code of ["", "../x", "A B", "dashboard", "x".repeat(200)]) {
            expect(await resolveTenant({ userId: member.id, code }), JSON.stringify(code)).toEqual({ ok: false, status: 403, code: "FORBIDDEN" }); // …but garbage never reaches that check
          }
        } finally {
          console.error = original;
        }
      });
    });

    test("NO tenant at all is a misconfiguration too", async () => {
      await withEnv(SOLO, async () => {
        const member = await createUser({ role: Role.ADMIN });
        const tenant = await db.tenant.findFirstOrThrow();
        await db.auditLog.deleteMany({});
        await db.tenant.deleteMany({});
        const original = console.error;
        console.error = () => undefined;
        try {
          expect(await resolveTenant({ userId: member.id, code: tenant.code })).toEqual({ ok: false, status: 500, code: "TENANT_MISCONFIGURED" });
        } finally {
          console.error = original;
          await seedInstance(); // leave the database usable for whatever runs next
        }
      });
    });

    test("the SAME data resolves in SaaS mode with a second tenant present (the mode only changes where the tenant comes from)", async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.PARENT);
      await withEnv(SAAS, async () => {
        expect(await resolveTenant({ userId: user.id, code: a.code })).toMatchObject({ ok: true });
      });
      await withEnv(SOLO, async () => {
        const original = console.error;
        console.error = () => undefined;
        try {
          expect(await resolveTenant({ userId: user.id, code: a.code })).toMatchObject({ ok: false, status: 500 });
        } finally {
          console.error = original;
        }
      });
    });
  });
});

// --- withAuth(…, { tenant: true, roles }) — the wrapper, called in-process ---------------------------------------

function request(opts: { method?: string; token?: string; origin?: string | null; code?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-host": `localhost:${HTTP_PORT}` };
  if (opts.origin !== null) headers.origin = opts.origin ?? HTTP_URL;
  if (opts.token) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.token}`;
  return new NextRequest(`${HTTP_URL}/api/v1/schools/${opts.code ?? "x"}/thing`, { method: opts.method ?? "GET", headers });
}
const params = (code: string): TenantRouteContext => ({ params: Promise.resolve({ code }) });
const bodyOf = async (res: Response) => ({ status: res.status, json: await res.json() });

function tenantRoute(roles?: readonly Role[]) {
  const seen: TenantAuthContext["tenant"][] = [];
  const route = withAuth(async (_req, auth: TenantAuthContext) => {
    seen.push(auth.tenant);
    return NextResponse.json({ ok: true, tenantId: auth.tenant.tenantId, role: auth.tenant.role });
  }, { tenant: true, roles });
  return { route, seen };
}

test.describe("withAuth(…, { tenant: true })", () => {
  test("a member passes; the handler gets the VERIFIED tenant and a tenant-scoped run()", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.TEACHING_STAFF, a.campuses[1].id);
      const { token } = await createSession(user.id);
      const { route, seen } = tenantRoute();
      const res = await route(request({ token }), params(a.code));
      expect(await bodyOf(res)).toEqual({ status: 200, json: { ok: true, tenantId: a.id, role: "TEACHING_STAFF" } });
      expect(seen[0]).toMatchObject({ tenantCode: a.code, campusId: a.campuses[1].id });
      const insideContext = await seen[0].run((tx) => tx.$queryRaw<{ t: string }[]>`SELECT current_setting('app.tenant_id', true) AS t`);
      expect(insideContext[0].t).toBe(a.id);
    });
  });

  test("not signed in is 401 BEFORE anything about schools is revealed — an unknown code and a real one look the same", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const { route, seen } = tenantRoute();
      const real = await bodyOf(await route(request(), params(a.code)));
      const unknown = await bodyOf(await route(request(), params("no-such-school")));
      expect(real).toEqual(unknown);
      expect(real.status).toBe(401);
      expect(seen).toHaveLength(0);
    });
  });

  test("another school's code, an unknown code and a malformed code: the SAME 403 body, no-store, handler never runs", async () => {
    await withEnv(SAAS, async () => {
      const { a, b } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.ADMIN);
      const { token } = await createSession(user.id);
      const { route, seen } = tenantRoute();
      const responses = [];
      for (const code of [b.code, "no-such-school", "../x", ""]) responses.push(await route(request({ token }), params(code)));
      const bodies = await Promise.all(responses.map(bodyOf));
      for (const body of bodies) expect(body).toEqual({ status: 403, json: { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } } });
      for (const res of responses) expect(res.headers.get("cache-control")).toBe("no-store");
      expect(seen).toHaveLength(0);
    });
  });

  test("a missing route context (no `params`) is refused, never treated as 'any school'", async () => {
    await withEnv(SAAS, async () => {
      const user = await createUser({ role: Role.ADMIN });
      const { token } = await createSession(user.id);
      const { route, seen } = tenantRoute();
      for (const context of [undefined, {}, { params: Promise.resolve({}) }] as unknown as TenantRouteContext[]) {
        expect((await route(request({ token }), context)).status).toBe(403);
      }
      expect(seen).toHaveLength(0);
    });
  });

  test("`roles` is checked against the role in THIS school: allowed passes, anything else is the same 403", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const admin = await createUser();
      const teacher = await createUser();
      await addMembership(admin.id, a.id, Role.ADMIN);
      await addMembership(teacher.id, a.id, Role.TEACHING_STAFF);
      const { route, seen } = tenantRoute([Role.ADMIN]);
      expect((await route(request({ token: (await createSession(admin.id)).token }), params(a.code))).status).toBe(200);
      const denied = await bodyOf(await route(request({ token: (await createSession(teacher.id)).token }), params(a.code)));
      expect(denied).toEqual({ status: 403, json: { data: null, meta: {}, error: { code: "FORBIDDEN", message: "You don't have access to this school." } } });
      expect(seen).toHaveLength(1);
    });
  });

  test("`roles` is NOT satisfied by a role held in a DIFFERENT school (the cross-tenant escalation)", async () => {
    await withEnv(SAAS, async () => {
      const { a, b } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.ADMIN); // admin of A…
      await addMembership(user.id, b.id, Role.STUDENT); // …but only a student of B
      const { token } = await createSession(user.id);
      const { route } = tenantRoute([Role.ADMIN]);
      expect((await route(request({ token }), params(a.code))).status).toBe(200);
      expect((await route(request({ token }), params(b.code))).status).toBe(403);
    });
  });

  test("an empty `roles` list allows nobody; omitting it allows every member", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.ADMIN);
      const { token } = await createSession(user.id);
      expect((await tenantRoute([]).route(request({ token }), params(a.code))).status).toBe(403);
      expect((await tenantRoute().route(request({ token }), params(a.code))).status).toBe(200);
    });
  });

  test("a session revoked between two requests is a 401 on the second", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.TEACHING_STAFF);
      const { token } = await createSession(user.id);
      const { route } = tenantRoute();
      expect((await route(request({ token }), params(a.code))).status).toBe(200);
      await db.session.deleteMany({ where: { userId: user.id } });
      expect((await route(request({ token }), params(a.code))).status).toBe(401);
    });
  });

  test("CSRF still applies to a tenant route's state-changing methods, and runs BEFORE the tenant is looked up", async () => {
    await withEnv(SAAS, async () => {
      const { a } = await twoSchools();
      const user = await createUser();
      await addMembership(user.id, a.id, Role.ADMIN);
      const { token } = await createSession(user.id);
      const { route, seen } = tenantRoute();
      const crossOrigin = await bodyOf(await route(request({ method: "POST", token, origin: "https://evil.example" }), params(a.code)));
      expect(crossOrigin.status).toBe(403);
      expect(crossOrigin.json.error.code).toBe("CSRF");
      expect((await route(request({ method: "POST", token }), params(a.code))).status).toBe(200);
      expect(seen).toHaveLength(1);
    });
  });

  test("Solo misconfiguration (a second tenant) is a 500 for a tenant route, with the handler never run", async () => {
    await withEnv(SOLO, async () => {
      const user = await createUser({ role: Role.ADMIN });
      const tenant = await db.tenant.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
      await createTenant();
      const { token } = await createSession(user.id);
      const { route, seen } = tenantRoute();
      const original = console.error;
      console.error = () => undefined;
      try {
        const res = await bodyOf(await route(request({ token }), params(tenant.code)));
        expect(res.status).toBe(500);
        expect(res.json.error.code).toBe("TENANT_MISCONFIGURED");
      } finally {
        console.error = original;
      }
      expect(seen).toHaveLength(0);
    });
  });
});

// --- forTenant / forUser ---------------------------------------------------------------------------------------

test.describe("the tenant context", () => {
  const setting = (name: string) => `SELECT current_setting('${name}', true) AS v`;

  test("forTenant sets app.tenant_id for the work inside, as a bind parameter", async () => {
    const t = trustedTenantId("tenant-123");
    const inside = await forTenant(t).transaction((tx) => tx.$queryRawUnsafe<{ v: string }[]>(setting("app.tenant_id")));
    expect(inside[0].v).toBe("tenant-123");
  });

  test("an id full of SQL is a harmless STRING, not SQL (set_config takes a parameter; SET LOCAL cannot)", async () => {
    const nasty = `x'; DROP TABLE "Campus"; --`;
    const inside = await forTenant(trustedTenantId(nasty)).transaction((tx) => tx.$queryRawUnsafe<{ v: string }[]>(setting("app.tenant_id")));
    expect(inside[0].v).toBe(nasty);
    expect(await db.campus.count()).toBeGreaterThanOrEqual(0); // the table is still there
  });

  test("forUser sets app.user_id and NOT the tenant; forTenant sets the tenant and NOT the user", async () => {
    const asUser = await forUser("user-9").transaction(async (tx) => ({
      user: (await tx.$queryRawUnsafe<{ v: string }[]>(setting("app.user_id")))[0].v,
      tenant: (await tx.$queryRawUnsafe<{ v: string | null }[]>(setting("app.tenant_id")))[0].v,
    }));
    expect(asUser.user).toBe("user-9");
    expect(asUser.tenant || null).toBeNull();
    const asTenant = await forTenant(trustedTenantId("t-9")).transaction(async (tx) => (await tx.$queryRawUnsafe<{ v: string | null }[]>(setting("app.user_id")))[0].v);
    expect(asTenant || null).toBeNull();
  });

  test("the context is TRANSACTION-LOCAL: on a one-connection pool nothing leaks to the next transaction or the next query", async () => {
    // One connection on purpose: if the setting were session-level, the very next statement would see it.
    const url = new URL(TEST_DATABASE_URL);
    url.searchParams.set("connection_limit", "1");
    const single = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      for (let i = 0; i < 5; i++) {
        await single.$transaction(async (tx) => {
          await setTenantContext(tx, trustedTenantId(`tenant-${i}`));
          await setUserContext(tx, `user-${i}`);
        });
        const after = await single.$queryRawUnsafe<{ t: string | null; u: string | null }[]>(
          `SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.user_id', true) AS u`,
        );
        expect(after[0].t || null).toBeNull(); // '' (reset) or null — never `tenant-i`
        expect(after[0].u || null).toBeNull();
      }
    } finally {
      await single.$disconnect();
    }
  });

  test("an error inside rolls the whole transaction back", async () => {
    const tenant = await db.tenant.findFirstOrThrow();
    await expect(
      forTenant(trustedTenantId(tenant.id)).transaction(async (tx) => {
        await tx.campus.create({ data: { tenantId: tenant.id, name: "Rolled back" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.campus.count({ where: { name: "Rolled back" } })).toBe(0);
  });

  test("trustedTenantId refuses an empty or oversized id; setUserContext refuses an empty user", async () => {
    expect(() => trustedTenantId("")).toThrow();
    expect(() => trustedTenantId("x".repeat(129))).toThrow();
    expect(() => trustedTenantId(undefined as unknown as string)).toThrow();
    await expect(forUser("").transaction(async () => 1)).rejects.toThrow();
  });
});

// --- the code that now runs inside those contexts ----------------------------------------------------------------

test.describe("person-level audit and the membership list, per school", () => {
  test("auditPersonEvent writes one row per school the person belongs to, each with its own tenantId — and none for a person with no school", async () => {
    const { a, b } = await twoSchools();
    const user = await createUser();
    const loner = await createUser();
    await addMembership(user.id, a.id, Role.TEACHING_STAFF);
    await addMembership(user.id, b.id, Role.PARENT);
    await auditPersonEvent(user.id, "PROFILE_UPDATED", { before: { name: "a" }, after: { name: "b" } });
    await auditPersonEvent(loner.id, "PROFILE_UPDATED");
    const rows = await db.auditLog.findMany({ where: { actorUserId: user.id, action: "PROFILE_UPDATED" } });
    expect(rows.map((r) => r.tenantId).sort()).toEqual([a.id, b.id].sort());
    for (const row of rows) {
      expect(row.targetId).toBe(user.id);
      expect(row.beforeValue).toEqual({ name: "a" });
      expect(row.afterValue).toEqual({ name: "b" });
    }
    expect(await db.auditLog.count({ where: { actorUserId: loner.id } })).toBe(0);
  });

  test("getUserMemberships lists the caller's own schools only, oldest first, with ids but no campus names", async () => {
    const { a, b } = await twoSchools();
    const user = await createUser();
    const other = await createUser();
    await addMembership(user.id, a.id, Role.STUDENT, a.campuses[0].id);
    await addMembership(user.id, b.id, Role.ADMIN);
    await addMembership(other.id, b.id, Role.TEACHING_STAFF);
    const list = await getUserMemberships(user.id);
    expect(list).toEqual([
      { tenantId: a.id, tenantCode: a.code, tenantName: "Alpha School", campusId: a.campuses[0].id, role: "STUDENT" },
      { tenantId: b.id, tenantCode: b.code, tenantName: "Beta School", campusId: null, role: "ADMIN" },
    ]);
    expect(await getUserMemberships((await createUser()).id)).toEqual([]);
  });
});
