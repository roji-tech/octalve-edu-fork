import { test, expect } from "../support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { Role, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { SAAS_URL } from "../support/env";
import { signInThroughUi } from "./helpers";

// Academic setup in a real browser, desktop and phone (plan "Build design — Phase 1.0 and 1.1"): the school year and its terms, classes and subjects,
// assessment schemes and grade scales. The SaaS-mode server (several schools).
test.use({ baseURL: SAAS_URL });

let school: TestTenant;

test.beforeAll(async () => {
  await seedInstance();
});
test.afterAll(async () => {
  await removeCreatedTenants();
});
test.beforeEach(async () => {
  school = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

const dialog = (page: Page) => page.getByRole("dialog");
const notice = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ });
const item = (page: Page, text: string | RegExp) => page.getByRole("listitem").filter({ hasText: text });
const field = (scope: Locator, label: string) => scope.getByLabel(label, { exact: true });

async function signedInAdmin(page: Page, section: string, name = "Amina Yusuf") {
  const admin = await createUser({ name });
  await addMembership(admin.id, school.id, Role.ADMIN);
  await signInThroughUi(page, admin);
  await page.goto(`/schools/${school.code}/academics?section=${section}`);
  await expect(page.getByRole("heading", { level: 1, name: "Academic setup" })).toBeVisible();
  return admin;
}

