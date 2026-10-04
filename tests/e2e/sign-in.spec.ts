import { test, expect } from "../support/fixtures";
import { Role, createUser, db, seedInstance, sha256Hex } from "../support/db";
import {
  alerts,
  emailField,
  fillCredentials,
  keepSignedInBox,
  passwordField,
  signInButton,
  signInThroughUi,
  signOut,
  trackLoginRequests,
} from "./helpers";

test.beforeAll(async () => {
  await seedInstance();
});

const SESSION_COOKIE = "octalve.session-token";

test.describe("signing in", () => {
  test("valid credentials land on the dashboard, showing who and which school; the cookie is HttpOnly", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN, name: "Amina Yusuf" });
    await signInThroughUi(page, user);

    await expect(page.getByRole("heading", { name: "Welcome, Amina" })).toBeVisible();
    await expect(page.getByText("Bright Future Academy")).toBeVisible();
    await expect(page.getByText("Administrator")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe("Lax");
    // Page scripts can't read it — an XSS bug can't lift the session.
    expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE);
    // And the password never ends up in the address bar or history.
    expect(page.url()).not.toContain(user.password);
  });

  test("a wrong password shows one generic message, empties the password, KEEPS the email, and puts focus back in the password field", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, user.email, "not-the-password-1");
    await signInButton(page).click();

    await expect(alerts(page)).toContainText("The email or password you entered is incorrect");
    await expect(page).toHaveURL(/\/login$/);
    await expect(passwordField(page)).toHaveValue("");
    await expect(emailField(page)).toHaveValue(user.email);
    // Regression: the inputs are disabled while submitting, and focus() on a
    // disabled input silently does nothing — keyboard/screen-reader users were
    // dropped onto <body>. Focus has to land AFTER the inputs are re-enabled.
    await expect(passwordField(page)).toBeFocused();

    // …and the same form still works on retry.
    await passwordField(page).fill(user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("an unknown account gets exactly the same message as a wrong password (no enumeration through the UI)", async ({ page }) => {
    const user = await createUser();
    await page.goto("/login");

    await fillCredentials(page, user.email, "not-the-password-1");
    await signInButton(page).click();
    await expect(alerts(page)).toBeVisible();
    const wrongPassword = (await alerts(page).innerText()).trim();

    await fillCredentials(page, "nobody-here@test.example", "not-the-password-1");
    await signInButton(page).click();
    await expect(alerts(page)).toBeVisible();
    // wait for the second response to land (password gets cleared again)
    await expect(passwordField(page)).toBeFocused();
    const unknownAccount = (await alerts(page).innerText()).trim();

    expect(unknownAccount).toBe(wrongPassword);
  });

  test("email is forgiving about case and stray spaces", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, `  ${user.email.toUpperCase()} `, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe("client-side validation", () => {
  test("empty submit shows inline errors on both fields, focuses the first, and sends NOTHING to the server", async ({ page }) => {
    await page.goto("/login");
    const sent = trackLoginRequests(page);

    await signInButton(page).click();

    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await expect(emailField(page)).toBeFocused();
    await expect(emailField(page)).toHaveAttribute("aria-invalid", "true");
    await expect(passwordField(page)).toHaveAttribute("aria-invalid", "true");
    // The error text is programmatically tied to its input (screen readers read it with the field).
    const describedBy = await emailField(page).getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toHaveText("Enter your email address.");
    expect(sent).toHaveLength(0);
  });

  test("a malformed email is caught locally; errors clear as the user fixes them", async ({ page }) => {
    await page.goto("/login");
    const sent = trackLoginRequests(page);

    await fillCredentials(page, "not-an-email", "whatever-1");
    await signInButton(page).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    expect(sent).toHaveLength(0);

    await emailField(page).fill("someone@school.test");
    await expect(page.getByText("Enter a valid email address.")).toBeHidden();
    await expect(emailField(page)).not.toHaveAttribute("aria-invalid", "true");
  });
});

test.describe("using only the keyboard", () => {
  test.skip(({ isMobile }) => isMobile, "tab order is a desktop concern");

  test("the email field is focused on arrival, Tab moves email → forgot-password link → password → show/hide → keep-signed-in → Sign in, Enter submits", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");

    await expect(emailField(page)).toBeFocused();
    await page.keyboard.type(user.email);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Forgot password?" })).toBeFocused(); // in the Password label row
    await page.keyboard.press("Tab");
    await expect(passwordField(page)).toBeFocused();
    await page.keyboard.type(user.password);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Show password" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(keepSignedInBox(page)).toBeFocused();
    // The drawn box (the input itself is invisible) shows a real focus ring…
    const ring = await keepSignedInBox(page)
      .locator("xpath=following-sibling::span[1]")
      .evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
    expect(ring).toEqual({ style: "solid", width: "2px" });
    // …and Space ticks it.
    await page.keyboard.press("Space");
    await expect(keepSignedInBox(page)).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(signInButton(page)).toBeFocused();

    // A visible focus indicator on the keyboard-focused button.
    const outline = await signInButton(page).evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("Enter inside the password field submits the form", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await passwordField(page).press("Enter");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

// "Keep me signed in on this device" (plan §0.5.A): unchecked by default → a browser-session cookie
// and a 12-hour cap; ticked → a persistent cookie and the long policy.
test.describe("keep me signed in on this device", () => {
  const LABEL = "Keep me signed in on this device";

  test("is unchecked by default, has a visible label, and its state is never stored client-side", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
    await expect(keepSignedInBox(page)).not.toBeChecked();

    await keepSignedInBox(page).check();
    await expect(keepSignedInBox(page)).toBeChecked();
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

    await page.reload();
    await expect(keepSignedInBox(page)).not.toBeChecked(); // a fresh visit starts from the safe default
  });

  test("the whole row is the target: clicking the label text ticks the box, and again unticks it", async ({ page }) => {
    await page.goto("/login");
    await page.getByText(LABEL, { exact: true }).click();
    await expect(keepSignedInBox(page)).toBeChecked();
    await page.getByText(LABEL, { exact: true }).click();
    await expect(keepSignedInBox(page)).not.toBeChecked();
  });

  test("ticked: the request carries remember:true and the browser is given a PERSISTENT cookie", async ({ page, context }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await keepSignedInBox(page).check();
    const request = page.waitForRequest((r) => r.url().endsWith("/api/v1/auth/login"));
    await signInButton(page).click();

    expect((await request).postDataJSON()).toMatchObject({ remember: true });
    await expect(page).toHaveURL(/\/dashboard$/);
    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000 + 80 * 86_400); // ~90 days out
  });

  test("unticked (the default): the request carries remember:false and the cookie is a browser-session cookie", async ({ page, context }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    const request = page.waitForRequest((r) => r.url().endsWith("/api/v1/auth/login"));
    await signInButton(page).click();

    expect((await request).postDataJSON()).toMatchObject({ remember: false });
    await expect(page).toHaveURL(/\/dashboard$/);
    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie!.expires).toBe(-1); // Playwright's marker for a session cookie
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.absoluteExpires.getTime() - Date.now()).toBeLessThan(12 * 3_600_000 + 60_000);
  });

  test("a failed attempt keeps the choice the person made (only the password is cleared)", async ({ page }) => {
    const user = await createUser();
    await page.goto("/login");
    await fillCredentials(page, user.email, "not-the-password-1");
    await keepSignedInBox(page).check();
    await signInButton(page).click();

    await expect(alerts(page)).toContainText("incorrect");
    await expect(passwordField(page)).toHaveValue("");
    await expect(keepSignedInBox(page)).toBeChecked();
  });
});

test.describe("show / hide password", () => {
  test("the toggle switches the input type, its own label, and aria-pressed", async ({ page }) => {
    await page.goto("/login");
    await passwordField(page).fill("hunter2-hunter2");
    const toggle = page.getByRole("button", { name: "Show password" });

    await expect(passwordField(page)).toHaveAttribute("type", "password");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    const hide = page.getByRole("button", { name: "Hide password" });
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await expect(passwordField(page)).toHaveAttribute("type", "text");
    await expect(passwordField(page)).toHaveValue("hunter2-hunter2");

    await hide.click();
    await expect(passwordField(page)).toHaveAttribute("type", "password");
  });
});

test.describe("when the server pushes back", () => {
  test("double-clicking Sign in sends exactly one request", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    const sent = trackLoginRequests(page);
    await page.route("**/api/v1/auth/login", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600)); // widen the window for a second click
      await route.continue();
    });

    await fillCredentials(page, user.email, user.password);
    await signInButton(page).dblclick();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(sent).toHaveLength(1);
  });

  test("a network failure gets a clear message and doesn't wedge the form", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await page.route("**/api/v1/auth/login", (route) => route.abort("connectionrefused"));

    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(alerts(page)).toContainText("Can't reach the server");
    await expect(passwordField(page)).toHaveValue("");
    await expect(signInButton(page)).toBeEnabled();

    await page.unroute("**/api/v1/auth/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("an unexpected server error is reported without leaking details", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "boom: prisma stack trace" } }) }),
    );
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(alerts(page)).toContainText("couldn't sign you in right now");
    await expect(page.getByText("prisma")).toHaveCount(0);
  });

  test("repeated failures pause sign-in: banner, live countdown, disabled button — and the SERVER keeps refusing after the pause ends", async ({ page }) => {
    test.setTimeout(120_000);
    const user = await createUser({ role: Role.ADMIN });
    await page.clock.install();
    await page.goto("/login");

    for (let i = 0; i < 5; i++) {
      await fillCredentials(page, user.email, `wrong-password-${i}`);
      await signInButton(page).click();
      await expect(alerts(page)).toContainText("incorrect");
      await expect(passwordField(page)).toBeFocused();
    }
    // The sixth attempt trips the server's per-account limit.
    await fillCredentials(page, user.email, user.password); // even the RIGHT password
    await signInButton(page).click();

    await expect(alerts(page)).toContainText("Sign-in is paused for a moment");
    const paused = page.getByRole("button", { name: "Try again in 30s" });
    await expect(paused).toBeDisabled();
    await expect(page).toHaveURL(/\/login$/);
    await expect(passwordField(page)).toBeFocused();

    // Freeze time, then tick the countdown deterministically. (pauseAt itself jumps
    // forward one second and fires the due timer once, so read where we are now.)
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    const countdown = page.getByRole("button", { name: /^Try again in \d+s$/ });
    let remaining = Number((await countdown.innerText()).match(/(\d+)s/)![1]);
    expect(remaining).toBeLessThanOrEqual(30);
    while (remaining > 1) {
      await page.clock.runFor(1000);
      remaining -= 1;
      await expect(page.getByRole("button", { name: `Try again in ${remaining}s` })).toBeVisible();
    }
    await page.clock.runFor(1000);
    await expect(signInButton(page)).toBeEnabled();

    // The pause was a courtesy. The server's window (5 minutes) is what enforces:
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(alerts(page)).toContainText("Sign-in is paused for a moment");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the paused banner's live text isn't spammed at screen readers every second", async ({ page }) => {
    test.setTimeout(120_000);
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    for (let i = 0; i < 6; i++) {
      await fillCredentials(page, user.email, `wrong-password-${i}`);
      await signInButton(page).click();
      if (i < 5) await expect(alerts(page)).toContainText("incorrect");
    }
    await expect(alerts(page)).toContainText("Sign-in is paused for a moment");
    // The changing countdown is aria-hidden; assistive tech gets one static sentence.
    await expect(alerts(page).locator('span[aria-hidden="true"]')).toContainText("wait");
    await expect(alerts(page).locator(".sr-only")).toContainText("Too many unsuccessful attempts");
  });
});

