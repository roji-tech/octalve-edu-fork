import { test, expect } from "../support/fixtures";
import { db, resetDatabase } from "../support/db";
import { alertWith, emailField, fillCredentials, passwordField, signInButton, HOME_URL } from "./helpers";

// The journey a brand-new deployer actually takes: empty install -> setup
// wizard -> sign in -> dashboard. Every test starts from a genuinely empty
// database, one after another (serial), because the wizard disables itself.
test.describe.configure({ mode: "serial" });
test.beforeEach(async () => {
  await resetDatabase();
});

const ADMIN = { name: "Amina Yusuf", email: "Amina@BrightFuture.test", password: "correct-horse-battery-9" };

const schoolName = (page: import("@playwright/test").Page) => page.getByLabel("School name");
const adminName = (page: import("@playwright/test").Page) => page.getByLabel("Administrator name");
const adminEmail = (page: import("@playwright/test").Page) => page.getByLabel("Administrator email");
const password = (page: import("@playwright/test").Page) => page.getByLabel("Password", { exact: true });
const confirm = (page: import("@playwright/test").Page) => page.getByLabel("Confirm password", { exact: true });
const complete = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Complete setup" });

async function fillWizard(page: import("@playwright/test").Page, pw = ADMIN.password) {
  await schoolName(page).fill("Bright Future Academy");
  await adminName(page).fill(ADMIN.name);
  await adminEmail(page).fill(ADMIN.email);
  await password(page).fill(pw);
  await confirm(page).fill(pw);
}

test.describe("a fresh install routes everyone to setup", () => {
  test("/, /login and /dashboard all end at /setup — never a sign-in form that cannot succeed", async ({ page }) => {
    for (const path of ["/", "/login", "/dashboard"]) {
      await page.goto(path);
      await expect(page, `from ${path}`).toHaveURL(/\/setup$/);
    }
    await expect(page.getByRole("heading", { name: "Initialize this instance" })).toBeVisible();
  });

  test("the wizard form is method=post, so a native submit could never put the administrator's password in the URL", async ({ page }) => {
    // (Without JavaScript the submit button is server-rendered disabled, so a native submit
    // can't be provoked here — this pins the attribute that makes it safe if that ever changes.)
    await page.goto("/setup");
    await expect(page.locator("form")).toHaveAttribute("method", "post");
  });

  test("on a plain-HTTP production build the wizard says so (sessions unprotected in transit)", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByText("This instance isn't served over HTTPS")).toBeVisible();
  });
});

test.describe("the wizard gives live, accessible feedback", () => {
  test("Complete stays disabled until everything is valid; the checklist and mismatch error update as you type", async ({ page }) => {
    await page.goto("/setup");
    await expect(complete(page)).toBeDisabled();

    const requirements = page.getByRole("list", { name: "Password requirements" });
    await expect(requirements).toContainText("At least 8 characters — not met yet");
    await expect(requirements).toContainText("Passwords match — not met yet");

    await password(page).fill("abc");
    await expect(requirements).toContainText("At least 8 characters — not met yet");
    await password(page).fill("correct-horse-battery-9");
    await expect(requirements).toContainText("At least 8 characters — met");
    await expect(requirements).toContainText("Contains both letters and numbers — met");

    await confirm(page).fill("something-different-1");
    await expect(page.getByText("Passwords don't match.")).toBeVisible();
    await expect(confirm(page)).toHaveAttribute("aria-invalid", "true");
    await expect(complete(page)).toBeDisabled();

    await schoolName(page).fill("Bright Future Academy");
    await adminName(page).fill(ADMIN.name);
    await adminEmail(page).fill(ADMIN.email);
    await confirm(page).fill("correct-horse-battery-9");
    await expect(requirements).toContainText("Passwords match — met");
    await expect(complete(page)).toBeEnabled();
  });

  test("a password over bcrypt's 72-BYTE limit is flagged as you type, in plain words, and blocks submit", async ({ page }) => {
    await page.goto("/setup");
    // 27 characters — looks short — but 25 emoji are 100 bytes.
    await fillWizard(page, `a1${"😀".repeat(25)}`);
    await expect(page.getByText(/Too long — at most 72 bytes/)).toBeVisible();
    await expect(complete(page)).toBeDisabled();

    await fillWizard(page, ADMIN.password);
    await expect(page.getByText(/Too long/)).toHaveCount(0);
    await expect(complete(page)).toBeEnabled();
  });

  test("show/hide works on both password fields independently", async ({ page }) => {
    await page.goto("/setup");
    await password(page).fill("correct-horse-battery-9");
    await page.getByRole("button", { name: "Show password" }).first().click();
    await expect(password(page)).toHaveAttribute("type", "text");
    await expect(confirm(page)).toHaveAttribute("type", "password");
  });

  test("a server-side refusal is shown and the form stays usable", async ({ page }) => {
    await page.goto("/setup");
    await fillWizard(page);
    await page.route("**/api/v1/setup", (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ data: null, meta: {}, error: { code: "ALREADY_COMPLETE", message: "Setup has already been completed." } }) }),
    );
    await complete(page).click();
    await expect(alertWith(page, "Setup has already been completed.")).toBeVisible();
    await expect(complete(page)).toBeEnabled();
    await expect(schoolName(page)).toHaveValue("Bright Future Academy"); // nothing lost
  });
});

