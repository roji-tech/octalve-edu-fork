import "../support/env";
import crypto from "node:crypto";
import { PrismaClient, Role } from "@prisma/client";
import { test, expect } from "@playwright/test";
import { TEST_APP_DATABASE_URL, TEST_DATABASE_URL } from "../support/env";
import { addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { prisma } from "@/lib/db";
import { assertRlsEnforced, checkRlsEnforcement, resetRlsAssertionForTests, rlsVerdict } from "@/lib/tenant/assert-rls";
import { setTenantContext, setUserContext, forInvitation, forTenant, forUser } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";

// THE negative-test file of domain-implementation-plan.md §0.5.2 / §0.5.3 — run as `app_user`, the role the app runs
// as. A negative test that ran as the table owner (or any role that bypasses RLS) would pass vacuously whether or not
// the policies filter anything: so the first tests prove WHO is running, and everything after arranges its data
// through the ADMIN (`db`, which bypasses RLS) and reads it back through the runtime role (`prisma`).

/// What an invitation link's token hashes to — the only thing that is ever stored or presented to the database.
const hashOf = (seed: string) => crypto.createHash("sha256").update(`rls-test-${seed}`).digest("hex");

let a: TestTenant;
let b: TestTenant;
let userA: { id: string };
let userBoth: { id: string };

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "RLS Alpha", campuses: ["A one", "A two"] });
  b = await createTenant({ name: "RLS Beta", campuses: ["B one"] });
  userA = await createUser();
  userBoth = await createUser();
  await addMembership(userA.id, a.id, Role.ADMIN);
  await addMembership(userBoth.id, a.id, Role.STUDENT);
  await addMembership(userBoth.id, b.id, Role.ADMIN);
  for (const t of [a, b]) {
    await db.invitation.create({ data: { tenantId: t.id, email: `invitee@${t.code}.test`, role: Role.TEACHING_STAFF, tokenHash: hashOf(t.code), expiresAt: new Date(Date.now() + 3_600_000) } });
    await db.auditLog.create({ data: { tenantId: t.id, actorUserId: userBoth.id, action: "ARRANGED", targetType: "User", targetId: userBoth.id } });
  }
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

const asTenant = <T>(t: TestTenant, fn: Parameters<ReturnType<typeof forTenant>["transaction"]>[0]) => forTenant(trustedTenantId(t.id)).transaction(fn) as Promise<T>;
const violation = /row-level security|violates|permission denied/i;

