import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { Role, createUser, db, seedInstance, uniqueEmail, uniqueIp } from "../support/db";
import { linkFrom, mailAfterGrace, waitForMail } from "../support/outbox";
import { createEmailChangeToken } from "@/lib/auth/email-change";
import { alerts, fillCredentials, signInButton, signInThroughUi } from "./helpers";

// Self-service on the account page, in a real browser (plan §0.5.E): edit your name, change your email address
// (the link goes to the NEW address), and see / end the devices you're signed in on.

test.beforeAll(async () => {
  await seedInstance();
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";

// --- Name ---------------------------------------------------------------------------------------------------

test.describe("edit your name", () => {
  test("Edit → type → Save: shown at once, persisted, the header follows, focus returns to Edit", async ({ page, isMobile }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF, name: "Old Name" });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(page.getByTestId("profile-name")).toHaveText("Old Name");

    await page.getByRole("button", { name: /^Edit name/ }).click();
    const field = page.getByLabel("Name", { exact: true });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Old Name");
    await field.fill("  Ọlámidé   Adéṣànyà ");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("status").filter({ hasText: "Name updated." })).toBeVisible();
    await expect(page.getByTestId("profile-name")).toHaveText("Ọlámidé Adéṣànyà"); // trimmed and collapsed, as stored
    await expect(page.getByRole("button", { name: /^Edit name/ })).toBeFocused();
    if (!isMobile) await expect(page.getByRole("banner").getByText("Ọlámidé Adéṣànyà")).toBeVisible(); // router.refresh()
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBe("Ọlámidé Adéṣànyà");

    await page.reload();
    await expect(page.getByTestId("profile-name")).toHaveText("Ọlámidé Adéṣànyà");
  });

  test("Cancel and Escape change nothing and send nothing; an unchanged Save sends nothing either", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF, name: "Keep Me" });
    await signInThroughUi(page, user);
    await page.goto("/account");
    const writes: string[] = [];
    page.on("request", (r) => r.url().endsWith("/account/profile") && writes.push(r.method()));

    await page.getByRole("button", { name: /^Edit name/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("Throwaway");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("profile-name")).toHaveText("Keep Me");
    await expect(page.getByRole("button", { name: /^Edit name/ })).toBeFocused();

    await page.getByRole("button", { name: /^Edit name/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("Throwaway");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("profile-name")).toHaveText("Keep Me");

    await page.getByRole("button", { name: /^Edit name/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("  Keep   Me ");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("profile-name")).toHaveText("Keep Me");
    expect(writes).toHaveLength(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBe("Keep Me");
  });

  test("an empty or forbidden name is explained next to the field, with nothing sent", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF, name: "Keep Me" });
    await signInThroughUi(page, user);
    await page.goto("/account");
    const writes: string[] = [];
    page.on("request", (r) => r.url().endsWith("/account/profile") && writes.push(r.method()));

    await page.getByRole("button", { name: /^Edit name/ }).click();
    await page.getByLabel("Name", { exact: true }).fill("   ");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Name", { exact: true }).fill("Amina‮Yusuf");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("That name contains characters that can't be used.")).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("a".repeat(101));
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Use at most 100 characters.")).toBeVisible();
    expect(writes).toHaveLength(0);
  });
});

// --- Change email ------------------------------------------------------------------------------------------

const newEmailField = (page: Page) => page.getByLabel("New email address");
// (Labelled "Your password", not "Current password": the Password card on the same page already has that label.)
const currentPasswordField = (page: Page) => page.getByLabel("Your password");

