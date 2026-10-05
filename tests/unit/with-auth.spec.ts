import "../support/env";
import { test, expect } from "@playwright/test";
import { withAuth } from "@/lib/auth/with-auth";

// Role gating needs a verified school (§0.5.2): a role only means something against a specific tenant's
// membership, and a straight port of "any ADMIN row grants access" would let an ADMIN of school A through on
// school B's routes. It is a COMPILE error to ask for `roles` without `tenant: true` (see with-auth.types.ts)
// and, if someone bypasses the types, a throw at construction.
test.describe("withAuth refuses options that can't be evaluated safely", () => {
  const handler = async () => new Response("ok");

  test("`roles` without `tenant: true` throws at construction", () => {
    expect(() => withAuth(handler, { roles: ["ADMIN"] } as never)).toThrow(/needs `tenant: true`/);
    expect(() => withAuth(handler, { tenant: false, roles: ["ADMIN"] } as never)).toThrow(/needs `tenant: true`/);
  });

  test("even an empty `roles` array without a tenant throws — the key's presence is what's refused", () => {
    expect(() => withAuth(handler, { roles: [] } as never)).toThrow();
  });

  test("`permissions` throws at construction, with or without a tenant", () => {
    expect(() => withAuth(handler, { permissions: ["students:read"] } as never)).toThrow(/§1\.7/);
    expect(() => withAuth(handler, { tenant: true, permissions: ["students:read"] } as never)).toThrow(/§1\.7/);
  });

  test("`roles` that is not an array throws", () => {
    expect(() => withAuth(handler as never, { tenant: true, roles: "ADMIN" } as never)).toThrow(/array/);
  });

  test("no options, `{}` and `{ tenant: true }` (with or without a roles list) are fine and yield a route handler", () => {
    expect(typeof withAuth(handler)).toBe("function");
    expect(typeof withAuth(handler, {})).toBe("function");
    expect(typeof withAuth(handler as never, { tenant: true })).toBe("function");
    expect(typeof withAuth(handler as never, { tenant: true, roles: ["ADMIN"] })).toBe("function");
  });
});
