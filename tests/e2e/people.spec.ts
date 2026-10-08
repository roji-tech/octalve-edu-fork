import { test, expect } from "../support/fixtures";
import type { Locator, Page } from "@playwright/test";
import {
  Role,
  addMembership,
  createTenant,
  createUser,
  db,
  removeCreatedTenants,
  seedInstance,
  uniqueIp,
  type TestTenant,
} from "../support/db";
import { SAAS_URL } from "../support/env";
import { tokenFrom, waitForMail } from "../support/outbox";
import { signInThroughUi } from "./helpers";

// People in a real browser, desktop and phone (plan "Build design — Phase 1.2", decision P9): students (add, search, class, enrol/move/withdraw, archive, guardians,
// CSV import and export) and staff (add, invite to sign in, link, what they teach), and what a member of staff can only look at. The SaaS-mode server.
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
let counter = 0;
const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++counter}`;

async function signedInAdmin(page: Page, section = "students") {
  const admin = await createUser({ name: "Amina Yusuf" });
  await addMembership(admin.id, school.id, Role.ADMIN);
  await signInThroughUi(page, admin);
  await page.goto(`/schools/${school.code}/people?section=${section}`);
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  return admin;
}
const pupil = (over: Record<string, unknown> = {}) =>
  db.studentRecord.create({
    data: {
      tenantId: school.id,
      firstName: "Sade",
      lastName: "Okoro",
      dateOfBirth: new Date("2012-05-01"),
      admissionNo: uniq("ADM/"),
      ...over,
    },
  });
async function classes() {
  const session = await db.academicSession.create({
    data: { tenantId: school.id, label: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31"), status: "ACTIVE" },
  });
  const group = await db.classGroup.create({ data: { tenantId: school.id, name: "JSS 1" } });
  const a = await db.classArm.create({ data: { tenantId: school.id, classGroupId: group.id, name: "A", capacity: 30 } });
  const b = await db.classArm.create({ data: { tenantId: school.id, classGroupId: group.id, name: "B" } });
  return { session, group, a, b };
}

test.describe("the page", () => {
  test("an administrator gets Students and Staff as links; the address chooses one; an unknown one falls back to students", async ({
    page,
  }) => {
    await signedInAdmin(page);
    await expect(page).toHaveTitle(/People/);
    const sections = page.getByRole("navigation", { name: "People sections" });
    await expect(sections.getByRole("link")).toHaveText(["Students", "Staff"]);
    await expect(sections.getByRole("link", { name: "Students" })).toHaveAttribute("aria-current", "page");
    await sections.getByRole("link", { name: "Staff" }).click();
    await expect(page).toHaveURL(/section=staff/);
    await expect(page.getByRole("heading", { level: 2, name: "Staff" })).toBeVisible();
    await page.goto(`/schools/${school.code}/people?section=nonsense`);
    await expect(page.getByRole("heading", { level: 2, name: "Students" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "People sections" }).getByRole("link", { name: "Students" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("staff may LOOK (the lists, a person's page) but nothing that writes is drawn; students and parents get the same 403 view as a stranger", async ({
    page,
    browser,
  }) => {
    const wide = await pupil({ firstName: "Wide", lastName: "Pupil" });
    const south = await pupil({ firstName: "Far", lastName: "South", campusId: school.campuses[1].id });
    await db.staffRecord.create({
      data: { tenantId: school.id, category: "TEACHING", firstName: "Tola", lastName: "Bello", email: "tola@example.com" },
    });
    const teacher = await createUser({ name: "Tola Teacher" });
    await addMembership(teacher.id, school.id, Role.TEACHING_STAFF, school.campuses[0].id);
    await signInThroughUi(page, teacher);

    const response = await page.goto(`/schools/${school.code}/people`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 2, name: "Students" })).toBeVisible();
    await expect(page.getByText("Only an administrator can change this.")).toBeVisible();
    await expect(item(page, "Wide Pupil")).toBeVisible();
    await expect(item(page, "Far South")).toHaveCount(0); // another campus's student is not theirs to see
    for (const name of ["Add student", "Import…", "Export"])
      await expect(page.getByRole("button", { name }).or(page.getByRole("link", { name })), name).toHaveCount(0);

    await item(page, "Wide Pupil").getByRole("link", { name: "Wide Pupil" }).click();
    await expect(page.getByRole("heading", { level: 2, name: /Wide Pupil/ })).toBeVisible();
    for (const name of [/^Edit /, /^Archive /, /^Restore /, /Enrol in a class/, /Add guardian/])
      await expect(page.getByRole("button", { name }), String(name)).toHaveCount(0);

    await page.goto(`/schools/${school.code}/people?section=staff`);
    await expect(item(page, "Tola Bello")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add staff member" })).toHaveCount(0);
    await item(page, "Tola Bello").getByRole("link", { name: "Tola Bello" }).click();
    await expect(page.getByRole("heading", { level: 2, name: /Tola Bello/ })).toBeVisible();
    for (const name of [/^Edit /, /^Archive /, /Invite /, /Link /, /Add a subject/])
      await expect(page.getByRole("button", { name }), String(name)).toHaveCount(0);

    // another campus's student is the 404 page, not a hint that it exists
    expect((await page.goto(`/schools/${school.code}/people/students/${south.id}`))?.status()).toBe(404);
    expect((await page.goto(`/schools/${school.code}/people/students/${wide.id}`))?.status()).toBe(200);

    for (const [role, name] of [
      [Role.PARENT, "Pat Parent"],
      [Role.STUDENT, "Sam Student"],
    ] as const) {
      const outsider = await createUser({ name });
      await addMembership(outsider.id, school.id, role);
      const fresh = await browser.newContext({ baseURL: SAAS_URL, extraHTTPHeaders: { "x-real-ip": uniqueIp() } });
      const other = await fresh.newPage();
      await signInThroughUi(other, outsider);
      for (const path of ["people", `people/students/${wide.id}`]) {
        const denied = await other.goto(`/schools/${school.code}/${path}`);
        expect(denied?.status(), `${name} ${path}`).toBe(403);
        await expect(other.getByRole("heading", { level: 1, name: "You don't have access to this school" })).toBeVisible();
      }
      await fresh.close();
    }
  });
});

test.describe("students", () => {
  test("add a student: the form says what is missing in place; the new student gets the next admission number and appears in the list", async ({
    page,
  }) => {
    await signedInAdmin(page);
    await expect(page.getByText("No students yet. Add the first one, or import a file.")).toBeVisible();
    await page.getByRole("button", { name: "Add student" }).click();
    const d = dialog(page);
    await d.getByRole("button", { name: "Add student" }).click();
    await expect(d.getByText("Give the student's first name.")).toBeVisible();
    await expect(d.getByText("Give the student's last name.")).toBeVisible();
    await expect(d.getByText("Give the date of birth.")).toBeVisible();
    await field(d, "First name").fill("Sade");
    await field(d, "Middle name (optional)").fill("Ruth");
    await field(d, "Last name").fill("Okoro");
    await field(d, "Date of birth").fill("2012-05-01");
    await d.getByRole("button", { name: "Add student" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText(/Added Sade Ruth Okoro \(\d{4}\/0001\)\./);
    await expect(item(page, "Sade Ruth Okoro")).toBeVisible();
    await expect(page.getByText("1 student")).toBeVisible();

    // the same name and birthday again is refused, in the form
    await page.getByRole("button", { name: "Add student" }).click();
    await field(dialog(page), "First name").fill("sade");
    await field(dialog(page), "Last name").fill("OKORO");
    await field(dialog(page), "Date of birth").fill("2012-05-01");
    await dialog(page).getByRole("button", { name: "Add student" }).click();
    await expect(
      dialog(page)
        .getByText(/already exists/i)
        .first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await db.studentRecord.count({ where: { tenantId: school.id } })).toBe(1);
  });

  test("search by name or number, the archived view, and the class filter (a class, or 'not in a class yet')", async ({ page }) => {
    const { session, a, b } = await classes();
    const sade = await pupil({ firstName: "Sade", lastName: "Okoro", admissionNo: "ADM/001" });
    const tunde = await pupil({ firstName: "Tunde", lastName: "Bello", admissionNo: "ADM/002" });
    await pupil({ firstName: "Chidi", lastName: "Eze", admissionNo: "ADM/003" });
    await pupil({ firstName: "Old", lastName: "Boy", admissionNo: "ADM/004", archivedAt: new Date() });
    await db.studentEnrollment.create({ data: { tenantId: school.id, studentId: sade.id, sessionId: session.id, classArmId: a.id } });
    await db.studentEnrollment.create({ data: { tenantId: school.id, studentId: tunde.id, sessionId: session.id, classArmId: b.id } });
    await signedInAdmin(page);
    await expect(page.getByText("3 students")).toBeVisible();
    await expect(item(page, "Sade Okoro")).toContainText("JSS 1 A");
    await expect(item(page, "Chidi Eze")).toContainText("Not in a class");

    await page.getByLabel("Search", { exact: true }).fill("bel");
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    await expect(item(page, "Tunde Bello")).toBeVisible();
    await page.getByLabel("Search", { exact: true }).fill("ADM/003");
    await expect(item(page, "Chidi Eze")).toBeVisible();
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    await page.getByLabel("Search", { exact: true }).fill("zzzz");
    await expect(page.getByText("No student matches these filters.")).toBeVisible();
    await page.getByLabel("Search", { exact: true }).fill("");

    await page.getByLabel("Class", { exact: true }).selectOption({ label: "JSS 1 A" });
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    await expect(item(page, "Sade Okoro")).toBeVisible();
    await page.getByLabel("Class", { exact: true }).selectOption({ label: "Not in a class yet" });
    await expect(item(page, "Chidi Eze")).toBeVisible();
    await expect(item(page, "Sade Okoro")).toHaveCount(0);
    await page.getByLabel("Class", { exact: true }).selectOption({ label: "All students" });
    await page.getByLabel("Show", { exact: true }).selectOption("archived");
    await expect(item(page, "Old Boy")).toContainText("Archived");
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
  });

  test("a student's page: enrol in a class, move to another, withdraw with a reason; archiving while enrolled is refused in words; archive and restore", async ({
    page,
  }) => {
    const { a } = await classes();
    const sade = await pupil({ admissionNo: "ADM/001" });
    await signedInAdmin(page);
    await item(page, "Sade Okoro").getByRole("link", { name: "Sade Okoro" }).click();
    await expect(page.getByRole("heading", { level: 2, name: /Sade Okoro/ })).toBeVisible();
    await expect(page.getByText("ADM/001")).toBeVisible();
    await expect(page.getByText("1 May 2012")).toBeVisible();
    await expect(page.getByText("Not in a class yet.")).toBeVisible();

    await page.getByRole("button", { name: "Enrol in a class" }).click();
    let d = dialog(page);
    await d.getByRole("button", { name: "Enrol student" }).click();
    await expect(d.getByText("Choose a class.")).toBeVisible();
    await expect(field(d, "Session")).toHaveValue(/.+/); // the open session is already chosen
    await field(d, "Class").selectOption({ label: "JSS 1 A" });
    await d.getByRole("button", { name: "Enrol student" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText("Enrolled.");
    await expect(item(page, "JSS 1 A")).toContainText("Enrolled");
    await expect(item(page, "JSS 1 A")).toContainText("2026/2027");

    await page.getByRole("button", { name: "Archive Sade Okoro" }).click();
    await dialog(page).getByRole("button", { name: "Archive student" }).click();
    await expect(dialog(page).getByText("The student is still enrolled. Withdraw them from the class first.")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Restore Sade Okoro" })).toHaveCount(0);

    await page.getByRole("button", { name: "Move Sade Okoro from JSS 1 A" }).click();
    d = dialog(page);
    await expect(d.getByText("Currently in JSS 1 A for 2026/2027.")).toBeVisible();
    await field(d, "Class").selectOption({ label: "JSS 1 B" });
    await d.getByRole("button", { name: "Move student" }).click();
    await expect(notice(page)).toContainText("Moved.");
    await expect(item(page, "JSS 1 B")).toContainText("Enrolled");

    await page.getByRole("button", { name: "Withdraw Sade Okoro from JSS 1 B" }).click();
    d = dialog(page);
    await d.getByRole("button", { name: "Withdraw student" }).click();
    await expect(d.getByText("Say why, in at least 5 characters.")).toBeVisible();
    await field(d, "Why are they being withdrawn?").fill("Family moved to Abuja");
    await d.getByRole("button", { name: "Withdraw student" }).click();
    await expect(notice(page)).toContainText("Withdrawn.");
    await expect(item(page, "JSS 1 B")).toContainText("Withdrawn");
    await expect(page.getByRole("button", { name: /^Move Sade Okoro/ })).toHaveCount(0);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "ENROLMENT_WITHDRAWN" } })).reason).toBe("Family moved to Abuja");

    // coming back into the same session reuses the row
    await page.getByRole("button", { name: "Enrol in a class" }).click();
    await field(dialog(page), "Class").selectOption({ label: "JSS 1 A" });
    await dialog(page).getByRole("button", { name: "Enrol student" }).click();
    await expect(notice(page)).toContainText("Enrolled.");
    expect(await db.studentEnrollment.count({ where: { studentId: sade.id } })).toBe(1);
    expect(a.id).toBeTruthy();

    await page.getByRole("button", { name: /^Withdraw Sade Okoro/ }).click();
    await field(dialog(page), "Why are they being withdrawn?").fill("Transferred to another school");
    await dialog(page).getByRole("button", { name: "Withdraw student" }).click();
    await expect(notice(page)).toContainText("Withdrawn.");
    await page.getByRole("button", { name: "Archive Sade Okoro" }).click();
    await dialog(page).getByRole("button", { name: "Archive student" }).click();
    await expect(notice(page)).toContainText("Archived.");
    await expect(page.getByRole("heading", { level: 2, name: /Sade Okoro/ }).getByText("Archived")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enrol in a class" })).toHaveCount(0);
    await page.getByRole("button", { name: "Restore Sade Okoro" }).click();
    await expect(notice(page)).toContainText("Restored.");
    await expect(page.getByRole("button", { name: "Archive Sade Okoro" })).toBeVisible();
  });

  test("editing a student: the form starts with what is there, says what is wrong in place, and a change is saved", async ({ page }) => {
    await pupil({ admissionNo: "ADM/001", middleName: "Ruth" });
    await signedInAdmin(page);
    await item(page, "Sade Ruth Okoro").getByRole("link").click();
    await page.getByRole("button", { name: "Edit Sade Ruth Okoro" }).click();
    const d = dialog(page);
    await expect(field(d, "First name")).toHaveValue("Sade");
    await expect(field(d, "Date of birth")).toHaveValue("2012-05-01");
    await field(d, "First name").fill("");
    await d.getByRole("button", { name: "Save changes" }).click();
    await expect(d.getByText("Give the student's first name.")).toBeVisible();
    await field(d, "First name").fill("Sadé");
    await field(d, "Last name").fill("Bello");
    await d.getByRole("button", { name: "Save changes" }).click();
    await expect(notice(page)).toContainText("Saved.");
    await expect(page.getByRole("heading", { level: 2, name: /Sadé Ruth Bello/ })).toBeVisible();
    expect((await db.studentRecord.findFirstOrThrow({ where: { tenantId: school.id } })).lastName).toBe("Bello");
  });

  test("guardians: add a new one (the first is the primary contact), add another and make them primary, edit, remove with a confirmation; a sibling's parent is picked from the register, not typed twice", async ({
    page,
  }) => {
    await pupil({ admissionNo: "ADM/001" });
    const sibling = await pupil({ firstName: "Bisi", lastName: "Okoro", dateOfBirth: new Date("2014-02-02"), admissionNo: "ADM/002" });
    await signedInAdmin(page);
    await item(page, "Sade Okoro").getByRole("link").click();
    await expect(page.getByText("No guardian recorded yet.")).toBeVisible();

    await page.getByRole("button", { name: "Add guardian" }).click();
    let d = dialog(page);
    await expect(d.getByText("The first guardian you add becomes the primary contact.")).toBeVisible();
    await d.getByRole("button", { name: "Add guardian" }).click();
    await expect(d.getByText("Give the guardian's first name.")).toBeVisible();
    await field(d, "First name").fill("Gbenga");
    await field(d, "Last name").fill("Okoro");
    await field(d, "Phone (optional)").fill("12");
    await field(d, "Relationship to the student").selectOption("FATHER");
    await d.getByRole("button", { name: "Add guardian" }).click();
    await expect(d.getByText("A phone number has 7 to 20 digits, spaces, + - or brackets.")).toBeVisible();
    await field(d, "Phone (optional)").fill("08031234567");
    await d.getByRole("button", { name: "Add guardian" }).click();
    await expect(notice(page)).toContainText("Guardian added.");
    await expect(item(page, "Gbenga Okoro")).toContainText("Primary contact");
    await expect(item(page, "Gbenga Okoro")).toContainText("Father · 08031234567");

    await page.getByRole("button", { name: "Add guardian" }).click();
    d = dialog(page);
    await field(d, "First name").fill("Mary");
    await field(d, "Last name").fill("Okoro");
    await field(d, "Relationship to the student").selectOption("MOTHER");
    await d.getByLabel("Make this the primary contact").check();
    await d.getByRole("button", { name: "Add guardian" }).click();
    await expect(notice(page)).toContainText("Guardian added.");
    await expect(item(page, "Mary Okoro")).toContainText("Primary contact");
    await expect(item(page, "Gbenga Okoro")).not.toContainText("Primary contact");

    await page.getByRole("button", { name: "Edit Gbenga Okoro" }).click();
    d = dialog(page);
    await field(d, "Relationship to the student").selectOption("GUARDIAN");
    await d.getByLabel("Primary contact").check();
    await d.getByRole("button", { name: "Save changes" }).click();
    await expect(notice(page)).toContainText("Saved.");
    await expect(item(page, "Gbenga Okoro")).toContainText("Primary contact");
    await expect(item(page, "Gbenga Okoro")).toContainText("Guardian");
    await expect(item(page, "Mary Okoro")).not.toContainText("Primary contact");

    await page.getByRole("button", { name: "Remove Mary Okoro" }).click();
    await expect(dialog(page).getByText(/no longer Sade Okoro's guardian/)).toBeVisible();
    await dialog(page).getByRole("button", { name: "Remove guardian" }).click();
    await expect(notice(page)).toContainText("Guardian removed.");
    await expect(item(page, "Mary Okoro")).toHaveCount(0);

    // the sibling: pick Gbenga from the register
    await page.goto(`/schools/${school.code}/people/students/${sibling.id}`);
    await page.getByRole("button", { name: "Add guardian" }).click();
    d = dialog(page);
    await field(d, "Who is it?").selectOption("existing");
    await field(d, "Search guardians").fill("gben");
    await expect(field(d, "Guardian").locator("option", { hasText: "Gbenga Okoro" })).toHaveCount(1);
    await field(d, "Guardian").selectOption({ label: "Gbenga Okoro · 08031234567" });
    await field(d, "Relationship to the student").selectOption("FATHER");
    await d.getByRole("button", { name: "Add guardian" }).click();
    await expect(notice(page)).toContainText("Guardian added.");
    await expect(item(page, "Gbenga Okoro")).toContainText("Primary contact");
    expect(await db.guardianRecord.count({ where: { tenantId: school.id, lastName: "Okoro" } })).toBe(2); // Gbenga once, Mary once — not a third
    await page.getByRole("button", { name: "Edit Gbenga Okoro" }).click();
    await expect(dialog(page).getByText(/shared with their other child/)).toBeVisible();
  });

  test("import: the check lists every problem and writes nothing; a clean file is imported all at once; the list shows them", async ({
    page,
  }) => {
    await signedInAdmin(page);
    await page.getByRole("button", { name: "Import…" }).click();
    const d = dialog(page);
    await expect(d.getByRole("button", { name: "Check the file" })).toBeDisabled();
    const header = "first_name,last_name,date_of_birth,guardian_name,relationship\r\n";
    await d.locator("#import-file").setInputFiles({
      name: "students.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        `${header}Sade,Okoro,2012-05-01,Gbenga Okoro,father\r\nTunde,Bello,2012-02-30,,\r\nChidi,Eze,2013-03-03,Madonna,mother\r\n`,
      ),
    });
    await d.getByRole("button", { name: "Check the file" }).click();
    await expect(d.getByText("2 rows have problems. Nothing was imported — fix the file and check it again.")).toBeVisible();
    const table = d.getByRole("table", { name: "Rows with problems" });
    await expect(table.getByRole("row")).toHaveCount(3); // header + two
    await expect(table.getByRole("row", { name: /Tunde Bello/ })).toContainText("date_of_birth");
    await expect(table.getByRole("row", { name: /Chidi Eze/ })).toContainText("guardian_name");
    await expect(d.getByRole("button", { name: /^Import \d/ })).toHaveCount(0);
    expect(await db.studentRecord.count({ where: { tenantId: school.id } })).toBe(0);

    await d.locator("#import-file").setInputFiles({
      name: "students.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`${header}Sade,Okoro,2012-05-01,Gbenga Okoro,father\r\nTunde,Bello,2012-03-30,,\r\n`),
    });
    await expect(d.getByRole("table", { name: "Rows with problems" })).toHaveCount(0); // choosing a new file clears the old report
    await d.getByRole("button", { name: "Check the file" }).click();
    await expect(d.getByText("The file is fine: 2 to add.")).toBeVisible();
    expect(await db.studentRecord.count({ where: { tenantId: school.id } })).toBe(0); // checking wrote nothing
    await d.getByRole("button", { name: "Import 2 students" }).click();
    await expect(d.getByText("Done: 2 added.")).toBeVisible();
    await d.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText("Imported 2 students.");
    await expect(item(page, "Sade Okoro")).toBeVisible();
    await expect(item(page, "Tunde Bello")).toBeVisible();
    expect(await db.guardianLink.count({ where: { tenantId: school.id } })).toBe(1);

    // running the same file again adds nobody and says so
    await page.getByRole("button", { name: "Import…" }).click();
    await dialog(page)
      .locator("#import-file")
      .setInputFiles({
        name: "students.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(`${header}Sade,Okoro,2012-05-01,Gbenga Okoro,father\r\nTunde,Bello,2012-03-30,,\r\n`),
      });
    await dialog(page).getByRole("button", { name: "Check the file" }).click();
    await expect(dialog(page).getByText("The file is fine")).toHaveCount(0); // nothing to add: no "Import" offered
    await expect(dialog(page).getByText(/0 to add, 2 already in the register/)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: /^Import \d/ })).toHaveCount(0);
  });

  test("export: a CSV download of the current filter, with the import's columns", async ({ page }) => {
    await pupil({ firstName: "Sade", lastName: "Okoro", admissionNo: "ADM/001" });
    await pupil({ firstName: "=cmd", lastName: "Evil", admissionNo: "ADM/002" });
    await signedInAdmin(page);
    await page.getByLabel("Search", { exact: true }).fill("okoro");
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^students-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
    expect(text.split("\r\n")[0]).toBe(
      "first_name,last_name,middle_name,date_of_birth,admission_no,campus,class,arm,session,guardian_name,guardian_phone,guardian_email,relationship",
    );
    expect(text).toContain("Sade,Okoro,,2012-05-01,ADM/001");
    expect(text).not.toContain("Evil"); // the filter travelled with the link
  });
});

test.describe("staff", () => {
  test("add a member of staff: what is missing is said in place; the record appears with 'No sign-in'", async ({ page }) => {
    await signedInAdmin(page, "staff");
    await expect(page.getByText("No staff yet. Add the first member of staff.")).toBeVisible();
    await page.getByRole("button", { name: "Add staff member" }).click();
    let d = dialog(page);
    await d.getByRole("button", { name: "Add staff member" }).click();
    await expect(d.getByText("Give their first name.")).toBeVisible();
    await expect(d.getByText("Give their last name.")).toBeVisible();
    await field(d, "First name").fill("Tola");
    await field(d, "Last name").fill("Bello");
    await field(d, "Email (optional)").fill("nope");
    await d.getByRole("button", { name: "Add staff member" }).click();
    await expect(d.getByText("Give a valid email address.")).toBeVisible();
    await field(d, "Email (optional)").fill("tola@example.com");
    await field(d, "Campus").selectOption({ label: "Alpha North" });
    await d.getByRole("button", { name: "Add staff member" }).click();
    await expect(notice(page)).toContainText("Added Tola Bello.");
    await expect(item(page, "Tola Bello")).toContainText("No sign-in");
    await expect(item(page, "Tola Bello")).toContainText("Teaching");
    await expect(item(page, "Tola Bello")).toContainText("Alpha North");

    await page.getByRole("button", { name: "Add staff member" }).click();
    d = dialog(page);
    await field(d, "First name").fill("Tolu");
    await field(d, "Last name").fill("Other");
    await field(d, "Email (optional)").fill("TOLA@example.com");
    await d.getByRole("button", { name: "Add staff member" }).click();
    await expect(d.getByText("Another record uses this address.")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByLabel("Kind", { exact: true }).selectOption("NON_TEACHING");
    await expect(page.getByText("Nobody matches these filters.")).toBeVisible();
  });

  test("invite a record to sign in: the mail goes to the record's address; accepting links the record; the page then says they can sign in", async ({
    page,
    request,
  }) => {
    const email = `${uniq("hire")}@example.com`;
    const record = await db.staffRecord.create({
      data: { tenantId: school.id, category: "NON_TEACHING", firstName: "Hira", lastName: "Newhire", email },
    });
    const noEmail = await db.staffRecord.create({
      data: { tenantId: school.id, category: "TEACHING", firstName: "Nomail", lastName: "Person" },
    });
    await signedInAdmin(page, "staff");
    await page.goto(`/schools/${school.code}/people/staff/${noEmail.id}`);
    await expect(page.getByRole("button", { name: "Invite Nomail Person to sign in" })).toBeDisabled();
    await expect(page.getByText(/Add an email address to invite them/)).toBeVisible();

    await page.goto(`/schools/${school.code}/people/staff/${record.id}`);
    await expect(page.getByText("No sign-in yet. An invitation goes to " + email + ".")).toBeVisible();
    await page.getByRole("button", { name: "Invite Hira Newhire to sign in" }).click();
    await expect(dialog(page)).toContainText(email);
    await expect(dialog(page)).toContainText("non-teaching staff");
    await dialog(page).getByRole("button", { name: "Send invitation" }).click();
    await expect(notice(page)).toContainText(`Invitation sent to ${email}.`);
    await expect(page.getByText(/An invitation has been sent/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Invite Hira Newhire to sign in" })).toBeVisible(); // (an invited record can be invited again: that replaces the old link)

    const token = tokenFrom((await waitForMail(email))[0]);
    const accepted = await request.post("/api/v1/invitations/accept", {
      data: { token, name: "Hira Newhire", password: "a-fresh-unseen-passphrase-3" },
      headers: { origin: SAAS_URL, "x-real-ip": uniqueIp() },
    });
    expect(accepted.status()).toBe(200);
    await page.reload();
    await expect(page.getByText("Hira Newhire", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Linked to/)).toContainText(email);
    await expect(page.getByText("Can sign in")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Invite / })).toHaveCount(0);
  });

  test("link an existing account (only members whose role fits are offered), see the link, unlink it; the kind is fixed while linked", async ({
    page,
  }) => {
    const record = await db.staffRecord.create({
      data: { tenantId: school.id, category: "TEACHING", firstName: "Tola", lastName: "Bello" },
    });
    const fits = await createUser({ name: "Fits Teacher" });
    await addMembership(fits.id, school.id, Role.TEACHING_STAFF);
    const wrong = await createUser({ name: "Wrong Clerk" });
    await addMembership(wrong.id, school.id, Role.NON_TEACHING_STAFF);
    await signedInAdmin(page, "staff");
    await page.goto(`/schools/${school.code}/people/staff/${record.id}`);
    await page.getByRole("button", { name: "Link Tola Bello to an existing account" }).click();
    const d = dialog(page);
    await d.getByRole("button", { name: "Link account" }).click();
    await expect(d.getByText("Choose who this record is.")).toBeVisible();
    await expect(field(d, "Account").locator("option", { hasText: "Fits Teacher" })).toHaveCount(1);
    await expect(field(d, "Account").locator("option", { hasText: "Wrong Clerk" })).toHaveCount(0);
    await field(d, "Account").selectOption({ label: `Fits Teacher · ${fits.email}` });
    await d.getByRole("button", { name: "Link account" }).click();
    await expect(notice(page)).toContainText("Account linked.");
    await expect(page.getByText(/Linked to/)).toContainText("Fits Teacher");
    await expect(page.getByText("Can sign in")).toBeVisible();

    await page.getByRole("button", { name: "Edit Tola Bello" }).click();
    await expect(field(dialog(page), "Kind of staff")).toBeDisabled();
    await expect(dialog(page).getByText("Fixed while they have a sign-in account.")).toBeVisible();
    await page.keyboard.press("Escape");

    await db.tenantMembership.update({
      where: { userId_tenantId: { userId: fits.id, tenantId: school.id } },
      data: { role: Role.NON_TEACHING_STAFF },
    });
    await page.reload();
    await expect(page.getByText(/no longer matches this record/)).toBeVisible();

    await page.getByRole("button", { name: "Unlink Tola Bello's account" }).click();
    await dialog(page).getByRole("button", { name: "Unlink account" }).click();
    await expect(notice(page)).toContainText("Account unlinked.");
    await expect(page.getByText(/No sign-in yet/)).toBeVisible();
    expect(await db.tenantMembership.count({ where: { userId: fits.id, tenantId: school.id } })).toBe(1);
  });

  test("what a person teaches: add a subject for a class that studies it, be told in words when it does not, remove it; a teacher with subjects cannot be archived", async ({
    page,
  }) => {
    const { group, a } = await classes();
    const maths = await db.subject.create({ data: { tenantId: school.id, name: "Mathematics" } });
    const art = await db.subject.create({ data: { tenantId: school.id, name: "Art" } });
    await db.subjectOffering.create({ data: { tenantId: school.id, classGroupId: group.id, subjectId: maths.id } });
    const record = await db.staffRecord.create({
      data: { tenantId: school.id, category: "TEACHING", firstName: "Tola", lastName: "Bello" },
    });
    await signedInAdmin(page, "staff");
    await page.goto(`/schools/${school.code}/people/staff/${record.id}`);
    await expect(page.getByText("Nothing assigned yet.")).toBeVisible();

    await page.getByRole("button", { name: "Add a subject" }).click();
    const d = dialog(page);
    await d.getByRole("button", { name: "Add", exact: true }).click();
    await expect(d.getByText("Choose a subject.")).toBeVisible();
    await expect(d.getByText("Choose a class.")).toBeVisible();
    await field(d, "Subject").selectOption({ label: "Art" });
    await field(d, "Class").selectOption({ label: "JSS 1 A" });
    await d.getByRole("button", { name: "Add", exact: true }).click();
    await expect(d.getByText("This class does not study this subject.")).toBeVisible();
    await field(d, "Subject").selectOption({ label: "Mathematics" });
    await d.getByRole("button", { name: "Add", exact: true }).click();
    await expect(notice(page)).toContainText("Added.");
    await expect(item(page, "Mathematics")).toContainText("JSS 1 A");

    await page.getByRole("button", { name: "Archive Tola Bello" }).click();
    await dialog(page).getByRole("button", { name: "Archive record" }).click();
    await expect(dialog(page).getByText("Subjects are still assigned to this person. Remove those first.")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Remove Mathematics in JSS 1 A" }).click();
    await dialog(page).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(notice(page)).toContainText("Removed.");
    await expect(page.getByText("Nothing assigned yet.")).toBeVisible();
    await page.getByRole("button", { name: "Archive Tola Bello" }).click();
    await dialog(page).getByRole("button", { name: "Archive record" }).click();
    await expect(notice(page)).toContainText("Archived.");
    await expect(page.getByRole("button", { name: "Restore Tola Bello" })).toBeVisible();
    expect(art.id).toBeTruthy();
    expect(a.id).toBeTruthy();
  });
});