test.describe("who is running", () => {
  test("the runtime role is NOT a superuser, has NO BYPASSRLS, and owns NO tables — so RLS applies to it", async () => {
    const report = await checkRlsEnforcement();
    expect(report.role).toBe("app_user");
    expect(report.problems).toEqual([]);
  });

  test("…while the admin used for fixtures IS exempt (which is exactly why nothing below is arranged through the runtime role)", async () => {
    const admin = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    try {
      const report = await checkRlsEnforcement(admin);
      expect(report.problems.join(" ")).toMatch(/BYPASSRLS|superuser|OWNS the tables/);
    } finally {
      await admin.$disconnect();
    }
  });

  test("the verdict matrix: production refuses a bypassing role unless explicitly allowed; elsewhere it only warns", () => {
    const bad = { role: "x", problems: ["the database role \"x\" has BYPASSRLS"] };
    const good = { role: "app_user", problems: [] };
    expect(rlsVerdict(good, { production: true, allowBypass: false })).toBe("ok");
    expect(rlsVerdict(bad, { production: true, allowBypass: false })).toBe("throw");
    expect(rlsVerdict(bad, { production: true, allowBypass: true })).toBe("warn");
    expect(rlsVerdict(bad, { production: false, allowBypass: false })).toBe("warn");
  });

  test("assertRlsEnforced(): production refuses a bypassing connection — and does NOT remember the refusal, so a fix (or a recovered database) is picked up without a restart", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { NODE_ENV: env.NODE_ENV, ALLOW_RLS_BYPASS: env.ALLOW_RLS_BYPASS };
    try {
      env.NODE_ENV = "production";
      env.ALLOW_RLS_BYPASS = "";
      resetRlsAssertionForTests();
      await expect(assertRlsEnforced(db)).rejects.toThrow(/NOT enforced.*BYPASSRLS|NOT enforced.*superuser|NOT enforced.*OWNS/);
      await expect(assertRlsEnforced(db)).rejects.toThrow(/NOT enforced/); // asked again, answered again
      await expect(assertRlsEnforced(prisma)).resolves.toBeUndefined(); // …and the proper role passes straight away
      await expect(assertRlsEnforced(db)).resolves.toBeUndefined(); // …and a pass IS remembered for the process
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      resetRlsAssertionForTests();
    }
  });

  test("assertRlsEnforced(): ALLOW_RLS_BYPASS=true is the explicit escape hatch (it warns, once, and serves); outside production it only warns", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { NODE_ENV: env.NODE_ENV, ALLOW_RLS_BYPASS: env.ALLOW_RLS_BYPASS };
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      env.NODE_ENV = "production";
      env.ALLOW_RLS_BYPASS = "true";
      resetRlsAssertionForTests();
      await expect(assertRlsEnforced(db)).resolves.toBeUndefined();
      await assertRlsEnforced(db);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/NOT enforced.*ALLOW_RLS_BYPASS=true/);
      env.NODE_ENV = "development";
      env.ALLOW_RLS_BYPASS = "";
      resetRlsAssertionForTests();
      await expect(assertRlsEnforced(db)).resolves.toBeUndefined();
      expect(warnings).toHaveLength(2);
    } finally {
      console.warn = warn;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      resetRlsAssertionForTests();
    }
  });

  test("assertRlsEnforced(): a failure to even ask (database briefly down) is not remembered either", async () => {
    resetRlsAssertionForTests();
    try {
      const down = { $queryRaw: () => Promise.reject(new Error("connection refused")) } as unknown as Parameters<typeof assertRlsEnforced>[0];
      await expect(assertRlsEnforced(down)).rejects.toThrow("connection refused");
      await expect(assertRlsEnforced(prisma)).resolves.toBeUndefined();
    } finally {
      resetRlsAssertionForTests();
    }
  });

  test("the runtime role's privileges are EXACTLY data access: four verbs on each table, two on AuditLog, none on the ledger, no TRUNCATE/TRIGGER/REFERENCES anywhere", async () => {
    const rows = await db.$queryRaw<{ table_name: string; verbs: string[] }[]>`
      SELECT table_name::text, array_agg(privilege_type::text ORDER BY privilege_type) AS verbs
        FROM information_schema.role_table_grants
       WHERE grantee = 'app_user' AND table_schema = 'public'
       GROUP BY table_name`;
    const byTable = Object.fromEntries(rows.map((r) => [r.table_name, r.verbs]));
    expect(byTable["_prisma_migrations"]).toBeUndefined();
    expect(byTable["AuditLog"]).toEqual(["INSERT", "SELECT"]);
    for (const [table, verbs] of Object.entries(byTable)) {
      if (table === "AuditLog") continue;
      expect(verbs, table).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }
    expect(Object.keys(byTable).length).toBeGreaterThan(10); // and every table is covered, not an empty list
    const [schema] = await db.$queryRaw<{ create_ok: boolean }[]>`SELECT has_schema_privilege('app_user', 'public', 'CREATE') AS create_ok`;
    expect(schema.create_ok).toBe(false);
  });

  test("checkRlsEnforcement() reports EACH way RLS can be inert, by name — and nothing for the proper role", async () => {
    expect(await checkRlsEnforcement(prisma)).toMatchObject({ role: "app_user", problems: [] });
    // The real admin: it bypasses RLS and owns the tables (and is a superuser too, where the docker role is).
    const admin = await checkRlsEnforcement(db);
    expect(admin.problems.join("|")).toMatch(/BYPASSRLS|superuser/);
    expect(admin.problems.join("|")).toMatch(/OWNS the tables/);
    // Each flag on its own, with a stand-in client, so a check that stopped looking at ONE of them is noticed.
    const standIn = (who: Partial<{ rolsuper: boolean; rolbypassrls: boolean; owns_tables: boolean }>, unprotected: string[] = []) => {
      let call = 0;
      return {
        $queryRaw: async () => (call++ === 0 ? [{ rolname: "x", rolsuper: false, rolbypassrls: false, owns_tables: false, ...who }] : unprotected.map((relname) => ({ relname }))),
      } as unknown as Parameters<typeof checkRlsEnforcement>[0];
    };
    expect((await checkRlsEnforcement(standIn({ rolsuper: true }))).problems).toEqual(['the database role "x" is a superuser']);
    expect((await checkRlsEnforcement(standIn({ rolbypassrls: true }))).problems).toEqual(['the database role "x" has BYPASSRLS']);
    expect((await checkRlsEnforcement(standIn({ owns_tables: true }))).problems).toEqual(['the database role "x" OWNS the tables (it is the migrator, not the runtime role)']);
    expect((await checkRlsEnforcement(standIn({}, ["Ledger", "Notes"]))).problems).toEqual([
      'table "Ledger" has a tenantId column but row-level security is not enabled and forced on it',
      'table "Notes" has a tenantId column but row-level security is not enabled and forced on it',
    ]);
  });

  test("…and a REAL tenant table without forced RLS is found in the catalog (what a forgetful migration would leave)", async () => {
    await db.$executeRawUnsafe(`CREATE TABLE "ZzForgotRls" ("tenantId" text)`);
    try {
      expect((await checkRlsEnforcement(prisma)).problems).toEqual(['table "ZzForgotRls" has a tenantId column but row-level security is not enabled and forced on it']);
      await db.$executeRawUnsafe(`ALTER TABLE "ZzForgotRls" ENABLE ROW LEVEL SECURITY`); // enabled but not FORCED is still a problem
      expect((await checkRlsEnforcement(prisma)).problems).toHaveLength(1);
      await db.$executeRawUnsafe(`ALTER TABLE "ZzForgotRls" FORCE ROW LEVEL SECURITY`);
      expect((await checkRlsEnforcement(prisma)).problems).toEqual([]);
    } finally {
      await db.$executeRawUnsafe(`DROP TABLE "ZzForgotRls"`);
    }
  });

  test("the runtime role can do DML but NOT DDL, and cannot touch the migration ledger", async () => {
    await expect(prisma.$executeRawUnsafe(`CREATE TABLE "ShouldNotExist" (id int)`)).rejects.toThrow(violation);
    await expect(prisma.$queryRawUnsafe(`SELECT * FROM "_prisma_migrations" LIMIT 1`)).rejects.toThrow(/permission denied/i);
    await expect(prisma.$executeRawUnsafe(`DROP TABLE "Campus"`)).rejects.toThrow(/must be owner|permission denied/i);
  });
});

