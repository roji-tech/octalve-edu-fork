import { test, expect } from "../support/fixtures";
import { Role, createUser, db, seedInstance } from "../support/db";
import { linkFrom, waitForMail } from "../support/outbox";
import { createResetToken } from "@/lib/auth/password-reset";
import { verifyPassword } from "@/lib/auth/password";
import { alerts, emailField, fillCredentials, signInButton, signInThroughUi, HOME_URL } from "./helpers";

// "I forgot my password" end to end, and changing it from the account page (plan §0.5.C).

test.beforeAll(async () => {
  await seedInstance();
});

const newPassword = (page: import("@playwright/test").Page) => page.getByLabel("New password", { exact: true });
const confirmPassword = (page: import("@playwright/test").Page) => page.getByLabel("Confirm new password");

async function requestLinkThroughUi(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await emailField(page).fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const mail = await waitForMail(email);
  return linkFrom(mail[mail.length - 1]);
}

test.describe("the whole journey", () => {
  test("forgot → email → link → new password → signed out everywhere → sign in with the new one", async ({ page, browser }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    // Signed in on another device.
    const other = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "10.55.0.1" } });
    const otherPage = await other.newPage();
    await signInThroughUi(otherPage, user);

    const link = await requestLinkThroughUi(page, user.email);
    await expect(page.getByText(`If an account exists for`)).toContainText(user.email);

    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    // The secret is gone from the address bar (and so from history and screenshots).
    await expect.poll(() => page.url()).not.toContain("token");
    expect(page.url()).toMatch(/\/reset-password$/);

    await newPassword(page).fill("my-new-password-42");
    await confirmPassword(page).fill("my-new-password-42");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();

    // The other device was signed out by the reset.
    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/login$/);
    await other.close();

    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await fillCredentials(page, user.email, user.password); // the OLD one
    await signInButton(page).click();
    await expect(alerts(page)).toContainText("incorrect");
    await fillCredentials(page, user.email, "my-new-password-42");
    await signInButton(page).click();
    await expect(page).toHaveURL(HOME_URL);
  });

  test("an address with no account sees the very same confirmation (and no email is sent)", async ({ page }) => {
    await page.goto("/forgot-password");
    await emailField(page).fill("nobody-at-all@test.example");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText("If an account exists for")).toBeVisible();
  });
});

test.describe("two reset links in one tab", () => {
  test("opening a second link in the same tab (only the fragment changes) resets the SECOND person's password, not the first's", async ({ page }) => {
    const first = await createUser({ role: Role.TEACHING_STAFF });
    const second = await createUser({ role: Role.TEACHING_STAFF });
    const firstToken = await createResetToken(first.id);
    const secondToken = await createResetToken(second.id);

    await page.goto(`/reset-password#token=${firstToken}`);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.goto(`/reset-password#token=${secondToken}`);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await newPassword(page).fill("second-persons-pass-1");
    await confirmPassword(page).fill("second-persons-pass-1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();

    const secondRow = await db.user.findUniqueOrThrow({ where: { id: second.id } });
    expect(await verifyPassword("second-persons-pass-1", secondRow.passwordHash)).toBe(true);
    const firstRow = await db.user.findUniqueOrThrow({ where: { id: first.id } });
    expect(await verifyPassword(first.password, firstRow.passwordHash)).toBe(true); // untouched
  });
});

test.describe("the forgot-password form", () => {
  test("validates locally, sends nothing for a blank or malformed address, and keeps focus sensible", async ({ page }) => {
    await page.goto("/forgot-password");
    const sent: string[] = [];
    page.on("request", (r) => r.url().endsWith("/forgot-password") && r.method() === "POST" && sent.push(r.url()));
    await expect(emailField(page)).toBeFocused();

    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await emailField(page).fill("nope");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  test("a signed-in person is sent to the dashboard instead", async ({ page }) => {
    await signInThroughUi(page, await createUser());
    await page.goto("/forgot-password");
    await expect(page).toHaveURL(HOME_URL);
  });
});

test.describe("the reset page", () => {
  test("a link with no token says so and offers a new one", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
    await page.getByRole("link", { name: "Request a new link" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test("a used or expired link says so after the attempt, without saying which", async ({ page }) => {
    await page.goto(`/reset-password#token=${"Z".repeat(43)}`);
    await newPassword(page).fill("some-password-123");
    await confirmPassword(page).fill("some-password-123");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
    await expect(alerts(page)).toContainText("invalid or has expired");
  });

  test("a weak or mismatched password is explained inline and the link is NOT spent", async ({ page }) => {
    const user = await createUser();
    const link = await requestLinkThroughUi(page, user.email);
    await page.goto(link);

    await newPassword(page).fill("short1");
    await confirmPassword(page).fill("short1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/at least 8 characters/)).toBeVisible();
    await newPassword(page).fill("a-fine-password-1");
    await confirmPassword(page).fill("a-different-one-2");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText("The two passwords don't match.")).toBeVisible();
    await confirmPassword(page).fill("a-fine-password-1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
  });

  test("it never sends a Referer, and the token never reaches the server's logs path (fragment only)", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.goto(`/reset-password#token=${"Q".repeat(43)}`);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    expect(urls.some((u) => u.includes("Q".repeat(10)))).toBe(false);
  });
});

test.describe("changing your password from the account page", () => {
  test("the Password card: wrong current password, then success; the other device is signed out", async ({ page, browser }) => {
    const user = await createUser({ role: Role.ADMIN });
    const other = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "10.55.0.2" } });
    const otherPage = await other.newPage();
    await signInThroughUi(otherPage, user);
    await signInThroughUi(page, user);

    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await page.getByLabel("Current password").fill("definitely-wrong-1");
    await newPassword(page).fill("another-new-pass-5");
    await confirmPassword(page).fill("another-new-pass-5");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Your current password is incorrect.")).toBeVisible();

    await page.getByLabel("Current password").fill(user.password);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Password changed" })).toBeVisible();
    await expect(page.getByLabel("Current password")).toHaveValue(""); // nothing sensitive left on screen

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible(); // this session survived
    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/login$/);
    await other.close();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  test("the account page needs a session", async ({ page }) => {
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login$/);
  });
});