test.describe("credentials never travel in the URL", () => {
  test.describe("with JavaScript unavailable (or not yet hydrated)", () => {
    test.use({ javaScriptEnabled: false });

    test("submitting the sign-in form natively must not put the password in the address bar", async ({ page }) => {
      const secret = "Sup3r-secret-in-url-check";
      await page.goto("/login");
      await emailField(page).fill("someone@school.test");
      await passwordField(page).fill(secret);
      await signInButton(page).click();
      await page.waitForLoadState("load");
      // A <form> with no method defaults to GET, which would leave the password
      // in the URL, browser history and every server/proxy access log.
      expect(page.url()).not.toContain(secret);
      expect(page.url()).not.toContain("password=");
    });
  });
});

test.describe("staying signed in, and signing out", () => {
  test("the session survives a reload; /login and / send a signed-in user straight to the dashboard", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("sign out: back at /login, the session is gone server-side AND in the browser, and the protected page is not left in this tab's history", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);

    await signOut(page);
    await expect(page).toHaveURL(/\/login$/);

    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();

    // Sign-in and sign-out use history *replacement*, so pressing Back from here
    // doesn't step onto a stale /dashboard entry.
    await page.goBack();
    expect(page.url()).not.toContain("/dashboard");

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("shared computer: someone signs out in another tab, then the next person presses Back to the old dashboard tab — they must land on /login, not see the dashboard", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

    await page.goto("about:blank"); // the tab wandered off; /dashboard is now the previous history entry

    const other = await context.newPage();
    await other.goto("/dashboard");
    await signOut(other);
    await expect(other).toHaveURL(/\/login$/);

    await page.goBack(); // whether restored from the back/forward cache or re-fetched…
    await expect(page).toHaveURL(/\/login$/); // …it must end at sign-in
    await expect(page.getByRole("heading", { name: /Welcome, / })).toHaveCount(0);
  });

  test("if the browser restores the dashboard from its back/forward cache after the session ended, the page re-checks and leaves", async ({ page }) => {
    // Chromium doesn't put no-store pages in the bfcache, so the real thing can't
    // be provoked here; this drives the same code path a bfcache-happy browser
    // would (a `pageshow` with persisted=true) against a genuinely dead session.
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

    await db.session.deleteMany({ where: { userId: user.id } }); // signed out elsewhere

    // The server-rendered heading is visible before React has hydrated and attached
    // the `pageshow` listener, so a single dispatch can land before anyone is
    // listening. Re-dispatch until the page reacts (no arbitrary sleeps).
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      await expect(page).toHaveURL(/\/login$/, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /Welcome, / })).toHaveCount(0);
  });

  test("a normal (non-cache) pageshow does nothing", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    await db.session.deleteMany({ where: { userId: user.id } });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/dashboard$/); // the server is only consulted on real navigations / bfcache restores
  });

  test("signing out in one tab signs out the others without them reloading", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    const other = await context.newPage();
    await other.goto("/dashboard");
    await expect(other.getByRole("heading", { name: /Welcome/ })).toBeVisible();

    await signOut(page);
    await expect(page).toHaveURL(/\/login$/);
    await expect(other).toHaveURL(/\/login$/);
    await expect(other.getByRole("heading", { name: /Welcome, / })).toHaveCount(0);
  });

  test("a session revoked on the server (e.g. 'sign out everywhere') is honoured at the next navigation", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    await db.session.deleteMany({ where: { userId: user.id } });

    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("an idle-expired session sends the user back to sign in", async ({ page, context }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    const token = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)!.value;
    await db.session.update({ where: { tokenHash: sha256Hex(token) }, data: { expires: new Date(Date.now() - 1000) } });

    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a signed-out visitor is sent to /login from /dashboard and /, and never sees protected content", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("two people can be signed in on two browsers at once without seeing each other", async ({ browser }) => {
    const a = await createUser({ role: Role.ADMIN, name: "Amina Yusuf" });
    const b = await createUser({ role: Role.TEACHING_STAFF, name: "Bola Adeyemi" });
    const ctxA = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "10.77.0.1" } });
    const ctxB = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "10.77.0.2" } });
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await signInThroughUi(pageA, a);
      await signInThroughUi(pageB, b);
      await expect(pageA.getByRole("heading", { name: "Welcome, Amina" })).toBeVisible();
      await expect(pageB.getByRole("heading", { name: "Welcome, Bola" })).toBeVisible();
      await expect(pageB.getByText("Teaching staff")).toBeVisible();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