test.describe("no context = no rows", () => {
  test("Campus, AuditLog, TenantMembership and Invitation return NOTHING without a context, though rows exist", async () => {
    expect(await db.campus.count({ where: { tenantId: { in: [a.id, b.id] } } })).toBe(3);
    expect(await prisma.campus.findMany()).toEqual([]);
    expect(await prisma.auditLog.findMany()).toEqual([]);
    expect(await prisma.tenantMembership.findMany()).toEqual([]);
    expect(await db.invitation.count({ where: { tenantId: { in: [a.id, b.id] } } })).toBe(2);
    expect(await prisma.invitation.findMany()).toEqual([]);
    expect(await prisma.campus.count()).toBe(0);
  });

  test("…and nothing can be written without one", async () => {
    await expect(prisma.campus.create({ data: { tenantId: a.id, name: "No context" } })).rejects.toThrow(violation);
    await expect(prisma.auditLog.create({ data: { tenantId: a.id, actorUserId: "x", action: "NO_CTX", targetType: "t", targetId: "t" } })).rejects.toThrow(violation);
    await expect(prisma.tenantMembership.create({ data: { userId: userA.id, tenantId: b.id, role: Role.ADMIN } })).rejects.toThrow(violation);
    await expect(prisma.invitation.createMany({ data: [{ tenantId: a.id, email: "x@y.test", role: Role.PARENT, tokenHash: hashOf("no-ctx"), expiresAt: new Date() }] })).rejects.toThrow(violation);
  });

  test("an EMPTY-string context (what a pooled connection reads back after a transaction) is also no context", async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', '', true)`;
      return tx.campus.findMany();
    });
    expect(rows).toEqual([]);
  });
});