async function requestChange(page: Page, user: { password: string }, newEmail: string) {
  await page.goto("/account");
  await page.getByRole("button", { name: "Change email address" }).click();
  await expect(page.getByRole("heading", { name: "Change your email address" })).toBeFocused();
  await newEmailField(page).fill(newEmail);
  await currentPasswordField(page).fill(user.password);
  await page.getByRole("button", { name: "Send confirmation link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeFocused();
}

test.describe("change your email address", () => {
  test("the whole journey: request → mail to the NEW address → confirm → signed out everywhere → the new address signs in", async ({ page, browser }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const newEmail = uniqueEmail("fresh");
    // Signed in on another device.
    const other = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": uniqueIp() } });
    const otherPage = await other.newPage();
    await signInThroughUi(otherPage, user);
    await signInThroughUi(page, user);

    await requestChange(page, user, newEmail);
    await expect(page.getByText(newEmail)).toBeVisible();
    // Nothing has changed yet: the old address is still the account's.
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);

    const link = linkFrom((await waitForMail(newEmail))[0]);
    await waitForMail(user.email); // the old address was told

    // Opening the link does NOT act: it shows what will happen and waits for a click (scanners open links).
    const posts: string[] = [];
    page.on("request", (r) => r.url().endsWith("/email-change/confirm") && posts.push(r.method()));
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Confirm your new email address" })).toBeVisible();
    await expect.poll(() => page.url()).not.toContain("token"); // the secret leaves the address bar
    expect(page.url()).toMatch(/\/confirm-email$/);
    expect(posts).toHaveLength(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);

    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email address changed" })).toBeFocused();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(newEmail);

    // Signed out everywhere: this browser…
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login$/);
    // …and the other device.
    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/login$/);
    await other.close();

    // The old address no longer signs in; the new one does, with the same password.
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(alerts(page)).toContainText("incorrect");
    await fillCredentials(page, newEmail, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("the success screen links to sign-in", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const newEmail = uniqueEmail("fresh");
    await signInThroughUi(page, user);
    await requestChange(page, user, newEmail);
    await page.goto(linkFrom((await waitForMail(newEmail))[0]));
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await page.getByRole("link", { name: "Continue to sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a link that was already used, and a link with no token, say so and offer a way on", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const newEmail = uniqueEmail("fresh");
    await signInThroughUi(page, user);
    await requestChange(page, user, newEmail);
    const link = linkFrom((await waitForMail(newEmail))[0]);
    await page.goto(link);
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email address changed" })).toBeVisible();

    await page.goto(link); // the same link again
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeFocused();
    await expect(alerts(page)).toContainText("invalid or has expired");

    await page.goto("/confirm-email"); // no token at all
    await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
    await expect(alerts(page)).toContainText("incomplete");
    await expect(page.getByRole("link", { name: "Go to your account" })).toBeVisible();
  });

  test("a second link opened in the SAME tab replaces the first (only the fragment changes, so the page must notice)", async ({ page }) => {
    const first = await createUser({ role: Role.TEACHING_STAFF });
    const second = await createUser({ role: Role.TEACHING_STAFF });
    const firstNew = uniqueEmail("one");
    const secondNew = uniqueEmail("two");
    const firstToken = await createEmailChangeToken(first.id, firstNew);
    const secondToken = await createEmailChangeToken(second.id, secondNew);

    await page.goto(`/confirm-email#token=${firstToken}`);
    await expect(page.getByRole("button", { name: "Confirm email address" })).toBeVisible();
    await page.goto(`/confirm-email#token=${secondToken}`); // same document: only the hash differs
    await expect(page.getByRole("button", { name: "Confirm email address" })).toBeVisible();
    await expect.poll(() => page.url()).not.toContain("token");
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email address changed" })).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id: second.id } })).email).toBe(secondNew);
    expect((await db.user.findUniqueOrThrow({ where: { id: first.id } })).email).toBe(first.email); // the first link was NOT the one used
  });

  test("the form checks locally and sends nothing for a blank/malformed address or a missing password", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    await page.goto("/account");
    const sent: string[] = [];
    page.on("request", (r) => r.url().endsWith("/email-change/request") && sent.push(r.method()));

    await page.getByRole("button", { name: "Change email address" }).click();
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText("Enter the new email address.")).toBeVisible();
    await expect(page.getByText("Enter your current password.")).toBeVisible();
    await newEmailField(page).fill("nope");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    expect(sent).toHaveLength(0);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Change email address" })).toBeFocused();
  });

  test("a wrong password is explained at the password field; the password is cleared; the address kept", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const newEmail = uniqueEmail("fresh");
    await signInThroughUi(page, user);
    await page.goto("/account");
    await page.getByRole("button", { name: "Change email address" }).click();
    await newEmailField(page).fill(newEmail);
    await currentPasswordField(page).fill("not-my-password-1");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText("Your password is incorrect.")).toBeVisible();
    await expect(currentPasswordField(page)).toHaveValue("");
    await expect(newEmailField(page)).toHaveValue(newEmail);
    expect(await mailAfterGrace(newEmail, 1000)).toHaveLength(0);
  });

  test("your own address is refused; an address that already has an account looks exactly like success", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const taken = await createUser();
    await signInThroughUi(page, user);
    await page.goto("/account");
    await page.getByRole("button", { name: "Change email address" }).click();
    await newEmailField(page).fill(user.email);
    await currentPasswordField(page).fill(user.password);
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText("That is already your email address.")).toBeVisible();

    await newEmailField(page).fill(taken.email);
    await currentPasswordField(page).fill(user.password);
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await expect(page.getByText(/If .* can be used, a confirmation link is on its way/)).toBeVisible(); // not "sent"; not "taken"
    // …while the other person is told, and no link goes to them.
    const [notice] = await waitForMail(taken.email);
    expect(notice.text).not.toContain("#token=");
    expect(await db.emailChangeToken.count({ where: { userId: user.id } })).toBe(0);
  });
});

