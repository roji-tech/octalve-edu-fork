import { test, expect } from "../support/fixtures";
import { seedInstance } from "../support/db";
import { signInButton } from "./helpers";

// The ONE spec that differs between Octalve Edu and AlEemaan: it pins the brand — the colours
// from app/brand.css and the words from lib/brand.ts — so a token or copy change can't slip
// through unnoticed, and so the two products can't quietly end up wearing each other's colours.

test.beforeAll(async () => {
  await seedInstance();
});

const INDIGO = "rgb(79, 70, 229)"; //      #4F46E5 — filled buttons (6.29 : 1 with white)
const DEEP_INDIGO = "rgb(55, 48, 163)"; // #3730a3 — the sign-in brand panel

const backgroundOf = (locator: import("@playwright/test").Locator) =>
  locator.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe("Octalve Edu's brand", () => {
  test("the tab title carries the product name", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle("Sign in · Octalve Edu");
  });

  test("the primary button is Octalve indigo — in the dark theme AND the light one", async ({ page }) => {
    await page.goto("/login");
    expect(await backgroundOf(signInButton(page))).toBe(INDIGO);

    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await backgroundOf(signInButton(page))).toBe(INDIGO);
  });

  test("desktop: the brand panel is deep indigo with the artifact's headline, blurb and three points", async ({ page, isMobile }) => {
    test.skip(isMobile, "the panel only exists from 1024 px up");
    await page.goto("/login");
    const panel = page.locator("aside");
    await expect(panel).toBeVisible();
    expect(await backgroundOf(panel)).toBe(DEEP_INDIGO);
    await expect(panel).toContainText("Run every campus from one dashboard.");
    await expect(panel).toContainText("Solo or SaaS — Octalve Edu adapts to how your school actually operates.");
    for (const point of ["Multi-campus & multi-tenant ready", "Role-based staff permissions", "Self-hosted or fully managed"]) {
      await expect(panel.getByText(point)).toBeVisible();
    }
  });

  test("phone: the panel gives way to a compact brand header (name and tagline) above the form", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the compact header is the phone layout");
    await page.goto("/login");
    await expect(page.locator("aside")).toBeHidden();
    const header = page.getByRole("main"); // the (hidden) panel repeats the name; this is the visible one
    await expect(header.getByText("Octalve Edu", { exact: true })).toBeVisible();
    await expect(header.getByText("Solo or SaaS — sign in to your dashboard")).toBeVisible();
  });
});