test.describe("a tenant sees ITS rows and never another's", () => {
  test("tenant A's context reads A's campuses only; B's are invisible — even when asked for BY ID", async () => {
    const seen = await asTenant<{ name: string }[]>(a, (tx) => tx.campus.findMany({ orderBy: { name: "asc" } }));
    expect(seen.map((c) => c.name)).toEqual(["A one", "A two"]);
    const bOne = await db.campus.findFirstOrThrow({ where: { tenantId: b.id } });
    expect(await asTenant(a, (tx) => tx.campus.findUnique({ where: { id: bOne.id } }))).toBeNull();
    expect(await asTenant(a, (tx) => tx.campus.findMany({ where: { tenantId: b.id } }))).toEqual([]); // asking explicitly changes nothing
  });

  test("WITH CHECK: A's context cannot INSERT a campus for B, and cannot MOVE one to B", async () => {
    // `create`/`update` use RETURNING, and Postgres also runs the READ policy on a returned row — so they are refused even with
    // a broken WITH CHECK. `createMany`/`updateMany` return nothing: ONLY the write check stands between them and the row
    // (found by mutation: with `WITH CHECK (true)` the RETURNING-based assertions alone still passed).
    await expect(asTenant(a, (tx) => tx.campus.createMany({ data: [{ tenantId: b.id, name: "Smuggled" }] }))).rejects.toThrow(violation);
    await expect(asTenant(a, (tx) => tx.campus.create({ data: { tenantId: b.id, name: "Smuggled" } }))).rejects.toThrow(violation);
    const mine = await db.campus.findFirstOrThrow({ where: { tenantId: a.id, name: "A one" } });
    await expect(asTenant(a, (tx) => tx.campus.updateMany({ where: { id: mine.id }, data: { tenantId: b.id } }))).rejects.toThrow(violation);
    await expect(asTenant(a, (tx) => tx.campus.update({ where: { id: mine.id }, data: { tenantId: b.id } }))).rejects.toThrow(violation);
    expect((await db.campus.findUniqueOrThrow({ where: { id: mine.id } })).tenantId).toBe(a.id);
    expect(await db.campus.count({ where: { name: "Smuggled" } })).toBe(0);
  });

  test("an UPDATE that reads no column cannot move rows to B either (then no READ policy is consulted — the write check stands alone)", async () => {
    // `UPDATE … WHERE col = …` also runs the read policy on the NEW row, which masks a broken WITH CHECK; an UPDATE with a
    // constant SET and no WHERE reads nothing, so only the WITH CHECK refuses the new tenant (found by mutation, S16).
    for (const table of ["Campus", "TenantMembership", "Invitation"]) {
      await expect(asTenant(a, (tx) => tx.$executeRawUnsafe(`UPDATE "${table}" SET "tenantId" = '${b.id}'`)), table).rejects.toThrow(violation);
    }
    expect(await db.campus.count({ where: { tenantId: b.id } })).toBe(1);
    expect(await db.tenantMembership.count({ where: { tenantId: a.id } })).toBe(2);
    expect(await db.invitation.count({ where: { tenantId: b.id } })).toBe(1);
  });

  test("A's context cannot UPDATE or DELETE B's rows — they are not there to touch (0 rows affected)", async () => {
    const theirs = await db.campus.findFirstOrThrow({ where: { tenantId: b.id } });
    expect(await asTenant<{ count: number }>(a, (tx) => tx.campus.updateMany({ where: { id: theirs.id }, data: { name: "Hacked" } }))).toEqual({ count: 0 });
    expect(await asTenant<{ count: number }>(a, (tx) => tx.campus.deleteMany({ where: { id: theirs.id } }))).toEqual({ count: 0 });
    expect(await db.campus.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ name: "B one", tenantId: b.id });
  });

  test("own rows are writable: A's context can create, rename and delete A's campus", async () => {
    const made = await asTenant<{ id: string }>(a, (tx) => tx.campus.create({ data: { tenantId: a.id, name: "Temp" } }));
    expect(await asTenant(a, (tx) => tx.campus.update({ where: { id: made.id }, data: { name: "Temp renamed" } }))).toMatchObject({ name: "Temp renamed" });
    await asTenant(a, (tx) => tx.campus.delete({ where: { id: made.id } }));
    expect(await db.campus.count({ where: { id: made.id } })).toBe(0);
  });

  test("the context does NOT leak: on a ONE-connection pool, the transaction after a tenant's sees nothing", async () => {
    const url = new URL(TEST_APP_DATABASE_URL);
    url.searchParams.set("connection_limit", "1");
    const single = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      for (let i = 0; i < 4; i++) {
        const inside = await single.$transaction(async (tx) => {
          await setTenantContext(tx, trustedTenantId(a.id));
          return tx.campus.count();
        });
        expect(inside).toBe(2);
        expect(await single.campus.count()).toBe(0); // the SAME connection, the very next statement
      }
    } finally {
      await single.$disconnect();
    }
  });
});

