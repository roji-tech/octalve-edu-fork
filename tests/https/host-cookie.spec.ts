import { test, expect } from "../support/fixtures";
import { HTTPS_URL } from "../support/env";
import { Role, createUser, db, resetDatabase, seedInstance } from "../support/db";
import {
  alerts,
  emailField,
  fillCredentials,
  keepSignedInBox,
  passwordField,
  signInButton,
  signOut,
} from "../e2e/helpers";

// The only environment where the session cookie's production shape can be
// checked honestly: real TLS in front of a production build whose APP_URL is
// https://, driven by real Chromium, which ENFORCES the cookie-prefix rules:
//   `__Host-` cookies are only accepted if Secure, Path=/, and with no Domain.
// (docs/auth-review-2026-09-29.md, P0 #4: a bare `cookies.delete()` can look
// fine in plain-HTTP dev and silently fail to clear a `__Host-` cookie in
// production — leaving a "signed-out" user still signed in.)
const COOKIE = "__Host-octalve.session-token";
const PLAIN_COOKIE = "octalve.session-token";

test.beforeAll(async () => {
  await seedInstance();
});

const cookieNamed = async (context: import("@playwright/test").BrowserContext, name: string) =>
  (await context.cookies(HTTPS_URL)).find((c) => c.name === name);

test.describe("the __Host- session cookie over real HTTPS", () => {
  test("login sets it — and Chromium accepts it, which it only does if it is Secure, Path=/ and has no Domain", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await keepSignedInBox(page).check(); // remembered → a persistent cookie
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

    const cookie = await cookieNamed(context, COOKIE);
    expect(cookie, "the __Host- cookie must be present in the browser's jar").toBeDefined();
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe("Lax");
    expect(cookie!.path).toBe("/");
    expect(cookie!.value).toMatch(/^[0-9a-f]{64}$/);
    // ADMIN, remembered: ~7 days
    expect(Math.abs(cookie!.expires * 1000 - (Date.now() + 7 * 86_400_000))).toBeLessThan(5 * 60_000);

    // The unprefixed (plain-HTTP) cookie name is NOT what this deployment uses.
    expect(await cookieNamed(context, PLAIN_COOKIE)).toBeUndefined();
    // Page JavaScript can't read it.
    expect(await page.evaluate(() => document.cookie)).not.toContain("octalve");
  });

  test("not remembered (the default): still a valid __Host- cookie, but a browser-session one — and the server holds the 12-hour cap", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await expect(keepSignedInBox(page)).not.toBeChecked();
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    const cookie = await cookieNamed(context, COOKIE);
    expect(cookie, "Chromium must still accept it as a __Host- cookie").toBeDefined();
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.expires).toBe(-1); // Playwright's marker for a session cookie

    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(Math.abs(row.absoluteExpires.getTime() - (Date.now() + 12 * 3_600_000))).toBeLessThan(5 * 60_000);

    // And signing out removes it just the same.
    await signOut(page);
    await expect(page).toHaveURL(/\/login$/);
    expect(await cookieNamed(context, COOKIE)).toBeUndefined();
  });

  test("the cookie authenticates later requests (the dashboard renders signed in, /api/v1/auth/me answers)", async ({ page, request }) => {
    const user = await createUser({ role: Role.ADMIN, name: "Zainab Bello" });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page.getByRole("heading", { name: "Welcome, Zainab" })).toBeVisible();

    const me = await page.request.get("/api/v1/auth/me");
    expect(me.status()).toBe(200);
    expect((await me.json()).data.user.email).toBe(user.email);

    // A context with no cookies is not signed in — proving the cookie, not the IP or anything else, is the credential.
    const anonymous = await request.get("/api/v1/auth/me", { headers: { cookie: "" } });
    expect(anonymous.status()).toBe(401);
  });

  test("LOGOUT ACTUALLY REMOVES the __Host- cookie from the browser (the P0 #4 check), and the session row is gone", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(await cookieNamed(context, COOKIE), "precondition: cookie set before logout").toBeDefined();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);

    await signOut(page);
    await expect(page).toHaveURL(/\/login$/);

    // The whole point: not "the server said it cleared it" — Chromium's jar no longer has it.
    expect(await cookieNamed(context, COOKIE), "the __Host- cookie must be gone after logout").toBeUndefined();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the logout response's Set-Cookie carries every attribute a browser needs to accept the clearing of a __Host- cookie", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    const logout = page.waitForResponse((res) => res.url().endsWith("/api/v1/auth/logout"));
    await signOut(page);
    const headers = (await (await logout).headersArray()).filter((h) => h.name.toLowerCase() === "set-cookie");
    expect(headers).toHaveLength(1);
    const header = headers[0].value;
    expect(header).toMatch(new RegExp(`^${COOKIE}=;`));
    for (const attribute of [/Max-Age=0/i, /Path=\//i, /Secure/i, /HttpOnly/i, /SameSite=lax/i]) {
      expect(header).toMatch(attribute);
    }
    expect(header).not.toMatch(/Domain=/i);
  });

  test("a stale __Host- cookie for a deleted session sends the user to sign in (and doesn't crash)", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await db.session.deleteMany({ where: { userId: user.id } });
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    // …and signing in again replaces whatever stale cookie the browser still holds.
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(await cookieNamed(context, COOKIE)).toBeDefined();
  });

  test("a wrong password over HTTPS behaves exactly as over HTTP: generic error, no cookie set", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, user.email, "not-the-password-1");
    await signInButton(page).click();
    await expect(alerts(page)).toContainText("incorrect");
    expect(await cookieNamed(context, COOKIE)).toBeUndefined();
    await expect(passwordField(page)).toBeFocused();
  });
});

test.describe("what the HTTPS deployment tells the user", () => {
  test("the setup wizard shows NO 'not served over HTTPS' warning when APP_URL is https", async ({ page }) => {
    await resetDatabase(); // the wizard only exists on a fresh install
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Initialize this instance" })).toBeVisible();
    await expect(page.getByText("This instance isn't served over HTTPS")).toHaveCount(0);
    await seedInstance(); // leave the database usable for whatever runs next
    await page.goto("/login");
    await expect(emailField(page)).toBeVisible();
  });
});
