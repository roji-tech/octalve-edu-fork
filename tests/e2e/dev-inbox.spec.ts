import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { DEVTOOLS_URL, DEV_TOOLS_TEST_TOKEN, HTTP_URL } from "../support/env";
import { createUser, seedInstance, uniqueIp } from "../support/db";
import { alerts, emailField } from "./helpers";

// The dev email inbox widget in a real browser, against the staging-mode server (dev tools on, token required).

test.use({ baseURL: DEVTOOLS_URL });
test.beforeAll(async () => {
  await seedInstance();
});
// The server's inbox is one shared in-memory buffer; every test starts from an empty one.
test.beforeEach(async () => {
  await fetch(`${DEVTOOLS_URL}/api/v1/dev/email-inbox`, {
    method: "DELETE",
    headers: { "x-dev-tools-token": DEV_TOOLS_TEST_TOKEN, origin: DEVTOOLS_URL, "x-real-ip": uniqueIp() },
  });
});

const launcher = (page: Page) => page.getByRole("button", { name: /^Dev email inbox/ }).first();
const dialog = (page: Page) => page.getByRole("dialog", { name: "Dev email inbox" });
const tokenField = (page: Page) => page.getByLabel("Dev tools token");

/// Skips the token form by putting the token where the widget keeps it (a tab-lifetime sessionStorage).
async function unlock(page: Page) {
  await page.addInitScript((token) => {
    try {
      sessionStorage.setItem("dev-tools-token", token);
    } catch {
      // best effort
    }
  }, DEV_TOOLS_TEST_TOKEN);
}

async function requestResetFor(page: Page, email: string) {
  await page.goto("/forgot-password");
  await emailField(page).fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}

test.describe("where it is, and where it is not", () => {
  test("this (staging-mode) server shows the launcher on every page; a production-shaped one shows nothing", async ({ page }) => {
    for (const path of ["/login", "/forgot-password"]) {
      await page.goto(path);
      await expect(launcher(page)).toBeVisible();
      await expect(launcher(page)).toHaveAttribute("aria-expanded", "false");
    }
    await page.goto(`${HTTP_URL}/login`);
    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Dev email inbox/ })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("unlocking it (a staging deployment is reachable by other people)", () => {
  test("opens on a token form; a wrong token is explained and stays locked; the right one shows the empty inbox — and survives a reload", async ({
    page,
  }) => {
    await page.goto("/login");
    await launcher(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("heading", { name: "Dev email inbox" })).toBeFocused();
    await expect(dialog(page).getByText("Dev", { exact: true })).toBeVisible();
    await expect(page.getByText(/staging deployment/)).toBeVisible();

    await tokenField(page).fill("not-the-token");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("That token isn't right.")).toBeVisible();
    await expect(tokenField(page)).toHaveAttribute("aria-invalid", "true");

    await tokenField(page).fill(DEV_TOOLS_TEST_TOKEN);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText(/No messages yet/)).toBeVisible();
    await expect(tokenField(page)).toHaveCount(0);

    await page.reload();
    await launcher(page).click();
    await expect(page.getByText(/No messages yet/)).toBeVisible(); // the token was kept for this tab
  });

  test("five wrong tokens in a row lock the form out with a clear message", async ({ page }) => {
    await page.goto("/login");
    await launcher(page).click();
    for (let i = 0; i < 5; i++) {
      await tokenField(page).fill(`guess-${i}`);
      await page.getByRole("button", { name: "Unlock" }).click();
      await expect(page.getByText("That token isn't right.")).toBeVisible();
    }
    await tokenField(page).fill(DEV_TOOLS_TEST_TOKEN);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("Too many wrong tokens")).toBeVisible();
  });
});

