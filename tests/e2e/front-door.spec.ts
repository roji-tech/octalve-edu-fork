import { test, expect } from "../support/fixtures";
import { Role, addMembership, createTenant, createUser, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { SAAS_URL } from "../support/env";
import { signInThroughUi } from "./helpers";

// The front door and the school pages in a real browser (domain-implementation-plan.md §0.5.2). Several schools
// share the database here, so this runs on the SaaS-mode server.
test.use({ baseURL: SAAS_URL });

let a: TestTenant;
let b: TestTenant;

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
  b = await createTenant({ name: "Beta <b>School</b>", campuses: ["Beta Main"] });
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("routing after sign-in", () => {
  test("ONE school: straight into it — its name, your role and your campus, no picker", async ({ page }) => {
    const teacher = await createUser({ name: "Tunde Bello" });
    await addMembership(teacher.id, a.id, Role.TEACHING_STAFF, a.campuses[1].id);
    await signInThroughUi(page, teacher);
    await expect(page).toHaveURL(new RegExp(`/schools/${a.code}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Tunde" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Alpha School" })).toBeVisible();
    await expect(page.getByRole("main").getByText("Teaching staff")).toBeVisible(); // (the shell repeats the role in its person card)
    await expect(page.getByText("Alpha South")).toBeVisible();
    await expect(page.getByText("Alpha North")).toHaveCount(0); // a non-admin sees only their campus
    await expect(page.getByText("Beta")).toHaveCount(0);
  });

  test("an ADMIN sees every campus of their school", async ({ page }) => {
    const admin = await createUser();
    await addMembership(admin.id, a.id, Role.ADMIN);
    await signInThroughUi(page, admin);
    await expect(page).toHaveURL(new RegExp(`/schools/${a.code}$`));
    await expect(page.getByText("Alpha North")).toBeVisible();
    await expect(page.getByText("Alpha South")).toBeVisible();
    await expect(page.getByText("all campuses")).toBeVisible();
  });

  test("SEVERAL schools: a picker listing each with the role held there; choosing one opens it", async ({ page }) => {
    const both = await createUser();
    await addMembership(both.id, a.id, Role.STUDENT, a.campuses[0].id);
    await addMembership(both.id, b.id, Role.ADMIN);
    await signInThroughUi(page, both);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: "Your schools" })).toBeVisible();
    const alpha = page.getByRole("link", { name: /Alpha School/ });
    const beta = page.getByRole("link", { name: /Beta/ });
    await expect(alpha).toContainText("Student");
    await expect(beta).toContainText("Administrator");
    // The hostile-looking name is TEXT, not markup.
    await expect(beta).toContainText("Beta <b>School</b>");
    await expect(page.locator("main b")).toHaveCount(0);

    await beta.click();
    await expect(page).toHaveURL(new RegExp(`/schools/${b.code}$`));
    await expect(page.getByRole("heading", { level: 2 })).toContainText("Beta <b>School</b>");
    await expect(page.getByText("Beta Main")).toBeVisible();
    await expect(page.getByRole("main").getByText("Alpha")).toHaveCount(0); // no Alpha DATA in Beta (the shell may list the person's own schools)
  });

  test("NO school: an honest message, nothing to click", async ({ page }) => {
    const loner = await createUser();
    await signInThroughUi(page, loner);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText("Ask your school administrator to invite you.")).toBeVisible();
    await expect(page.getByRole("link", { name: /School/ })).toHaveCount(0);
  });
});

test.describe("changing the code in the address bar", () => {
  test("another school's code → a real 403 view that names nothing; an unknown code looks identical", async ({ page }) => {
    const member = await createUser();
    await addMembership(member.id, a.id, Role.ADMIN);
    await signInThroughUi(page, member);

    const other = await page.goto(`/schools/${b.code}`);
    expect(other!.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "You don't have access to this school" })).toBeVisible();
    const otherText = await page.locator("main").innerText();

    const unknown = await page.goto("/schools/no-such-school");
    expect(unknown!.status()).toBe(403);
    expect(await page.locator("main").innerText()).toBe(otherText);

    for (const text of [otherText]) {
      expect(text).not.toContain("Beta");
      expect(text).not.toContain(b.code);
    }
    await page.getByRole("link", { name: "Go to your dashboard" }).click();
    await expect(page).toHaveURL(new RegExp(`/schools/${a.code}$`)); // and back to their own school
  });

  test("signed out: the school pages send you to sign in, and say nothing about whether the school exists", async ({ page }) => {
    await page.goto(`/schools/${a.code}`);
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/schools/no-such-school");
    await expect(page).toHaveURL(/\/login$/);
  });
});
