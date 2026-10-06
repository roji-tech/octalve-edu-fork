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

  test("`permissions` without `tenant: true` throws at construction, like `roles` — a permission only means something against one school's membership", () => {
    expect(() => withAuth(handler, { permissions: ["CAN_MANAGE_FINANCE"] } as never)).toThrow(/needs `tenant: true`/);
    expect(() => withAuth(handler, { tenant: false, permissions: ["CAN_MANAGE_FINANCE"] } as never)).toThrow(/needs `tenant: true`/);
  });

  test("`permissions` must be a NON-EMPTY array of real permissions: an empty list would read as 'everyone', a typo would never match", () => {
    for (const bad of [[], "CAN_MANAGE_FINANCE", ["CAN_MANAGE_FINANCES"], ["students:read"], [null]]) {
      expect(() => withAuth(handler as never, { tenant: true, permissions: bad } as never), JSON.stringify(bad)).toThrow(
        /permissions|permission/,
      );
    }
    expect(typeof withAuth(handler as never, { tenant: true, permissions: ["CAN_MANAGE_FINANCE"] })).toBe("function");
    expect(
      typeof withAuth(handler as never, {
        tenant: true,
        roles: ["TEACHING_STAFF"],
        permissions: ["CAN_APPROVE_RESULTS", "CAN_PUBLISH_CONTENT"],
      }),
    ).toBe("function");
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