test.describe("reading the mail", () => {
  test("forgot password → a badge appears → the message and its link → the link works", async ({ page }) => {
    const user = await createUser();
    await unlock(page);
    await requestResetFor(page, user.email);

    // The widget polls; the badge says how many messages are new.
    await expect(page.getByRole("button", { name: "Dev email inbox, 1 unread" })).toBeVisible({ timeout: 12_000 });
    await launcher(page).click();
    await expect(page.getByRole("button", { name: "Dev email inbox, 1 unread" })).toHaveCount(0); // opening reads it
    const row = dialog(page).getByRole("button", { name: new RegExp(`${user.email}.*Reset your`) });
    await expect(row).toBeVisible();
    await row.click();

    await expect(dialog(page).getByText(`To ${user.email}`)).toBeVisible();
    await expect(dialog(page).getByText(/Someone asked to reset the password/)).toBeVisible();
    const link = dialog(page).getByRole("link", { name: /\/reset-password#token=/ });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/reset-password$/); // the page scrubbed the token from the address bar
    await page.getByLabel("New password", { exact: true }).fill("from-the-inbox-1");
    await page.getByLabel("Confirm new password").fill("from-the-inbox-1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
  });

  test("reading it clears the badge; a NEW message brings it back — even after a full page load; Clear all empties the list", async ({
    page,
  }) => {
    const user = await createUser();
    await unlock(page);
    await requestResetFor(page, user.email);
    await expect(page.getByRole("button", { name: "Dev email inbox, 1 unread" })).toBeVisible({ timeout: 12_000 });
    await launcher(page).click();
    await expect(dialog(page).getByRole("listitem")).toHaveCount(1);
    await launcher(page).click(); // close: that message is now read
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Dev email inbox", exact: true })).toBeVisible(); // nothing unread

    // A second message arrives. Wait until the server HAS both before reloading, so the reloaded widget sees
    // both at once: what is "unread" must then come from the memory kept across page loads, not from timing.
    const second = await fetch(`${DEVTOOLS_URL}/api/v1/auth/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: DEVTOOLS_URL, "x-real-ip": uniqueIp() },
      body: JSON.stringify({ email: user.email }),
    });
    expect(second.status).toBe(200);
    await expect
      .poll(async () => {
        const res = await fetch(`${DEVTOOLS_URL}/api/v1/dev/email-inbox`, { headers: { "x-dev-tools-token": DEV_TOOLS_TEST_TOKEN } });
        return ((await res.json()).data.emails as { to: string }[]).filter((m) => m.to === user.email).length;
      })
      .toBe(2);
    await page.reload();
    await expect(page.getByRole("button", { name: "Dev email inbox, 1 unread" })).toBeVisible({ timeout: 12_000 });
    await page.waitForTimeout(5000); // longer than a poll: it must STAY at 1 (a wrong count would have shown by now)
    await expect(page.getByRole("button", { name: "Dev email inbox, 1 unread" })).toBeVisible();

    await launcher(page).click();
    await dialog(page).getByRole("button", { name: "Clear all messages" }).click();
    await expect(page.getByText(/No messages yet/)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Clear all messages" })).toBeDisabled();
  });

  test("Escape closes the dialog and puts focus back on the launcher; Back returns from a message to the list", async ({ page }) => {
    const user = await createUser();
    await unlock(page);
    await requestResetFor(page, user.email);
    await launcher(page).click();
    await dialog(page).getByRole("listitem").first().getByRole("button").click();
    // The row that was clicked is gone, so focus moves to the message's Back button…
    await expect(dialog(page).getByRole("button", { name: "Back to the list" })).toBeFocused();
    await dialog(page).getByRole("button", { name: "Back to the list" }).click();
    await expect(dialog(page).getByRole("listitem").first()).toBeVisible();
    // …and from there back to the dialog's heading: focus is never left on something that no longer exists.
    await expect(dialog(page).getByRole("heading", { name: "Dev email inbox" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(launcher(page)).toBeFocused();
  });
});

test.describe("what a message can contain", () => {
  test("hostile markup in a message is shown as text and does nothing: no elements, no script, no javascript: link", async ({ page }) => {
    await unlock(page);
    const hostile = {
      id: "evil-1",
      to: "<img src=x onerror=window.__pwned=1>@x.test",
      subject: "<script>window.__pwned=1</script>Hello",
      text: [
        '<img src=x onerror="window.__pwned=1"> <b>bold?</b> <a href="javascript:window.__pwned=1">click</a>',
        "javascript:window.__pwned=1",
        "a real one: https://ok.example/path?x=1#frag",
      ].join("\n"),
      sentAt: new Date().toISOString(),
    };
    await page.route("**/api/v1/dev/email-inbox", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { data: { emails: [hostile], mode: "staging" }, meta: {}, error: null } })
        : route.continue(),
    );
    await page.goto("/login");
    await launcher(page).click();
    await dialog(page).getByRole("listitem").first().getByRole("button").click();

    // Everything is TEXT: the literal markup is visible, and no element was created from it.
    await expect(dialog(page).getByText("<b>bold?</b>", { exact: false })).toBeVisible();
    await expect(dialog(page).locator("img, script, b, a[href^='javascript']")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // …and the only link offered is the genuine http(s) one.
    const links = dialog(page).getByRole("link");
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute("href", "https://ok.example/path?x=1#frag");
    await expect(links).toHaveAttribute("rel", /noopener/);
  });
});

test.describe("on a phone", () => {
  test("the dialog fits the screen: nothing overflows and nothing is cut off", async ({ page }) => {
    await unlock(page);
    await page.goto("/login");
    await launcher(page).click();
    const box = (await dialog(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("alerts on this page are the product's own (the widget adds none when nothing is wrong)", async ({ page }) => {
  await unlock(page);
  await page.goto("/login");
  await expect(launcher(page)).toBeVisible();
  await expect(alerts(page)).toHaveCount(0);
});
