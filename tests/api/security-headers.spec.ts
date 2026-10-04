import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, seedInstance } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// Every response — pages, redirects, API routes, static files, errors — carries
// the baseline headers; a route added later can't forget them.
const BASELINE_PATHS = ["/login", "/setup", "/", "/dashboard", "/api/v1/auth/me", "/favicon.ico", "/no-such-page"];

test.beforeAll(async () => {
  await seedInstance(); // so /login and / don't bounce to /setup
});

test.describe("baseline security headers", () => {
  for (const path of BASELINE_PATHS) {
    test(`${path}: framing denied, no MIME sniffing, referrer trimmed, no X-Powered-By`, async () => {
      const res = await api(path);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      // Pages carry the per-request nonce policy (proxy.ts), the API its static one (next.config.ts); both
      // forbid framing. Static assets are excluded from the proxy and carry neither (tests/api/csp.spec.ts).
      if (path !== "/favicon.ico") {
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      }
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("x-powered-by")).toBeNull(); // don't advertise the framework
    });
  }

  test("the API's auth responses carry them too, on success and on refusal", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const ok = await loginAs(user);
    const refused = await api("/api/v1/auth/login", { body: { email: user.email, password: "wrong-wrong-1" } });
    for (const res of [ok, refused]) {
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

test.describe("pages that depend on who is asking are never cached", () => {
  test("/login, /setup and the signed-in /dashboard are all no-store", async () => {
    const user = await createUser();
    const { token } = await loginAs(user);

    const login = await api("/login", { ip: null });
    expect(login.status).toBe(200);
    expect(login.headers.get("cache-control")).toContain("no-store");

    const dashboard = await api("/dashboard", { cookie: cookieHeader(token!) });
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("cache-control")).toContain("no-store");
    expect(dashboard.text).toContain(user.name); // it really is the signed-in page

    // …and the signed-out redirect isn't cacheable either.
    const anon = await api("/dashboard");
    expect(anon.status).toBe(307);
    expect(anon.headers.get("location")).toContain("/login");
    expect(anon.headers.get("cache-control")).toContain("no-store");
    expect(anon.text).not.toContain(user.name); // no flash of protected content in the redirect body
  });
});
