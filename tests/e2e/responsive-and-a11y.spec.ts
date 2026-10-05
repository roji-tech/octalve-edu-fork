import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { Role, codeFor, createUser, db, enableMfa, resetDatabase, seedInstance, uniqueEmail, uniqueIp } from "./../support/db";
import { DEVTOOLS_URL, DEV_TOOLS_TEST_TOKEN } from "../support/env";
import { linkFrom, waitForMail } from "../support/outbox";
import { createEmailChangeToken } from "@/lib/auth/email-change";
import { base32Decode } from "@/lib/auth/mfa/base32";
import { alerts, codeField, fillCredentials, mfaHeading, passwordField, recoveryField, signInButton, signInThroughUi, verifyButton } from "./helpers";

// Runs on the desktop AND the phone project (see playwright.config.ts).
//  - axe-core, WCAG 2.2 A/AA rules, on every screen and on the STATES that
//    change the DOM (errors, paused, revealed password) — not just first paint.
//  - No horizontal scrolling at any size we test.
//  - On phones, every control is a comfortable tap target (>= 44 CSS px).

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectAccessible(page: Page, what: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const report = results.violations.map(
    (v) =>
      `${v.id} [${v.impact}] ${v.help}\n      ` +
      v.nodes
        .slice(0, 4)
        .map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`)
        .join("\n      "),
  );
  expect(report, `accessibility violations on ${what}`).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page, what: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `horizontal overflow on ${what}`).toBeLessThanOrEqual(innerWidth);
}

async function expectComfortableTapTargets(page: Page, what: string, isMobile: boolean) {
  if (!isMobile) return;
  const tooSmall = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && !el.closest(".sr-only");
    };
    return Array.from(document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea"))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el: `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.getAttribute("name") ?? el.textContent?.trim().slice(0, 20)}]`, w: Math.round(r.width), h: Math.round(r.height) };
      })
      .filter((t) => t.w < 44 || t.h < 44);
  });
  expect(tooSmall, `controls smaller than 44x44 CSS px on ${what}`).toEqual([]);
}

/// Colours *transition* (`transition-colors`) when the theme flips, and axe would sample the in-between
/// values — once it measured #565c6a on #a8acb4, which is neither theme's colour. So wait for every
/// running CSS transition to finish first. (Only transitions: an infinite animation such as the
/// loading spinner never "finishes" and would hang this.)
async function settled(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/// Both themes, every time: the light theme is the same DOM with different token values, so a
/// contrast failure can hide in either. (Flipping `data-theme` directly is what the toggle
/// does too; it needs no reload because the colours are CSS variables.)
async function checkScreen(page: Page, what: string, isMobile: boolean) {
  // Next.js applies a page's <title> a beat after a client-side navigation, and axe's `document-title`
  // rule saw the gap once. Scan the settled page: wait until it has a title.
  await expect(page).toHaveTitle(/\S/);
  const initial = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => void (document.documentElement.dataset.theme = t), theme);
    await settled(page);
    await expect(page).toHaveTitle(/\S/); // a router.refresh() re-renders the <title> too; scan the settled page
    await expectAccessible(page, `${what} [${theme} theme]`);
    await expectNoHorizontalScroll(page, `${what} [${theme} theme]`);
  }
  await page.evaluate((t) => void (document.documentElement.dataset.theme = t), initial);
  await settled(page);
  await expectComfortableTapTargets(page, what, isMobile);
}

test.describe("sign-in screen", () => {
  test.beforeAll(async () => {
    await seedInstance();
  });

  test("idle, with validation errors, with a server error, with the password revealed", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await checkScreen(page, "/login (idle)", isMobile);

    await signInButton(page).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await checkScreen(page, "/login (validation errors)", isMobile);

    await fillCredentials(page, user.email, "not-the-password-1");
    await page.getByRole("button", { name: "Show password" }).click();
    await checkScreen(page, "/login (password revealed)", isMobile);
    await page.getByRole("button", { name: "Hide password" }).click();

    await signInButton(page).click();
    await expect(alerts(page)).toContainText("incorrect");
    await checkScreen(page, "/login (wrong-password alert)", isMobile);
  });

  test("the paused state", async ({ page, isMobile }) => {
    test.setTimeout(120_000);
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    for (let i = 0; i < 6; i++) {
      await fillCredentials(page, user.email, `wrong-password-${i}`);
      await signInButton(page).click();
      if (i < 5) await expect(alerts(page)).toContainText("incorrect");
    }
    await expect(alerts(page)).toContainText("Sign-in is paused for a moment");
    await expect(passwordField(page)).toBeVisible();
    await checkScreen(page, "/login (paused)", isMobile);
  });
});

test.describe("dashboard", () => {
  test.beforeAll(async () => {
    await seedInstance();
  });

  test("with a school, and with none", async ({ page, isMobile }) => {
    const withSchool = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, withSchool);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
    await checkScreen(page, "/dashboard (with a school)", isMobile);
  });

  test("a member of no school sees an honest empty state", async ({ page, isMobile }) => {
    const loner = await createUser({ name: "Chidi Okafor" });
    await signInThroughUi(page, loner);
    await expect(page.getByText("You're signed in, but you aren't a member of any school yet.")).toBeVisible();
    await expect(page.getByText("Ask your school administrator to invite you.")).toBeVisible();
    await checkScreen(page, "/dashboard (no school)", isMobile);
  });

  test("a long name and school name don't break the layout", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.ADMIN, name: "Oluwatobiloba Adebayo-Ogunleye-Nwosu-Abdulrahman" });
    await signInThroughUi(page, user);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
    await expectNoHorizontalScroll(page, "/dashboard (long name)");
    await checkScreen(page, "/dashboard (long name)", isMobile);
  });
});

test.describe("password reset and change screens", () => {
  test.beforeAll(async () => {
    await seedInstance();
  });

  test("/forgot-password: idle, validation error, and the confirmation", async ({ page, isMobile }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
    await checkScreen(page, "/forgot-password (idle)", isMobile);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await checkScreen(page, "/forgot-password (validation error)", isMobile);
    await page.getByLabel("Email address").fill("someone@test.example");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await checkScreen(page, "/forgot-password (sent)", isMobile);
  });

  test("/reset-password: the form, its errors, success, and the dead-link states", async ({ page, isMobile }) => {
    const user = await createUser();
    await page.goto("/forgot-password");
    await page.getByLabel("Email address").fill(user.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    const mail = await waitForMail(user.email);
    await page.goto(linkFrom(mail[0]));
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await checkScreen(page, "/reset-password (form)", isMobile);
    await page.getByLabel("New password", { exact: true }).fill("short1");
    await page.getByLabel("Confirm new password").fill("short1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/at least 8 characters/)).toBeVisible();
    await checkScreen(page, "/reset-password (error)", isMobile);
    await page.getByLabel("New password", { exact: true }).fill("a-fine-password-1");
    await page.getByLabel("Confirm new password").fill("a-fine-password-1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
    await checkScreen(page, "/reset-password (success)", isMobile);

    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
    await checkScreen(page, "/reset-password (no token)", isMobile);
  });

  test("/account with the Password card: idle, errors, success", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await checkScreen(page, "/account (idle)", isMobile);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Enter your current password.")).toBeVisible();
    await checkScreen(page, "/account (validation errors)", isMobile);
    await page.getByLabel("Current password").fill(user.password);
    await page.getByLabel("New password", { exact: true }).fill("yet-another-pass-3");
    await page.getByLabel("Confirm new password").fill("yet-another-pass-3");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Password changed" })).toBeVisible();
    await checkScreen(page, "/account (changed)", isMobile);
  });
});

test.describe("two-step verification screens", () => {
  test.beforeAll(async () => {
    await seedInstance();
  });

  const startSignIn = async (page: Page, user: { email: string; password: string }) => {
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();
  };

  test("sign-in step 2: the code, its errors, the recovery-code form", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.ADMIN });
    const { secret } = await enableMfa(user.id);
    await startSignIn(page, user);
    await checkScreen(page, "/login step 2 (code)", isMobile);

    await verifyButton(page).click();
    await expect(page.getByText("Enter your authentication code.")).toBeVisible();
    await checkScreen(page, "/login step 2 (validation error)", isMobile);

    await codeField(page).fill(codeFor(secret, 3));
    await verifyButton(page).click();
    await expect(alerts(page)).toContainText("That code isn't right");
    await checkScreen(page, "/login step 2 (wrong code)", isMobile);

    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await expect(recoveryField(page)).toBeVisible();
    await checkScreen(page, "/login step 2 (recovery code)", isMobile);
    await recoveryField(page).fill("ABCDE-FGHJK");
    await verifyButton(page).click();
    await expect(alerts(page)).toContainText("isn't right");
    await checkScreen(page, "/login step 2 (wrong recovery code)", isMobile);
  });

  test("sign-in step 2: the paused state", async ({ page, isMobile }) => {
    test.setTimeout(120_000);
    const user = await createUser({ role: Role.ADMIN });
    const { secret } = await enableMfa(user.id);
    // Ten wrong codes in the window lock the account's step 2 (five per challenge, so two challenges).
    for (let round = 0; round < 2; round++) {
      await startSignIn(page, user);
      for (let i = 0; i < 5; i++) {
        await codeField(page).fill(codeFor(secret, 3));
        await verifyButton(page).click();
        await expect(alerts(page)).toContainText("That code isn't right");
        await expect(codeField(page)).toHaveValue("");
      }
      await codeField(page).fill(codeFor(secret, 3));
      await verifyButton(page).click();
      await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    }
    await startSignIn(page, user);
    await codeField(page).fill(codeFor(secret));
    await verifyButton(page).click();
    await expect(alerts(page)).toContainText("Verification is paused for a moment");
    await checkScreen(page, "/login step 2 (paused)", isMobile);
  });

  test("/account: turning it on — password, scan, a wrong code, the recovery codes, the finished state", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.ADMIN });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(page.getByRole("button", { name: "Set up two-step verification" })).toBeVisible();
    await checkScreen(page, "/account (two-step off)", isMobile);

    await page.getByRole("button", { name: "Set up two-step verification" }).click();
    await checkScreen(page, "/account two-step (password step)", isMobile);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await checkScreen(page, "/account two-step (password error)", isMobile);

    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Continue" }).click();
    const qr = page.getByRole("img", { name: /QR code/ });
    await expect(qr).toBeVisible();
    await expect.poll(() => qr.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    await checkScreen(page, "/account two-step (scan)", isMobile);

    const key = (await page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/).textContent())!.replace(/\s/g, "");
    const secret = base32Decode(key)!;
    await codeField(page).fill(codeFor(secret, 3));
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByText(/That code isn't right/)).toBeVisible();
    await checkScreen(page, "/account two-step (scan, wrong code)", isMobile);

    await codeField(page).fill(codeFor(secret));
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
    await checkScreen(page, "/account two-step (recovery codes)", isMobile);

    await page.getByLabel("I have saved my recovery codes").check();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("10 of 10")).toBeVisible();
    await checkScreen(page, "/account two-step (on)", isMobile);
  });

  test("/account: managing it — low on codes, new codes, turning it off with its errors", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.ADMIN });
    const { secret } = await enableMfa(user.id);
    // Two recovery codes left.
    const keep = (await db.mfaRecoveryCode.findMany({ where: { userId: user.id }, take: 2, select: { id: true } })).map((r) => r.id);
    await db.mfaRecoveryCode.updateMany({ where: { userId: user.id, id: { notIn: keep } }, data: { usedAt: new Date() } });
    await startSignIn(page, user);
    await codeField(page).fill(codeFor(secret));
    await verifyButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.goto("/account");
    await expect(alerts(page)).toContainText("running low");
    await checkScreen(page, "/account two-step (on, running low)", isMobile);

    await page.getByRole("button", { name: "Generate new recovery codes" }).click();
    await page.getByRole("button", { name: "Generate new codes" }).click();
    await expect(page.getByText("Enter the 6-digit code.")).toBeVisible();
    await checkScreen(page, "/account two-step (new codes, error)", isMobile);
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Turn off two-step verification" }).click();
    await checkScreen(page, "/account two-step (turn off)", isMobile);
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await checkScreen(page, "/account two-step (turn off, errors)", isMobile);
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await checkScreen(page, "/account two-step (turn off, recovery code)", isMobile);
  });
});

test.describe("account self-service screens (profile, email, sessions)", () => {
  const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

  test("/account: profile editor (idle, editing, error), email card (form, errors, sent), sessions (alone, with others)", async ({ page, isMobile, browser }) => {
    const user = await createUser({ role: Role.ADMIN, name: "Amina Yusuf" });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(page.getByRole("list", { name: "Signed-in devices" })).toBeVisible();
    await checkScreen(page, "/account (profile + email + sessions, idle)", isMobile);

    await page.getByRole("button", { name: /^Edit name/ }).click();
    await checkScreen(page, "/account (editing the name)", isMobile);
    await page.getByLabel("Name", { exact: true }).fill("   ");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await checkScreen(page, "/account (name error)", isMobile);
    await page.getByLabel("Name", { exact: true }).fill("Amina Yusuf-Bello");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Name updated." })).toBeVisible();
    await checkScreen(page, "/account (name saved)", isMobile);

    await page.getByRole("button", { name: "Change email address" }).click();
    await checkScreen(page, "/account (change email form)", isMobile);
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText("Enter the new email address.")).toBeVisible();
    await checkScreen(page, "/account (change email, validation errors)", isMobile);
    await page.getByLabel("New email address").fill(uniqueEmail("fresh"));
    await page.getByLabel("Your password").fill("not-my-password-1");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText("Your password is incorrect.")).toBeVisible();
    await checkScreen(page, "/account (change email, wrong password)", isMobile);
    await page.getByLabel("Your password").fill(user.password);
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await checkScreen(page, "/account (change email, sent)", isMobile);

    // Sessions with another device listed.
    const other = await browser.newContext({ userAgent: IPHONE_UA, extraHTTPHeaders: { "x-real-ip": uniqueIp() } });
    await signInThroughUi(await other.newPage(), user);
    await page.reload();
    await expect(page.getByTestId("session-row")).toHaveCount(2);
    await checkScreen(page, "/account (sessions, two devices)", isMobile);
    await page.getByRole("button", { name: "Sign out of all other devices" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Signed out of 1 other device." })).toBeVisible();
    await checkScreen(page, "/account (sessions, signed others out)", isMobile);
    await other.close();
  });

  test("/confirm-email: ready, changed, link can't be used, no token", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const token = await createEmailChangeToken(user.id, uniqueEmail("fresh"));
    await page.goto(`/confirm-email#token=${token}`);
    await expect(page.getByRole("button", { name: "Confirm email address" })).toBeVisible();
    await checkScreen(page, "/confirm-email (ready)", isMobile);
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email address changed" })).toBeVisible();
    await checkScreen(page, "/confirm-email (changed)", isMobile);

    await page.goto(`/confirm-email#token=${token}`); // used already
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
    await checkScreen(page, "/confirm-email (link already used)", isMobile);

    await page.goto("/confirm-email");
    await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
    await checkScreen(page, "/confirm-email (no token)", isMobile);
  });
});

