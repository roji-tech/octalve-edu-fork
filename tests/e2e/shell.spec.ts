import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { Role, addMembership, createTenant, createUser, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { SAAS_URL } from "../support/env";
import { signInThroughUi } from "./helpers";

// The app shell in a real browser (domain-implementation-plan.md §0.5.2-H): the school-aware sidebar, top bar, account
// menu, school switcher and — on a phone — the tab bar and "More" sheet. Several schools share the database, so this runs on
// the SaaS-mode server. The shell only DISPLAYS; every assertion about access lives with the pages and APIs.
test.use({ baseURL: SAAS_URL });

let a: TestTenant;
let b: TestTenant;

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North"] });
  b = await createTenant({ name: "Beta Academy", campuses: ["Beta Main"] });
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" });
const accountMenu = (page: Page) => page.getByRole("button", { name: /^Account menu for/ });

async function signedInAs(page: Page, role: Role, opts: { name?: string; also?: Role } = {}) {
  const user = await createUser({ name: opts.name ?? "Amina Yusuf" });
  await addMembership(user.id, a.id, role, role === Role.ADMIN ? null : a.campuses[0].id);
  if (opts.also) await addMembership(user.id, b.id, opts.also, opts.also === Role.ADMIN ? null : b.campuses[0].id);
  await signInThroughUi(page, user);
  return user;
}

test.describe("on a desktop: the sidebar and the top bar", () => {
  test.beforeEach(({ isMobile }) => test.skip(isMobile, "the sidebar exists from the `lg` breakpoint up"));

  test("an ADMIN: the school's name, Overview (current), Users as a link, and Settings as visible 'coming soon' text — never a dead link", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    await expect(page).toHaveURL(new RegExp(`/schools/${a.code}$`));
    const nav = mainNav(page);
    await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Users" })).toHaveAttribute("href", `/schools/${a.code}/users`);
    await expect(nav.getByRole("link", { name: "Users" })).not.toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0); // not built: text, not a link
    await expect(nav.getByText("Settings")).toBeVisible();
    await expect(nav.getByText(", coming soon").first()).toBeAttached(); // said in words too, not only a pill
    await expect(page.getByText("Alpha School").first()).toBeVisible(); // the school, under the brand
    await expect(breadcrumb(page)).toContainText("Alpha School");
    await expect(breadcrumb(page).getByText("Overview")).toHaveAttribute("aria-current", "page");
    const card = page.getByRole("group", { name: "Signed in as" }); // the person card: who, and the role IN this school
    await expect(card).toContainText("Amina Yusuf");
    await expect(card).toContainText("Administrator");
  });

  test("anyone else sees Overview only — the role in THIS school decides what is drawn", async ({ page }) => {
    await signedInAs(page, Role.TEACHING_STAFF);
    const nav = mainNav(page);
    await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(nav.getByText("Users")).toHaveCount(0);
    await expect(nav.getByText("Settings")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Signed in as" })).toContainText("Teaching staff");
    // The account menu follows the same rule: Settings (soon) is an administrator's entry.
    await accountMenu(page).click();
    await expect(page.getByRole("link", { name: "Profile" })).toBeVisible();
    await expect(page.locator("header").getByText("Settings")).toHaveCount(0);
  });

  test("ONE school: its name is plain text — there is nothing to switch to", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    await expect(page.getByRole("button", { name: /School/ })).toHaveCount(0);
    await expect(page.getByText("Alpha School").first()).toBeVisible();
  });

  test("SEVERAL schools: a switcher lists each with the role held there, marks the current one, and changes school", async ({ page }) => {
    await signedInAs(page, Role.TEACHING_STAFF, { also: Role.ADMIN });
    await expect(page).toHaveURL(/\/dashboard$/); // two schools → the picker is the front door
    await expect(breadcrumb(page)).toContainText("Octalve Edu"); // outside a school, the product
    await expect(mainNav(page).getByRole("link", { name: "Your schools" })).toHaveAttribute("aria-current", "page");

    await page.goto(`/schools/${a.code}`);
    const switcher = page.getByRole("button", { name: /School.*Alpha School/ });
    await expect(switcher).toHaveAttribute("aria-expanded", "false");
    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-expanded", "true");
    const alpha = page.getByRole("link", { name: /Alpha School.*Teaching staff/ });
    const beta = page.getByRole("link", { name: /Beta Academy.*Administrator/ });
    await expect(alpha).toHaveAttribute("aria-current", "true");
    await expect(beta).not.toHaveAttribute("aria-current", "true");

    await beta.click();
    await expect(page).toHaveURL(new RegExp(`/schools/${b.code}$`));
    await expect(breadcrumb(page)).toContainText("Beta Academy");
    await expect(page.getByRole("button", { name: /School.*Beta Academy/ })).toHaveAttribute("aria-expanded", "false"); // closed by navigating
    await expect(mainNav(page).getByText("Users")).toBeVisible(); // Beta: an administrator → the admin entries are drawn
    await page.goto(`/schools/${a.code}`);
    await expect(mainNav(page).getByText("Users")).toHaveCount(0); // …and Alpha: a teacher → they are not (per school)
  });

  test("the switcher closes on Escape (focus back on its button) and on a click elsewhere", async ({ page }) => {
    await signedInAs(page, Role.TEACHING_STAFF, { also: Role.ADMIN });
    await page.goto(`/schools/${a.code}`);
    const switcher = page.getByRole("button", { name: /School.*Alpha School/ });
    await switcher.click();
    await expect(page.getByRole("link", { name: /Beta Academy/ })).toBeVisible();
    await page.keyboard.press("Tab"); // focus moves INTO the panel…
    await expect(page.getByRole("link", { name: /Alpha School/ })).toBeFocused();
    await page.keyboard.press("Escape"); // …so the panel's disappearance would drop it on <body> unless it is put back
    await expect(page.getByRole("link", { name: /Beta Academy/ })).toHaveCount(0);
    await expect(switcher).toBeFocused();
    await switcher.click();
    // A click on truly inert space (the top bar's empty middle): nothing is focusable there, so the BLUR path cannot close
    // it — only the outside-click handler can. (Clicking the page heading used to look like proof; it focuses <main>.)
    await page.mouse.click(760, 30);
    await expect(page.getByRole("link", { name: /Beta Academy/ })).toHaveCount(0);
  });

  test("a school the person is NOT in: the page is a 403 and the shell shows no trace of it", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    const response = await page.goto(`/schools/${b.code}`);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1, name: "You don't have access to this school" })).toBeVisible();
    await expect(page.getByText("Beta Academy")).toHaveCount(0);
    await expect(breadcrumb(page)).toContainText("Octalve Edu"); // matched nothing: the shell treats it as no school
    await expect(mainNav(page)).toBeVisible(); // the person can still get around from the 403 page
    await expect(page.getByText("Alpha School").first()).toBeVisible(); // their OWN school is in the shell
  });

  test("the account page lives in the shell: with ONE school the sidebar still leads into it; with several it asks them to choose", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await expect(breadcrumb(page).getByText("Account")).toHaveAttribute("aria-current", "page");
    await expect(breadcrumb(page).getByText("Octalve Edu")).toBeVisible(); // the account page is the PERSON's: the product, not a school
    await expect(mainNav(page).getByRole("link", { name: "Overview" })).toHaveAttribute("href", `/schools/${a.code}`);
  });

  test("the account page with SEVERAL schools: 'Your schools' and the switcher, no school guessed", async ({ page }) => {
    await signedInAs(page, Role.TEACHING_STAFF, { also: Role.ADMIN });
    await page.goto("/account");
    await expect(mainNav(page).getByRole("link", { name: "Your schools" })).toBeVisible();
    await expect(page.getByRole("button", { name: /School.*Choose a school/ })).toBeVisible();
  });

  test("the account menu: opens, shows who you are and where, goes to Profile, and Escape closes it with focus back on its button", async ({ page }) => {
    await signedInAs(page, Role.ADMIN, { name: "Tunde Bello" });
    const menu = accountMenu(page);
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(page.locator("header").getByText("Administrator · Alpha School")).toBeVisible();
    await page.keyboard.press("Tab"); // focus into the panel (Profile), then Escape must put it back on the button
    await expect(page.getByRole("link", { name: "Profile" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("link", { name: "Profile" })).toHaveCount(0);
    await expect(menu).toBeFocused();
    await menu.click();
    await page.mouse.click(760, 30); // inert space: only the outside-click handler can close it
    await expect(page.getByRole("link", { name: "Profile" })).toHaveCount(0);
    await menu.click();
    await page.getByRole("link", { name: "Profile" }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("link", { name: "Profile" })).toHaveCount(0); // closed by navigating
  });

  test("Sign out from the account menu ends the session and lands on the sign-in screen", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    await accountMenu(page).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(`/schools/${a.code}`);
    await expect(page).toHaveURL(/\/login/); // really signed out
  });

  test("the skip link is the first thing in the tab order and moves focus to the page content", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
  });
});

