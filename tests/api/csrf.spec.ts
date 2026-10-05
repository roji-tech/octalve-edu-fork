import "../support/env";
import { test, expect } from "@playwright/test";
import { Role, createUser, seedInstance } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

// CSRF over real HTTP (plan §0.5.3, C): the decision table is unit-tested; this proves the wiring on a real server.

test.beforeAll(async () => {
  await seedInstance();
});

async function signedIn() {
  const user = await createUser({ role: Role.TEACHING_STAFF });
  return cookieHeader((await loginAs(user)).token!);
}
const post = (cookie: string, headers: Record<string, string>, origin?: string | null) =>
  api("/api/v1/account/profile", { method: "PATCH", body: { name: "Same Name" }, cookie, headers, origin });

test("a client-supplied X-Forwarded-Host does NOT choose the host its Origin is compared with", async () => {
  const cookie = await signedIn();
  const res = await post(cookie, { "x-forwarded-host": "evil.example" }, "https://evil.example");
  expect(res.status).toBe(403);
  expect(res.json.error.code).toBe("CSRF");
});

test("Sec-Fetch-Site: cross-site and same-site are refused even with a matching Origin; same-origin and none pass", async () => {
  const cookie = await signedIn();
  for (const site of ["cross-site", "same-site"]) {
    const res = await post(cookie, { "sec-fetch-site": site });
    expect(res.status, site).toBe(403);
    expect(res.json.error.code).toBe("CSRF");
  }
  for (const site of ["same-origin", "none"]) expect((await post(cookie, { "sec-fetch-site": site })).status, site).toBe(200);
  expect((await post(cookie, {})).status).toBe(200); // no header at all (curl, old browsers) → Origin decides
});

test("no Origin and no Referer is refused even for a signed-in person", async () => {
  const cookie = await signedIn();
  expect((await post(cookie, {}, null)).status).toBe(403);
});