test.describe("dev email inbox widget (the staging-mode server)", () => {
  test.use({ baseURL: DEVTOOLS_URL });
  test.beforeEach(async () => {
    await fetch(`${DEVTOOLS_URL}/api/v1/dev/email-inbox`, {
      method: "DELETE",
      headers: { "x-dev-tools-token": DEV_TOOLS_TEST_TOKEN, origin: DEVTOOLS_URL, "x-real-ip": uniqueIp() },
    });
  });

  test("the launcher, the token form and its error, the empty inbox, the list and a message", async ({ page, isMobile }) => {
    const launcher = page.getByRole("button", { name: /^Dev email inbox/ });
    const dialog = page.getByRole("dialog", { name: "Dev email inbox" });
    await page.goto("/login");
    await expect(launcher).toBeVisible();
    await checkScreen(page, "/login with the dev inbox launcher", isMobile);

    await launcher.click();
    await expect(page.getByLabel("Dev tools token")).toBeVisible();
    await checkScreen(page, "dev inbox (token form)", isMobile);

    await page.getByLabel("Dev tools token").fill("not-the-token");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("That token isn't right.")).toBeVisible();
    await checkScreen(page, "dev inbox (wrong token)", isMobile);

    await page.getByLabel("Dev tools token").fill(DEV_TOOLS_TEST_TOKEN);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText(/No messages yet/)).toBeVisible();
    await checkScreen(page, "dev inbox (empty)", isMobile);

    // A list and a message, with awkward lengths: a long address, a long subject, an unbroken link.
    const now = Date.now();
    const emails = [
      { id: "a", to: "a-rather-long-address-for-a-person@some-school-with-a-long-domain-name.example.com", subject: "Reset your Octalve Edu password — and a subject long enough to need truncating in the list", text: "Someone asked to reset the password.\n\nOpen this link within 30 minutes:\nhttps://school.example.com/reset-password#token=aVeryLongTokenWithoutAnyBreaksInItAtAllAbcdefghijklmnopqrstuvwxyz0123456789\n\nIf you didn't ask, ignore this.", sentAt: new Date(now).toISOString() },
      { id: "b", to: "teacher@school.example", subject: "Two-step verification is on for your account", text: "Two-step verification was just turned on.", sentAt: new Date(now - 60_000).toISOString() },
      { id: "c", to: "admin@school.example", subject: "Your password was changed", text: "The password was changed.", sentAt: new Date(now - 120_000).toISOString() },
    ];
    await page.route("**/api/v1/dev/email-inbox", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { data: { emails, mode: "staging" }, meta: {}, error: null } })
        : route.continue(),
    );
    await launcher.click(); // close
    await launcher.click(); // open again: refreshes at once
    await expect(dialog.getByRole("listitem")).toHaveCount(3);
    await checkScreen(page, "dev inbox (list)", isMobile);

    await dialog.getByRole("listitem").first().getByRole("button").click();
    await expect(dialog.getByRole("link")).toHaveCount(1);
    await checkScreen(page, "dev inbox (message with a long link)", isMobile);
  });
});

test.describe("setup wizard screens", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test("idle, invalid input, and the success screen", async ({ page, isMobile }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Initialize this instance" })).toBeVisible();
    await checkScreen(page, "/setup (idle)", isMobile);

    await page.getByLabel("School name").fill("Bright Future Academy");
    await page.getByLabel("Administrator name").fill("Amina Yusuf");
    await page.getByLabel("Administrator email").fill("amina@brightfuture.test");
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Confirm password", { exact: true }).fill("shor");
    await expect(page.getByText("Passwords don't match.")).toBeVisible();
    await checkScreen(page, "/setup (invalid input)", isMobile);

    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery-9");
    await page.getByLabel("Confirm password", { exact: true }).fill("correct-horse-battery-9");
    await page.getByRole("button", { name: "Complete setup" }).click();
    await expect(page.getByRole("heading", { name: "Setup complete" })).toBeVisible();
    await checkScreen(page, "/setup (complete)", isMobile);
  });
});