test.describe("AuditLog is tenant-scoped AND append-only", () => {
  test("a tenant reads its own audit rows only; inserts only for itself", async () => {
    const rows = await asTenant<{ tenantId: string }[]>(a, (tx) => tx.auditLog.findMany());
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([a.id]));
    await asTenant(a, (tx) => tx.auditLog.create({ data: { tenantId: a.id, actorUserId: userA.id, action: "OWN_ROW", targetType: "User", targetId: userA.id } }));
    const forged = { tenantId: b.id, actorUserId: userA.id, action: "FORGED_ROW", targetType: "User", targetId: userA.id };
    await expect(asTenant(a, (tx) => tx.auditLog.createMany({ data: [forged] }))).rejects.toThrow(violation); // no RETURNING: only WITH CHECK refuses it
    await expect(asTenant(a, (tx) => tx.auditLog.create({ data: forged }))).rejects.toThrow(violation);
    expect(await db.auditLog.count({ where: { action: "FORGED_ROW" } })).toBe(0);
  });

  test("UPDATE and DELETE are refused OUTRIGHT, even on the tenant's own rows (the privilege is not granted)", async () => {
    const own = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "ARRANGED" } });
    await expect(asTenant(a, (tx) => tx.auditLog.update({ where: { id: own.id }, data: { action: "REWRITTEN" } }))).rejects.toThrow(/permission denied/i);
    await expect(asTenant(a, (tx) => tx.auditLog.delete({ where: { id: own.id } }))).rejects.toThrow(/permission denied/i);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/permission denied/i);
    expect(await db.auditLog.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ action: "ARRANGED" });
  });
});

test.describe("AuditLog: the policy lock (independent of the privilege lock)", () => {
  // Two locks on purpose: the privilege REVOKE is what the test above exercises; this one proves the POLICIES alone would
  // also refuse a rewrite — so removing either lock by accident leaves the other, and a test goes red for each.
  test("only SELECT and INSERT policies exist on AuditLog — there is no UPDATE, DELETE or ALL policy", async () => {
    const rows = await db.$queryRaw<{ policyname: string; cmd: string }[]>`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'AuditLog' ORDER BY cmd`;
    expect(rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  test("with the privilege lock lifted, a tenant STILL cannot rewrite or delete its rows: no policy admits it", async () => {
    // The admin grants UPDATE/DELETE for the length of this test and the grant is ALWAYS taken back (finally) — so a run
    // that dies half-way is noticed by the privilege test above, not hidden. Then the RUNTIME role tries: with the
    // privilege in place the only thing left between it and the rows is the (missing) policy.
    const own = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "ARRANGED" } });
    await db.$executeRawUnsafe(`GRANT UPDATE, DELETE ON "AuditLog" TO app_user`);
    try {
      const touched = await asTenant<{ updated: number; deleted: number }>(a, async (tx) => ({
        updated: (await tx.auditLog.updateMany({ where: { id: own.id }, data: { action: "REWRITTEN" } })).count,
        deleted: (await tx.auditLog.deleteMany({ where: { id: own.id } })).count,
      }));
      expect(touched).toEqual({ updated: 0, deleted: 0 });
    } finally {
      await db.$executeRawUnsafe(`REVOKE UPDATE, DELETE ON "AuditLog" FROM app_user`);
    }
    expect(await db.auditLog.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ action: "ARRANGED" });
    const [priv] = await db.$queryRaw<{ ok: boolean }[]>`SELECT has_table_privilege('app_user', '"AuditLog"', 'UPDATE,DELETE') AS ok`;
    expect(priv.ok).toBe(false); // the grant did not outlive the test
  });
});