test.describe("setup -> sign in -> dashboard", () => {
  test("the whole hand-off works, with no surprise timed redirect, and the wizard is gone afterwards", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await fillWizard(page);
    await complete(page).click();

    await expect(page.getByRole("heading", { name: "Setup complete" })).toBeVisible();
    await expect(page.getByText("amina@brightfuture.test")).toBeVisible(); // normalised to lowercase
    await expect(page.getByText("permanently disabled")).toBeVisible();

    // An unrequested timed navigation fails WCAG 2.2.1 (timing adjustable): the
    // user moves on only when they choose to.
    await page.waitForTimeout(4500);
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("button", { name: "Continue to sign in" })).toBeFocused();

    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await fillCredentials(page, ADMIN.email, ADMIN.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(HOME_URL);
    await expect(page.getByRole("heading", { name: "Welcome, Amina" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Bright Future Academy" })).toBeVisible();
    await expect(page.getByRole("main").getByText("Administrator")).toBeVisible();
    await expect(page.getByRole("main").getByText("bright-future-academy")).toBeVisible();

    // What the wizard wrote is exactly what the UI showed.
    const admin = await db.user.findUniqueOrThrow({ where: { email: "amina@brightfuture.test" } });
    expect(admin.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await db.tenantMembership.count({ where: { userId: admin.id, role: "ADMIN" } })).toBe(1);
  });

  test("once set up, /setup is permanently closed: it sends a signed-out visitor to /login", async ({ page }) => {
    await page.goto("/setup");
    await fillWizard(page);
    await complete(page).click();
    await expect(page.getByRole("heading", { name: "Setup complete" })).toBeVisible();

    await page.goto("/setup");
    await expect(page).toHaveURL(/\/login$/);
    await expect(emailField(page)).toBeVisible();
    await expect(passwordField(page)).toBeVisible();
  });

  test("setting up twice from two browsers: the second gets a clear refusal, not a second admin", async ({ page, browser }) => {
    await page.goto("/setup");
    const other = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "10.88.0.9" } });
    const otherPage = await other.newPage();
    try {
      await otherPage.goto("/setup");
      await fillWizard(otherPage);
      await fillWizard(page);
      await complete(page).click();
      await expect(page.getByRole("heading", { name: "Setup complete" })).toBeVisible();

      await complete(otherPage).click(); // the wizard the second person still has open
      await expect(alertWith(otherPage, "Setup has already been completed")).toBeVisible();
      expect(await db.user.count()).toBe(1);
      expect(await db.tenant.count()).toBe(1);
    } finally {
      await other.close();
    }
  });
});