test.describe("on a phone: the tab bar and the More sheet", () => {
  test.beforeEach(({ isMobile }) => test.skip(!isMobile, "the tab bar exists below the `lg` breakpoint"));

  test("the sidebar is absent; the tab bar has Overview (current) and More; the page is not covered by it", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    const nav = mainNav(page);
    await expect(nav).toHaveCount(1); // only the tab bar is in the accessibility tree
    await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "More" })).toBeVisible();
    await expect(page.getByText("Skip to content")).toHaveCount(1); // present for keyboards, visually hidden
    const lastCard = page.getByText("Alpha North");
    await lastCard.scrollIntoViewIfNeeded();
    const card = await lastCard.boundingBox();
    const bar = await nav.boundingBox();
    expect(card && bar && card.y + card.height <= bar.y).toBe(true); // the bar never covers the last thing on the page
  });

  test("More: who you are and where, Settings as 'coming soon' (administrator), Profile, Sign out; Escape closes it and returns focus — Users is a TAB", async ({ page }) => {
    await signedInAs(page, Role.ADMIN, { name: "Tunde Bello" });
    const more = mainNav(page).getByRole("button", { name: "More" });
    await more.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Tunde Bello" })).toBeVisible();
    await expect(sheet.getByText("Administrator · Alpha School")).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Users" })).toBeVisible(); // a page now: it earns a tab on the phone
    await expect(sheet.getByText("Users")).toHaveCount(0);
    await expect(sheet.getByText("Settings")).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Settings" })).toHaveCount(0);
    await expect(sheet.getByRole("link", { name: "Profile" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
  });

  test("a tap outside the sheet (on the dimmed page) closes it", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    const more = mainNav(page).getByRole("button", { name: "More" });
    await more.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.mouse.click(8, 8); // the top-left corner: the backdrop, well clear of the sheet
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(more).toBeFocused();
  });

  test("More with SEVERAL schools lists them; choosing one goes there and closes the sheet", async ({ page }) => {
    await signedInAs(page, Role.TEACHING_STAFF, { also: Role.ADMIN });
    await page.goto(`/schools/${a.code}`);
    await mainNav(page).getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("link", { name: /Alpha School/ })).toHaveAttribute("aria-current", "true");
    await sheet.getByRole("link", { name: /Beta Academy/ }).click();
    await expect(page).toHaveURL(new RegExp(`/schools/${b.code}$`));
    await expect(sheet).toBeHidden();
  });

  test("a person with ONE school sees no school list in the sheet", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    await mainNav(page).getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Your schools" })).toHaveCount(0);
  });

  test("Sign out from the More sheet", async ({ page }) => {
    await signedInAs(page, Role.ADMIN);
    await mainNav(page).getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("Profile from the sheet opens the account page inside the shell", async ({ page }) => {
    await signedInAs(page, Role.TEACHING_STAFF);
    await mainNav(page).getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Profile" }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