test.describe("the page", () => {
  test("an administrator gets the four sections as links; the address chooses one; an unknown one falls back to sessions", async ({
    page,
  }) => {
    await signedInAdmin(page, "sessions");
    await expect(page).toHaveTitle(/Academic setup/);
    const sections = page.getByRole("navigation", { name: "Academic setup sections" });
    await expect(sections.getByRole("link")).toHaveText(["Sessions & terms", "Classes & subjects", "Assessment", "Grading"]);
    await expect(sections.getByRole("link", { name: "Sessions & terms" })).toHaveAttribute("aria-current", "page");
    await sections.getByRole("link", { name: "Grading" }).click();
    await expect(page).toHaveURL(/section=grading/);
    await expect(page.getByRole("heading", { level: 2, name: "Grade scales" })).toBeVisible();
    await page.goto(`/schools/${school.code}/academics?section=nonsense`);
    await expect(page.getByRole("heading", { level: 2, name: "Sessions" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Academic setup sections" }).getByRole("link", { name: "Sessions & terms" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("anyone who is not an administrator of this school gets the same 403 view as a stranger", async ({ page }) => {
    const teacher = await createUser({ name: "Tola Teacher" });
    await addMembership(teacher.id, school.id, Role.TEACHING_STAFF, school.campuses[0].id);
    await signInThroughUi(page, teacher);
    const response = await page.goto(`/schools/${school.code}/academics`);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1, name: "You don't have access to this school" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sessions" })).toHaveCount(0);
  });
});

test.describe("sessions and terms", () => {
  test("create a session (errors first), open it, add a term and make it current, preview and make the copy for next year, then archive the copy", async ({
    page,
  }) => {
    await signedInAdmin(page, "sessions");
    await expect(page.getByText("No sessions yet.")).toBeVisible();

    await page.getByRole("button", { name: "New session" }).click();
    await dialog(page).getByRole("button", { name: "Create session" }).click();
    await expect(dialog(page).getByText("Give the session a name, such as 2026/2027.")).toBeVisible();
    await expect(dialog(page).getByText("Choose the first day.")).toBeVisible();
    await field(dialog(page), "Name").fill("2026/2027");
    await field(dialog(page), "First day").fill("2026-09-07");
    await field(dialog(page), "Last day").fill("2026-09-01"); // before the start: the SERVER refuses, the form says where
    await dialog(page).getByRole("button", { name: "Create session" }).click();
    await expect(dialog(page).getByText("The end must be after the start.")).toBeVisible();
    await field(dialog(page), "Last day").fill("2027-07-23");
    await dialog(page).getByRole("button", { name: "Create session" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText("Saved 2026/2027.");
    const row = item(page, "2026/2027");
    await expect(row).toContainText("Planned");
    await expect(row).toContainText("Whole school");
    await expect(page.getByText("1 session")).toBeVisible();

    // a second, overlapping one is refused with the clash named
    await page.getByRole("button", { name: "New session" }).click();
    await field(dialog(page), "Name").fill("Overlap");
    await field(dialog(page), "First day").fill("2027-07-01");
    await field(dialog(page), "Last day").fill("2027-09-01");
    await dialog(page).getByRole("button", { name: "Create session" }).click();
    await expect(dialog(page).getByText(/overlap/i)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "New session" })).toBeFocused(); // focus came back to what opened it

    await page.getByRole("button", { name: "Open 2026/2027" }).click();
    await dialog(page).getByRole("button", { name: "Open session" }).click();
    await expect(notice(page)).toContainText("2026/2027 is now open");
    await expect(item(page, "2026/2027")).toContainText("Active");

    await page.getByRole("button", { name: "Terms of 2026/2027" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Terms of 2026/2027" })).toBeFocused();
    await expect(page.getByText("No terms yet.")).toBeVisible();
    await page.getByRole("button", { name: "Add a term" }).click();
    await field(dialog(page), "Name").fill("Term 1");
    await field(dialog(page), "First day").fill("2026-09-07");
    await field(dialog(page), "Last day").fill("2026-12-18");
    await dialog(page).getByRole("button", { name: "Add term" }).click();
    await expect(notice(page)).toContainText("Saved the term.");
    await expect(item(page, "Term 1")).toContainText("7 Sep 2026 – 18 Dec 2026");
    await page.getByRole("button", { name: "Make Term 1 the current term" }).click();
    await expect(notice(page)).toContainText("Term 1 is now the current term.");
    await expect(item(page, "Term 1")).toContainText("Current");
    await page.getByRole("button", { name: "All sessions" }).click();
    await expect(item(page, "2026/2027")).toContainText("1 term");

    await page.getByRole("button", { name: "Copy 2026/2027 to next year" }).click();
    await expect(field(dialog(page), "New first day")).toHaveValue("2027-09-07");
    await expect(dialog(page).getByRole("button", { name: "Create session" })).toBeDisabled(); // not before a preview
    await dialog(page).getByRole("button", { name: "Preview" }).click();
    await expect(dialog(page).getByText("2027/2028")).toBeVisible();
    await expect(dialog(page).getByText("Term 1")).toBeVisible();
    await expect(dialog(page).getByText("7 Sep 2027 – 18 Dec 2027")).toBeVisible();
    await expect(dialog(page).getByText("No clashes.")).toBeVisible();
    expect(await db.academicSession.count({ where: { tenantId: school.id } })).toBe(1); // the preview wrote nothing
    await dialog(page).getByRole("button", { name: "Create session" }).click();
    await expect(notice(page)).toContainText("2027/2028 was created as a planned session.");
    expect(await db.academicSession.count({ where: { tenantId: school.id } })).toBe(2);

    // copying again is refused at the PREVIEW, with the reason
    await page.getByRole("button", { name: "Copy 2026/2027 to next year" }).click();
    await dialog(page).getByRole("button", { name: "Preview" }).click();
    await expect(dialog(page).getByText("This session has already been copied", { exact: false })).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Create session" })).toBeDisabled();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Archive 2027/2028" }).click();
    await dialog(page).getByRole("button", { name: "Archive session" }).click();
    await expect(notice(page)).toContainText("2027/2028 was archived.");
    await expect(item(page, "2027/2028")).toHaveCount(0);
    await page.getByLabel("Show", { exact: true }).selectOption("archived");
    await expect(item(page, "2027/2028")).toContainText("Archived");
  });

  test("opening a second session needs the person to say so; 'close it first' closes the old one and opens the new one", async ({
    page,
  }) => {
    const admin = await signedInAdmin(page, "sessions");
    void admin;
    await db.academicSession.create({
      data: {
        tenantId: school.id,
        label: "2025/2026",
        startDate: new Date("2025-09-01"),
        endDate: new Date("2026-07-31"),
        status: "ACTIVE",
      },
    });
    await db.academicSession.create({
      data: { tenantId: school.id, label: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });
    await page.reload();
    await page.getByRole("button", { name: "Open 2026/2027" }).click();
    await dialog(page).getByRole("button", { name: "Open session" }).click();
    await expect(dialog(page).getByText(/"2025\/2026" is already the active session/)).toBeVisible();
    await dialog(page).getByLabel("If another session is already open, close it first").check();
    await dialog(page).getByRole("button", { name: "Open session" }).click();
    await expect(notice(page)).toContainText("2026/2027 is now open, and 2025/2026 was closed.");
    await expect(item(page, "2025/2026")).toContainText("Closed");
    await expect(item(page, "2026/2027")).toContainText("Active");
  });
});

test.describe("classes and subjects", () => {
  test("a class with arms and subjects: create, add arms, choose what it studies, and archiving refuses while something depends on it", async ({
    page,
  }) => {
    await signedInAdmin(page, "classes");
    await expect(page.getByText("No classes yet.")).toBeVisible();
    await expect(page.getByText("No subjects yet.")).toBeVisible();

    await page.getByRole("button", { name: "New class" }).click();
    await dialog(page).getByRole("button", { name: "Create class" }).click();
    await expect(dialog(page).getByText("Give the class a name, such as JSS 1.")).toBeVisible();
    await field(dialog(page), "Name").fill("JSS 1");
    await dialog(page).getByRole("button", { name: "Create class" }).click();
    await expect(notice(page)).toContainText("Saved JSS 1.");
    await expect(page.getByText("1 class")).toBeVisible();

    await page.getByRole("button", { name: "Add an arm to JSS 1" }).click();
    await field(dialog(page), "Name").fill("A");
    await field(dialog(page), "Capacity (optional)").fill("40");
    await dialog(page).getByRole("button", { name: "Add arm" }).click();
    await expect(notice(page)).toContainText("Saved arm A of JSS 1.");
    await expect(item(page, /^A\s*Up to 40 pupils/)).toBeVisible();
    await page.getByRole("button", { name: "Add an arm to JSS 1" }).click();
    await field(dialog(page), "Name").fill("A");
    await dialog(page).getByRole("button", { name: "Add arm" }).click();
    await expect(dialog(page).getByText("That name is already used here.")).toBeVisible();
    await page.keyboard.press("Escape");

    // subjects: create, then choose them for the class
    await page.getByRole("button", { name: "New subject" }).click();
    await field(dialog(page), "Name").fill("Mathematics");
    await field(dialog(page), "Short code (optional)").fill("mth");
    await dialog(page).getByRole("button", { name: "Create subject" }).click();
    await expect(notice(page)).toContainText("Saved Mathematics.");
    await expect(item(page, "Mathematics")).toContainText("MTH"); // upper-cased by the server
    await page.getByRole("button", { name: "New subject" }).click();
    await field(dialog(page), "Name").fill("English");
    await dialog(page).getByRole("button", { name: "Create subject" }).click();
    await expect(item(page, "English")).toBeVisible();

    await page.getByRole("button", { name: "Subjects of JSS 1" }).click();
    await expect(dialog(page).getByLabel("Mathematics (MTH)")).toBeVisible();
    await dialog(page).getByLabel("Mathematics (MTH)").check();
    await dialog(page).getByRole("button", { name: "Save subjects" }).click();
    await expect(notice(page)).toContainText("Saved the subjects of JSS 1.");
    await expect(page.getByText("1 subject", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: "Subjects of JSS 1" }).click();
    await expect(dialog(page).getByLabel("Mathematics (MTH)")).toBeChecked();
    await dialog(page).getByRole("button", { name: "Save subjects" }).click();
    await expect(notice(page)).toContainText("Nothing needed changing.");

    // a subject a class studies cannot be archived; a class with arms cannot be archived
    await page.getByRole("button", { name: "Archive Mathematics" }).click();
    await dialog(page).getByRole("button", { name: "Archive subject" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("A class still studies this subject");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Archive JSS 1", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Archive class" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("This class still has arms");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Archive arm A of JSS 1" }).click();
    await dialog(page).getByRole("button", { name: "Archive arm" }).click();
    await expect(notice(page)).toContainText("JSS 1 A was archived.");
    await expect(page.getByText("No arms yet.")).toBeVisible();
    await page.getByRole("button", { name: "Archive JSS 1", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Archive class" }).click();
    await expect(notice(page)).toContainText("JSS 1 was archived.");
    await expect(page.getByText("No classes yet.")).toBeVisible();
  });

  test("the subject search treats % as text and says when nothing matches", async ({ page }) => {
    await db.subject.create({ data: { tenantId: school.id, name: "100% Effort" } });
    await db.subject.create({ data: { tenantId: school.id, name: "Biology" } });
    await signedInAdmin(page, "classes");
    await expect(item(page, "Biology")).toBeVisible();
    await page.getByLabel("Search subjects").fill("%");
    await expect(item(page, "100% Effort")).toBeVisible();
    await expect(item(page, "Biology")).toHaveCount(0);
    await page.getByLabel("Search subjects").fill("zzz-nothing");
    await expect(page.getByText("No subject matches that search.")).toBeVisible();
  });
});

test.describe("assessment schemes", () => {
  test("the sum is shown as you type and enforced; a scheme in use is locked and gets a new version instead of an edit", async ({
    page,
  }) => {
    await signedInAdmin(page, "assessment");
    await expect(page.getByText("No assessment scheme yet.")).toBeVisible();
    await page.getByRole("button", { name: "New scheme" }).click();
    await field(dialog(page), "Name").fill("Standard");
    await field(dialog(page), "Exam mark").fill("60");
    await field(dialog(page), "Component 1 name").fill("CA 1");
    await field(dialog(page), "Component 1 maximum").fill("30");
    await expect(dialog(page).getByText(/add up to\s*90\s*of\s*100/)).toBeVisible();
    await dialog(page).getByRole("button", { name: "Create scheme" }).click();
    await expect(dialog(page).getByText(/add up to 90, not the total/)).toBeVisible(); // refused by the server, shown at the exam mark
    await field(dialog(page), "Component 1 maximum").fill("40");
    await expect(dialog(page).getByText(/that matches/)).toBeVisible();
    await dialog(page).getByRole("button", { name: "Add a component" }).click();
    await expect(field(dialog(page), "Component 2 name")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Remove component 2" }).click();
    await dialog(page).getByRole("button", { name: "Create scheme" }).click();
    await expect(notice(page)).toContainText("Saved Standard.");
    const card = item(page, "Standard");
    await expect(card).toContainText("School default");
    await expect(card).toContainText("Not used yet");
    await expect(card).toContainText("CA 1");

    await page.getByRole("button", { name: "Edit Standard" }).click();
    await field(dialog(page), "Name").fill("Standard v1");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(notice(page)).toContainText("Saved Standard v1.");

    // what Phase 1.4 will do the first time a result uses it
    await db.assessmentScheme.updateMany({ where: { tenantId: school.id }, data: { lockedAt: new Date() } });
    await page.reload();
    await expect(item(page, "Standard v1")).toContainText("In use");
    await expect(page.getByRole("button", { name: "Edit Standard v1" })).toHaveCount(0);
    await page.getByRole("button", { name: "Make a new version of Standard v1" }).click();
    await expect(dialog(page).getByText("Results already use version 1")).toBeVisible();
    await field(dialog(page), "Exam mark").fill("50");
    await field(dialog(page), "Component 1 maximum").fill("50");
    await dialog(page).getByRole("button", { name: "Create new version" }).click();
    await expect(notice(page)).toContainText("Version 2 of Standard v1 is ready.");
    await expect(item(page, /Standard v1.*Version 2/)).toContainText("Not used yet");
    await page.getByLabel("Show", { exact: true }).selectOption("all");
    await expect(item(page, /Standard v1.*Version 1/)).toContainText("Archived");
  });
});

test.describe("grade scales", () => {
  test("the standard A–F scale in one click; the first scale is the default; the bands must cover 0–100; make-default swaps; the default cannot be archived", async ({
    page,
  }) => {
    await signedInAdmin(page, "grading");
    await expect(page.getByText("No grade scale yet.")).toBeVisible();
    await page.getByRole("button", { name: "New scale" }).click();
    await dialog(page).getByRole("button", { name: "Create scale" }).click();
    await expect(dialog(page).getByText("Give the scale a name, such as Standard A–F.")).toBeVisible();
    await field(dialog(page), "Name").fill("Standard A–F");
    await dialog(page).getByRole("button", { name: "Fill in a standard A–F scale" }).click();
    await expect(field(dialog(page), "Band 1 letter")).toHaveValue("A");
    await field(dialog(page), "Band 6 from").fill("5"); // the lowest band no longer starts at 0
    await dialog(page).getByRole("button", { name: "Create scale" }).click();
    await expect(dialog(page).getByText("The lowest band must start at 0.")).toBeVisible();
    await field(dialog(page), "Band 6 from").fill("0");
    await dialog(page).getByRole("button", { name: "Create scale" }).click();
    await expect(notice(page)).toContainText("Saved Standard A–F.");
    const card = item(page, "Standard A–F");
    await expect(card).toContainText("Default");
    const table = card.getByRole("table", { name: "Bands of Standard A–F" });
    await expect(table.getByRole("row")).toHaveCount(7); // header + six bands
    await expect(table.getByRole("row").nth(1)).toContainText("A");
    await expect(table.getByRole("row").nth(1)).toContainText("70 to 100");
    await expect(table.getByRole("row").nth(2)).toContainText("60 to under 70");
    await expect(card.getByRole("button", { name: "Archive Standard A–F" })).toHaveCount(0); // the default can't be archived

    await page.getByRole("button", { name: "New scale" }).click();
    await field(dialog(page), "Name").fill("Pass / fail");
    await field(dialog(page), "Band 1 from").fill("0");
    await field(dialog(page), "Band 1 up to").fill("50");
    await field(dialog(page), "Band 1 letter").fill("F");
    await field(dialog(page), "Band 1 remark").fill("Fail");
    await dialog(page).getByRole("button", { name: "Add a band" }).click();
    await field(dialog(page), "Band 2 from").fill("60"); // a gap from 50 to 60
    await field(dialog(page), "Band 2 up to").fill("100");
    await field(dialog(page), "Band 2 letter").fill("P");
    await field(dialog(page), "Band 2 remark").fill("Pass");
    await dialog(page).getByRole("button", { name: "Create scale" }).click();
    await expect(dialog(page).getByText(/There is a gap before this band/)).toBeVisible();
    await field(dialog(page), "Band 2 from").fill("50");
    await dialog(page).getByRole("button", { name: "Create scale" }).click();
    await expect(notice(page)).toContainText("Saved Pass / fail.");
    await expect(item(page, "Pass / fail")).not.toContainText("Default");

    await page.getByRole("button", { name: "Make Pass / fail the default" }).click();
    await dialog(page).getByRole("button", { name: "Make default" }).click();
    await expect(notice(page)).toContainText("Pass / fail is now the default scale.");
    await expect(item(page, "Pass / fail")).toContainText("Default");
    await expect(item(page, "Standard A–F")).not.toContainText("Default");
    await page.getByRole("button", { name: "Archive Standard A–F" }).click();
    await dialog(page).getByRole("button", { name: "Archive scale" }).click();
    await expect(notice(page)).toContainText("Standard A–F was archived.");
    await expect(item(page, "Standard A–F")).toHaveCount(0);
  });
});