test.describe("TenantMembership: tenant roster, own memberships, and nobody else's", () => {
  test("the USER context reads exactly that person's memberships across schools — never anyone else's", async () => {
    const mine = await forUser(userBoth.id).transaction((tx) => tx.tenantMembership.findMany());
    expect(mine.map((m) => m.tenantId).sort()).toEqual([a.id, b.id].sort());
    expect(new Set(mine.map((m) => m.userId))).toEqual(new Set([userBoth.id]));
    const other = await forUser(userA.id).transaction((tx) => tx.tenantMembership.findMany());
    expect(other.map((m) => m.tenantId)).toEqual([a.id]); // not userBoth's rows in A, though they share the school
  });

  test("the TENANT context reads that school's whole roster and no other school's", async () => {
    const roster = await asTenant<{ userId: string; tenantId: string }[]>(a, (tx) => tx.tenantMembership.findMany());
    expect(roster.map((m) => m.userId).sort()).toEqual([userA.id, userBoth.id].sort());
    expect(new Set(roster.map((m) => m.tenantId))).toEqual(new Set([a.id]));
  });

  test("the user path is READ-ONLY: a person cannot grant themselves a role or join a school through it", async () => {
    await expect(
      forUser(userA.id).transaction((tx) => tx.tenantMembership.create({ data: { userId: userA.id, tenantId: b.id, role: Role.ADMIN } })),
    ).rejects.toThrow(violation);
    const escalate = await forUser(userBoth.id).transaction((tx) => tx.tenantMembership.updateMany({ where: { userId: userBoth.id, tenantId: a.id }, data: { role: Role.ADMIN } }));
    expect(escalate).toEqual({ count: 0 });
    expect((await db.tenantMembership.findFirstOrThrow({ where: { userId: userBoth.id, tenantId: a.id } })).role).toBe("STUDENT");
    const removed = await forUser(userBoth.id).transaction((tx) => tx.tenantMembership.deleteMany({ where: { userId: userBoth.id } }));
    expect(removed).toEqual({ count: 0 });
  });

  test("a tenant context can manage ITS roster but cannot add a member to ANOTHER school", async () => {
    const extra = await createUser();
    await asTenant(a, (tx) => tx.tenantMembership.create({ data: { userId: extra.id, tenantId: a.id, role: Role.PARENT } }));
    await expect(asTenant(a, (tx) => tx.tenantMembership.createMany({ data: [{ userId: extra.id, tenantId: b.id, role: Role.PARENT }] }))).rejects.toThrow(violation); // WITH CHECK alone
    await expect(asTenant(a, (tx) => tx.tenantMembership.create({ data: { userId: extra.id, tenantId: b.id, role: Role.PARENT } }))).rejects.toThrow(violation);
    // …and a membership cannot be MOVED to another school (UPDATE's WITH CHECK; `updateMany` returns nothing).
    await expect(asTenant(a, (tx) => tx.tenantMembership.updateMany({ where: { userId: extra.id }, data: { tenantId: b.id } }))).rejects.toThrow(violation);
    expect(await db.tenantMembership.count({ where: { userId: extra.id, tenantId: b.id } })).toBe(0);
    expect(await asTenant<{ count: number }>(a, (tx) => tx.tenantMembership.updateMany({ where: { userId: extra.id }, data: { role: Role.TEACHING_STAFF } }))).toEqual({ count: 1 });
    expect(await asTenant<{ count: number }>(b, (tx) => tx.tenantMembership.updateMany({ where: { userId: extra.id }, data: { role: Role.ADMIN } }))).toEqual({ count: 0 }); // B can't touch A's member
    await asTenant(a, (tx) => tx.tenantMembership.deleteMany({ where: { userId: extra.id } }));
    expect(await db.tenantMembership.count({ where: { userId: extra.id } })).toBe(0);
  });

  test("a user context does NOT see the tenant data it is not part of (campuses, audit)", async () => {
    expect(await forUser(userBoth.id).transaction((tx) => tx.campus.findMany())).toEqual([]);
    expect(await forUser(userBoth.id).transaction((tx) => tx.auditLog.findMany())).toEqual([]);
    void setUserContext;
  });
});

