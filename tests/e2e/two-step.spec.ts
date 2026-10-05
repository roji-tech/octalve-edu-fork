import fs from "node:fs/promises";
import jsQR from "jsqr";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { Role, codeFor, createUser, db, enableMfa, rewindMfa, seedInstance } from "../support/db";
import { base32Decode } from "@/lib/auth/mfa/base32";
import { alerts, codeField, fillCredentials, keepSignedInBox, mfaHeading, passwordField, recoveryField, signInButton, signInThroughUi, signInWithSecondFactor, signOut, verifyButton, HOME_URL } from "./helpers";

// Two-step verification in a real browser (plan §0.5.D): turning it on, signing in with it, losing the
// authenticator, turning it off. Codes are computed by the test from the secret the page shows — exactly what
// an authenticator app does.

test.beforeAll(async () => {
  await seedInstance();
});

const setUpButton = (page: Page) => page.getByRole("button", { name: "Set up two-step verification" });
const RECOVERY_ITEM = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

/// Drives the account page through enrolment; leaves the recovery-codes screen open and returns what the
/// authenticator would hold and the codes shown.
async function enrol(page: Page, user: { password: string }) {
  await page.goto("/account");
  await setUpButton(page).click();
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toBeVisible();
  const key = (await page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/).textContent())!.replace(/\s/g, "");
  const secret = base32Decode(key)!;
  await codeField(page).fill(codeFor(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const recoveryCodes = await page.getByRole("listitem").filter({ hasText: RECOVERY_ITEM }).allTextContents();
  return { secret, recoveryCodes };
}

async function finishRecoveryCodes(page: Page) {
  await page.getByLabel("I have saved my recovery codes").check();
  await page.getByRole("button", { name: "Done" }).click();
}

test.describe("the whole journey", () => {
  test("turn it on → sign out → sign in needs the code → turn it off", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
    await expect(page.getByText("Off", { exact: true })).toBeVisible();

    // Step 1: the password.
    await setUpButton(page).click();
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2: the QR code and the key; then a code.
    await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toBeFocused();
    await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
    const key = (await page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/).textContent())!.replace(/\s/g, "");
    const secret = base32Decode(key)!;
    await codeField(page).fill(codeFor(secret));
    await page.getByRole("button", { name: "Turn on" }).click();

    // Step 3: the recovery codes, shown once; you can't leave until you say you saved them.
    await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Two-step verification is on" })).toBeVisible();
    const codes = await page.getByRole("listitem").filter({ hasText: RECOVERY_ITEM }).allTextContents();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
    await finishRecoveryCodes(page);
    await expect(page.getByText("10 of 10")).toBeVisible();
    await expect(page.getByText("On", { exact: true })).toBeVisible();
    // They are never shown again.
    await page.reload();
    await expect(page.getByText(RECOVERY_ITEM)).toHaveCount(0);
    await expect(page.getByText("10 of 10")).toBeVisible();

    // Signing in now takes two steps.
    await signOut(page);
    await expect(page).toHaveURL(/\/login$/);
    await rewindMfa(user.id); // time passes (the confirming code's step is spent)
    await signInWithSecondFactor(page, user, { code: codeFor(secret) });

    // Turning it off needs the password and a code.
    await page.goto("/account");
    await page.getByRole("button", { name: "Turn off two-step verification" }).click();
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await rewindMfa(user.id);
    await codeField(page).fill(codeFor(secret));
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Two-step verification is off" })).toBeVisible();
    await expect(setUpButton(page)).toBeVisible();

    await signOut(page);
    await signInThroughUi(page, user); // single step again
  });

  test("the QR code really encodes the key shown beside it (decoded here, as a phone would)", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await setUpButton(page).click();
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Continue" }).click();

    const img = page.getByRole("img", { name: /QR code/ });
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    const image = await img.evaluate((el: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(el, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(data), width, height };
    });
    const decoded = jsQR(Uint8ClampedArray.from(image.data), image.width, image.height);
    expect(decoded, "the QR code could not be decoded").not.toBeNull();
    const url = new URL(decoded!.data);
    expect(url.protocol).toBe("otpauth:");
    const key = (await page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/).textContent())!.replace(/\s/g, "");
    expect(url.searchParams.get("secret")).toBe(key);
    expect(decodeURIComponent(url.pathname)).toContain(user.email);
  });

  test("reloading mid-setup leaves nothing half-on: it is still off, and the secret is not in the page's storage", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await setUpButton(page).click();
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Continue" }).click();
    const key = (await page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/).textContent())!.replace(/\s/g, "");

    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    expect(stored).not.toContain(key);
    expect(page.url()).not.toContain(key);

    await page.reload();
    await expect(setUpButton(page)).toBeVisible();
    expect(await db.mfaCredential.count({ where: { userId: user.id, confirmedAt: { not: null } } })).toBe(0);
  });

  test("cancelling at either step changes nothing", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await setUpButton(page).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(setUpButton(page)).toBeVisible();

    await setUpButton(page).click();
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(setUpButton(page)).toBeVisible();
    expect(await db.mfaCredential.count({ where: { userId: user.id, confirmedAt: { not: null } } })).toBe(0);
  });
});