// --- Sessions ----------------------------------------------------------------------------------------------

test.describe("active sessions", () => {
  async function device(browser: import("@playwright/test").Browser, user: { email: string; password: string }, userAgent: string) {
    const context = await browser.newContext({ userAgent, extraHTTPHeaders: { "x-real-ip": uniqueIp() } });
    const page = await context.newPage();
    await signInThroughUi(page, user);
    return { context, page };
  }
  const list = (page: Page) => page.getByRole("list", { name: "Signed-in devices" });
  const rows = (page: Page) => list(page).getByTestId("session-row");

  test("lists this device first, then the others, each described by browser and system", async ({ page, browser }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const phone = await device(browser, user, IPHONE_UA);
    await signInThroughUi(page, user);
    await page.goto("/account");

    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first()).toContainText("This device");
    await expect(rows(page).first()).not.toContainText("Sign out");
    await expect(rows(page).nth(1)).toContainText("Safari on iPhone");
    await expect(rows(page).nth(1)).not.toContainText("This device");
    await expect(rows(page).nth(1)).toContainText(/Signed in (just now|\d+ minutes? ago)/);
    await expect(page.getByRole("button", { name: "Sign out of all other devices" })).toBeVisible();
    await phone.context.close();
  });

  test("Sign out on one row ends THAT device only; the list updates and says what happened", async ({ page, browser }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const phone = await device(browser, user, IPHONE_UA);
    const laptop = await device(browser, user, FIREFOX_UA);
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(rows(page)).toHaveCount(3);

    await page.getByRole("button", { name: /^Sign out Safari on iPhone/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Signed out of Safari on iPhone." })).toBeVisible();
    await expect(rows(page)).toHaveCount(2);
    await expect(list(page)).not.toContainText("Safari on iPhone");

    await phone.page.reload();
    await expect(phone.page).toHaveURL(/\/login$/); // that device is out…
    await laptop.page.reload();
    await expect(laptop.page).toHaveURL(/\/account$|\/dashboard$/); // …the other is not
    await phone.context.close();
    await laptop.context.close();
  });

  test("Sign out of all other devices ends every other one, keeps this one, and the button goes away", async ({ page, browser }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const phone = await device(browser, user, IPHONE_UA);
    const laptop = await device(browser, user, FIREFOX_UA);
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(rows(page)).toHaveCount(3);

    await page.getByRole("button", { name: "Sign out of all other devices" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Signed out of 2 other devices." })).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Sign out of all other devices" })).toHaveCount(0);
    await expect(page.getByText("You're not signed in anywhere else.")).toBeVisible();

    for (const other of [phone, laptop]) {
      await other.page.reload();
      await expect(other.page).toHaveURL(/\/login$/);
      await other.context.close();
    }
    await page.reload(); // this one is still signed in
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  });

  test("a device already ended elsewhere is simply removed from the list (no error)", async ({ page, browser }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const phone = await device(browser, user, IPHONE_UA);
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(rows(page)).toHaveCount(2);
    await db.session.deleteMany({ where: { userId: user.id, userAgent: IPHONE_UA } }); // it signed out on its own, meanwhile
    await page.getByRole("button", { name: /^Sign out Safari on iPhone/ }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(alerts(page)).toHaveCount(0);
    await phone.context.close();
  });
});