test.describe("Invitation: a school's own invitations — and the ONE row a token names", () => {
  test("the TENANT context reads that school's invitations and no other school's", async () => {
    const seen = await asTenant<{ tenantId: string; email: string }[]>(a, (tx) => tx.invitation.findMany());
    expect(seen.map((i) => i.tenantId)).toEqual([a.id]);
    expect(await asTenant(a, (tx) => tx.invitation.findMany({ where: { tenantId: b.id } }))).toEqual([]); // asking explicitly changes nothing
  });

  test("the INVITATION context reads exactly the row whose token-hash it presents — never another's, never a guess", async () => {
    const mine = await forInvitation(hashOf(a.code)).transaction((tx) => tx.invitation.findMany());
    expect(mine.map((i) => i.tenantId)).toEqual([a.id]);
    const theirs = await forInvitation(hashOf(b.code)).transaction((tx) => tx.invitation.findMany());
    expect(theirs.map((i) => i.tenantId)).toEqual([b.id]); // each hash opens ITS row
    expect(await forInvitation(hashOf("someone-elses")).transaction((tx) => tx.invitation.findMany())).toEqual([]);
    // a partial hash, an uppercase hash, a hash with a wildcard — none is "close enough"
    for (const near of [hashOf(a.code).slice(0, 63), hashOf(a.code).toUpperCase(), hashOf(a.code).slice(0, 10) + "%"]) {
      await expect(forInvitation(near).transaction((tx) => tx.invitation.findMany())).rejects.toThrow(/not a token hash/); // refused before it reaches SQL
    }
    const viaRaw = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.invitation_hash', ${hashOf(a.code).toUpperCase()}::text, true)`; // bypassing the helper: still no match
      return tx.invitation.findMany();
    });
    expect(viaRaw).toEqual([]);
  });

  test("the invitation context reads NOTHING else: no campuses, no audit rows, no memberships, no other school's invitations", async () => {
    await forInvitation(hashOf(a.code)).transaction(async (tx) => {
      expect(await tx.campus.findMany()).toEqual([]);
      expect(await tx.auditLog.findMany()).toEqual([]);
      expect(await tx.tenantMembership.findMany()).toEqual([]);
      expect((await tx.invitation.findMany()).map((i) => i.tenantId)).toEqual([a.id]);
    });
  });

  test("the invitation context is READ-ONLY: it cannot insert, update or delete — not even the row it can read", async () => {
    const row = await db.invitation.findFirstOrThrow({ where: { tenantId: a.id } });
    await forInvitation(hashOf(a.code)).transaction(async (tx) => {
      expect((await tx.invitation.updateMany({ where: { id: row.id }, data: { acceptedAt: new Date() } })).count).toBe(0);
      expect((await tx.invitation.deleteMany({ where: { id: row.id } })).count).toBe(0);
    });
    await expect(
      forInvitation(hashOf(a.code)).transaction((tx) => tx.invitation.createMany({ data: [{ tenantId: a.id, email: "forged@x.test", role: Role.ADMIN, tokenHash: hashOf("forged"), expiresAt: new Date() }] })),
    ).rejects.toThrow(violation);
    expect(await db.invitation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ acceptedAt: null, revokedAt: null });
  });

  test("the accepting path: read by hash, then set the tenant context from the row, then write — and only then", async () => {
    // What lib/invitations does: one transaction, three contexts in order. The write works only after the tenant context is set.
    const row = await db.invitation.create({ data: { tenantId: a.id, email: "accept@x.test", role: Role.PARENT, tokenHash: hashOf("accept-path"), expiresAt: new Date(Date.now() + 60_000) } });
    const claimed = await forInvitation(hashOf("accept-path")).transaction(async (tx) => {
      const found = await tx.invitation.findUniqueOrThrow({ where: { tokenHash: hashOf("accept-path") } });
      expect((await tx.invitation.updateMany({ where: { id: found.id, acceptedAt: null }, data: { acceptedAt: new Date() } })).count).toBe(0); // not yet
      await setTenantContext(tx, trustedTenantId(found.tenantId));
      return (await tx.invitation.updateMany({ where: { id: found.id, acceptedAt: null }, data: { acceptedAt: new Date() } })).count;
    });
    expect(claimed).toBe(1);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).not.toBeNull();
  });

  test("WITH CHECK: A's context cannot create an invitation for B (nothing returned, so only the write check refuses it), nor move one", async () => {
    const forB = { tenantId: b.id, email: "smuggled@x.test", role: Role.ADMIN, tokenHash: hashOf("smuggled"), expiresAt: new Date(Date.now() + 60_000) };
    await expect(asTenant(a, (tx) => tx.invitation.createMany({ data: [forB] }))).rejects.toThrow(violation);
    await expect(asTenant(a, (tx) => tx.invitation.create({ data: forB }))).rejects.toThrow(violation);
    const mine = await db.invitation.findFirstOrThrow({ where: { tenantId: a.id, acceptedAt: null, revokedAt: null } });
    await expect(asTenant(a, (tx) => tx.invitation.updateMany({ where: { id: mine.id }, data: { tenantId: b.id } }))).rejects.toThrow(violation);
    expect(await db.invitation.count({ where: { tokenHash: hashOf("smuggled") } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: mine.id } })).tenantId).toBe(a.id);
  });

  test("A's context cannot UPDATE or DELETE B's invitations — they are not there to touch", async () => {
    const theirs = await db.invitation.findFirstOrThrow({ where: { tenantId: b.id } });
    expect((await asTenant<{ count: number }>(a, (tx) => tx.invitation.updateMany({ where: { id: theirs.id }, data: { revokedAt: new Date() } }))).count).toBe(0);
    expect((await asTenant<{ count: number }>(a, (tx) => tx.invitation.deleteMany({ where: { id: theirs.id } }))).count).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: theirs.id } })).revokedAt).toBeNull();
  });

  test("ONE live invitation per (school, address): a second cannot exist while the first is open — and can once it is revoked or accepted", async () => {
    const base = { tenantId: a.id, email: "one-live@x.test", role: Role.STUDENT, expiresAt: new Date(Date.now() + 60_000) };
    const first = await db.invitation.create({ data: { ...base, tokenHash: hashOf("live-1") } });
    await expect(db.invitation.create({ data: { ...base, tokenHash: hashOf("live-2") } })).rejects.toThrow(/Unique constraint/);
    await db.invitation.create({ data: { ...base, tenantId: b.id, tokenHash: hashOf("live-other-school") } }); // another school: fine
    await db.invitation.update({ where: { id: first.id }, data: { revokedAt: new Date() } });
    const second = await db.invitation.create({ data: { ...base, tokenHash: hashOf("live-2") } }); // the earlier one is dead: allowed
    await db.invitation.update({ where: { id: second.id }, data: { acceptedAt: new Date() } });
    await db.invitation.create({ data: { ...base, tokenHash: hashOf("live-3") } }); // accepted is not live either
  });
});