test.describe("setting it up — mistakes", () => {
  test("a wrong password is explained under the field and starts nothing", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await setUpButton(page).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("not-my-password-1");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Your password is incorrect.")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(0);
  });

  test("a wrong or malformed code is explained and nothing is turned on", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    await page.goto("/account");
    await setUpButton(page).click();
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Continue" }).click();
    const key = (await page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/).textContent())!.replace(/\s/g, "");

    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByText("Enter the 6-digit code.")).toBeVisible();
    await codeField(page).fill("12ab");
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByText("Enter the 6-digit code from your authenticator app.", { exact: true })).toBeVisible();
    await codeField(page).fill(codeFor(base32Decode(key)!, 3));
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByText(/That code isn't right/)).toBeVisible();
    expect(await db.mfaCredential.count({ where: { userId: user.id, confirmedAt: { not: null } } })).toBe(0);
  });
});

test.describe("signing in — step 2", () => {
  test("arrives focused on the code field; Enter submits; the rest of the page tells you what is going on", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { secret } = await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();

    await expect(mfaHeading(page)).toBeVisible();
    await expect(codeField(page)).toBeFocused();
    await expect(page.getByText("Open your authenticator app")).toBeVisible();
    await expect(passwordField(page)).toHaveCount(0); // the password step is gone, not hidden
    await page.keyboard.type(codeFor(secret));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(HOME_URL);
  });

  test("nothing about step 2 survives a reload or lands in storage or the URL: it starts again at the password", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();

    const challenge = (await db.mfaChallenge.findFirstOrThrow({ where: { userId: user.id } })).tokenHash;
    expect(challenge).toBeTruthy();
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    expect(stored).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(page.url()).toMatch(/\/login$/);

    await page.reload();
    await expect(passwordField(page)).toBeVisible();
    await expect(mfaHeading(page)).toHaveCount(0);
  });

  test("a wrong code is explained, the field is emptied and focused, and a right one then works", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { secret } = await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();

    await codeField(page).fill(codeFor(secret, 3));
    await verifyButton(page).click();
    await expect(alerts(page)).toContainText("That code isn't right");
    await expect(codeField(page)).toHaveValue("");
    await expect(codeField(page)).toBeFocused();

    await codeField(page).fill(codeFor(secret));
    await verifyButton(page).click();
    await expect(page).toHaveURL(HOME_URL);
  });

  test("a code that is the wrong shape is caught before any request is made", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();
    const sent: string[] = [];
    page.on("request", (r) => r.url().endsWith("/login/mfa") && sent.push(r.url()));

    await verifyButton(page).click();
    await expect(page.getByText("Enter your authentication code.")).toBeVisible();
    await codeField(page).fill("12345");
    await verifyButton(page).click();
    await expect(page.getByText("Enter the 6-digit code from your authenticator app.", { exact: true })).toBeVisible();
    expect(sent).toEqual([]);
  });

  test("lost your authenticator: a recovery code signs you in — once; the second use is explained", async ({ page, browser }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { recoveryCodes } = await enableMfa(user.id);
    await signInWithSecondFactor(page, user, { recoveryCode: recoveryCodes[0].toLowerCase() });

    const second = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "10.77.0.2" } });
    const page2 = await second.newPage();
    await page2.goto("/login");
    await fillCredentials(page2, user.email, user.password);
    await signInButton(page2).click();
    await page2.getByRole("button", { name: "Use a recovery code instead" }).click();
    await expect(recoveryField(page2)).toBeFocused();
    await recoveryField(page2).fill(recoveryCodes[0]);
    await verifyButton(page2).click();
    await expect(alerts(page2)).toContainText("isn't right, or it has already been used");
    await recoveryField(page2).fill(recoveryCodes[1]);
    await verifyButton(page2).click();
    await expect(page2).toHaveURL(HOME_URL);
    await second.close();
  });

  test("the toggle switches between the two kinds of code and back, and keeps the person on the same step", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(codeField(page)).toBeVisible();
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await expect(recoveryField(page)).toBeVisible();
    await expect(codeField(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Use your authenticator app instead" }).click();
    await expect(codeField(page)).toBeVisible();
    await expect(mfaHeading(page)).toBeVisible();
  });

  test("'Back to sign in' returns to the password step with the email kept, the password empty and the caret in it", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();
    await page.getByRole("button", { name: "Back to sign in" }).click();

    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveValue(user.email);
    await expect(passwordField(page)).toHaveValue("");
    await expect(passwordField(page)).toBeFocused();
  });

  test("an expired challenge sends the person back to the password with a clear message", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { secret } = await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();

    await db.mfaChallenge.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await codeField(page).fill(codeFor(secret));
    await verifyButton(page).click();
    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    await expect(alerts(page)).toContainText("timed out");
    await expect(passwordField(page)).toBeFocused();
  });

  test("five wrong codes use the challenge up: the sixth try says so and starts over at the password", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { secret } = await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();
    for (let i = 0; i < 5; i++) {
      await codeField(page).fill(codeFor(secret, 3));
      await verifyButton(page).click();
      await expect(alerts(page)).toContainText("That code isn't right");
      await expect(codeField(page)).toHaveValue("");
    }
    await codeField(page).fill(codeFor(secret));
    await verifyButton(page).click();
    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    await expect(alerts(page)).toContainText("ran out of attempts");
  });

  test("'Keep me signed in' ticked at the password step is honoured after step 2 (persistent cookie); unticked is a session cookie", async ({ page, context }) => {
    const remembered = await createUser({ role: Role.TEACHING_STAFF });
    const rm = await enableMfa(remembered.id);
    await signInWithSecondFactor(page, remembered, { code: codeFor(rm.secret) }, { remember: true });
    const persistent = (await context.cookies()).find((c) => c.name === "octalve.session-token")!;
    expect(persistent.expires).toBeGreaterThan(Date.now() / 1000 + 60 * 24 * 3600);

    await context.clearCookies();
    const plain = await createUser({ role: Role.TEACHING_STAFF });
    const pm = await enableMfa(plain.id);
    await signInWithSecondFactor(page, plain, { code: codeFor(pm.secret) });
    const session = (await context.cookies()).find((c) => c.name === "octalve.session-token")!;
    expect(session.expires).toBe(-1);
    expect(await keepSignedInBox(page).count()).toBe(0); // (we are on the dashboard now)
  });

  test("a password-only attempt never reaches the dashboard: going there directly sends you to sign in", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await enableMfa(user.id);
    await page.goto("/login");
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(mfaHeading(page)).toBeVisible();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("managing it — recovery codes and turning it off", () => {
  test("generating new recovery codes shows ten fresh ones and kills the old ones", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    const { secret, recoveryCodes: old } = await enrol(page, user);
    await finishRecoveryCodes(page);

    await page.getByRole("button", { name: "Generate new recovery codes" }).click();
    await rewindMfa(user.id);
    await codeField(page).fill(codeFor(secret));
    await page.getByRole("button", { name: "Generate new codes" }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "old ones no longer work" })).toBeVisible();
    const fresh = await page.getByRole("listitem").filter({ hasText: RECOVERY_ITEM }).allTextContents();
    expect(fresh).toHaveLength(10);
    expect(fresh.filter((c) => old.includes(c))).toEqual([]);
    await finishRecoveryCodes(page);
    await expect(page.getByText("10 of 10")).toBeVisible();
  });

  test("running low on recovery codes is called out", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { secret } = await enableMfa(user.id);
    await db.mfaRecoveryCode.updateMany({ where: { userId: user.id }, data: { usedAt: new Date() } });
    const ids = await db.mfaRecoveryCode.findMany({ where: { userId: user.id }, take: 2, select: { id: true } });
    await db.mfaRecoveryCode.updateMany({ where: { id: { in: ids.map((r) => r.id) } }, data: { usedAt: null } });
    await signInWithSecondFactor(page, user, { code: codeFor(secret) });
    await page.goto("/account");
    await expect(page.getByText("2 of 10")).toBeVisible();
    await expect(alerts(page)).toContainText("running low");
  });

  test("turning it off: a wrong password and a wrong code are each explained; a recovery code works in place of the app", async ({ page }) => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const { secret, recoveryCodes } = await enableMfa(user.id);
    await signInWithSecondFactor(page, user, { code: codeFor(secret) });
    await rewindMfa(user.id); // time passes before the next code is used
    await page.goto("/account");
    await page.getByRole("button", { name: "Turn off two-step verification" }).click();

    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await expect(page.getByText("Enter the 6-digit code.")).toBeVisible();

    await page.getByLabel("Password", { exact: true }).fill("not-my-password-1");
    await codeField(page).fill(codeFor(secret));
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByText("Your password is incorrect.")).toBeVisible();

    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await codeField(page).fill(codeFor(secret, 3));
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByText(/That code isn't right/)).toBeVisible();
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(1);

    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await expect(recoveryField(page)).toBeFocused();
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await recoveryField(page).fill(recoveryCodes[0]);
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Two-step verification is off" })).toBeVisible();
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(0);
  });
});

test.describe("the recovery-codes screen", () => {
  test("Download saves a text file with the codes; Copy puts them on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await signInThroughUi(page, user);
    const { recoveryCodes } = await enrol(page, user);

    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as text file" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("recovery-codes.txt");
    const text = await fs.readFile((await download.path())!, "utf8");
    for (const code of recoveryCodes) expect(text).toContain(code);

    await page.getByRole("button", { name: "Copy codes" }).click();
    await expect(page.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(recoveryCodes.join("\n"));
  });
});
