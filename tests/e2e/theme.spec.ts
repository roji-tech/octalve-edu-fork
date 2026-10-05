import { test, expect } from "../support/fixtures";
import { Role, createUser, seedInstance } from "../support/db";
import { HTTP_URL } from "../support/env";
import { api } from "../support/http";
import { emailField, fillCredentials, signInButton, HOME_URL } from "./helpers";

// The light/dark choice is a `theme` cookie the SERVER reads, so the first paint is right
// (no flash) and no inline script is needed — which is what lets the CSP forbid them.

test.beforeAll(async () => {
  await seedInstance();
});

const html = (page: import("@playwright/test").Page) => page.locator("html");
const toggle = (page: import("@playwright/test").Page, to: "light" | "dark") =>
  page.getByRole("button", { name: `Switch to ${to} theme` });

test.describe("server-rendered theme", () => {
  test("dark by default, light when the cookie says so — in the raw HTML, before any script runs", async () => {
    const byDefault = await api("/login", { ip: null });
    expect(byDefault.text).toMatch(/<html[^>]*data-theme="dark"/);

    const light = await api("/login", { ip: null, cookie: "theme=light" });
    expect(light.text).toMatch(/<html[^>]*data-theme="light"/);
  });

  test("anything that isn't exactly 'light' is dark, and a hostile cookie value can't inject markup", async () => {
    for (const value of ["LIGHT", "dark", "", "solarized", '"><script>alert(1)</script>', "light; x=1"]) {
      const res = await api("/login", { ip: null, cookie: `theme=${encodeURIComponent(value)}` });
      expect(res.text, `theme=${value}`).toMatch(/<html[^>]*data-theme="dark"/);
      expect(res.text).not.toContain("<script>alert(1)</script>");
    }
  });
});

test.describe("the toggle", () => {
  test("flips the theme, updates its own accessible name, and sets a Lax cookie", async ({ page, context }) => {
    await page.goto("/login");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");

    await toggle(page, "light").click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(toggle(page, "dark")).toBeVisible();

    const cookie = (await context.cookies()).find((c) => c.name === "theme");
    expect(cookie?.value).toBe("light");
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.httpOnly).toBe(false); // a preference the toggle sets from script — not a credential

    await toggle(page, "dark").click();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
  });

  test("the colours really change (the tokens are wired, not just the attribute)", async ({ page }) => {
    await page.goto("/login");
    const canvas = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await canvas()).toBe("rgb(2, 6, 23)"); // #020617
    await toggle(page, "light").click();
    await expect.poll(canvas).toBe("rgb(248, 250, 252)"); // #f8fafc
  });

  test("the choice survives a reload — and the reloaded page is ALREADY light in the server's HTML (no flash)", async ({ page }) => {
    await page.goto("/login");
    await toggle(page, "light").click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");

    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    const raw = await page.request.get(`${HTTP_URL}/login`); // shares the browser context's cookies
    expect(await raw.text()).toMatch(/<html[^>]*data-theme="light"/);
  });

  test("it follows the user across screens: sign-in stays light on the dashboard", async ({ page }) => {
    const user = await createUser({ role: Role.ADMIN });
    await page.goto("/login");
    await toggle(page, "light").click();
    await fillCredentials(page, user.email, user.password);
    await signInButton(page).click();
    await expect(page).toHaveURL(HOME_URL);
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(toggle(page, "dark")).toBeVisible(); // the header has one too
  });

  test("keyboard: reachable by Tab, operable with Enter and Space, and focus stays put", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard flows are a desktop concern");
    await page.goto("/login");
    // The email field takes focus on arrival; the toggle is the control just before the form.
    await expect(emailField(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(toggle(page, "light")).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(toggle(page, "dark")).toBeFocused(); // same control, new name — focus isn't lost
    await page.keyboard.press("Space");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");

    await page.keyboard.press("Tab");
    await expect(emailField(page)).toBeFocused(); // and the tab order carries on into the form
  });
});
