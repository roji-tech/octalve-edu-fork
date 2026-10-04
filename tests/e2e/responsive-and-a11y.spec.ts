import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { Role, createUser, resetDatabase, seedInstance } from "./../support/db";
import { linkFrom, waitForMail } from "../support/outbox";
import { alerts, fillCredentials, passwordField, signInButton, signInThroughUi } from "./helpers";

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