// --- the catalog guard: the next table cannot forget -------------------------------------------------------------------
test.describe("catalog guard", () => {
  // Tables with NO tenantId column — by design, and each for a stated reason. A NEW table must either carry a tenantId
  // (and then the test below demands forced RLS and a policy) or be added here on purpose, in review.
  const IDENTITY_TABLES = [
    "User", "Session", "PasswordResetToken", "EmailChangeToken", "MfaCredential", "MfaRecoveryCode", "MfaChallenge", // a person's own credentials, found by userId
    "Tenant", // resolved by code before any tenant is known
    "SystemSettings", // the one global singleton row
    "_prisma_migrations", // Prisma's own ledger (the runtime role has no access)
  ];

  test("every table with a tenantId column has RLS ENABLED and FORCED and at least one policy", async () => {
    const rows = await db.$queryRaw<{ relname: string; enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'tenantId' AND NOT att.attisdropped
       WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    expect(rows.map((r) => r.relname).sort()).toEqual(["AuditLog", "Campus", "Invitation", "TenantMembership"]); // update this list WITH the migration
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({ enabled: true, forced: true });
      expect(row.policies, `${row.relname} needs a policy`).toBeGreaterThanOrEqual(1);
    }
  });

  test("the tables WITHOUT a tenantId are exactly the reviewed identity list", async () => {
    const rows = await db.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...IDENTITY_TABLES].sort());
  });

  test("every policy has BOTH a USING and a WITH CHECK where it can write (no read-only-protected writes)", async () => {
    const rows = await db.$queryRaw<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'`;
    for (const p of rows) {
      if (p.cmd === "SELECT" || p.cmd === "DELETE") expect(p.qual, `${p.tablename}.${p.policyname}`).toBeTruthy();
      if (p.cmd === "INSERT") expect(p.with_check, `${p.tablename}.${p.policyname}`).toBeTruthy();
      if (p.cmd === "UPDATE" || p.cmd === "ALL") {
        expect(p.qual, `${p.tablename}.${p.policyname}`).toBeTruthy();
        expect(p.with_check, `${p.tablename}.${p.policyname}`).toBeTruthy();
      }
    }
  });

  test("a table created by a LATER migration is granted to the runtime role without anyone remembering (default privileges)", async () => {
    await db.$executeRawUnsafe(`CREATE TABLE "ZzPrivilegeProbe" (id int)`);
    try {
      const [row] = await db.$queryRaw<{ ok: boolean }[]>`SELECT has_table_privilege('app_user', '"ZzPrivilegeProbe"', 'SELECT,INSERT,UPDATE,DELETE') AS ok`;
      expect(row.ok).toBe(true);
    } finally {
      await db.$executeRawUnsafe(`DROP TABLE "ZzPrivilegeProbe"`);
    }
  });
});
